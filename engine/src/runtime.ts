/**
 * Runtime orchestrator — the 24/7 brain.
 *
 * Responsibilities
 *   • keep the OKX universe, tickers and candle memory hot (REST seed + WS live)
 *   • analyse the focus instrument continuously and the watchlist on rotation
 *   • scan the liquid universe for the best setups
 *   • ask Gemini only when a real setup passed every local gate
 *   • evaluate alert rules, push Telegram cards, journal and grade every idea
 *   • never place an order: this system decides, the human executes
 */
import { ENV, HAS_OKX_KEYS } from './env.js'
import { log } from './log.js'
import { convex, type AlertRuleRow, type SignalRow, type WatchRow } from './convex/client.js'
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
import type { Analysis, DerivativesBlock, EngineSettings, InstrumentSpec } from './quant/types.js'
import { DEFAULT_SETTINGS } from './quant/types.js'
import { GeminiOrchestrator, type AiConfig } from './ai/gemini.js'
import { TelegramBot } from './telegram/bot.js'
import { alertCard, signalCard, statusCard, HELP } from './telegram/cards.js'
import { evaluateRule, scopeMatches, type AlertCandidate } from './alerts/rules.js'
import { gradeSignal, toSignalRecord } from './journal.js'
import { fmtPct, fmtPrice, fmtUsd } from './format.js'

/* -------------------------------------------------------------------------- */
/*  Settings shape (mirrors the Convex document)                               */
/* -------------------------------------------------------------------------- */

export interface RuntimeSettings {
  instId: string
  timeframe: string
  htfTimeframe: string
  htf2Timeframe: string
  strategy: string
  minConfidence: number
  minCompositeScore: number
  requireMtfAlignment: boolean
  usePatterns: boolean
  useDerivatives: boolean
  useEmpiricalEdge: boolean
  maxAtrPct: number
  minAdx: number
  weights: Record<string, number>
  riskPerTradePct: number
  leverage: number
  rrRatio: number
  equityUsd: number
  useAccountBalance: boolean
  takerFeeBps: number
  ai: AiConfig
  scanner: {
    enabled: boolean
    timeframe: string
    instTypes: string[]
    quoteCcy: string
    minVol24hUsd: number
    universeSize: number
    intervalMs: number
    includeEquities: boolean
  }
  telegram: {
    enabled: boolean
    minConviction: number
    onlyWatchlist: boolean
    quietHoursStart: number
    quietHoursEnd: number
    sendScanDigest: boolean
    digestIntervalMin: number
  }
  engineEnabled: boolean
}

