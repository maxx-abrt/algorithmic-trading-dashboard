import { ATR, EMA, RSI } from 'technicalindicators'
import type {
  Bias,
  Candle,
  Indicators,
  QuantEvaluation,
  Setup,
  Settings,
} from './types.js'

/* -------------------------------------------------------------------------- */
/*  Rolling candle store (RAM only — 300 bars max, O(1) updates)               */
/* -------------------------------------------------------------------------- */

const MAX_BARS = 300

export class CandleSeries {
  private bars: Candle[] = []

  seed(candles: Candle[]) {
    this.bars = candles.slice(-MAX_BARS)
  }

  /** Upsert by open-time: WS resends the forming bar on every tick. */
  upsert(candle: Candle) {
    const last = this.bars[this.bars.length - 1]
    if (last && last.ts === candle.ts) {
      this.bars[this.bars.length - 1] = candle
      return false // same bar
    }
    if (last && candle.ts < last.ts) return false // stale
    this.bars.push(candle)
    if (this.bars.length > MAX_BARS) this.bars.shift()
    return true // new bar opened
  }

  get length() {
    return this.bars.length
  }
  get all(): readonly Candle[] {
    return this.bars
  }
  get last(): Candle | undefined {
    return this.bars[this.bars.length - 1]
  }
  closes() {
    return this.bars.map((c) => c.close)
  }
  highs() {
    return this.bars.map((c) => c.high)
  }
  lows() {
    return this.bars.map((c) => c.low)
  }
}

/* -------------------------------------------------------------------------- */
/*  Indicator maths                                                            */
/* -------------------------------------------------------------------------- */

function lastOf(arr: number[], fallback = Number.NaN) {
  return arr.length ? arr[arr.length - 1] : fallback
}

function ema(values: number[], period: number) {
  if (values.length < period) return lastOf(values)
  return lastOf(EMA.calculate({ period, values }))
}

function rsi(values: number[], period = 14) {
  if (values.length < period + 1) return 50
  return lastOf(RSI.calculate({ period, values }), 50)
}

function atr(candles: readonly Candle[], period = 14) {
  if (candles.length < period + 1) return 0
  return lastOf(
    ATR.calculate({
      period,
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
    }),
    0,
  )
}

/**
 * Keltner Channels (EMA 20 ± 2 × ATR 20).
 * Computed manually so the middle line stays an EMA of closes (the standard
 * definition) rather than the library's typical-price variant.
 */
function keltner(candles: readonly Candle[], period = 20, mult = 2) {
  const middle = ema(
    candles.map((c) => c.close),
    period,
  )
  const a = atr(candles, period)
  return { upper: middle + mult * a, middle, lower: middle - mult * a }
}

/**
 * Session VWAP. For intraday bars we reset at UTC midnight (OKX settlement);
 * for >= 1D bars we use the whole window.
 */
function vwap(candles: readonly Candle[], intraday: boolean) {
  if (!candles.length) return 0
  let slice = candles
  if (intraday) {
    const lastTs = candles[candles.length - 1].ts
    const dayStart = Math.floor(lastTs / 86_400_000) * 86_400_000
    const fromSession = candles.filter((c) => c.ts >= dayStart)
    // Guard: near UTC midnight a session can be 1-2 bars -> fall back to 50 bars.
    slice = fromSession.length >= 10 ? fromSession : candles.slice(-50)
  }
  let pv = 0
  let vol = 0
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3
    pv += typical * c.volume
    vol += c.volume
  }
  return vol > 0 ? pv / vol : slice[slice.length - 1].close
}

/**
 * Volume Profile Point of Control: price level of the highest traded volume,
 * binned over the visible range (default 48 buckets).
 */
function pointOfControl(candles: readonly Candle[], buckets = 48) {
  if (!candles.length) return 0
  const window = candles.slice(-150)
  const hi = Math.max(...window.map((c) => c.high))
  const lo = Math.min(...window.map((c) => c.low))
  if (!(hi > lo)) return window[window.length - 1].close
  const step = (hi - lo) / buckets
  const profile = new Float64Array(buckets)
  for (const c of window) {
    const typical = (c.high + c.low + c.close) / 3
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((typical - lo) / step)))
    profile[idx] += c.volume
  }
  let best = 0
  for (let i = 1; i < buckets; i++) if (profile[i] > profile[best]) best = i
  return lo + (best + 0.5) * step
}

