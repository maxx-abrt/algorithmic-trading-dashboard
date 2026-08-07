/**
 * Historical sample harvester.
 *
 * A learning system is worthless until it has evidence. Waiting for live trades
 * to accumulate would take months, so on first boot (and whenever a niche is
 * starved) the harvester replays REAL confirmed OKX candles bar by bar, runs the
 * exact same decision pipeline and the exact same paper broker, and writes the
 * resulting point-in-time samples into the evolution store.
 *
 * Guarantees
 *   • every decision only sees candles that closed BEFORE the decision timestamp
 *   • every sample carries `horizonEndAt`, so the purge can remove overlapping labels
 *   • the cursor is durable: a restart continues instead of duplicating work
 *   • it yields to the event loop and respects a wall-clock budget, so the live
 *     engine never stalls behind it
 */
import { log } from '../log.js'
import { fetchCandles, fetchInstruments, fetchTickers } from '../okx/market.js'
import { analyze } from '../quant/engine.js'
import { higherTimeframes } from '../quant/timeframes.js'
import { DEFAULT_SETTINGS, type Candle, type InstrumentSpec } from '../quant/types.js'
import { createPaperPlan, runPaperPlan } from '../paper/broker.js'
import { evaluateStrategies } from '../strategies/registry.js'
import { buildFeatureVector } from './features.js'
import type { DurableStore } from '../store/durable.js'
import type { EvolutionService } from './evolution-service.js'

export interface HarvestRequest {
  symbols?: string[]
  timeframes?: string[]
  /** how many liquid instruments to auto-select per instrument type when no list is given */
  perType?: number
  barsPerSymbol?: number
  maxWallMs?: number
}

export interface HarvestProgress {
  running: boolean
  startedAt: number
  finishedAt: number
  samples: number
  seriesDone: number
  seriesTotal: number
  current: string
  lastError: string
  totalSamplesEver: number
}

