/**
 * Tape builder — turns stored candles into a testable decision tape.
 *
 * The old harvester fetched candles from OKX on every run and wrote one row per
 * bar for a single playbook, with a 14-of-32 feature vector. This builder:
 *
 *   • reads bars from the local SQLite first (6 M+ are already there) and only
 *     calls OKX when the local series is too short — so a full rebuild costs no
 *     rate limit and finishes in seconds instead of minutes
 *   • writes one row per PLAYBOOK per bar, in both directions, whenever the
 *     playbook is eligible or a single condition away from eligible — which is what
 *     finally gives every niche real coverage instead of the 18 accidental ones
 *   • stores the FULL price path that followed, so any exit policy, any stop, any
 *     take-profit ladder and any RL exit agent can be re-simulated later without
 *     touching a candle again
 *   • uses the V3 feature builder, which is the same code the live path uses, so
 *     there is no train/serve distribution shift
 */
import { log } from '../log.js'
import { fetchCandles } from '../okx/market.js'
import { analyze } from '../quant/engine.js'
import { buildRiskPlan } from '../quant/risk.js'
import { higherTimeframes, barMinutes } from '../quant/timeframes.js'
import { tradingContinuity } from '../quant/universe.js'
import { DEFAULT_SETTINGS, type Candle, type InstrumentSpec } from '../quant/types.js'
import { evaluateStrategies } from '../strategies/registry.js'
import type { DurableStore } from '../store/durable.js'
import { TAPE_MAX_BARS, type TapeInsert, type TapePathBar, type TapeStore } from '../store/tape-store.js'
import { buildFeatureVectorV3, FEATURE_SCHEMA_V3, type DerivativesExtras } from './features-v3.js'
import { simulateTapeRow } from '../arena/exit-sim.js'
import type { PlaybookId as RiskPlaybookId } from '../quant/types.js'
import type { PlaybookId } from '../strategies/registry.js'

/**
 * The strategy registry and the risk engine use two different playbook
 * vocabularies. This is the single place that translates between them, so a
 * mismatch can never silently pick the wrong stop multiplier.
 */
const RISK_PLAYBOOK: Record<PlaybookId, RiskPlaybookId> = {
  trend_pullback: 'trend_pullback',
  volatility_breakout: 'squeeze_breakout',
  range_fade: 'range_fade',
}

export interface BuildSeriesRequest {
  symbol: string
  instType: string
  timeframe: string
  spec: InstrumentSpec
  bars?: number
  /** benchmark bars (BTC) on the SAME timeframe, used for beta / relative strength */
  benchmark?: readonly Candle[] | null
  /** allow network top-ups when the local series is short */
  allowFetch?: boolean
  /** per-bar sampling stride; 1 = every bar */
  stride?: number
  derivatives?: DerivativesExtras | null
}

export interface BuildSeriesResult {
  symbol: string
  timeframe: string
  scannedBars: number
  candidates: number
  inserted: number
  fetched: boolean
  error?: string
}

/**
 * Cheap, purely candle-derived regime id compatible with the live detector's
 * vocabulary (0 calm-trend, 1 calm-range, 2 volatile-trend, 3 volatile-range,
 * 4 crisis). It exists so the regime column is real in history too.
 */
export function classifyRegimeFromCandles(window: readonly Candle[]): number {
  if (window.length < 40) return 1
  const closes = window.map((candle) => candle.close)
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(Math.max(1e-12, closes[i] / closes[i - 1])))
  const recent = rets.slice(-30)
  const long = rets.slice(-120)
  const sd = (values: number[]) => {
    if (values.length < 2) return 0
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
  }
  const shortVol = sd(recent)
  const longVol = sd(long) || shortVol
  const volRatio = longVol > 0 ? shortVol / longVol : 1
  const netMove = Math.abs(closes[closes.length - 1] / closes[Math.max(0, closes.length - 30)] - 1)
  const pathMove = recent.reduce((sum, value) => sum + Math.abs(value), 0)
  const efficiency = pathMove > 0 ? netMove / pathMove : 0
  const trending = efficiency > 0.28
  if (volRatio > 2.4) return 4
  const volatile = volRatio > 1.35
  if (trending && !volatile) return 0
  if (!trending && !volatile) return 1
  if (trending && volatile) return 2
  return 3
}

function relativePath(candles: readonly Candle[], from: number, count: number, entry: number): TapePathBar[] {
  const out: TapePathBar[] = []
  const end = Math.min(candles.length, from + count)
  for (let i = from; i < end; i++) {
    const candle = candles[i]
    out.push({ o: candle.open / entry - 1, h: candle.high / entry - 1, l: candle.low / entry - 1, c: candle.close / entry - 1 })
  }
  return out
}