/** Most recent structural swing over `lookback` bars. */
function swings(candles: readonly Candle[], lookback = 20) {
  const w = candles.slice(-lookback)
  if (!w.length) return { swingHigh: 0, swingLow: 0 }
  return {
    swingHigh: Math.max(...w.map((c) => c.high)),
    swingLow: Math.min(...w.map((c) => c.low)),
  }
}

function biasFrom(price: number, ema200Htf: number): Bias {
  if (!Number.isFinite(ema200Htf) || ema200Htf === 0) return 'NEUTRAL'
  const dist = ((price - ema200Htf) / ema200Htf) * 100
  if (dist > 0.15) return 'BULLISH'
  if (dist < -0.15) return 'BEARISH'
  return 'NEUTRAL'
}

const INTRADAY = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H'])

/* -------------------------------------------------------------------------- */
/*  Quant Engine                                                               */
/* -------------------------------------------------------------------------- */

export class QuantEngine {
  readonly ltf = new CandleSeries()
  readonly htf = new CandleSeries()

  seed(ltf: Candle[], htf: Candle[]) {
    this.ltf.seed(ltf)
    this.htf.seed(htf)
  }

  get ready() {
    // EMA200 needs 200 bars; we accept 60+ on HTF and degrade gracefully.
    return this.ltf.length >= 60 && this.htf.length >= 30
  }

  compute(timeframe: string, livePrice?: number): Indicators {
    const bars = this.ltf.all
    const closes = this.ltf.closes()
    const price = livePrice ?? closes[closes.length - 1] ?? 0
    const k = keltner(bars)
    const a = atr(bars)
    const vw = vwap(bars, INTRADAY.has(timeframe))
    const { swingHigh, swingLow } = swings(bars)
    const ema200Htf = ema(this.htf.closes(), Math.min(200, this.htf.length))

    return {
      price,
      ema200: ema(closes, Math.min(200, closes.length)),
      ema200Htf,
      rsi: rsi(closes),
      atr: a,
      atrPct: price > 0 ? (a / price) * 100 : 0,
      vwap: vw,
      vwapDeviationPct: vw > 0 ? ((price - vw) / vw) * 100 : 0,
      poc: pointOfControl(bars),
      keltnerUpper: k.upper,
      keltnerMiddle: k.middle,
      keltnerLower: k.lower,
      swingHigh,
      swingLow,
      htfBias: biasFrom(price, ema200Htf),
    }
  }

  /**
   * The money-saving gate. The LLM is only consulted when a real technical
   * setup exists, so idle markets cost zero tokens.
   */
  evaluate(settings: Settings, livePrice?: number): QuantEvaluation {
    const i = this.compute(settings.timeframe, livePrice)
    const triggers: string[] = []
    let setup: Setup = 'NONE'

    const trendUp = i.htfBias === 'BULLISH' && i.price > i.ema200
    const trendDown = i.htfBias === 'BEARISH' && i.price < i.ema200

    /* --- Strategy 1: trend + momentum pullback (Keltner + RSI) ------------ */
    if (settings.strategy === 'trend_momentum' || settings.strategy === 'hybrid') {
      if (trendUp && i.price <= i.keltnerLower * 1.001 && i.rsi < 40) {
        setup = 'LONG_SETUP'
        triggers.push(
          'HTF bias bullish + price above LTF EMA200',
          `price at/below Keltner lower (${i.keltnerLower.toFixed(4)})`,
          `RSI ${i.rsi.toFixed(1)} < 40`,
        )
      } else if (trendDown && i.price >= i.keltnerUpper * 0.999 && i.rsi > 60) {
        setup = 'SHORT_SETUP'
        triggers.push(
          'HTF bias bearish + price below LTF EMA200',
          `price at/above Keltner upper (${i.keltnerUpper.toFixed(4)})`,
          `RSI ${i.rsi.toFixed(1)} > 60`,
        )
      }
    }

    /* --- Strategy 2: mean reversion (VWAP deviation + POC) ---------------- */
    if (
      setup === 'NONE' &&
      (settings.strategy === 'mean_reversion' || settings.strategy === 'hybrid')
    ) {
      // Deviation threshold scales with realised volatility (ATR%).
      const threshold = Math.max(1.2, i.atrPct * 1.5)
      const belowPoc = i.price < i.poc
      if (i.vwapDeviationPct <= -threshold && i.rsi < 32 && belowPoc) {
        setup = 'LONG_SETUP'
        triggers.push(
          `VWAP deviation ${i.vwapDeviationPct.toFixed(2)}% <= -${threshold.toFixed(2)}%`,
          `RSI ${i.rsi.toFixed(1)} oversold`,
          'price below Volume Profile POC (reversion target above)',
        )
      } else if (i.vwapDeviationPct >= threshold && i.rsi > 68 && !belowPoc) {
        setup = 'SHORT_SETUP'
        triggers.push(
          `VWAP deviation +${i.vwapDeviationPct.toFixed(2)}% >= ${threshold.toFixed(2)}%`,
          `RSI ${i.rsi.toFixed(1)} overbought`,
          'price above Volume Profile POC (reversion target below)',
        )
      }
    }

    const plan = setup === 'NONE' ? null : this.buildPlan(setup, i, settings)

    return {
      indicators: i,
      setup,
      triggers,
      plan,
      compact: this.compact(settings, i, setup, triggers, plan),
    }
  }

