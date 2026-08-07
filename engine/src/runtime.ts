/**
 * Runtime orchestrator — the 24/7 brain.
 *
 * Loop responsibilities
 *   • keep the OKX universe, tickers and candle memory hot (REST seed + WS live)
 *   • analyse the focus instrument continuously and rotate the watchlist
 *   • scan the liquid SPOT + SWAP universe for the best setups
 *   • route every actionable candidate to the qualified specialist committee
 *   • arm it as a paper trade AND, when demo keys exist, as a real OKX demo order
 *   • absorb every closed outcome as an immutable point-in-time training sample
 *   • evolve new generations, promote on forward evidence, roll back on decay
 *   • report to Telegram: orders, generations, heartbeat, daily digest
 *
 * SQLite is the single source of truth. Convex is an optional write-only mirror.
 */
import { loadavg, freemem, totalmem } from 'node:os'
import { ENV, HAS_OKX_KEYS } from './env.js'
import { log } from './log.js'
import { convex, type AlertRuleRow, type WatchRow } from './convex/client.js'
import {
  fetchAccount,
  fetchDerivatives,
  fetchInstruments,
  fetchTickers,
  isEquityInstrument,
  restStats,
  type AccountSnapshot,
  type InstType,
  type Ticker,
} from './okx/market.js'
import { OkxStream } from './okx/ws.js'
import { candleStore } from './store/candles.js'
import { analyze, quickScore, type QuickScore } from './quant/engine.js'
import { higherTimeframes, normalizeBar } from './quant/timeframes.js'
import type { Analysis, Candle, DerivativesBlock, EngineSettings, InstrumentSpec } from './quant/types.js'
import { DEFAULT_SETTINGS } from './quant/types.js'
import { GeminiOrchestrator } from './ai/gemini.js'
import { TelegramBot } from './telegram/bot.js'
import { alertCard, signalCard, statusCard, HELP } from './telegram/cards.js'
import { digestCard, evolutionCard, heartbeatCard, orderCard } from './telegram/notify.js'
import { evaluateRule, scopeMatches, type AlertCandidate } from './alerts/rules.js'
import { DurableStore } from './store/durable.js'
import { backupFileName, diskUsage, listBackups, pruneBackups } from './store/backup.js'
import { evaluateStrategies, type StrategyCandidate } from './strategies/registry.js'
import { createPaperPlan, processPaperBar, submitPaperPlan } from './paper/broker.js'
import { assessPaperRisk, DEFAULT_RISK_POLICY } from './paper/risk.js'
import { REASON_LABELS, hypothesisFromAttribution, type ReasonCode } from './paper/attribution.js'
import type { PaperTrade } from './paper/types.js'
import { ResearchLab, type CampaignType } from './research/lab.js'
import { EvolutionService } from './research/evolution-service.js'
import { Harvester } from './research/harvester.js'
import { applyMask, nicheKey, type CommitteeVerdict } from './research/population.js'
import { OkxDemoBroker } from './execution/okx-demo.js'
import { applySettingsPatch, DEFAULT_RUNTIME_SETTINGS, hydrateSettings, type Settings } from './settings/schema.js'
import { fetchMarketContext, type MarketContext } from './quant/market-context.js'
import { buildFeatureVector, FEATURE_ORDER } from './research/features.js'
import { getCrossAssetData, type CrossAssetData } from './quant/cross-asset.js'
import { getOnChainData, type OnChainData } from './quant/onchain.js'
import { fetchOrderBook, type OrderBookSnapshot } from './quant/orderbook.js'
import { forecastVolatility, type VolForecast } from './quant/vol-forecast.js'
import { RegimeDetector, type RegimeInfo } from './quant/regime.js'
import { fitAnomalyModel, detectAnomaly, type AnomalyModel, type AnomalyResult } from './quant/anomaly.js'
import { computeKellySize, estimateUncertainty, type KellyResult } from './quant/kelly.js'
import { explainPrediction, type ExplanationResult } from './research/explain.js'
import { createMetaPlaybookModel, recordPlaybookOutcome, serializeMetaPlaybook, deserializeMetaPlaybook, type MetaPlaybookModel } from './research/meta-playbook.js'
import { fmtPct, fmtPrice, fmtUsd } from './format.js'

export type RuntimeSettings = Settings
export const FALLBACK_SETTINGS = DEFAULT_RUNTIME_SETTINGS
const FEATURE_SCHEMA = `features_v2_${FEATURE_ORDER.length}`
const POLICY_VERSION = 'explicit-playbooks-v2'

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

class Limiter {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

function every(ms: number, fn: () => Promise<void> | void, label: string) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await fn()
    } catch (err) {
      log.error(label, err instanceof Error ? err.message : String(err))
    } finally {
      running = false
    }
  }
  void tick()
  const handle = setInterval(tick, ms)
  handle.unref?.()
  return handle
}

export interface ScanRow extends QuickScore {
  instId: string
  instType: string
  isEquity: boolean
  volUsd24h: number
  changePct24h: number
  spreadBps: number
  scannedAt: number
}