export class TapeBuilder {
  constructor(
    private readonly store: DurableStore,
    private readonly tape: TapeStore,
  ) {}

  /** Load bars from SQLite, topping up from OKX only when the local series is short. */
  async series(symbol: string, timeframe: string, bars: number, allowFetch: boolean): Promise<{ candles: Candle[]; fetched: boolean }> {
    const local = this.store.loadCandles(symbol, timeframe, bars).filter((candle) => candle.confirmed)
    if (local.length >= Math.min(bars, 400) || !allowFetch) return { candles: local, fetched: false }
    try {
      const remote = (await fetchCandles(symbol, timeframe, bars, { history: true })).filter((candle) => candle.confirmed)
      if (remote.length) {
        this.store.upsertCandles(symbol, timeframe, remote)
        const merged = new Map<number, Candle>()
        for (const candle of [...local, ...remote]) merged.set(candle.ts, candle)
        return { candles: [...merged.values()].sort((a, b) => a.ts - b.ts), fetched: true }
      }
    } catch (error) {
      log.error('tape', `${symbol} ${timeframe} fetch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { candles: local, fetched: false }
  }

  async buildSeries(request: BuildSeriesRequest): Promise<BuildSeriesResult> {
    const { symbol, timeframe, instType, spec } = request
    const bars = Math.min(3000, Math.max(400, request.bars ?? 1200))
    const stride = Math.max(1, request.stride ?? 1)
    const allowFetch = request.allowFetch ?? true
    const result: BuildSeriesResult = { symbol, timeframe, scannedBars: 0, candidates: 0, inserted: 0, fetched: false }

    const [htfName, htf2Name] = higherTimeframes(timeframe)
    const ltfLoad = await this.series(symbol, timeframe, bars, allowFetch)
    result.fetched = ltfLoad.fetched
    const ltf = ltfLoad.candles
    if (ltf.length < 340) {
      result.error = `insufficient_bars(${ltf.length})`
      return result
    }
    // Refuse to learn from anything that is not a continuously traded market:
    // tokenized equities and dormant listings would otherwise dominate the tape
    // with weekend gaps and flat sessions.
    const continuity = tradingContinuity(ltf, barMinutes(timeframe) * 60_000)
    if (!continuity.continuous) {
      result.error = `not_continuously_traded(${continuity.reason})`
      return result
    }
    const htf = (await this.series(symbol, htfName, Math.round(bars * 0.6), allowFetch)).candles
    const htf2 = (await this.series(symbol, htf2Name, Math.round(bars * 0.35), allowFetch)).candles

    const cursorKey = `${symbol}|${timeframe}|v3`
    const lastDone = this.tape.cursor(cursorKey)
    const pending: TapeInsert[] = []
    const warmup = 260
    let lastTs = lastDone

    for (let index = warmup; index < ltf.length - 12; index += stride) {
      const signalBar = ltf[index]
      if (signalBar.ts <= lastDone) continue
      const closedAt = signalBar.ts + barMinutes(timeframe) * 60_000
      result.scannedBars++

      const ltfWindow = ltf.slice(Math.max(0, index - 299), index + 1)
      const htfWindow = htf.filter((candle) => candle.ts < closedAt).slice(-220)
      const htf2Window = htf2.filter((candle) => candle.ts < closedAt).slice(-160)
      const benchWindow = request.benchmark ? request.benchmark.filter((candle) => candle.ts < closedAt).slice(-160) : null

      let analysis
      try {
        analysis = analyze({
          instId: symbol,
          instType,
          spec,
          ltf: ltfWindow,
          htf: htfWindow,
          htf2: htf2Window,
          livePrice: signalBar.close,
          now: closedAt,
          settings: {
            ...DEFAULT_SETTINGS,
            instId: symbol,
            timeframe,
            htfTimeframe: htfName,
            htf2Timeframe: htf2Name,
            useDerivatives: false,
            useEmpiricalEdge: false,
            // Permissive on purpose: the tape must describe the whole behaviour
            // space. Selectivity is what the models are supposed to learn.
            minConfidence: 40,
            minCompositeScore: 5,
            minAdx: 8,
            maxAtrPct: 18,
            requireMtfAlignment: false,
          },
        })
      } catch {
        continue
      }

      const regimeId = classifyRegimeFromCandles(ltfWindow)
      const candidates = evaluateStrategies(analysis)

      for (const candidate of candidates) {
        // eligible, or a single condition away: the informative population
        if (candidate.rejectionReasons.length > 1) continue
        result.candidates++

        let plan
        try {
          plan = buildRiskPlan({
            side: candidate.side,
            entry: signalBar.close,
            indicators: analysis.indicators,
            settings: {
              ...DEFAULT_SETTINGS,
              instId: symbol,
              timeframe,
              htfTimeframe: htfName,
              htf2Timeframe: htf2Name,
              useDerivatives: false,
              useEmpiricalEdge: false,
            },
            spec,
            conviction: analysis.conviction,
            playbook: RISK_PLAYBOOK[candidate.playbook],
            equityUsd: DEFAULT_SETTINGS.equityUsd ?? 10_000,
            barMinutes: barMinutes(timeframe),
            playbookScore: candidate.score,
            compositeScore: analysis.compositeScore,
            mtfAlignment: analysis.mtfAlignment,
          })
        } catch {
          continue
        }
        if (!(plan.entry > 0) || !(plan.stopLoss > 0) || !plan.takeProfits.length) continue
        if (candidate.side === 'LONG' ? plan.stopLoss >= plan.entry : plan.stopLoss <= plan.entry) continue

        const features = buildFeatureVectorV3({
          ltf: ltfWindow,
          htf: htfWindow,
          htf2: htf2Window,
          benchmark: benchWindow,
          at: closedAt,
          side: candidate.side,
          playbookScore: candidate.score,
          compositeScore: analysis.compositeScore,
          conviction: analysis.conviction,
          derivatives: request.derivatives ?? null,
          regimeId,
          volForecastNormalized: null,
        })

        const maxEntryBars = 3
        const pathBars = Math.min(TAPE_MAX_BARS, plan.timeStopBars + maxEntryBars + 2)
        const path = relativePath(ltf, index + 1, pathBars, plan.entry)
        if (path.length < 8) continue
        // Clamp the time stop to what the stored path can actually resolve, so a
        // replayed trade is never left hanging and mark-to-market guesswork never
        // enters a training label.
        const maxHoldBars = Math.max(4, Math.min(plan.timeStopBars, path.length - maxEntryBars))

        const targets = plan.takeProfits.map((target) => ({ price: target.price, allocation: target.allocationPct / 100 }))
        const allocationSum = targets.reduce((sum, target) => sum + target.allocation, 0)
        if (!(allocationSum > 0.5)) continue

        const row: TapeInsert = {
          at: closedAt,
          symbol,
          instType,
          timeframe,
          playbook: candidate.playbook,
          side: candidate.side,
          featureSchema: FEATURE_SCHEMA_V3,
          features,
          entry: plan.entry,
          entryLow: Math.min(...plan.entryZone),
          entryHigh: Math.max(...plan.entryZone),
          stop: plan.stopLoss,
          targets: targets.map((target) => ({ price: target.price, allocation: target.allocation / allocationSum })),
          atr: analysis.indicators.volatility.atr,
          maxEntryBars,
          maxHoldBars,
          trailAtrMult: plan.trailAtrMult,
          feeBps: 5,
          slippageBps: Math.max(1, plan.slippageBps || 2),
          fundingRate8h: request.derivatives?.fundingRate ?? null,
          regimeId,
          path,
          baselineNetR: null,
          baselineLabel: null,
          horizonEndAt: closedAt + (path.length + 1) * barMinutes(timeframe) * 60_000,
          source: 'replay',
        }

        // Resolve the baseline outcome immediately so light queries never need the path.
        const simulated = simulateTapeRow({ ...row, id: 0 }, { id: 'plan', label: 'plan', stopMult: 1, tpR: [], allocations: [], trailAtrMult: plan.trailAtrMult, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true })
        if (!simulated.filled) continue
        row.baselineNetR = Number(simulated.netR.toFixed(5))
        row.baselineLabel = simulated.netR > 0 ? 1 : 0
        row.horizonEndAt = closedAt + (simulated.barsPending + simulated.barsHeld + 1) * barMinutes(timeframe) * 60_000
        pending.push(row)
      }

      lastTs = signalBar.ts
      // Yield often: `analyze()` is synchronous and a long replay would otherwise
      // block the HTTP API and the WebSocket feed for minutes.
      if (result.scannedBars % 6 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      if (pending.length >= 400) {
        result.inserted += this.tape.insert(pending)
        pending.length = 0
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }

    if (pending.length) result.inserted += this.tape.insert(pending)
    if (lastTs > lastDone) this.tape.setCursor(cursorKey, lastTs)
    return result
  }
}