export const FALLBACK_SETTINGS: RuntimeSettings = {
  instId: 'BTC-USDT-SWAP',
  timeframe: '15m',
  htfTimeframe: '1H',
  htf2Timeframe: '4H',
  strategy: 'adaptive',
  minConfidence: 60,
  minCompositeScore: 20,
  requireMtfAlignment: true,
  usePatterns: true,
  useDerivatives: true,
  useEmpiricalEdge: true,
  maxAtrPct: 8,
  minAdx: 16,
  weights: { trend: 1, momentum: 1, volatility: 1, volume: 1, structure: 1, pattern: 1, derivatives: 1, mtf: 1, stats: 1, edge: 1 },
  riskPerTradePct: 1,
  leverage: 5,
  rrRatio: 2,
  equityUsd: ENV.defaultEquityUsd,
  useAccountBalance: false,
  takerFeeBps: 5,
  ai: {
    enabled: true,
    model: ENV.gemini.model,
    temperature: 0.15,
    maxOutputTokens: 1200,
    thinkingBudget: 0,
    cooldownMs: 90_000,
    minConvictionToAsk: 45,
    contextDepth: 'standard',
  },
  scanner: {
    enabled: true,
    timeframe: '15m',
    instTypes: ['SWAP'],
    quoteCcy: 'USDT',
    minVol24hUsd: 5_000_000,
    universeSize: 60,
    intervalMs: 60_000,
    includeEquities: true,
  },
  telegram: {
    enabled: true,
    minConviction: 62,
    onlyWatchlist: false,
    quietHoursStart: 0,
    quietHoursEnd: 0,
    sendScanDigest: false,
    digestIntervalMin: 240,
  },
  engineEnabled: true,
}

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
  settings: RuntimeSettings = { ...FALLBACK_SETTINGS }
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
  counters = { evaluations: 0, alerts: 0, signals: 0, errors: 0, wsMessages: 0 }
  lastAlertAt = new Map<string, number>()
  private derivCache = new Map<string, { at: number; data: DerivativesBlock }>()
  private aiCooldown = new Map<string, number>()
  private watchCursor = 0
  private limiter = new Limiter(4)
  private stream: OkxStream
  gemini: GeminiOrchestrator
  bot: TelegramBot
  universeLoadedAt = 0

  constructor() {
    this.gemini = new GeminiOrchestrator(ENV.gemini.apiKey)
    this.bot = new TelegramBot(ENV.telegram.token)
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
    log.info('boot', `APEX-02 engine starting · OKX keys ${HAS_OKX_KEYS ? 'present (read-only)' : 'absent (public data)'}`)
    await this.refreshSettings()
    await this.refreshUniverse()
    await this.refreshTickers()
    await this.seedDefaults()
    this.stream.connect()
    this.syncSubscriptions()

    if (this.bot.configured) {
      await this.bot.identify()
      await this.bot.syncOffset()
      this.bot.startPolling((ctx) => this.handleCommand(ctx))
      log.info('telegram', `bot @${this.bot.me?.username ?? '?'} online`)
      if (ENV.telegram.chatId) {
        const id = Number(ENV.telegram.chatId)
        if (Number.isFinite(id)) {
          this.chats = [...new Set([...this.chats, id])]
          await convex.registerChat(id)
        }
      }
    }

    every(10_000, () => this.refreshSettings(), 'settings')
    every(6_000, () => this.refreshTickers(), 'tickers')
    every(10 * 60_000, () => this.refreshUniverse(), 'universe')
    every(4_000, () => this.focusLoop(), 'focus')
    every(5_000, () => this.watchLoop(), 'watch')
    every(15_000, () => this.scanLoop(), 'scanner')
    every(20_000, () => this.journalLoop(), 'journal')
    every(30_000, () => this.telemetryLoop(), 'telemetry')
    every(5_000, () => log.flush(), 'logflush')
    every(60_000, () => this.refreshAccount(), 'account')
    log.info('boot', 'all loops armed')
  }

  /* ---- configuration --------------------------------------------------- */

  async refreshSettings() {
    const row = (await convex.getSettings()) as Partial<RuntimeSettings> | null
    if (row) {
      this.settings = {
        ...FALLBACK_SETTINGS,
        ...row,
        weights: { ...FALLBACK_SETTINGS.weights, ...(row.weights ?? {}) },
        ai: { ...FALLBACK_SETTINGS.ai, ...(row.ai ?? {}) },
        scanner: { ...FALLBACK_SETTINGS.scanner, ...(row.scanner ?? {}) },
        telegram: { ...FALLBACK_SETTINGS.telegram, ...(row.telegram ?? {}) },
      }
    }
    if (this.settings.htfTimeframe === 'auto' || this.settings.htf2Timeframe === 'auto') {
      const [h1, h2] = higherTimeframes(this.settings.timeframe)
      if (this.settings.htfTimeframe === 'auto') this.settings.htfTimeframe = h1
      if (this.settings.htf2Timeframe === 'auto') this.settings.htf2Timeframe = h2
    }
    const [wl, rules, chats] = await Promise.all([convex.listWatchlist(), convex.listRules(), convex.listChats()])
    if (wl) this.watchlist = wl.filter((w) => w.enabled)
    if (rules) this.rules = rules
    if (chats) {
      this.chats = chats.map((c) => c.chatId)
      this.mutedChats = new Set(chats.filter((c) => c.muted).map((c) => c.chatId))
    }
  }

  async updateSettings(patch: Record<string, unknown>) {
    await convex.updateSettings(patch)
    await this.refreshSettings()
    this.syncSubscriptions()
    return this.settings
  }

  /** First-run experience: a useful watchlist and sane alert rules. */
  private async seedDefaults() {
    if (!convex.configured) return
    if (!this.watchlist.length) {
      const seed = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'NVDA-USDT-SWAP']
      for (const instId of seed) {
        const spec = this.universe.get(instId)
        if (!spec) continue
        await convex.addWatch(instId, spec.instType, this.settings.timeframe, 'seeded on first run')
      }
      log.info('boot', `seeded watchlist with ${seed.length} instruments`)
    }
    if (!this.rules.length) {
      await convex.upsertRule({
        name: 'Actionable setup on watchlist',
        scope: '*',
        type: 'signal',
        timeframe: 'any',
        params: { threshold: 65, direction: 'any' },
        cooldownMs: 30 * 60_000,
        telegram: true,
        enabled: true,
      })
      await convex.upsertRule({
        name: 'Volatility squeeze fires',
        scope: '*',
        type: 'squeeze_fire',
        timeframe: 'any',
        params: {},
        cooldownMs: 45 * 60_000,
        telegram: true,
        enabled: true,
      })
      await convex.upsertRule({
        name: 'Funding extreme (crowded book)',
        scope: '*',
        type: 'funding_extreme',
        timeframe: 'any',
        params: { threshold: 45 },
        cooldownMs: 6 * 60 * 60_000,
        telegram: true,
        enabled: true,
      })
      log.info('boot', 'seeded 3 default alert rules')
    }
    await this.refreshSettings()
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
    const cached = this.derivCache.get(instId)
    if (cached && Date.now() - cached.at < 60_000) return cached.data
    try {
      const data = await fetchDerivatives(
        instId,
        (instType as InstType) ?? 'SWAP',
        this.tickers.get(instId)?.changePct24h ?? null,
      )
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
      bars:
        instId === focus
          ? [this.settings.timeframe, this.settings.htfTimeframe]
          : [this.watchlist.find((w) => w.instId === instId)?.timeframe ?? this.settings.timeframe],
    }))
    this.stream.syncCandles(pairs)
  }

  /* ---- analysis -------------------------------------------------------- */

  engineSettings(instId: string, timeframe: string): EngineSettings {
    const s = this.settings
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
      minConfidence: s.minConfidence,
      minCompositeScore: s.minCompositeScore,
      requireMtfAlignment: s.requireMtfAlignment,
      usePatterns: s.usePatterns,
      useDerivatives: s.useDerivatives,
      useEmpiricalEdge: s.useEmpiricalEdge,
      takerFeeBps: s.takerFeeBps,
      useAccountBalance: s.useAccountBalance,
      maxAtrPct: s.maxAtrPct,
      minAdx: s.minAdx,
      weights: s.weights as EngineSettings['weights'],
      equityUsd: s.equityUsd,
      aiModel: s.ai.model,
    }
  }

  key(instId: string, timeframe: string) {
    return `${instId}|${normalizeBar(timeframe)}`
  }

  /**
   * Full pipeline for one instrument: warm candles for three timeframes, pull
   * the derivatives context, run the quant brain, optionally ask the LLM, then
   * fire alerts and journal the idea.
   */
  async analyzeInstrument(
    instIdRaw: string,
    timeframeRaw?: string,
    opts: { withAi?: boolean; silent?: boolean } = {},
  ): Promise<Analysis | null> {
    const instId = this.resolveInstId(instIdRaw)
    if (!instId) return null
    const spec = this.universe.get(instId) ?? null
    const timeframe = normalizeBar(timeframeRaw ?? this.settings.timeframe)
    const [htf, htf2] = (() => {
      const auto = higherTimeframes(timeframe)
      const a = normalizeBar(this.settings.htfTimeframe)
      const b = normalizeBar(this.settings.htf2Timeframe)
      // Never let the "higher" timeframe be lower than the entry timeframe.
      return [a === timeframe ? auto[0] : a, b === timeframe || b === a ? auto[1] : b]
    })()

    const [ltfC, htfC, htf2C] = await Promise.all([
      candleStore.ensure(instId, timeframe, 300),
      candleStore.ensure(instId, htf, 220),
      candleStore.ensure(instId, htf2, 160),
    ])

    const ticker = this.tickers.get(instId) ?? null
    const deriv = await this.derivatives(instId, spec?.instType ?? 'SWAP')

    const analysis = analyze({
      instId,
      instType: spec?.instType,
      spec,
      ltf: ltfC,
      htf: htfC,
      htf2: htf2C,
      derivatives: deriv,
      settings: this.engineSettings(instId, timeframe),
      livePrice: ticker?.last ?? null,
      volUsd24h: ticker?.volUsd24h ?? null,
      availableUsd: this.account?.availableUsdt ?? null,
    })
    this.counters.evaluations++

    const k = this.key(instId, timeframe)
    const prev = this.analyses.get(k) ?? null
    if (prev) this.previous.set(k, prev)

    /* ---- AI arbitration, strictly gated ------------------------------- */
    const ai = this.settings.ai
    const hardVeto = analysis.vetoes.some((v) => v.severity === 'hard')
    const wantAi =
      (opts.withAi ?? true) &&
      ai.enabled &&
      this.gemini.configured &&
      analysis.decision !== 'WAIT' &&
      analysis.conviction >= ai.minConvictionToAsk &&
      !hardVeto
    const cooldownOk = Date.now() - (this.aiCooldown.get(k) ?? 0) > Math.max(ai.cooldownMs, 15_000)

    if (wantAi && (cooldownOk || opts.withAi === true)) {
      try {
        this.aiCooldown.set(k, Date.now())
        const opinion = await this.gemini.decide(analysis, { ...ai, model: ai.model })
        if (opinion) {
          analysis.ai = opinion
          if (!opinion.cached) {
            log.ai(
              'gemini',
              `${instId} ${timeframe} → ${opinion.decision} @ ${opinion.confidence.toFixed(0)}% (${opinion.tokensIn}/${opinion.tokensOut} tok, ${opinion.latencyMs}ms): ${opinion.reasoning.slice(0, 220)}`,
              { instId, timeframe },
            )
          }
        }
      } catch (err) {
        this.counters.errors++
        log.error('gemini', err instanceof Error ? err.message : String(err), { instId, timeframe })
      }
    }

    this.analyses.set(k, analysis)

    if (!opts.silent) {
      await this.postAnalysis(analysis, prev)
    }
    return analysis
  }

  /** Alerting + journaling for a fresh analysis. */
  private async postAnalysis(a: Analysis, prev: Analysis | null) {
    const inWatchlist = this.watchlist.some((w) => w.instId === a.instId)
    const ticker = this.tickers.get(a.instId)
    const candidates: AlertCandidate[] = []

    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (!scopeMatches(rule, a.instId, inWatchlist)) continue
      if (rule.timeframe && rule.timeframe !== 'any' && normalizeBar(rule.timeframe) !== a.timeframe) continue
      if (Date.now() - rule.lastFiredAt < rule.cooldownMs) continue
      const hit = evaluateRule(rule, {
        analysis: a,
        previous: prev,
        changePct24h: ticker?.changePct24h ?? null,
        volUsd24h: ticker?.volUsd24h ?? null,
        inWatchlist,
      })
      if (hit) candidates.push(hit)
    }

    for (const c of candidates) {
      const last = this.lastAlertAt.get(c.fingerprint) ?? 0
      if (Date.now() - last < 10 * 60_000) continue
      this.lastAlertAt.set(c.fingerprint, Date.now())
      this.counters.alerts++

      let delivered = false
      if (c.telegram && this.shouldNotify(a, c)) {
        const html =
          c.type === 'signal'
            ? signalCard(a)
            : alertCard({ ...c, analysis: c.severity === 'opportunity' ? a : null })
        delivered = (await this.bot.broadcast(this.activeChats(), html)) > 0
      }
      log.alert('alerts', `${c.title} — ${c.message}`, { instId: a.instId, timeframe: a.timeframe })
      await convex.recordAlert({
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
        payload: JSON.stringify(a.compact).slice(0, 3500),
        telegramDelivered: delivered,
      })
      if (c.ruleId) {
        await convex.markRuleFired(c.ruleId, Date.now())
        const rule = this.rules.find((r) => r._id === c.ruleId)
        if (rule) rule.lastFiredAt = Date.now()
      }
    }

    await this.maybeJournal(a)
  }

  private async maybeJournal(a: Analysis) {
    if (a.decision === 'WAIT' || !a.plan) return
    if (a.conviction < this.settings.minConfidence) return
    if (a.vetoes.some((v) => v.severity === 'hard')) return
    const live = (await convex.listLiveSignals()) ?? []
    const dup = live.find(
      (s) => s.instId === a.instId && s.timeframe === a.timeframe && s.decision === a.decision,
    )
    if (dup) return
    const record = toSignalRecord(a)
    if (!record) return
    const id = await convex.recordSignal(record)
    if (id) {
      this.counters.signals++
      log.signal(
        'journal',
        `logged ${a.decision} ${a.instId} ${a.timeframe} @ ${fmtPrice(a.price)} · conviction ${a.conviction.toFixed(0)} · ${a.plan.expectedRr.toFixed(2)}R`,
        { instId: a.instId, timeframe: a.timeframe },
      )
    }
  }

  private shouldNotify(a: Analysis, c: AlertCandidate) {
    const t = this.settings.telegram
    if (!t.enabled || !this.bot.configured) return false
    if (t.onlyWatchlist && !this.watchlist.some((w) => w.instId === a.instId)) return false
    if (c.type === 'signal' && a.conviction < t.minConviction) return false
    if (t.quietHoursStart !== t.quietHoursEnd) {
      const hour = new Date().getUTCHours()
      const inQuiet =
        t.quietHoursStart < t.quietHoursEnd
          ? hour >= t.quietHoursStart && hour < t.quietHoursEnd
          : hour >= t.quietHoursStart || hour < t.quietHoursEnd
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
    if (!cfg.enabled || !this.settings.engineEnabled) return
    if (this.scan.running) return
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
              /* a single instrument failing must not kill the scan */
            }
          }),
        ),
      )
      rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      this.scan = { at: Date.now(), scanned: rows.length, rows, running: false }
      log.scan(
        'scanner',
        `${rows.length}/${targets.length} instruments scored in ${((Date.now() - started) / 1000).toFixed(1)}s · best ${rows
          .slice(0, 3)
          .map((r) => `${r.instId} ${r.score > 0 ? '+' : ''}${r.score.toFixed(0)}`)
          .join(', ')}`,
      )
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
      .slice(0, Math.max(5, Math.min(cfg.universeSize, 200)))
    // Always include the watchlist, whatever its turnover.
    for (const w of this.watchlist) {
      if (!out.some((t) => t.instId === w.instId)) {
        const t = this.tickers.get(w.instId)
        if (t) out.push(t)
      }
    }
    return out
  }

  private async journalLoop() {
    const live = (await convex.listLiveSignals()) ?? []
    for (const s of live as SignalRow[]) {
      const candles = candleStore.peek(s.instId, s.timeframe) ?? (await candleStore.ensure(s.instId, s.timeframe, 200))
      const lastPrice = this.tickers.get(s.instId)?.last ?? candles[candles.length - 1]?.close ?? s.lastPrice
      const graded = gradeSignal(s, candles, lastPrice)
      if (!graded) continue
      await convex.gradeSignal(s._id, graded.patch)
      if (graded.closed) {
        log.signal('journal', graded.headline, { instId: s.instId, timeframe: s.timeframe })
        if (this.settings.telegram.enabled) {
          const realized = Number(graded.patch.realizedR ?? 0)
          await this.bot.broadcast(
            this.activeChats(),
            `${realized >= 0 ? '\u2705' : '\u274C'} <b>Idea closed</b>\n<code>${s.instId}</code> ${s.timeframe} ${s.decision}\n${graded.headline}`,
          )
        }
      }
    }
  }

  private async telemetryLoop() {
    const health = this.stream.health()
    const ai = this.gemini.stats()
    await convex.ping('engine', this.settings.engineEnabled ? 'online' : 'degraded',
      `${this.settings.instId} ${this.settings.timeframe} · ${this.universe.size} instruments · ${candleStore.stats().series} series`,
      {
        evaluations: this.counters.evaluations,
        alerts: this.counters.alerts,
        errors: this.counters.errors,
        wsMessages: this.counters.wsMessages,
        restCalls: restStats.calls,
      })
    await convex.ping(
      'okx_ws',
      health.public.healthy && health.business.healthy ? 'online' : health.public.healthy || health.business.healthy ? 'degraded' : 'offline',
      `public ${health.public.subs} subs / business ${health.business.subs} subs`,
      { wsMessages: this.counters.wsMessages },
    )
    await convex.ping(
      'okx_rest',
      restStats.errors > 0 && Date.now() - restStats.lastErrorAt < 60_000 ? 'degraded' : 'online',
      `${restStats.calls} calls · ${restStats.avgLatencyMs.toFixed(0)}ms avg${restStats.lastError ? ` · ${restStats.lastError}` : ''}`,
      { restCalls: restStats.calls, errors: restStats.errors },
    )
    if (this.gemini.configured) {
      await convex.ping('ai', ai.errors && Date.now() - ai.lastCallAt < 120_000 ? 'degraded' : 'online',
        `${this.settings.ai.model} · ${ai.calls} calls · ${ai.cacheHits} cached · ${ai.tokensIn}/${ai.tokensOut} tokens`,
        { aiCalls: ai.calls, aiCacheHits: ai.cacheHits, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut })
    }
    if (this.bot.configured) {
      await convex.ping('telegram', this.bot.failed > this.bot.sent ? 'degraded' : 'online',
        `@${this.bot.me?.username ?? '?'} · ${this.bot.sent} sent · ${this.chats.length} chat(s)`)
    }
  }

  /* ---- symbol resolution ---------------------------------------------- */

  resolveInstId(input: string): string | null {
    if (!input) return null
    const raw = input.trim().toUpperCase()
    if (this.universe.has(raw)) return raw
    if (this.universe.size === 0) return raw.includes('-') ? raw : `${raw}-USDT-SWAP`
    const candidates = [`${raw}-USDT-SWAP`, `${raw}-USDT`, `${raw}-USDC-SWAP`, `${raw}-USD-SWAP`]
    for (const c of candidates) if (this.universe.has(c)) return c
    const partial = [...this.universe.keys()].find((k) => k.startsWith(`${raw}-`))
    if (partial) return partial
    const loose = [...this.universe.keys()].find((k) => k.replace(/-/g, '').includes(raw.replace(/-/g, '')))
    return loose ?? null
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
        await convex.registerChat(chatId, ctx.from.firstName, ctx.from.username)
        if (!this.chats.includes(chatId)) this.chats.push(chatId)
        this.mutedChats.delete(chatId)
        log.info('telegram', `chat ${chatId} registered (${ctx.from.firstName ?? 'unknown'})`)
        return `\u{1F44B} <b>Welcome ${ctx.from.firstName ?? 'trader'}</b>\nThis chat is now registered for live OKX decisions.\n\n${HELP}`
      }
      case 'help':
        return HELP
      case 'status':
        return this.statusHtml()
      case 'settings': {
        const s = this.settings
        return `\u{2699} <b>Configuration</b>\n<pre>focus       ${s.instId} ${s.timeframe} (HTF ${s.htfTimeframe}/${s.htf2Timeframe})\nstrategy    ${s.strategy}\nrisk        ${s.riskPerTradePct}% of ${fmtUsd(s.equityUsd)} · max ${s.leverage}x · min ${s.rrRatio}R\ngates       conviction ≥ ${s.minConfidence} · composite ≥ ${s.minCompositeScore} · ADX ≥ ${s.minAdx} · ATR ≤ ${s.maxAtrPct}%\nai          ${s.ai.enabled ? s.ai.model : 'off'} · depth ${s.ai.contextDepth} · ask ≥ ${s.ai.minConvictionToAsk}\nscanner     ${s.scanner.enabled ? `${s.scanner.instTypes.join('/')} top ${s.scanner.universeSize} ≥ ${fmtUsd(s.scanner.minVol24hUsd)}` : 'off'}\ntelegram    ≥ ${s.telegram.minConviction} conviction${s.telegram.onlyWatchlist ? ' · watchlist only' : ''}</pre>`
      }
      case 'mute':
        this.mutedChats.add(chatId)
        await convex.muteChat(chatId, true)
        return '\u{1F507} Muted. Send /unmute to resume alerts.'
      case 'unmute':
        this.mutedChats.delete(chatId)
        await convex.muteChat(chatId, false)
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
        if (!args.length) return 'Usage: <code>/watch NVDA 1H</code>'
        const instId = this.resolveInstId(args[0])
        if (!instId) return `Unknown instrument <code>${args[0]}</code>.`
        const spec = this.universe.get(instId)
        await convex.addWatch(instId, spec?.instType ?? 'SWAP', normalizeBar(args[1] ?? this.settings.timeframe))
        await this.refreshSettings()
        this.syncSubscriptions()
        return `\u{1F440} Watching <code>${instId}</code> on ${normalizeBar(args[1] ?? this.settings.timeframe)}.`
      }
      case 'unwatch': {
        if (!args.length) return 'Usage: <code>/unwatch NVDA</code>'
        const instId = this.resolveInstId(args[0])
        if (!instId) return `Unknown instrument <code>${args[0]}</code>.`
        await convex.removeWatch(instId)
        await this.refreshSettings()
        this.syncSubscriptions()
        return `Removed <code>${instId}</code> from the watchlist.`
      }
      case 'list': {
        if (!this.watchlist.length) return 'Watchlist is empty. Add one with <code>/watch BTC 15m</code>.'
        const lines = this.watchlist.map((w) => {
          const a = this.analyses.get(this.key(w.instId, w.timeframe || this.settings.timeframe))
          const t = this.tickers.get(w.instId)
          return `${w.instId} ${w.timeframe} — ${a ? `${a.decision} ${a.conviction.toFixed(0)}/100 · ${a.regime.toLowerCase()}` : 'warming up'} · ${fmtPrice(t?.last ?? 0)} ${t ? fmtPct(t.changePct24h, 1) : ''}`
        })
        return `\u{1F440} <b>Watchlist</b>\n<pre>${lines.join('\n')}</pre>`
      }
      case 'scan': {
        if (!this.scan.rows.length) return 'No scan yet — give the engine a minute.'
        const top = this.scan.rows.slice(0, 10)
        const lines = top.map(
          (r) =>
            `${r.instId.padEnd(18)} ${(r.score > 0 ? '+' : '') + r.score.toFixed(0).padStart(4)} ${r.bias.padEnd(8)} ${r.regime.toLowerCase().padEnd(14)} RSI ${r.rsi.toFixed(0).padStart(3)} ATR ${r.atrPct.toFixed(2)}%`,
        )
        return `\u{1F50E} <b>Best setups</b> (${this.scan.scanned} scanned)\n<pre>${lines.join('\n')}</pre>\nUse <code>/analyze SYMBOL</code> for the full plan.`
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
      convex: `${convex.health.status} · ${convex.health.writes}w/${convex.health.reads}r`,
      scanner: {
        lastRunAt: this.scan.at,
        scanned: this.scan.scanned,
        top: this.scan.rows.slice(0, 5).map((r) => `${r.instId} ${r.score > 0 ? '+' : ''}${r.score.toFixed(0)} ${r.bias.toLowerCase()}`),
      },
      equityUsd: this.settings.equityUsd,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      alerts24h: this.counters.alerts,
    })
  }

  health() {
    const wsHealth = this.stream.health()
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
      ai: this.gemini.stats(),
      telegram: { ...this.bot.stats(), chats: this.chats.length, muted: this.mutedChats.size },
      convex: convex.health,
      counters: this.counters,
      scanner: { at: this.scan.at, scanned: this.scan.scanned, running: this.scan.running },
      account: this.account,
      okxKeys: HAS_OKX_KEYS,
      analyses: this.analyses.size,
    }
  }

  stop() {
    this.stream.close()
    this.bot.stop()
  }
}

export const runtime = new Runtime()