/* -------------------------------------------------------------------------- */
/*  Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export class Runtime {
  settings: Settings = { ...DEFAULT_RUNTIME_SETTINGS }
  settingsSavedAt = 0
  universe = new Map<string, InstrumentSpec>()
  tickers = new Map<string, Ticker>()
  watchlist: WatchRow[] = []
  rules: AlertRuleRow[] = []
  analyses = new Map<string, Analysis>()
  previous = new Map<string, Analysis>()
  scan: { at: number; scanned: number; rows: ScanRow[]; running: boolean } = { at: 0, scanned: 0, rows: [], running: false }
  account: AccountSnapshot | null = null
  chats: number[] = []
  mutedChats = new Set<number>()
  startedAt = Date.now()
  store = new DurableStore()
  evolution: EvolutionService
  demo: OkxDemoBroker
  research: ResearchLab
  harvester: Harvester
  paperTrades = new Map<string, PaperTrade>()
  paperKillSwitch = this.store.getState<boolean>('paper_kill_switch', false)
  private lastDrySpellFactor: number | null = null
  latestCandidates = new Map<string, StrategyCandidate[]>()
  latestVerdicts = new Map<string, CommitteeVerdict>()
  counters = { evaluations: 0, alerts: 0, signals: 0, errors: 0, wsMessages: 0, demoOrders: 0 }
  lastAlertAt = new Map<string, number>()
  private derivCache = new Map<string, { at: number; data: DerivativesBlock }>()
  private aiCooldown = new Map<string, number>()
  private watchCursor = 0
  private limiter = new Limiter(4)
  private stream: OkxStream
  gemini: GeminiOrchestrator
  bot: TelegramBot
  universeLoadedAt = 0
  marketContext: MarketContext | null = null
  crossAsset: CrossAssetData | null = null
  onChain: OnChainData | null = null
  orderBook = new Map<string, OrderBookSnapshot>()
  volForecast: VolForecast | null = null
  regime: RegimeInfo | null = null
  regimeDetector = new RegimeDetector()
  anomalyModel: AnomalyModel | null = null
  anomalyResult: AnomalyResult | null = null
  kellyResult: KellyResult | null = null
  explanation: ExplanationResult | null = null
  metaPlaybook: MetaPlaybookModel = createMetaPlaybookModel()

  constructor() {
    candleStore.attachDurableStore(this.store)
    this.evolution = new EvolutionService(this.store)
    this.demo = new OkxDemoBroker(this.evolution.store)
    this.research = new ResearchLab(this.store, (sample) => this.evolution.recordBackfillSample(sample))
    this.harvester = new Harvester(this.store, this.evolution)
    for (const trade of this.store.loadActiveTrades()) this.paperTrades.set(trade.id, trade)
    this.gemini = new GeminiOrchestrator(ENV.gemini.apiKey)
    this.bot = new TelegramBot(ENV.telegram.token)
    this.evolution.onNotice = (notice) => {
      if (!this.settings.telegram.enabled || !this.settings.telegram.evolutionEvents) return
      if (notice.type === 'rejected') return
      void this.bot.broadcast(this.activeChats(), evolutionCard(notice))
    }
    this.stream = new OkxStream({
      onCandle: (instId, bar, candle) => {
        this.counters.wsMessages++
        candleStore.upsert(instId, bar, candle)
      },
      onTicker: (instId, last, ts) => {
        this.counters.wsMessages++
        const t = this.tickers.get(instId)
        if (t) {
          t.last = last
          t.ts = ts
          t.changePct24h = t.open24h > 0 ? ((last - t.open24h) / t.open24h) * 100 : t.changePct24h
        }
      },
      onStatus: (kind, status, meta) => {
        if (status !== 'online') log.info('ws', `${kind} ${status} — ${meta}`)
      },
    })
  }

  /* ---- lifecycle ------------------------------------------------------- */

  async boot() {
    log.info('boot', `MYCROFT engine starting · OKX ${HAS_OKX_KEYS ? (ENV.okx.simulated ? 'DEMO keys present' : 'LIVE keys present — demo execution disabled') : 'public data only'}`)
    if (this.store.restoredFrom) log.info('boot', `database was missing and has been restored from ${this.store.restoredFrom}`)
    this.loadLocalState()
    await this.refreshUniverse()
    await this.refreshTickers()
    this.seedDefaults()
    this.loadMetaPlaybook()
    if (this.demo.configured) {
      const balance = await this.demo.refreshBalance()
      log.info('okx-demo', balance ? `demo account ready · equity ${fmtUsd(balance.equityUsd)} · ${fmtUsd(balance.availableUsdt)} USDT free` : `demo balance unavailable: ${this.demo.health().lastError}`)
    } else {
      log.info('okx-demo', `real demo execution disabled — ${this.demo.blockReason}`)
    }
    this.stream.connect()
    this.syncSubscriptions()

    if (this.bot.configured) {
      await this.bot.identify()
      await this.bot.syncOffset()
      this.bot.startPolling((ctx) => this.handleCommand(ctx))
      log.info('telegram', `bot @${this.bot.me?.username ?? '?'} online`)
      if (ENV.telegram.chatId) {
        const id = Number(ENV.telegram.chatId)
        if (Number.isFinite(id)) this.registerChat(id)
      }
    }

    every(6_000, () => this.refreshTickers(), 'tickers')
    every(10 * 60_000, () => this.refreshUniverse(), 'universe')
    every(4_000, () => this.focusLoop(), 'focus')
    every(5_000, () => this.watchLoop(), 'watch')
    every(15_000, () => this.scanLoop(), 'scanner')
    every(10_000, () => this.paperLoop(), 'paper-broker')
    every(20_000, () => this.demoLoop(), 'okx-demo')
    every(10 * 60_000, () => this.maintenanceLoop(), 'maintenance')
    every(5 * 60_000, () => this.evolutionLoop(), 'evolution')
    every(30 * 60_000, () => this.autoResearchLoop(), 'auto-research')
    every(60 * 60_000, () => this.backupLoop(), 'backup')
    every(15 * 60_000, () => this.refreshMarketContext(), 'market-context')
    every(15 * 60_000, () => this.refreshCrossAsset(), 'cross-asset')
    every(30 * 60_000, () => this.refreshOnChain(), 'on-chain')
    every(10_000, () => this.refreshOrderBook(), 'order-book')
    every(60_000, () => this.refreshVolForecast(), 'vol-forecast')
    every(30_000, () => this.refreshRegime(), 'regime-detect')
    every(30 * 60_000, () => this.saveMetaPlaybook(), 'meta-playbook')
    every(60_000, () => this.reportLoop(), 'telegram-reports')
    every(30_000, () => this.telemetryLoop(), 'telemetry')
    every(5_000, () => log.flush(), 'logflush')
    every(60_000, () => this.refreshAccount(), 'account')
    every(60 * 60_000, () => this.harvestLoop(), 'harvest')
    log.info('boot', 'all loops armed')
    void this.backupLoop()
  }

  /* ---- configuration (SQLite only) ------------------------------------- */

  private loadLocalState() {
    this.settings = hydrateSettings(this.store.getState<unknown>('settings', {}))
    this.settingsSavedAt = this.store.getState<number>('settings_saved_at', 0)
    if (this.settings.htfTimeframe === 'auto' || this.settings.htf2Timeframe === 'auto') {
      const [h1, h2] = higherTimeframes(this.settings.timeframe)
      if (this.settings.htfTimeframe === 'auto') this.settings.htfTimeframe = h1 as Settings['htfTimeframe']
      if (this.settings.htf2Timeframe === 'auto') this.settings.htf2Timeframe = h2 as Settings['htf2Timeframe']
    }
    this.watchlist = this.store.getState<WatchRow[]>('watchlist', []).filter((row) => row.enabled)
    this.rules = this.store.getState<AlertRuleRow[]>('alert_rules', [])
    const chats = this.store.getState<{ chatId: number; muted?: boolean }[]>('telegram_chats', [])
    this.chats = chats.map((chat) => chat.chatId)
    this.mutedChats = new Set(chats.filter((chat) => chat.muted).map((chat) => chat.chatId))
  }

  /** Validate first, persist second, read back third. A rejected patch changes nothing. */
  updateSettings(patch: Record<string, unknown>) {
    const result = applySettingsPatch(this.settings, patch)
    if (!result.ok) {
      log.error('settings', `rejected patch: ${result.errors.join('; ')}`)
      return { ok: false as const, errors: result.errors, settings: this.settings, savedAt: this.settingsSavedAt }
    }
    this.settings = result.settings
    this.settingsSavedAt = Date.now()
    this.store.setState('settings', this.settings)
    this.store.setState('settings_saved_at', this.settingsSavedAt)
    const persisted = hydrateSettings(this.store.getState<unknown>('settings', {}))
    this.settings = persisted
    this.syncSubscriptions()
    log.info('settings', `saved: ${result.changed.join(', ') || 'no-op'}`)
    if (ENV.convexMirror) void convex.updateSettings(patch)
    return { ok: true as const, errors: [] as string[], settings: persisted, savedAt: this.settingsSavedAt }
  }

  private seedDefaults() {
    if (!this.watchlist.length) {
      const seed = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'AVAX-USDT', 'LINK-USDT']
      for (const instId of seed) {
        const spec = this.universe.get(instId)
        if (!spec) continue
        this.addWatch(instId, spec.instType, this.settings.timeframe, 'default liquidity-ranked universe')
      }
      log.info('boot', `seeded watchlist with ${this.watchlist.length} instruments across SPOT and SWAP`)
    }
    if (!this.rules.length) {
      this.upsertAlertRule({
        name: 'Evidence-backed paper candidate',
        scope: '*',
        type: 'signal',
        timeframe: 'any',
        params: { threshold: 62, direction: 'any' },
        cooldownMs: 30 * 60_000,
        telegram: true,
        enabled: true,
      })
    }
  }

  addWatch(instId: string, instType: string, timeframe: string, note?: string) {
    const existing = this.watchlist.find((row) => row.instId === instId)
    if (existing) Object.assign(existing, { instType, timeframe, note, enabled: true })
    else this.watchlist.push({ _id: `local:${instId}`, instId, instType, timeframe, enabled: true, alertsEnabled: true, note, addedAt: Date.now() })
    this.store.setState('watchlist', this.watchlist)
  }

  removeWatch(instId: string) {
    this.watchlist = this.watchlist.filter((row) => row.instId !== instId)
    this.store.setState('watchlist', this.watchlist)
  }

  patchWatch(instId: string, patch: Partial<WatchRow>) {
    const row = this.watchlist.find((item) => item.instId === instId)
    if (row) Object.assign(row, patch)
    this.store.setState('watchlist', this.watchlist)
  }

  upsertAlertRule(rule: Omit<AlertRuleRow, '_id' | 'lastFiredAt' | 'firedCount' | 'createdAt'> & { id?: string }) {
    const id = rule.id ?? `local:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const existing = this.rules.find((item) => item._id === id)
    const row: AlertRuleRow = { ...rule, _id: id, lastFiredAt: existing?.lastFiredAt ?? 0, firedCount: existing?.firedCount ?? 0, createdAt: existing?.createdAt ?? Date.now() }
    delete (row as AlertRuleRow & { id?: string }).id
    this.rules = [...this.rules.filter((item) => item._id !== id), row]
    this.store.setState('alert_rules', this.rules)
    return id
  }

  deleteAlertRule(id: string) {
    this.rules = this.rules.filter((rule) => rule._id !== id)
    this.store.setState('alert_rules', this.rules)
  }

  registerChat(chatId: number, firstName?: string, username?: string) {
    const chats = this.store.getState<{ chatId: number; muted?: boolean; firstName?: string; username?: string }[]>('telegram_chats', [])
    const next = [...chats.filter((chat) => chat.chatId !== chatId), { chatId, muted: false, firstName, username }]
    this.store.setState('telegram_chats', next)
    this.chats = next.map((chat) => chat.chatId)
    this.mutedChats.delete(chatId)
  }

  setChatMuted(chatId: number, muted: boolean) {
    const chats = this.store.getState<{ chatId: number; muted?: boolean }[]>('telegram_chats', [])
    this.store.setState(
      'telegram_chats',
      chats.map((chat) => (chat.chatId === chatId ? { ...chat, muted } : chat)),
    )
    if (muted) this.mutedChats.add(chatId)
    else this.mutedChats.delete(chatId)
  }

  /* ---- market data ----------------------------------------------------- */

  async refreshUniverse() {
    const types: InstType[] = ['SWAP', 'SPOT', 'FUTURES']
    const results = await Promise.allSettled(types.map((t) => fetchInstruments(t)))
    let count = 0
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const spec of r.value) {
        this.universe.set(spec.instId, spec)
        count++
      }
    }
    if (count) {
      this.universeLoadedAt = Date.now()
      log.info('universe', `${count} live instruments (${this.universe.size} cached)`)
    }
  }

  async refreshTickers() {
    const types: InstType[] = ['SWAP', 'SPOT', 'FUTURES']
    const results = await Promise.allSettled(types.map((t) => fetchTickers(t)))
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      for (const t of r.value) this.tickers.set(t.instId, t)
    }
  }

  async refreshMarketContext() {
    try {
      this.marketContext = await fetchMarketContext()
    } catch (err) {
      log.error('market-context', err instanceof Error ? err.message : String(err))
    }
  }

  async refreshCrossAsset() {
    try {
      this.crossAsset = await getCrossAssetData()
    } catch (err) {
      log.error('cross-asset', err instanceof Error ? err.message : String(err))
    }
  }

  async refreshOnChain() {
    try {
      this.onChain = await getOnChainData()
    } catch (err) {
      log.error('onchain', err instanceof Error ? err.message : String(err))
    }
  }

  async refreshOrderBook() {
    if (!this.settings.engineEnabled) return
    try {
      const snapshot = await fetchOrderBook(this.settings.instId)
      if (snapshot) this.orderBook.set(this.settings.instId, snapshot)
    } catch {
      /* graceful */
    }
  }

  refreshVolForecast() {
    try {
      const candles = candleStore.peek(this.settings.instId, this.settings.timeframe)
      if (!candles || candles.length < 30) return
      const returns = candles.slice(-100).map((c: Candle) => (c.close - c.open) / c.open)
      const atrPct = this.analyses.get(this.key(this.settings.instId, this.settings.timeframe))?.indicators?.volatility?.atrPct
      this.volForecast = forecastVolatility(returns, { atrPct })
    } catch {
      /* graceful */
    }
  }

  refreshRegime() {
    try {
      const analysis = this.analyses.get(this.key(this.settings.instId, this.settings.timeframe))
      if (!analysis?.indicators) return
      const i = analysis.indicators
      const features = {
        atrPct: i.volatility.atrPct,
        adx: i.trend.adx,
        rsi: i.momentum.rsi,
        return20: ((i.price - i.ma.ema21) / i.ma.ema21) * 100,
        volumeRatio: i.volume.volumeRatio,
        hurst: i.stats.hurst,
      }
      this.regimeDetector.update(features)
      this.regime = this.regimeDetector.classify(features)
    } catch {
      /* graceful */
    }
  }

  saveMetaPlaybook() {
    try {
      this.store.setState('meta_playbook', serializeMetaPlaybook(this.metaPlaybook))
    } catch {
      /* graceful */
    }
  }

  loadMetaPlaybook() {
    try {
      const json = this.store.getState<string | null>('meta_playbook', null)
      if (json) {
        const model = deserializeMetaPlaybook(json)
        if (model) this.metaPlaybook = model
      }
    } catch {
      /* graceful */
    }
  }

  async refreshAccount() {
    if (!HAS_OKX_KEYS || !this.settings.useAccountBalance) return
    try {
      const snap = await fetchAccount()
      if (snap) {
        this.account = snap
        if (snap.totalEquityUsd > 0) this.settings.equityUsd = snap.totalEquityUsd
      }
    } catch (err) {
      log.error('account', err instanceof Error ? err.message : String(err))
    }
  }

  private async derivatives(instId: string, instType: string): Promise<DerivativesBlock | null> {
    if (!this.settings.useDerivatives) return null
    if (instType === 'SPOT') return null
    const cached = this.derivCache.get(instId)
    if (cached && Date.now() - cached.at < 60_000) return cached.data
    try {
      const data = await fetchDerivatives(instId, (instType as InstType) ?? 'SWAP', this.tickers.get(instId)?.changePct24h ?? null)
      this.derivCache.set(instId, { at: Date.now(), data })
      return data
    } catch (err) {
      log.error('derivatives', `${instId}: ${err instanceof Error ? err.message : String(err)}`)
      return cached?.data ?? null
    }
  }

  syncSubscriptions() {
    const focus = this.settings.instId
    const instruments = [...new Set([focus, ...this.watchlist.map((w) => w.instId)])]
    this.stream.syncTickers(instruments.slice(0, 60))
    const pairs = instruments.slice(0, 12).map((instId) => ({
      instId,
      bars: instId === focus ? [this.settings.timeframe, this.settings.htfTimeframe] : [this.watchlist.find((w) => w.instId === instId)?.timeframe ?? this.settings.timeframe],
    }))
    this.stream.syncCandles(pairs)
  }

  /* ---- analysis -------------------------------------------------------- */

  engineSettings(instId: string, timeframe: string): EngineSettings {
    const s = this.settings
    const drySpell = this.drySpellFactor()
    return {
      ...DEFAULT_SETTINGS,
      instId,
      timeframe: normalizeBar(timeframe),
      htfTimeframe: normalizeBar(s.htfTimeframe),
      htf2Timeframe: normalizeBar(s.htf2Timeframe),
      strategy: s.strategy as EngineSettings['strategy'],
      riskPerTradePct: s.riskPerTradePct,
      leverage: s.leverage,
      rrRatio: s.rrRatio,
      minConfidence: Math.round(s.minConfidence * drySpell),
      minCompositeScore: Math.max(3, Math.round(s.minCompositeScore * drySpell)),
      requireMtfAlignment: s.requireMtfAlignment,
      usePatterns: s.usePatterns,
      useDerivatives: s.useDerivatives,
      useEmpiricalEdge: s.useEmpiricalEdge,
      takerFeeBps: s.takerFeeBps,
      maxOpenPositions: s.maxOpenPositions,
      maxDailyLossPct: s.maxDailyLossPct,
      useAccountBalance: s.useAccountBalance,
      maxAtrPct: s.maxAtrPct,
      minAdx: s.minAdx,
      weights: s.weights as EngineSettings['weights'],
      equityUsd: s.equityUsd,
      aiModel: s.ai.model,
    }
  }

  /**
   * If no trades have been armed in 2+ hours, progressively lower the gates so
   * the system can generate evidence. Without this, a tight-gate deadlock
   * prevents any trades from ever firing, so no learning can happen.
   *
   * Restoration is gradual: after a trade fires, gates ramp back up over 4 hours
   * (0.6 → 0.8 → 1.0) rather than snapping to 1.0 instantly. This prevents a
   * single lucky trade from re-locking the system if market conditions haven't
   * actually improved.
   *
   * Returns a multiplier < 1.0 during dry spells, 1.0 at full strength.
   */
  private drySpellFactor(): number {
    const lastArmedAt = this.store.getState<number>('last_trade_armed_at', 0)
    if (!lastArmedAt) {
      const factor = 0.6 // cold start: be permissive to bootstrap evidence
      if (this.lastDrySpellFactor !== factor) {
        log.info('gates', `cold start — gates at ${(factor * 100).toFixed(0)}% (conviction ≥ ${Math.round(this.settings.minConfidence * factor)}, composite ≥ ${Math.max(3, Math.round(this.settings.minCompositeScore * factor))})`)
        this.lastDrySpellFactor = factor
      }
      return factor
    }
    const elapsed = Date.now() - lastArmedAt
    let factor: number
    if (elapsed < 30 * 60_000) factor = 0.6 // first 30m after a trade: stay permissive to catch follow-through
    else if (elapsed < 1 * 60 * 60_000) factor = 0.8 // 30m-1h: ramping up
    else if (elapsed < 2 * 60 * 60_000) factor = 1.0 // 1-2h: full strength
    else if (elapsed < 4 * 60 * 60_000) factor = 0.7 // 2-4h dry: lowering
    else if (elapsed < 8 * 60 * 60_000) factor = 0.5 // 4-8h dry: lower
    else factor = 0.4 // 8h+ dry: very permissive to break the deadlock

    if (this.lastDrySpellFactor !== factor) {
      if (factor < 1.0) {
        log.info('gates', `dry-spell breaker active — gates at ${(factor * 100).toFixed(0)}% (conviction ≥ ${Math.round(this.settings.minConfidence * factor)}, composite ≥ ${Math.max(3, Math.round(this.settings.minCompositeScore * factor))})`)
      } else if (this.lastDrySpellFactor != null && this.lastDrySpellFactor < 1.0) {
        log.info('gates', `gates restored to 100% — conviction ≥ ${this.settings.minConfidence}, composite ≥ ${this.settings.minCompositeScore}`)
      }
      this.lastDrySpellFactor = factor
    }
    return factor
  }

  key(instId: string, timeframe: string) {
    return `${instId}|${normalizeBar(timeframe)}`
  }

  private consecutiveLosses(instId: string): number {
    const trades = this.store
      .listTrades(50, 'closed')
      .filter((t) => t.plan.instId === instId)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    let count = 0
    for (const t of trades) {
      if ((t.netRealizedR ?? 0) > 0) break
      count++
    }
    return count
  }

  private currentDrawdownR(instId: string): number {
    const trades = this.store
      .listTrades(100, 'closed')
      .filter((t) => t.plan.instId === instId)
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    let peak = 0
    let cumulative = 0
    let maxDD = 0
    for (const t of trades) {
      cumulative += t.netRealizedR ?? 0
      peak = Math.max(peak, cumulative)
      maxDD = Math.max(maxDD, peak - cumulative)
    }
    return maxDD
  }

  featureSnapshot(analysis: Analysis, playbookScore: number) {
    return buildFeatureVector({
      compositeScore: analysis.compositeScore,
      mtfAlignment: analysis.mtfAlignment,
      indicators: analysis.indicators,
      playbookScore,
      marketContext: analysis.marketContext,
      derivatives: analysis.derivatives,
      crossAsset: this.crossAsset,
      onChain: this.onChain,
      orderBook: this.orderBook.get(analysis.instId) ?? null,
      volForecast: this.volForecast,
      regime: this.regime,
    })
  }

  async analyzeInstrument(instIdRaw: string, timeframeRaw?: string, opts: { withAi?: boolean; silent?: boolean } = {}): Promise<Analysis | null> {
    const instId = this.resolveInstId(instIdRaw)
    if (!instId) return null
    const spec = this.universe.get(instId) ?? null
    const instType = spec?.instType ?? 'SWAP'
    const timeframe = normalizeBar(timeframeRaw ?? this.settings.timeframe)
    const [htf, htf2] = (() => {
      const auto = higherTimeframes(timeframe)
      const a = normalizeBar(this.settings.htfTimeframe)
      const b = normalizeBar(this.settings.htf2Timeframe)
      return [a === timeframe ? auto[0] : a, b === timeframe || b === a ? auto[1] : b]
    })()

    const [ltfC, htfC, htf2C] = await Promise.all([
      candleStore.ensure(instId, timeframe, 300),
      candleStore.ensure(instId, htf, 220),
      candleStore.ensure(instId, htf2, 160),
    ])

    const ticker = this.tickers.get(instId) ?? null
    const deriv = await this.derivatives(instId, instType)

    const analysis = analyze({
      instId,
      instType,
      spec,
      ltf: ltfC,
      htf: htfC,
      htf2: htf2C,
      derivatives: deriv,
      settings: this.engineSettings(instId, timeframe),
      livePrice: ticker?.last ?? null,
      volUsd24h: ticker?.volUsd24h ?? null,
      availableUsd: this.account?.availableUsdt ?? null,
      championModel: null,
      marketContext: this.marketContext,
      crossAsset: this.crossAsset,
      onChain: this.onChain,
      orderBook: this.orderBook.get(instId) ?? null,
      volForecast: this.volForecast,
      regimeInfo: this.regime,
    })
    this.counters.evaluations++

    const k = this.key(instId, timeframe)
    const prev = this.analyses.get(k) ?? null
    if (prev) this.previous.set(k, prev)

    const candidates = evaluateStrategies(analysis)
    this.latestCandidates.set(k, candidates)
    const selected =
      candidates.find((candidate) => candidate.eligible && candidate.side === analysis.decision) ??
      candidates.find((candidate) => candidate.side === (analysis.plan ?? analysis.shadowPlan)?.side) ??
      candidates[0]

    /* ---- mixture of experts: only qualified specialists get a vote ------ */
    if (selected && analysis.decision !== 'WAIT') {
      const features = this.featureSnapshot(analysis, selected.score)
      const verdict = this.evolution.verdict({ playbook: selected.playbook, instType, timeframe }, features)
      if (verdict) {
        this.latestVerdicts.set(k, verdict)
        const exactExpert = verdict.members.some((member) => member.trust === 1)
        if (analysis.plan) {
          const costR = analysis.plan.expectancyR - analysis.plan.netExpectancyR
          const trust = Math.min(0.75, verdict.confidence * (exactExpert ? 0.75 : 0.4))
          const blended = analysis.plan.winProbability * (1 - trust) + verdict.probability * trust
          analysis.plan.winProbability = blended
          analysis.plan.probabilityBasis = 'champion_calibrated_blend'
          analysis.plan.expectancyR = blended * analysis.plan.expectedRr - (1 - blended)
          analysis.plan.netExpectancyR = blended * (analysis.plan.expectedRr - costR) - (1 - blended) * (1 + costR)
        }
        // Only an EXACT-niche expert may veto. Adjacent experts can shrink size but
        // never silence a niche they were not trained on — the system must keep
        // generating evidence for niches it has not learned yet.
        if (verdict.consensus === 'skip' && exactExpert) {
          analysis.vetoes.push({
            id: 'committee_skip',
            reason: `specialist committee skip · p=${(verdict.probability * 100).toFixed(0)}% · ${verdict.agreement}/${verdict.totalMembers} agree`,
            severity: 'hard',
          })
          analysis.decision = 'WAIT'
        }
        analysis.narrative.push(
          `── Specialist committee (${verdict.totalMembers} expert${verdict.totalMembers === 1 ? '' : 's'}) ──`,
          `${verdict.consensus.toUpperCase()} · p=${(verdict.probability * 100).toFixed(1)}% · confidence ${(verdict.confidence * 100).toFixed(0)}% · size ×${verdict.sizeMultiplier.toFixed(2)}`,
          ...verdict.votes.slice(0, 4).map((vote) => `  • ${vote.displayName} G${vote.generation} → ${(vote.probability * 100).toFixed(0)}% (weight ${vote.weight.toFixed(2)})`),
        )
        const primary = verdict.members.find((member) => member.trust === 1) ?? verdict.members[0]
        if (primary) {
          try {
            this.explanation = explainPrediction(primary.artifact.model, applyMask(features, primary.artifact.featureMask), [...FEATURE_ORDER])
          } catch {
            /* feature schema mismatch */
          }
        }
      } else {
        this.latestVerdicts.delete(k)
      }

      if (this.anomalyModel) {
        const anomaly = detectAnomaly(this.anomalyModel, features)
        this.anomalyResult = anomaly
        if (anomaly.action === 'skip') {
          analysis.vetoes.push({ id: 'anomaly_skip', reason: `unseen market conditions: ${anomaly.reason}`, severity: 'hard' })
          analysis.decision = 'WAIT'
        } else if (anomaly.action === 'reduce') {
          analysis.vetoes.push({ id: 'anomaly_reduce', reason: `unusual conditions: ${anomaly.reason}`, severity: 'soft' })
        }
      }

      if (analysis.plan) {
        const verdictSize = verdict?.sizeMultiplier ?? 1
        this.kellyResult = computeKellySize({
          winProbability: analysis.plan.winProbability,
          avgWinR: analysis.plan.expectedRr ?? 2,
          avgLossR: 1,
          uncertainty: estimateUncertainty(analysis.plan.winProbability),
          regimeMultiplier: (this.regime?.sizeMultiplier ?? 1) * (verdictSize > 0 ? verdictSize : 1),
          consecutiveLosses: this.consecutiveLosses(instId),
          currentDrawdownR: this.currentDrawdownR(instId),
          maxDrawdownR: this.settings.evolution.rollbackMaxDrawdownR,
          volForecast: this.volForecast?.normalized ?? 0.5,
        })
      }
    }

    /* ---- optional AI narrative, strictly budget-gated ------------------ */
    const ai = this.settings.ai
    const aiUsage = this.store.aiUsageThisMonth()
    const hardVeto = analysis.vetoes.some((v) => v.severity === 'hard')
    const wantAi =
      (opts.withAi ?? true) &&
      ai.enabled &&
      aiUsage.spend < Math.max(0, this.settings.aiMonthlyBudgetEur) &&
      this.gemini.configured &&
      analysis.decision !== 'WAIT' &&
      analysis.conviction >= ai.minConvictionToAsk &&
      !hardVeto
    if (wantAi && (Date.now() - (this.aiCooldown.get(k) ?? 0) > Math.max(ai.cooldownMs, 15_000) || opts.withAi === true)) {
      try {
        this.aiCooldown.set(k, Date.now())
        const opinion = await this.gemini.decide(analysis, ai)
        if (opinion) {
          analysis.ai = opinion
          this.store.recordAiUsage(opinion.model, opinion.tokensIn, opinion.tokensOut, (opinion.tokensIn * 0.3 + opinion.tokensOut * 2.5) / 1_000_000)
        }
      } catch (err) {
        this.counters.errors++
        log.error('gemini', err instanceof Error ? err.message : String(err), { instId, timeframe })
      }
    }

    if (this.regime) {
      analysis.narrative.push(`── Regime: ${this.regime.label} (${(this.regime.confidence * 100).toFixed(0)}% confidence, ×${this.regime.sizeMultiplier} size) ──`)
    }

    this.analyses.set(k, analysis)
    if (!opts.silent) await this.postAnalysis(analysis, prev, selected, instType)
    return analysis
  }

  /* ---- alerting + arming ---------------------------------------------- */

  private async postAnalysis(a: Analysis, prev: Analysis | null, selected: StrategyCandidate | undefined, instType: string) {
    const inWatchlist = this.watchlist.some((w) => w.instId === a.instId)
    const ticker = this.tickers.get(a.instId)
    const candidates: AlertCandidate[] = []

    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (!scopeMatches(rule, a.instId, inWatchlist)) continue
      if (rule.timeframe && rule.timeframe !== 'any' && normalizeBar(rule.timeframe) !== a.timeframe) continue
      if (Date.now() - rule.lastFiredAt < rule.cooldownMs) continue
      const hit = evaluateRule(rule, { analysis: a, previous: prev, changePct24h: ticker?.changePct24h ?? null, volUsd24h: ticker?.volUsd24h ?? null, inWatchlist })
      if (hit) candidates.push(hit)
    }

    for (const c of candidates) {
      const last = this.lastAlertAt.get(c.fingerprint) ?? 0
      if (Date.now() - last < 10 * 60_000) continue
      this.lastAlertAt.set(c.fingerprint, Date.now())
      this.counters.alerts++
      let delivered = false
      if (c.telegram && this.shouldNotify(a, c)) {
        const html = c.type === 'signal' ? signalCard(a) : alertCard({ ...c, analysis: c.severity === 'opportunity' ? a : null })
        delivered = (await this.bot.broadcast(this.activeChats(), html)) > 0
      }
      log.alert('alerts', `${c.title} — ${c.message}`, { instId: a.instId, timeframe: a.timeframe })
      this.store.recordAlert({
        ruleId: c.ruleId,
        ruleName: c.ruleName,
        type: c.type,
        severity: c.severity,
        instId: c.instId,
        timeframe: c.timeframe,
        title: c.title,
        message: c.message,
        decision: c.decision,
        conviction: c.conviction,
        price: c.price,
        telegramDelivered: delivered,
        ts: Date.now(),
      })
      if (c.ruleId) {
        const rule = this.rules.find((r) => r._id === c.ruleId)
        if (rule) {
          rule.lastFiredAt = Date.now()
          rule.firedCount++
          this.store.setState('alert_rules', this.rules)
        }
      }
    }

    await this.maybeArm(a, selected, instType)
  }

  private async maybeArm(a: Analysis, selected: StrategyCandidate | undefined, instType: string) {
    const featureTime = a.generatedAt - Math.max(0, a.dataQuality.staleMs)
    const decisionId = `${a.instId}:${a.timeframe}:${featureTime}`
    const verdict = this.latestVerdicts.get(this.key(a.instId, a.timeframe)) ?? null
    const modelVersion = selected ? this.evolution.primaryModelVersion({ playbook: selected.playbook, instType, timeframe: a.timeframe }) : 'deterministic-playbook'
    this.store.recordDecision(decisionId, a, POLICY_VERSION, modelVersion)

    for (const candidate of this.latestCandidates.get(this.key(a.instId, a.timeframe)) ?? []) {
      this.store.recordCandidate({
        id: `${decisionId}:${candidate.playbook}:${candidate.side}`,
        observedAt: a.generatedAt,
        instId: a.instId,
        timeframe: a.timeframe,
        playbook: candidate.playbook,
        side: candidate.side,
        eligible: candidate.eligible,
        reasons: candidate.rejectionReasons,
        policyVersion: POLICY_VERSION,
        featureTime,
        latestSourceTime: featureTime,
        availableAt: a.generatedAt,
        payload: candidate,
      })
    }

    if (this.paperKillSwitch) return
    if (a.decision === 'WAIT' || !a.plan) return
    const drySpell = this.drySpellFactor()
    if (a.conviction < Math.round(this.settings.minConfidence * drySpell) || a.plan.netExpectancyR <= 0) return
    if (a.vetoes.some((v) => v.severity === 'hard')) return
    if (!selected || !selected.eligible || selected.side !== a.decision) return

    const active = [...this.paperTrades.values()].filter((trade) => trade.status === 'pending' || trade.status === 'open')
    if (active.some((trade) => trade.plan.instId === a.instId && trade.plan.timeframe === a.timeframe && trade.plan.side === a.decision)) return

    const features = this.featureSnapshot(a, selected.score)
    const plan = createPaperPlan({
      id: `paper:${decisionId}:${selected.playbook}`,
      instId: a.instId,
      timeframe: a.timeframe,
      signalAt: a.generatedAt,
      playbook: selected.playbook,
      policyVersion: POLICY_VERSION,
      modelVersion,
      plan: a.plan,
      atrAtEntry: a.indicators.volatility.atr,
      feeBps: this.settings.takerFeeBps,
      fundingRate8h: a.derivatives?.fundingRate ?? undefined,
      instType,
      features,
      featureSchema: FEATURE_SCHEMA,
      committee: verdict
        ? {
            probability: verdict.probability,
            confidence: verdict.confidence,
            consensus: verdict.consensus,
            agreement: verdict.agreement,
            totalMembers: verdict.totalMembers,
            sizeMultiplier: verdict.sizeMultiplier,
            votes: verdict.votes.map((vote) => ({ id: vote.id, displayName: vote.displayName, generation: vote.generation, probability: vote.probability, weight: vote.weight })),
          }
        : null,
    })

    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const realizedDailyR = this.store
      .listTrades(1000)
      .filter((trade) => (trade.closedAt ?? 0) >= today.getTime())
      .reduce((sum, trade) => sum + trade.netRealizedR, 0)
    const risk = assessPaperRisk(
      plan,
      {
        equityUsd: this.settings.equityUsd,
        openRiskUsd: active.reduce((sum, trade) => sum + trade.plan.riskUsd * trade.remaining, 0),
        openNotionalUsd: active.reduce((sum, trade) => sum + trade.plan.quantity * trade.plan.entry * trade.remaining, 0),
        realizedDailyR,
        openTrades: active,
      },
      {
        ...DEFAULT_RISK_POLICY,
        maxOpenPositions: this.settings.maxOpenPositions,
        maxDailyLossR: this.settings.maxDailyLossPct,
        maxOpenRiskPct: this.settings.maxOpenRiskPct,
        maxGrossExposurePct: this.settings.maxGrossExposurePct,
      },
    )

    const trade = submitPaperPlan(plan)
    if (!risk.allowed) {
      trade.status = 'rejected'
      trade.exitReason = 'risk_rejected'
      trade.closedAt = Date.now()
      trade.events.push({ at: Date.now(), type: 'rejected', detail: risk.reasons.join(', ') })
      this.store.saveTrade(trade)
      this.evolution.recordOutcome(trade, undefined, { instType, playbook: selected.playbook })
      this.store.setState('last_risk_decision', risk)
      return
    }

    this.paperTrades.set(trade.id, trade)
    this.counters.signals++
    this.store.saveTrade(trade)
    this.store.setState('last_risk_decision', risk)
    this.store.setState('last_trade_armed_at', Date.now())
    log.signal('paper', `armed ${a.decision} ${a.instId} ${a.timeframe} · ${selected.playbook} · p=${(a.plan.winProbability * 100).toFixed(0)}%`, { instId: a.instId, timeframe: a.timeframe })

    await this.mirrorToDemo(trade, instType, selected.playbook, verdict)
  }

  private async mirrorToDemo(trade: PaperTrade, instType: string, playbook: string, verdict: CommitteeVerdict | null) {
    if (!this.settings.execution.okxDemoEnabled || !this.demo.configured) return
    if (!this.settings.execution.demoInstTypes.includes(instType as 'SPOT' | 'SWAP')) return
    if (instType === 'SPOT' && trade.plan.side === 'SHORT') return
    if (this.evolution.store.openOrders().length >= this.settings.execution.maxConcurrentDemoOrders) return
    const spec = this.universe.get(trade.plan.instId)
    if (!spec) return
    const result = await this.demo.placeBracket(trade, spec, this.settings.execution.demoSizeMultiplier)
    if (result.ok) this.counters.demoOrders++
    if (this.settings.telegram.enabled && this.settings.telegram.orderCards) {
      await this.bot.broadcast(
        this.activeChats(),
        orderCard({
          kind: result.ok ? 'placed' : 'rejected',
          instId: trade.plan.instId,
          side: trade.plan.side,
          timeframe: trade.plan.timeframe,
          playbook,
          px: result.px ?? trade.plan.entry,
          sz: result.sz,
          reason: result.reason,
          modelName: verdict?.votes[0]?.displayName ?? null,
          probability: verdict?.probability ?? null,
        }),
      )
    }
  }

  private shouldNotify(a: Analysis, c: AlertCandidate) {
    const t = this.settings.telegram
    if (!t.enabled || !this.bot.configured) return false
    if (c.type === 'signal' && !t.signalCards) return false
    if (t.onlyWatchlist && !this.watchlist.some((w) => w.instId === a.instId)) return false
    if (c.type === 'signal' && a.conviction < t.minConviction) return false
    if (t.quietHoursStart !== t.quietHoursEnd) {
      const hour = new Date().getUTCHours()
      const inQuiet = t.quietHoursStart < t.quietHoursEnd ? hour >= t.quietHoursStart && hour < t.quietHoursEnd : hour >= t.quietHoursStart || hour < t.quietHoursEnd
      if (inQuiet && c.severity !== 'critical') return false
    }
    return true
  }

  activeChats() {
    return this.chats.filter((c) => !this.mutedChats.has(c))
  }

  /* ---- loops ----------------------------------------------------------- */

  private async focusLoop() {
    if (!this.settings.engineEnabled) return
    await this.analyzeInstrument(this.settings.instId, this.settings.timeframe)
  }

  private async watchLoop() {
    if (!this.settings.engineEnabled || !this.watchlist.length) return
    const w = this.watchlist[this.watchCursor % this.watchlist.length]
    this.watchCursor++
    if (!w) return
    await this.analyzeInstrument(w.instId, w.timeframe || this.settings.timeframe)
  }

  private async scanLoop() {
    const cfg = this.settings.scanner
    if (!cfg.enabled || !this.settings.engineEnabled || this.scan.running) return
    if (Date.now() - this.scan.at < cfg.intervalMs) return
    this.scan.running = true
    const started = Date.now()
    try {
      const targets = this.scanTargets()
      const rows: ScanRow[] = []
      await Promise.all(
        targets.map((t) =>
          this.limiter.run(async () => {
            try {
              const candles = await candleStore.ensure(t.instId, cfg.timeframe, 260)
              if (candles.length < 90) return
              const q = quickScore(candles, cfg.timeframe)
              rows.push({
                ...q,
                instId: t.instId,
                instType: t.instType,
                isEquity: isEquityInstrument(t.instId),
                volUsd24h: t.volUsd24h,
                changePct24h: t.changePct24h,
                spreadBps: t.spreadBps,
                scannedAt: Date.now(),
              })
            } catch {
              /* one instrument failing must not kill the scan */
            }
          }),
        ),
      )
      rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      this.scan = { at: Date.now(), scanned: rows.length, rows, running: false }
      log.scan('scanner', `${rows.length}/${targets.length} scored in ${((Date.now() - started) / 1000).toFixed(1)}s · best ${rows.slice(0, 3).map((r) => `${r.instId} ${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}`).join(', ')}`)

      // Run the FULL pipeline on the strongest scanner candidates so opportunity is
      // not limited to the manually watched list.
      for (const row of rows.filter((row) => Math.abs(row.score) >= 35).slice(0, 4)) {
        await this.analyzeInstrument(row.instId, cfg.timeframe, { withAi: false })
      }
    } finally {
      this.scan.running = false
    }
  }

  scanTargets() {
    const cfg = this.settings.scanner
    const wanted = new Set(cfg.instTypes.map((t) => t.toUpperCase()))
    const out = [...this.tickers.values()]
      .filter((t) => wanted.has(t.instType))
      .filter((t) => (cfg.quoteCcy ? t.instId.includes(`-${cfg.quoteCcy}`) : true))
      .filter((t) => t.volUsd24h >= cfg.minVol24hUsd)
      .filter((t) => (cfg.includeEquities ? true : !isEquityInstrument(t.instId)))
      .filter((t) => this.universe.has(t.instId))
      .sort((a, b) => b.volUsd24h - a.volUsd24h)
      .slice(0, Math.max(5, Math.min(cfg.universeSize, 300)))
    for (const w of this.watchlist) {
      if (!out.some((t) => t.instId === w.instId)) {
        const t = this.tickers.get(w.instId)
        if (t) out.push(t)
      }
    }
    return out
  }

  private async paperLoop() {
    for (const [id, existing] of this.paperTrades) {
      if (existing.status !== 'pending' && existing.status !== 'open') continue
      const candles = candleStore.peek(existing.plan.instId, existing.plan.timeframe) ?? (await candleStore.ensure(existing.plan.instId, existing.plan.timeframe, 300))
      let trade = existing
      let changed = false
      for (const candle of candles) {
        const result = processPaperBar(trade, candle)
        trade = result.trade
        changed ||= result.changed
        if (trade.status === 'closed' || trade.status === 'expired' || trade.status === 'rejected') break
      }
      if (!changed) continue
      this.paperTrades.set(id, trade)
      this.store.saveTrade(trade)
      if (trade.status !== 'closed' && trade.status !== 'expired') continue

      const playbook = trade.plan.playbook
      const instType = trade.plan.instType ?? this.universe.get(trade.plan.instId)?.instType ?? 'SWAP'
      // THE fix: learn from the frozen decision-time snapshot, never from now.
      const attribution = this.evolution.recordOutcome(trade, trade.plan.features, {
        instType,
        playbook,
        winProbability: trade.plan.committee?.probability ?? null,
      })
      log.signal(
        'paper',
        `${trade.plan.instId} ${trade.plan.side} ${trade.exitReason} ${trade.netRealizedR >= 0 ? '+' : ''}${trade.netRealizedR.toFixed(2)}R · ${attribution.reasonCode}`,
        { instId: trade.plan.instId, timeframe: trade.plan.timeframe },
      )
      if (this.regime) recordPlaybookOutcome(this.metaPlaybook, playbook, this.regime.id, trade.netRealizedR > 0, trade.netRealizedR)
      if (this.demo.configured) await this.demo.cancelForTrade(trade.id)
      if (this.settings.telegram.enabled && this.settings.telegram.orderCards) {
        await this.bot.broadcast(
          this.activeChats(),
          orderCard({
            kind: 'closed',
            instId: trade.plan.instId,
            side: trade.plan.side,
            timeframe: trade.plan.timeframe,
            playbook,
            netR: trade.netRealizedR,
            reason: `${attribution.reasonCode} — ${attribution.detail}`,
            modelName: trade.plan.committee?.votes[0]?.displayName ?? null,
            probability: trade.plan.committee?.probability ?? null,
          }),
        )
      }
      this.paperTrades.delete(id)
    }
  }

  private async demoLoop() {
    if (!this.demo.configured) return
    await this.demo.sync()
    await this.demo.refreshBalance()
  }

  private maintenanceLoop() {
    const keep = new Set([this.settings.instId, ...this.watchlist.map((row) => row.instId)])
    candleStore.evict(keep)
    // 400 GB of disk is available: keep two years of bars, they are the raw material
    // for every future backtest. Only prune harder when the volume is genuinely tight.
    const disk = diskUsage()
    const tight = disk.freeBytes != null && disk.freeBytes < 20e9
    this.store.pruneCandles(Date.now() - (tight ? 365 : 730) * 24 * 60 * 60_000)
    this.store.checkpoint()
  }

  private async backupLoop() {
    try {
      const destination = backupFileName()
      const result = await this.store.backup(destination)
      const pruned = pruneBackups(12)
      log.info('backup', `snapshot ${destination.split('/').pop()} (${result.pages} pages), pruned ${pruned} old snapshot(s)`)
    } catch (error) {
      log.error('backup', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Keep the evidence base growing. On a cold volume this bootstraps ~1000 real
   * point-in-time samples within minutes; afterwards it only tops up the tail.
   */
  private async harvestLoop() {
    if (!this.settings.engineEnabled || !this.settings.evolution.enabled) return
    if (this.harvester.progress.running) return
    const total = this.evolution.store.sampleTotal()
    const cold = total < this.settings.evolution.minNicheSamples * 8
    const last = this.store.getState<{ at?: number }>('harvest_last', {})
    if (!cold && Date.now() - (last.at ?? 0) < 4 * 60 * 60_000) return
    log.info('harvest', cold ? `cold start (${total} samples) — bootstrapping the evidence base` : 'scheduled top-up')
    await this.harvester.run({ perType: cold ? 8 : 4, timeframes: cold ? ['15m', '30m', '1H'] : ['15m', '30m', '1H'], barsPerSymbol: cold ? 1200 : 600, maxWallMs: cold ? 10 * 60_000 : 4 * 60_000 })
  }

  /** The self-improvement heartbeat: evolve, promote, roll back, refit anomaly. */
  private evolutionLoop() {
    if (!this.settings.engineEnabled || !this.settings.evolution.enabled) return
    this.evolution.lifecycle(this.settings)
    const eligible = this.evolution.eligibleNiches(this.settings)
    if (eligible.length) {
      // One niche per tick keeps the CPU budget predictable on an 8 GB mini PC.
      const target = eligible[0]
      log.info('evolution', `evolving ${nicheKey(target.niche)} · ${target.samples} samples (+${target.newSamples} new)`)
      this.evolution.evolveOne(target.niche, this.settings)
    }
    const samples = this.evolution.store.listSamples({ limit: 2000 })
    if (samples.length >= 60) this.anomalyModel = fitAnomalyModel(samples.map((row) => row.features), [...FEATURE_ORDER])
  }

  private async autoResearchLoop() {
    if (!this.settings.engineEnabled || !this.settings.autoResearchEnabled) return
    const state = this.store.researchState()
    const latest = state.campaigns.reduce((max, campaign) => Math.max(max, Number(campaign.created_at ?? 0)), 0)
    if (latest && Date.now() - latest < Math.max(1, this.settings.researchIntervalHours) * 60 * 60_000) return
    if (!this.research.governor().allowed) return

    // Evidence first: if the failure histogram is telling us something, test THAT.
    const evidence = hypothesisFromAttribution(this.evolution.store.attributionSummary())
    const campaignTypes: CampaignType[] = ['baseline', 'spot_swap', 'multi_symbol', 'triple_barrier', 'feature_rich', 'high_conviction', 'low_conviction', 'regime_aware', 'timeframe_sweep']
    const recent = state.campaigns
      .slice(0, 8)
      .map((c) => (c.manifest as Record<string, unknown>)?.campaignType as string | undefined)
      .filter(Boolean) as string[]
    const nextType = (evidence?.campaignType as CampaignType | undefined) ?? campaignTypes.find((t) => !recent.includes(t)) ?? 'baseline'

    log.info('research', `campaign ${nextType}${evidence ? ` triggered by ${evidence.reasonCode}` : ' (scheduled rotation)'}`)
    const result = await this.research.run({ type: nextType, hypothesis: evidence?.hypothesis })
    log.info('research', `${nextType} ${result.status}: ${result.samplesEmitted} historical samples harvested · ${result.validationState}`)
  }

  /* ---- telegram reporting --------------------------------------------- */

  private async reportLoop() {
    if (!this.bot.configured || !this.settings.telegram.enabled) return
    const chats = this.activeChats()
    if (!chats.length) return
    const now = new Date()

    if (this.settings.telegram.heartbeatHours > 0) {
      const last = this.store.getState<number>('last_heartbeat_at', 0)
      if (Date.now() - last > this.settings.telegram.heartbeatHours * 60 * 60_000) {
        this.store.setState('last_heartbeat_at', Date.now())
        const today = this.todayStats()
        await this.bot.broadcast(
          chats,
          heartbeatCard({
            uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
            samples: this.evolution.store.sampleTotal(),
            championCount: this.evolution.store.listByLifecycle('champion').length,
            openTrades: this.store.loadActiveTrades().length,
            closedToday: today.closed,
            sumRToday: today.sumR,
            validationState: this.evolution.snapshot().validationState,
            wsHealthy: this.stream.health().public.healthy,
          }),
        )
      }
    }

    if (this.settings.telegram.dailyDigest && now.getUTCHours() === this.settings.telegram.digestHourUtc) {
      const key = `digest:${now.toISOString().slice(0, 10)}`
      if (this.store.getState<string>('last_digest_key', '') !== key) {
        this.store.setState('last_digest_key', key)
        await this.bot.broadcast(chats, digestCard(this.digestInput()))
      }
    }
  }

  private todayStats() {
    const start = new Date()
    start.setUTCHours(0, 0, 0, 0)
    const trades = this.store.listTrades(2000, 'closed').filter((trade) => (trade.closedAt ?? 0) >= start.getTime())
    return {
      closed: trades.length,
      sumR: trades.reduce((sum, trade) => sum + trade.netRealizedR, 0),
      wins: trades.filter((trade) => trade.netRealizedR > 0).length,
    }
  }

  digestInput() {
    const snapshot = this.evolution.snapshot()
    const disk = diskUsage()
    const paper = this.store.paperStats()
    const demo = this.demo.health()
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      engineEnabled: this.settings.engineEnabled,
      instruments: this.universe.size,
      samples: snapshot.summary.samples,
      specialists: snapshot.summary.specialists,
      championCount: snapshot.summary.champions,
      validationState: snapshot.validationState,
      paper: { total: paper.total, closed: paper.closed, open: paper.open, winRate: paper.winRate, avgR: paper.avgR, sumR: paper.sumR },
      today: this.todayStats(),
      champions: snapshot.specialists
        .filter((row) => row.lifecycle === 'champion')
        .map((row) => ({ displayName: row.displayName, nicheKey: row.nicheKey, generation: row.generation, liveTrades: row.liveTrades, liveMeanR: row.liveMeanR })),
      attribution: snapshot.attribution,
      demo: { configured: demo.configured, reason: demo.reason, placed: demo.placed, filled: demo.filled, rejected: demo.rejected, equityUsd: demo.equityUsd },
      aiSpendEur: this.store.aiUsageThisMonth().spend,
      aiBudgetEur: this.settings.aiMonthlyBudgetEur,
      diskFreeGb: disk.freeBytes != null ? disk.freeBytes / 1e9 : null,
    }
  }

  private async telemetryLoop() {
    if (!ENV.convexMirror) return
    const health = this.stream.health()
    await convex.ping('engine', this.settings.engineEnabled ? 'online' : 'degraded', `${this.settings.instId} ${this.settings.timeframe} · ${this.universe.size} instruments`, {
      evaluations: this.counters.evaluations,
      alerts: this.counters.alerts,
      errors: this.counters.errors,
      wsMessages: this.counters.wsMessages,
      restCalls: restStats.calls,
    })
    await convex.ping('okx_ws', health.public.healthy ? 'online' : 'degraded', `public ${health.public.subs} subs / business ${health.business.subs} subs`)
  }

  /* ---- symbol resolution ---------------------------------------------- */

  resolveInstId(input: string): string | null {
    if (!input) return null
    const raw = input.trim().toUpperCase()
    if (this.universe.has(raw)) return raw
    if (this.universe.size === 0) return raw.includes('-') ? raw : `${raw}-USDT-SWAP`
    for (const c of [`${raw}-USDT-SWAP`, `${raw}-USDT`, `${raw}-USDC-SWAP`, `${raw}-USD-SWAP`]) if (this.universe.has(c)) return c
    const partial = [...this.universe.keys()].find((k) => k.startsWith(`${raw}-`))
    if (partial) return partial
    return [...this.universe.keys()].find((k) => k.replace(/-/g, '').includes(raw.replace(/-/g, ''))) ?? null
  }

  searchUniverse(query: string, instType?: string, limit = 40) {
    const q = query.trim().toUpperCase()
    const rows = [...this.universe.values()]
      .filter((s) => (instType && instType !== 'ALL' ? s.instType === instType : true))
      .filter((s) => (q ? s.instId.includes(q) || s.baseCcy.toUpperCase().includes(q) : true))
      .map((s) => {
        const t = this.tickers.get(s.instId)
        return {
          instId: s.instId,
          instType: s.instType,
          baseCcy: s.baseCcy,
          quoteCcy: s.quoteCcy,
          isEquity: s.isEquity,
          maxLever: s.maxLever,
          tickSz: s.tickSz,
          ctVal: s.ctVal,
          last: t?.last ?? null,
          changePct24h: t?.changePct24h ?? null,
          volUsd24h: t?.volUsd24h ?? null,
          spreadBps: t?.spreadBps ?? null,
        }
      })
      .sort((a, b) => (b.volUsd24h ?? 0) - (a.volUsd24h ?? 0))
    return { total: rows.length, rows: rows.slice(0, Math.min(limit, 300)) }
  }

  /* ---- telegram commands ---------------------------------------------- */

  async handleCommand(ctx: { chatId: number; from: { id: number; firstName?: string; username?: string }; command: string; args: string[] }): Promise<string | null> {
    const { command, args, chatId } = ctx
    switch (command) {
      case 'start': {
        this.registerChat(chatId, ctx.from.firstName, ctx.from.username)
        log.info('telegram', `chat ${chatId} registered (${ctx.from.firstName ?? 'unknown'})`)
        return `\u{1F44B} <b>Welcome ${ctx.from.firstName ?? 'trader'}</b>\nThis chat now receives live OKX decisions, demo order cards and evolution events.\n\n${HELP}`
      }
      case 'help':
        return HELP
      case 'status':
        return this.statusHtml()
      case 'digest':
        return digestCard(this.digestInput())
      case 'models': {
        const rows = this.evolution.snapshot().specialists.filter((row) => row.lifecycle === 'champion' || row.lifecycle === 'canary')
        if (!rows.length) return 'No specialist has been born yet. The system is still collecting evidence — that is the honest state, not a failure.'
        return `\u{1F9EC} <b>Live specialists</b>\n<pre>${rows
          .map((row) => `${row.displayName.padEnd(18).slice(0, 18)} G${row.generation} ${row.lifecycle.padEnd(8)} ${row.nicheKey} ${row.liveTrades}t ${row.liveMeanR == null ? '—' : `${row.liveMeanR >= 0 ? '+' : ''}${row.liveMeanR.toFixed(2)}R`}`)
          .join('\n')}</pre>`
      }
      case 'settings': {
        const s = this.settings
        return `\u{2699} <b>Configuration</b>\n<pre>focus       ${s.instId} ${s.timeframe} (HTF ${s.htfTimeframe}/${s.htf2Timeframe})\nstrategy    ${s.strategy}\nrisk        ${s.riskPerTradePct}% of ${fmtUsd(s.equityUsd)} · max ${s.leverage}x · min ${s.rrRatio}R\ngates       conviction \u2265 ${s.minConfidence} · composite \u2265 ${s.minCompositeScore} · ADX \u2265 ${s.minAdx}\nevolution   ${s.evolution.enabled ? `on · pop ${s.evolution.populationSize} \u00D7 ${s.evolution.generations} gens · placebo ${s.evolution.placebo ? 'on' : 'off'}` : 'off'}\ndemo orders ${s.execution.okxDemoEnabled ? (this.demo.configured ? 'live' : `blocked: ${this.demo.blockReason}`) : 'off'}\nscanner     ${s.scanner.enabled ? `${s.scanner.instTypes.join('/')} top ${s.scanner.universeSize}` : 'off'}\nsaved       ${this.settingsSavedAt ? new Date(this.settingsSavedAt).toISOString() : 'defaults'}</pre>`
      }
      case 'mute':
        this.setChatMuted(chatId, true)
        return '\u{1F507} Muted. Send /unmute to resume.'
      case 'unmute':
        this.setChatMuted(chatId, false)
        return '\u{1F514} Alerts resumed.'
      case 'a':
      case 'analyze': {
        if (!args.length) return 'Usage: <code>/analyze BTC 15m</code>'
        const instId = this.resolveInstId(args[0])
        if (!instId) return `Unknown instrument <code>${args[0]}</code>.`
        const a = await this.analyzeInstrument(instId, args[1], { withAi: true, silent: true })
        return a ? signalCard(a) : 'Analysis failed — not enough data for that instrument.'
      }
      case 'watch': {
        if (!args.length) return 'Usage: <code>/watch SOL 1H</code>'
        const instId = this.resolveInstId(args[0])
        if (!instId) return `Unknown instrument <code>${args[0]}</code>.`
        this.addWatch(instId, this.universe.get(instId)?.instType ?? 'SWAP', normalizeBar(args[1] ?? this.settings.timeframe))
        this.syncSubscriptions()
        return `\u{1F440} Watching <code>${instId}</code>.`
      }
      case 'unwatch': {
        if (!args.length) return 'Usage: <code>/unwatch SOL</code>'
        const instId = this.resolveInstId(args[0])
        if (!instId) return `Unknown instrument <code>${args[0]}</code>.`
        this.removeWatch(instId)
        this.syncSubscriptions()
        return `Removed <code>${instId}</code>.`
      }
      case 'list': {
        if (!this.watchlist.length) return 'Watchlist is empty. Add one with <code>/watch BTC 15m</code>.'
        return `\u{1F440} <b>Watchlist</b>\n<pre>${this.watchlist
          .map((w) => {
            const a = this.analyses.get(this.key(w.instId, w.timeframe || this.settings.timeframe))
            const t = this.tickers.get(w.instId)
            return `${w.instId} ${w.timeframe} — ${a ? `${a.decision} ${a.conviction.toFixed(0)}/100` : 'warming up'} · ${fmtPrice(t?.last ?? 0)} ${t ? fmtPct(t.changePct24h, 1) : ''}`
          })
          .join('\n')}</pre>`
      }
      case 'scan': {
        if (!this.scan.rows.length) return 'No scan yet — give the engine a minute.'
        return `\u{1F50E} <b>Best setups</b> (${this.scan.scanned} scanned)\n<pre>${this.scan.rows
          .slice(0, 10)
          .map((r) => `${r.instId.padEnd(18)} ${(r.score > 0 ? '+' : '') + r.score.toFixed(0).padStart(4)} ${r.bias.padEnd(8)} RSI ${r.rsi.toFixed(0).padStart(3)}`)
          .join('\n')}</pre>`
      }
      case 'why': {
        const summary = this.evolution.store.attributionSummary()
        if (!summary.length) return 'No closed trades yet.'
        return `\u{1F50D} <b>Why trades ended</b> (30d)\n<pre>${summary
          .map((row) => `${String(row.count).padStart(4)} ${row.meanR >= 0 ? '+' : ''}${row.meanR.toFixed(2)}R  ${REASON_LABELS[row.reasonCode as ReasonCode] ?? row.reasonCode}`)
          .join('\n')}</pre>`
      }
      default:
        return `Unknown command <code>/${command}</code>.\n\n${HELP}`
    }
  }

  statusHtml() {
    const health = this.stream.health()
    const ai = this.gemini.stats()
    const stats = candleStore.stats()
    return statusCard({
      engineEnabled: this.settings.engineEnabled,
      instId: this.settings.instId,
      timeframe: this.settings.timeframe,
      universe: this.universe.size,
      watchlist: this.watchlist.length,
      series: stats.series,
      bars: stats.bars,
      ws: { public: health.public.healthy, business: health.business.healthy, subs: health.public.subs + health.business.subs },
      rest: { calls: restStats.calls, errors: restStats.errors, avgLatencyMs: restStats.avgLatencyMs },
      ai: { configured: ai.configured, calls: ai.calls, cacheHits: ai.cacheHits, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, model: this.settings.ai.model },
      convex: ENV.convexMirror ? `${convex.health.status} · mirror` : 'disabled (SQLite is truth)',
      scanner: { lastRunAt: this.scan.at, scanned: this.scan.scanned, top: this.scan.rows.slice(0, 5).map((r) => `${r.instId} ${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}`) },
      equityUsd: this.settings.equityUsd,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      alerts24h: this.counters.alerts,
    })
  }

  health() {
    const wsHealth = this.stream.health()
    const aiUsage = this.store.aiUsageThisMonth()
    const snapshot = this.evolution.snapshot()
    const disk = diskUsage()
    return {
      ok: true,
      startedAt: this.startedAt,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      engineEnabled: this.settings.engineEnabled,
      focus: { instId: this.settings.instId, timeframe: this.settings.timeframe },
      universe: { instruments: this.universe.size, tickers: this.tickers.size, loadedAt: this.universeLoadedAt },
      memory: candleStore.stats(),
      ws: wsHealth,
      rest: { ...restStats },
      ai: { ...this.gemini.stats(), monthlySpendEur: aiUsage.spend, monthlyBudgetEur: this.settings.aiMonthlyBudgetEur, budgetBlocked: aiUsage.spend >= this.settings.aiMonthlyBudgetEur },
      telegram: { ...this.bot.stats(), chats: this.chats.length, muted: this.mutedChats.size },
      storage: { ...disk, restoredFrom: this.store.restoredFrom, backups: listBackups().length, tables: this.store.summary() },
      dataFreshness: (() => {
        const tables = this.store.summary()
        const uptimeSec = Math.floor((Date.now() - this.startedAt) / 1000)
        const isEmpty = tables.candles === 0 && tables.paperTrades === 0 && tables.decisions === 0
        return {
          likelyWiped: isEmpty && uptimeSec > 60 && !this.store.restoredFrom,
          dbHasData: !isEmpty,
          restoredFromBackup: this.store.restoredFrom !== null,
          uptimeSec,
        }
      })(),
      paper: { ...this.store.paperStats(), active: this.store.loadActiveTrades().length, killSwitch: this.paperKillSwitch },
      drySpell: { factor: this.drySpellFactor(), lastArmedAt: this.store.getState<number>('last_trade_armed_at', 0) },
      evolution: {
        validationState: snapshot.validationState,
        ...snapshot.summary,
        nicheCount: snapshot.niches.length,
        championList: snapshot.specialists
          .filter((row) => row.lifecycle === 'champion')
          .map((row) => ({ displayName: row.displayName, nicheKey: row.nicheKey, generation: row.generation, liveTrades: row.liveTrades, liveMeanR: row.liveMeanR, brier: (row.metrics as { brier?: number })?.brier ?? null })),
      },
      demoExecution: { ...this.demo.health(), parity: this.demo.parityReport() },
      resources: { rssMb: process.memoryUsage().rss / 1024 / 1024, freeMemoryMb: freemem() / 1024 / 1024, totalMemoryMb: totalmem() / 1024 / 1024, load1: loadavg()[0] },
      counters: this.counters,
      scanner: { at: this.scan.at, scanned: this.scan.scanned, running: this.scan.running },
      account: this.account,
      okxKeys: HAS_OKX_KEYS,
      settingsSavedAt: this.settingsSavedAt,
      analyses: this.analyses.size,
      marketContext: this.marketContext,
      edge: {
        regime: this.regime,
        volForecast: this.volForecast,
        crossAsset: this.crossAsset ? { vix: this.crossAsset.vix, riskScore: this.crossAsset.riskScore } : null,
        onChain: this.onChain ? { score: this.onChain.onChainScore, hashRate: this.onChain.hashRate } : null,
        anomaly: this.anomalyResult ? { isAnomaly: this.anomalyResult.isAnomaly, action: this.anomalyResult.action, score: this.anomalyResult.anomalyScore } : null,
        kelly: this.kellyResult ? { sizeMultiplier: this.kellyResult.sizeMultiplier, riskFraction: this.kellyResult.riskFraction } : null,
        explanation: this.explanation ? { summary: this.explanation.summary, topReasons: this.explanation.topReasons.slice(0, 3) } : null,
      },
    }
  }

  stop() {
    this.stream.close()
    this.bot.stop()
    this.store.close()
  }
}

export const runtime = new Runtime()