const closedAt = (candle: Candle, timeframe: string) => {
  const unit = timeframe.endsWith('H') ? 3_600_000 : timeframe.endsWith('D') ? 86_400_000 : 60_000
  return candle.ts + Number.parseInt(timeframe) * unit
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Timeout wrapper: rejects after ms milliseconds so a single hung fetch cannot stall the harvest. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class Harvester {
  progress: HarvestProgress = {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    samples: 0,
    seriesDone: 0,
    seriesTotal: 0,
    current: '',
    lastError: '',
    totalSamplesEver: 0,
  }

  constructor(
    private readonly store: DurableStore,
    private readonly evolution: EvolutionService,
  ) {
    this.progress.totalSamplesEver = this.store.getState<number>('harvest_total_samples', 0)
  }

  private cursor() {
    return this.store.getState<Record<string, number>>('harvest_cursor', {})
  }

  private setCursor(key: string, ts: number) {
    this.store.setState('harvest_cursor', { ...this.cursor(), [key]: ts })
  }

  /** Pick the most liquid USDT instruments across SPOT and SWAP. */
  private async selectSymbols(perType: number) {
    const [swapSpecs, spotSpecs, swapTickers, spotTickers] = await Promise.all([
      fetchInstruments('SWAP'),
      fetchInstruments('SPOT'),
      fetchTickers('SWAP'),
      fetchTickers('SPOT'),
    ])
    const specs = new Map([...swapSpecs, ...spotSpecs].map((row) => [row.instId, row] as const))
    const pick = (tickers: { instId: string; volUsd24h: number }[]) =>
      tickers
        .filter((ticker) => ticker.instId.endsWith('-USDT') || ticker.instId.endsWith('-USDT-SWAP'))
        .filter((ticker) => specs.has(ticker.instId))
        .sort((a, b) => b.volUsd24h - a.volUsd24h)
        .slice(0, perType)
        .map((ticker) => ticker.instId)
    return { symbols: [...pick(swapTickers), ...pick(spotTickers)], specs }
  }

  async run(request: HarvestRequest = {}): Promise<HarvestProgress> {
    // Auto-recover from a crashed previous run: if running is true but startedAt
    // is more than 30 minutes ago, the previous harvest died without calling finish().
    if (this.progress.running && Date.now() - this.progress.startedAt > 30 * 60_000) {
      log.info('harvest', `stale run detected (started ${Math.round((Date.now() - this.progress.startedAt) / 60_000)}m ago) — force resetting`)
      this.progress = { ...this.progress, running: false, finishedAt: Date.now(), lastError: 'auto-recovered from stale state' }
    }
    if (this.progress.running) return this.progress
    const timeframes = request.timeframes?.length ? request.timeframes : ['15m', '30m', '1H']
    const barsPerSymbol = Math.min(1500, Math.max(300, request.barsPerSymbol ?? 900))
    const maxWallMs = Math.min(20 * 60_000, Math.max(30_000, request.maxWallMs ?? 6 * 60_000))
    const deadline = Date.now() + maxWallMs

    const { symbols, specs } = request.symbols?.length
      ? { symbols: request.symbols, specs: new Map((await Promise.all([fetchInstruments('SWAP'), fetchInstruments('SPOT')])).flat().map((row) => [row.instId, row] as const)) }
      : await this.selectSymbols(Math.max(1, request.perType ?? 6))

    const tickers = new Map((await Promise.all([fetchTickers('SWAP'), fetchTickers('SPOT')])).flat().map((row) => [row.instId, row] as const))

    this.progress = {
      running: true,
      startedAt: Date.now(),
      finishedAt: 0,
      samples: 0,
      seriesDone: 0,
      seriesTotal: symbols.length * timeframes.length,
      current: '',
      lastError: '',
      totalSamplesEver: this.progress.totalSamplesEver,
    }
    log.info('harvest', `starting: ${symbols.length} instruments × ${timeframes.join('/')} · ${barsPerSymbol} bars each · budget ${(maxWallMs / 1000).toFixed(0)}s`)

    try {
      for (const timeframe of timeframes) {
        for (const symbol of symbols) {
          if (Date.now() > deadline) {
            log.info('harvest', `wall-clock budget reached, stopping cleanly after ${this.progress.samples} samples`)
            return this.finish()
          }
          this.progress.current = `${symbol} ${timeframe}`
          try {
            const added = await this.harvestSeries(symbol, timeframe, specs.get(symbol), tickers.get(symbol)?.volUsd24h ?? 0, barsPerSymbol)
            this.progress.samples += added
          } catch (error) {
            this.progress.lastError = `${symbol} ${timeframe}: ${error instanceof Error ? error.message : String(error)}`
          }
          this.progress.seriesDone++
          await sleep(150) // be polite to OKX and to the event loop
        }
      }
      return this.finish()
    } catch (error) {
      this.progress.lastError = error instanceof Error ? error.message : String(error)
      return this.finish()
    }
  }

  private finish() {
    this.progress.running = false
    this.progress.finishedAt = Date.now()
    this.progress.totalSamplesEver += this.progress.samples
    this.store.setState('harvest_total_samples', this.progress.totalSamplesEver)
    this.store.setState('harvest_last', { at: Date.now(), samples: this.progress.samples, series: this.progress.seriesDone })
    log.info('harvest', `finished: ${this.progress.samples} new samples from ${this.progress.seriesDone} series (${this.progress.totalSamplesEver} lifetime)`)
    return this.progress
  }

  private async harvestSeries(symbol: string, timeframe: string, spec: InstrumentSpec | undefined, volUsd24h: number, bars: number) {
    if (!spec) return 0
    const cursorKey = `${symbol}|${timeframe}`
    const lastDone = this.cursor()[cursorKey] ?? 0
    const [htfName, htf2Name] = higherTimeframes(timeframe)
    const [ltfRaw, htf, htf2] = await Promise.all([
      withTimeout(fetchCandles(symbol, timeframe, bars, { history: true }), 30_000, `fetchCandles ${symbol} ${timeframe}`),
      withTimeout(fetchCandles(symbol, htfName, Math.round(bars * 0.7), { history: true }), 30_000, `fetchCandles ${symbol} ${htfName}`),
      withTimeout(fetchCandles(symbol, htf2Name, Math.round(bars * 0.4), { history: true }), 30_000, `fetchCandles ${symbol} ${htf2Name}`),
    ])
    const ltf = ltfRaw.filter((row) => row.confirmed)
    if (ltf.length < 300) return 0
    this.store.upsertCandles(symbol, timeframe, ltf)

    let added = 0
    let lastTs = lastDone
    // 240 warm-up bars are needed before the indicator stack is meaningful.
    for (let index = 240; index < ltf.length - 30; index++) {
      const signalBar = ltf[index]
      if (signalBar.ts <= lastDone) continue
      const availableAt = closedAt(signalBar, timeframe)
      const analysis = analyze({
        instId: symbol,
        instType: spec.instType,
        spec,
        ltf: ltf.slice(Math.max(0, index - 299), index + 1),
        htf: htf.filter((row) => row.ts < availableAt).slice(-220),
        htf2: htf2.filter((row) => row.ts < availableAt).slice(-160),
        livePrice: signalBar.close,
        volUsd24h,
        now: availableAt,
        settings: {
          ...DEFAULT_SETTINGS,
          instId: symbol,
          timeframe,
          htfTimeframe: htfName,
          htf2Timeframe: htf2Name,
          useDerivatives: false,
          useEmpiricalEdge: false,
          // Permissive on purpose: the harvester's job is to produce EVIDENCE across
          // the whole behaviour space, not to be selective. Selectivity is learned.
          minConfidence: 45,
          minCompositeScore: 8,
          minAdx: 10,
          maxAtrPct: 14,
          requireMtfAlignment: false,
        },
      })
      const riskPlan = analysis.plan ?? analysis.shadowPlan
      if (!riskPlan) continue
      const candidates = evaluateStrategies(analysis)
      const selected = candidates.find((candidate) => candidate.eligible && candidate.side === riskPlan.side) ?? candidates.find((candidate) => candidate.side === riskPlan.side)
      if (!selected) continue

      const features = buildFeatureVector({
        compositeScore: analysis.compositeScore,
        mtfAlignment: analysis.mtfAlignment,
        indicators: analysis.indicators,
        playbookScore: selected.score,
        marketContext: analysis.marketContext,
        derivatives: analysis.derivatives,
      })

      const plan = createPaperPlan({
        id: `harvest:${symbol}:${timeframe}:${availableAt}`,
        instId: symbol,
        timeframe,
        signalAt: availableAt,
        playbook: selected.playbook,
        policyVersion: 'harvest-v1',
        plan: riskPlan,
        atrAtEntry: analysis.indicators.volatility.atr,
        feeBps: 5,
        slippageBps: Math.max(1, riskPlan.slippageBps),
        instType: spec.instType,
        features,
      })
      const trade = runPaperPlan(plan, ltf.slice(index + 1, index + 1 + plan.maxHoldBars + plan.maxEntryBars + 2))
      lastTs = signalBar.ts
      if (trade.status !== 'closed' || trade.filledAt == null) continue

      this.evolution.recordBackfillSample({
        at: availableAt,
        symbol,
        features,
        label: trade.netRealizedR > 0 ? 1 : 0,
        netR: trade.netRealizedR,
        horizonEndAt: trade.closedAt ?? availableAt,
        instType: spec.instType,
        timeframe,
        playbook: selected.playbook,
        tradeId: trade.id,
      })
      added++
      if (index % 60 === 0) await sleep(0) // yield so the live loops keep breathing
    }
    if (lastTs > lastDone) this.setCursor(cursorKey, lastTs)
    return added
  }
}