  /** ATR + structure based SL, R:R based TP. */
  private buildPlan(setup: Setup, i: Indicators, s: Settings) {
    const side = setup === 'LONG_SETUP' ? 'LONG' : 'SHORT'
    const entry = i.price
    const atrStop = 1.5 * i.atr

    // SL = the tighter of (structure, ATR) but never inside 0.15% of entry.
    let stopLoss =
      side === 'LONG'
        ? Math.max(i.swingLow, entry - atrStop)
        : Math.min(i.swingHigh, entry + atrStop)

    const minDist = entry * 0.0015
    if (side === 'LONG' && entry - stopLoss < minDist) stopLoss = entry - minDist
    if (side === 'SHORT' && stopLoss - entry < minDist) stopLoss = entry + minDist

    const riskDistance = Math.abs(entry - stopLoss)
    const rr = Math.max(2, s.rrRatio)
    const takeProfit =
      side === 'LONG' ? entry + rr * riskDistance : entry - rr * riskDistance

    return { side: side as 'LONG' | 'SHORT', entry, stopLoss, takeProfit, riskDistance, rr }
  }

  /** Ultra-dense payload for the LLM (< ~300 tokens). */
  private compact(
    s: Settings,
    i: Indicators,
    setup: Setup,
    triggers: string[],
    plan: QuantEvaluation['plan'],
  ) {
    const r = (n: number, d = 4) => Number(n.toFixed(d))
    return {
      sym: s.instId,
      tf: s.timeframe,
      htf: s.htfTimeframe,
      px: r(i.price),
      bias: i.htfBias,
      ema200: r(i.ema200),
      ema200_htf: r(i.ema200Htf),
      rsi: r(i.rsi, 1),
      atr_pct: r(i.atrPct, 2),
      kelt: [r(i.keltnerLower), r(i.keltnerMiddle), r(i.keltnerUpper)],
      vwap: r(i.vwap),
      vwap_dev_pct: r(i.vwapDeviationPct, 2),
      poc: r(i.poc),
      swing: [r(i.swingLow), r(i.swingHigh)],
      setup,
      triggers,
      proposed: plan
        ? {
            side: plan.side,
            entry: r(plan.entry),
            sl: r(plan.stopLoss),
            tp: r(plan.takeProfit),
            rr: plan.rr,
          }
        : null,
      max_lev: s.leverage,
    }
  }
}

/** Risk-based position sizing in contracts. */
export function sizePosition(params: {
  equityUsd: number
  riskPct: number
  entry: number
  stopLoss: number
  ctVal: number
  lotSz: number
  minSz: number
  leverage: number
}) {
  const { equityUsd, riskPct, entry, stopLoss, ctVal, lotSz, minSz, leverage } = params
  const riskUsd = equityUsd * (riskPct / 100)
  const stopDist = Math.abs(entry - stopLoss)
  if (stopDist <= 0 || entry <= 0) {
    return { contracts: 0, notionalUsd: 0, riskUsd: 0, marginUsd: 0 }
  }

  // Loss per contract = stop distance × contract value (base units).
  const lossPerContract = stopDist * ctVal
  let contracts = riskUsd / lossPerContract

  // Never exceed the margin the account can post at the chosen leverage.
  const maxNotional = equityUsd * leverage * 0.95
  const maxContracts = maxNotional / (entry * ctVal)
  contracts = Math.min(contracts, maxContracts)

  const decimals = (String(lotSz).split('.')[1] ?? '').length
  contracts = Number((Math.floor(contracts / lotSz) * lotSz).toFixed(decimals))

  if (contracts < minSz) return { contracts: 0, notionalUsd: 0, riskUsd: 0, marginUsd: 0 }

  const notionalUsd = contracts * ctVal * entry
  return {
    contracts,
    notionalUsd,
    riskUsd: contracts * lossPerContract,
    marginUsd: notionalUsd / leverage,
  }
}
