/**
 * FEATURE SCHEMA V3 — one vector, identical in live and in replay.
 *
 * Why this file exists
 * --------------------
 * V2 had 32 slots but the historical harvester could only fill 14 of them: every
 * cross-asset, on-chain, order-flow, vol-forecast and regime column was a constant
 * default in all 20 000+ backfilled rows, while the live path filled them with real
 * varying numbers. A model trained on that data sees a different distribution at
 * inference time, which is the textbook way to turn a good idea into noise.
 *
 * V3 fixes it structurally:
 *   1. Every feature that CAN be derived from confirmed candles IS derived from
 *      confirmed candles, by this file, in both paths. No exceptions.
 *   2. Everything that genuinely only exists live (order book, macro APIs, news)
 *      lives in a clearly separated tail block and is accompanied by an
 *      AVAILABILITY FLAG, so a model can learn "ignore this column when the flag
 *      is 0" instead of silently learning a constant.
 *   3. The order is frozen and the schema id is stamped on every sample, so old
 *      rows stay readable forever and can never be mixed with new ones by mistake.
 *
 * Everything is computed from bars that closed strictly BEFORE the decision
 * timestamp. There is no look-ahead anywhere in this file.
 */
import type { Candle } from '../quant/types.js'

export const FEATURE_SCHEMA_V3 = 'v3'

/* -------------------------------------------------------------------------- */
/*  Order (frozen)                                                             */
/* -------------------------------------------------------------------------- */

export const FEATURE_ORDER_V3 = [
  /* ---- returns, multi-horizon, volatility-normalised (0-7) --------------- */
  'ret1',
  'ret3',
  'ret5',
  'ret10',
  'ret20',
  'ret50',
  'retSkew20',
  'retKurt20',
  /* ---- volatility (8-16) ------------------------------------------------- */
  'atrPct',
  'atrPctRank',
  'volRatio5_20',
  'volRatio20_100',
  'parkinsonVol',
  'volOfVol',
  'bbWidth',
  'keltnerWidth',
  'rangeExpansion',
  /* ---- trend (17-27) ----------------------------------------------------- */
  'emaFastDist',
  'emaSlowDist',
  'emaSlope',
  'emaStack',
  'adx',
  'diDelta',
  'macdHist',
  'macdSlope',
  'linRegSlope',
  'linRegR2',
  'hurst',
  /* ---- momentum (28-36) -------------------------------------------------- */
  'rsi',
  'rsiSlope',
  'stochK',
  'stochD',
  'williamsR',
  'cci',
  'roc10',
  'mfi',
  'ultimateOsc',
  /* ---- volume & flow proxies (37-44) ------------------------------------- */
  'volumeRatio',
  'volumeZ',
  'obvSlope',
  'vwapDist',
  'cvdProxy',
  'upDownVolRatio',
  'volumeTrendCorr',
  'illiquidityAmihud',
  /* ---- structure & candle anatomy (45-55) -------------------------------- */
  'donchianPos',
  'distSwingHigh',
  'distSwingLow',
  'rangePos',
  'bodyRatio',
  'upperWick',
  'lowerWick',
  'consecUp',
  'gapPct',
  'closeLocation',
  'pivotDist',
  /* ---- multi-timeframe (56-62) ------------------------------------------- */
  'htfRet10',
  'htfAdx',
  'htfRsi',
  'htfEmaDist',
  'htf2Ret10',
  'htf2EmaDist',
  'mtfAgree',
  /* ---- benchmark / relative strength (63-67) ----------------------------- */
  'benchRet10',
  'benchCorr50',
  'benchBeta50',
  'relStrength20',
  'benchVolRatio',
  /* ---- calendar (68-73) -------------------------------------------------- */
  'hourSin',
  'hourCos',
  'dowSin',
  'dowCos',
  'isWeekend',
  'sessionOverlap',
  /* ---- playbook context (74-77) ----------------------------------------- */
  'playbookScore',
  'compositeScore',
  'convictionScore',
  'sideIsLong',
  /* ---- live-only: derivatives (78-82) ----------------------------------- */
  'fundingRate',
  'oiChange',
  'longShortRatio',
  'takerRatio',
  'basisBps',
  /* ---- live-only: order flow (83-88) ------------------------------------ */
  'bookImbalance',
  'weightedImbalance',
  'spreadBps',
  'microSignal',
  'takerBuyRatio',
  'depthConcentration',
  /* ---- live-only: macro / sentiment (89-95) ----------------------------- */
  'fearGreed',
  'sentiment',
  'btcDominance',
  'marketCapChange',
  'vix',
  'dxyChange',
  'onChainScore',
  /* ---- live-only: news & regime (96-100) -------------------------------- */
  'newsRisk',
  'newsDirection',
  'eventProximity',
  'regimeId',
  'volForecast',
  /* ---- availability flags (101-105) ------------------------------------- */
  'availDerivatives',
  'availOrderFlow',
  'availMacro',
  'availNews',
  'availRegime',
] as const

export const FEATURE_COUNT_V3 = FEATURE_ORDER_V3.length

/** Index of the first live-only column. Everything before it exists in replay too. */
export const FIRST_LIVE_ONLY_INDEX = FEATURE_ORDER_V3.indexOf('fundingRate')

export type FeatureNameV3 = (typeof FEATURE_ORDER_V3)[number]

/* -------------------------------------------------------------------------- */
/*  Small numeric helpers (kept local: zero dependencies, fully deterministic)  */
/* -------------------------------------------------------------------------- */

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)
const clamp01 = (v: number) => clamp(v, 0, 1)
const sym = (v: number) => clamp(v, -1, 1)
const safeDiv = (a: number, b: number, fallback = 0) => (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-12 ? a / b : fallback)

function mean(values: readonly number[]): number {
  if (!values.length) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  let acc = 0
  for (const v of values) acc += (v - m) ** 2
  return Math.sqrt(acc / (values.length - 1))
}

function ema(values: readonly number[], period: number): number[] {
  const out: number[] = []
  const k = 2 / (period + 1)
  let prev = values[0] ?? 0
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

function rma(values: readonly number[], period: number): number[] {
  const out: number[] = []
  let prev = 0
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : (prev * (period - 1) + values[i]) / period
    out.push(prev)
  }
  return out
}

function percentileRank(values: readonly number[], target: number): number {
  if (!values.length) return 0.5
  let below = 0
  for (const v of values) if (v <= target) below++
  return below / values.length
}

function linreg(values: readonly number[]): { slope: number; r2: number } {
  const n = values.length
  if (n < 3) return { slope: 0, r2: 0 }
  const xm = (n - 1) / 2
  const ym = mean(values)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = i - xm
    const dy = values[i] - ym
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  const slope = safeDiv(sxy, sxx)
  const r2 = syy > 0 ? clamp01((sxy * sxy) / (sxx * syy)) : 0
  return { slope, r2 }
}

/** Rescaled-range Hurst exponent on log returns. 0.5 = random walk. */
function hurstExponent(returns: readonly number[]): number {
  if (returns.length < 32) return 0.5
  const sizes = [8, 16, 32, Math.min(64, returns.length)]
  const points: { x: number; y: number }[] = []
  for (const size of sizes) {
    if (size > returns.length) continue
    const chunks = Math.floor(returns.length / size)
    if (chunks < 1) continue
    let rsAcc = 0
    let used = 0
    for (let c = 0; c < chunks; c++) {
      const slice = returns.slice(c * size, (c + 1) * size)
      const m = mean(slice)
      let cum = 0
      let min = Infinity
      let max = -Infinity
      for (const v of slice) {
        cum += v - m
        min = Math.min(min, cum)
        max = Math.max(max, cum)
      }
      const range = max - min
      const sd = stdev(slice)
      if (sd > 1e-12 && range > 0) {
        rsAcc += range / sd
        used++
      }
    }
    if (used > 0) points.push({ x: Math.log(size), y: Math.log(rsAcc / used) })
  }
  if (points.length < 2) return 0.5
  const xm = mean(points.map((p) => p.x))
  const ym = mean(points.map((p) => p.y))
  let sxy = 0
  let sxx = 0
  for (const p of points) {
    sxy += (p.x - xm) * (p.y - ym)
    sxx += (p.x - xm) ** 2
  }
  return clamp(safeDiv(sxy, sxx, 0.5), 0, 1)
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 8) return 0
  const x = a.slice(-n)
  const y = b.slice(-n)
  const xm = mean(x)
  const ym = mean(y)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - xm) * (y[i] - ym)
    sxx += (x[i] - xm) ** 2
    syy += (y[i] - ym) ** 2
  }
  return sxx > 0 && syy > 0 ? sym(sxy / Math.sqrt(sxx * syy)) : 0
}

/* -------------------------------------------------------------------------- */
/*  Candle-derived block (available in BOTH live and replay)                    */
/* -------------------------------------------------------------------------- */

interface Series {
  close: number[]
  high: number[]
  low: number[]
  open: number[]
  volume: number[]
  logRet: number[]
  trueRange: number[]
}

function toSeries(candles: readonly Candle[]): Series {
  const close: number[] = []
  const high: number[] = []
  const low: number[] = []
  const open: number[] = []
  const volume: number[] = []
  for (const candle of candles) {
    close.push(candle.close)
    high.push(candle.high)
    low.push(candle.low)
    open.push(candle.open)
    volume.push(candle.volume)
  }
  const logRet: number[] = []
  for (let i = 1; i < close.length; i++) logRet.push(Math.log(Math.max(1e-12, close[i] / close[i - 1])))
  const trueRange: number[] = []
  for (let i = 1; i < close.length; i++) {
    trueRange.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])))
  }
  return { close, high, low, open, volume, logRet, trueRange }
}

/* -------------------------------------------------------------------------- */
/*  Public input                                                               */
/* -------------------------------------------------------------------------- */

export interface DerivativesExtras {
  fundingRate?: number | null
  openInterestChangePct?: number | null
  longShortRatio?: number | null
  takerRatio?: number | null
  basisBps?: number | null
}

export interface OrderFlowExtras {
  imbalance?: number | null
  weightedImbalance?: number | null
  spreadBps?: number | null
  microSignal?: number | null
  takerBuyRatio?: number | null
  depthConcentration?: number | null
}

export interface MacroExtras {
  fearGreedIndex?: number | null
  sentimentScore?: number | null
  btcDominance?: number | null
  marketCapChange24h?: number | null
  vix?: number | null
  dxyChange?: number | null
  onChainScore?: number | null
}

export interface NewsExtras {
  /** 0..1 aggregate "do not trade into this" risk */
  riskScore?: number | null
  /** -1..1 directional tilt implied by the news flow */
  direction?: number | null
  /** 0..1, 1 = a high-impact scheduled event is imminent */
  eventProximity?: number | null
}

export interface FeatureInputV3 {
  /** confirmed bars, oldest → newest, LAST bar is the decision bar */
  ltf: readonly Candle[]
  htf?: readonly Candle[] | null
  htf2?: readonly Candle[] | null
  /** BTC (or chosen benchmark) bars on the same timeframe, already truncated to the decision time */
  benchmark?: readonly Candle[] | null
  /** decision timestamp (ms) — the moment the decision bar closed */
  at: number
  side?: 'LONG' | 'SHORT'
  playbookScore?: number | null
  compositeScore?: number | null
  conviction?: number | null
  derivatives?: DerivativesExtras | null
  orderFlow?: OrderFlowExtras | null
  macro?: MacroExtras | null
  news?: NewsExtras | null
  regimeId?: number | null
  volForecastNormalized?: number | null
}

/* -------------------------------------------------------------------------- */
/*  Builder                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical V3 vector. Deterministic, allocation-light, and safe on
 * short histories: with fewer than 120 bars the derived columns degrade to
 * neutral values instead of throwing.
 */
export function buildFeatureVectorV3(input: FeatureInputV3): number[] {
  const s = toSeries(input.ltf)
  const n = s.close.length
  const last = s.close[n - 1] ?? 0
  const out = new Array<number>(FEATURE_COUNT_V3).fill(0)
  if (n < 30 || !(last > 0)) return out

  const atrSeries = rma(s.trueRange, 14)
  const atr = atrSeries[atrSeries.length - 1] ?? 0
  const atrPct = safeDiv(atr, last) * 100
  const atrHistory: number[] = []
  for (let i = Math.max(0, atrSeries.length - 200); i < atrSeries.length; i++) {
    const c = s.close[i + 1] ?? last
    atrHistory.push(safeDiv(atrSeries[i], c) * 100)
  }

  const retOf = (bars: number) => {
    const from = s.close[n - 1 - bars]
    if (!(from > 0)) return 0
    // volatility-normalised: a 1% move in a calm market is not a 1% move in chaos
    return sym(safeDiv(Math.log(last / from) * 100, Math.max(0.05, atrPct) * Math.sqrt(bars)) / 2)
  }

  const ret20 = s.logRet.slice(-20)
  const m20 = mean(ret20)
  const sd20 = stdev(ret20)
  const skew = sd20 > 1e-12 ? mean(ret20.map((r) => ((r - m20) / sd20) ** 3)) : 0
  const kurt = sd20 > 1e-12 ? mean(ret20.map((r) => ((r - m20) / sd20) ** 4)) - 3 : 0

  const sd5 = stdev(s.logRet.slice(-5))
  const sd100 = stdev(s.logRet.slice(-100))
  const parkinson = (() => {
    const win = Math.min(20, n - 1)
    let acc = 0
    for (let i = n - win; i < n; i++) acc += Math.log(Math.max(1e-12, s.high[i] / Math.max(1e-12, s.low[i]))) ** 2
    return Math.sqrt(acc / (4 * Math.log(2) * win))
  })()
  const volSeries: number[] = []
  for (let i = 20; i <= s.logRet.length; i += 5) volSeries.push(stdev(s.logRet.slice(i - 20, i)))

  const ema20 = ema(s.close, 20)
  const ema50 = ema(s.close, 50)
  const ema200 = ema(s.close, Math.min(200, Math.max(50, Math.floor(n / 2))))
  const sma20 = mean(s.close.slice(-20))
  const sd20price = stdev(s.close.slice(-20))
  const bbWidth = safeDiv(4 * sd20price, sma20) * 100
  const keltnerWidth = safeDiv(4 * atr, last) * 100

  /* ADX / DI */
  const { adx, diDelta } = (() => {
    const period = 14
    if (n < period * 3) return { adx: 0, diDelta: 0 }
    const plus: number[] = []
    const minus: number[] = []
    for (let i = 1; i < n; i++) {
      const up = s.high[i] - s.high[i - 1]
      const down = s.low[i - 1] - s.low[i]
      plus.push(up > down && up > 0 ? up : 0)
      minus.push(down > up && down > 0 ? down : 0)
    }
    const trs = rma(s.trueRange, period)
    const plusR = rma(plus, period)
    const minusR = rma(minus, period)
    const dx: number[] = []
    for (let i = 0; i < trs.length; i++) {
      const tr = trs[i]
      if (!(tr > 0)) {
        dx.push(0)
        continue
      }
      const pdi = (100 * plusR[i]) / tr
      const mdi = (100 * minusR[i]) / tr
      dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0)
    }
    const adxSeries = rma(dx, period)
    const tr = trs[trs.length - 1] || 1
    const pdi = (100 * (plusR[plusR.length - 1] ?? 0)) / tr
    const mdi = (100 * (minusR[minusR.length - 1] ?? 0)) / tr
    return { adx: adxSeries[adxSeries.length - 1] ?? 0, diDelta: pdi - mdi }
  })()

  const ema12 = ema(s.close, 12)
  const ema26 = ema(s.close, 26)
  const macdLine = ema12.map((value, index) => value - (ema26[index] ?? value))
  const macdSignal = ema(macdLine, 9)
  const macdHist = (macdLine[macdLine.length - 1] ?? 0) - (macdSignal[macdSignal.length - 1] ?? 0)
  const macdHistPrev = (macdLine[macdLine.length - 4] ?? 0) - (macdSignal[macdSignal.length - 4] ?? 0)

  const reg = linreg(s.close.slice(-50).map((v) => Math.log(Math.max(1e-12, v))))

  /* RSI */
  const rsiSeries = (() => {
    const period = 14
    const gains: number[] = []
    const losses: number[] = []
    for (let i = 1; i < n; i++) {
      const delta = s.close[i] - s.close[i - 1]
      gains.push(Math.max(0, delta))
      losses.push(Math.max(0, -delta))
    }
    const ag = rma(gains, period)
    const al = rma(losses, period)
    return ag.map((g, i) => {
      const l = al[i]
      if (!(l > 0)) return g > 0 ? 100 : 50
      const rs = g / l
      return 100 - 100 / (1 + rs)
    })
  })()
  const rsi = rsiSeries[rsiSeries.length - 1] ?? 50
  const rsiPrev = rsiSeries[rsiSeries.length - 6] ?? rsi

  const stoch = (() => {
    const period = 14
    const ks: number[] = []
    for (let i = Math.max(period, n - 20); i < n; i++) {
      const hh = Math.max(...s.high.slice(i - period + 1, i + 1))
      const ll = Math.min(...s.low.slice(i - period + 1, i + 1))
      ks.push(hh > ll ? ((s.close[i] - ll) / (hh - ll)) * 100 : 50)
    }
    const k = ks[ks.length - 1] ?? 50
    const d = mean(ks.slice(-3))
    return { k, d }
  })()

  const williamsR = (() => {
    const period = 14
    const hh = Math.max(...s.high.slice(-period))
    const ll = Math.min(...s.low.slice(-period))
    return hh > ll ? ((hh - last) / (hh - ll)) * -100 : -50
  })()

  const cci = (() => {
    const period = 20
    const tp: number[] = []
    for (let i = n - period; i < n; i++) tp.push((s.high[i] + s.low[i] + s.close[i]) / 3)
    const m = mean(tp)
    const md = mean(tp.map((v) => Math.abs(v - m)))
    return md > 0 ? (tp[tp.length - 1] - m) / (0.015 * md) : 0
  })()

  const mfi = (() => {
    const period = 14
    let pos = 0
    let neg = 0
    for (let i = n - period; i < n; i++) {
      if (i < 1) continue
      const tp = (s.high[i] + s.low[i] + s.close[i]) / 3
      const tpPrev = (s.high[i - 1] + s.low[i - 1] + s.close[i - 1]) / 3
      const flow = tp * s.volume[i]
      if (tp > tpPrev) pos += flow
      else neg += flow
    }
    return pos + neg > 0 ? (100 * pos) / (pos + neg) : 50
  })()

  const ultimate = (() => {
    const bp: number[] = []
    const tr: number[] = []
    for (let i = Math.max(1, n - 30); i < n; i++) {
      const trueLow = Math.min(s.low[i], s.close[i - 1])
      bp.push(s.close[i] - trueLow)
      tr.push(Math.max(s.high[i], s.close[i - 1]) - trueLow)
    }
    const avg = (p: number) => {
      const b = bp.slice(-p).reduce((a, v) => a + v, 0)
      const t = tr.slice(-p).reduce((a, v) => a + v, 0)
      return t > 0 ? b / t : 0.5
    }
    return (100 * (4 * avg(7) + 2 * avg(14) + avg(28))) / 7
  })()

  const volumeMean20 = mean(s.volume.slice(-20))
  const volumeSd20 = stdev(s.volume.slice(-20))
  const obv = (() => {
    const values: number[] = [0]
    for (let i = 1; i < n; i++) {
      const dir = Math.sign(s.close[i] - s.close[i - 1])
      values.push(values[values.length - 1] + dir * s.volume[i])
    }
    return values
  })()
  const obvReg = linreg(obv.slice(-30))
  const vwap = (() => {
    let pv = 0
    let v = 0
    for (let i = Math.max(0, n - 30); i < n; i++) {
      const tp = (s.high[i] + s.low[i] + s.close[i]) / 3
      pv += tp * s.volume[i]
      v += s.volume[i]
    }
    return v > 0 ? pv / v : last
  })()
  const cvdProxy = (() => {
    // Signed volume approximation: where in its range did the bar close?
    let acc = 0
    let total = 0
    for (let i = Math.max(0, n - 30); i < n; i++) {
      const range = s.high[i] - s.low[i]
      const loc = range > 0 ? (2 * (s.close[i] - s.low[i])) / range - 1 : 0
      acc += loc * s.volume[i]
      total += s.volume[i]
    }
    return total > 0 ? acc / total : 0
  })()
  const upDownVol = (() => {
    let up = 0
    let down = 0
    for (let i = Math.max(1, n - 30); i < n; i++) {
      if (s.close[i] >= s.close[i - 1]) up += s.volume[i]
      else down += s.volume[i]
    }
    return up + down > 0 ? up / (up + down) : 0.5
  })()
  const volumeTrendCorr = correlation(s.close.slice(-30), s.volume.slice(-30))
  const amihud = (() => {
    let acc = 0
    let count = 0
    for (let i = Math.max(1, n - 30); i < n; i++) {
      const dollar = s.volume[i] * s.close[i]
      if (dollar > 0) {
        acc += Math.abs(s.logRet[i - 1] ?? 0) / dollar
        count++
      }
    }
    return count ? acc / count : 0
  })()

  const donchianHigh = Math.max(...s.high.slice(-55))
  const donchianLow = Math.min(...s.low.slice(-55))
  const swingHigh = Math.max(...s.high.slice(-20))
  const swingLow = Math.min(...s.low.slice(-20))
  const rangeHigh = Math.max(...s.high.slice(-100))
  const rangeLow = Math.min(...s.low.slice(-100))

  const lastBar = input.ltf[n - 1]
  const prevBar = input.ltf[n - 2]
  const barRange = Math.max(1e-12, lastBar.high - lastBar.low)
  const consecUp = (() => {
    let count = 0
    for (let i = n - 1; i > 0 && count < 8; i--) {
      if (s.close[i] > s.close[i - 1]) count++
      else break
    }
    return count
  })()
  const pivot = (prevBar.high + prevBar.low + prevBar.close) / 3

  /* higher timeframes */
  const htfBlock = (candles?: readonly Candle[] | null) => {
    if (!candles || candles.length < 30) return { ret10: 0, adx: 0, rsi: 0.5, emaDist: 0 }
    const hs = toSeries(candles)
    const hn = hs.close.length
    const hlast = hs.close[hn - 1]
    const hAtr = rma(hs.trueRange, 14)
    const hAtrPct = safeDiv(hAtr[hAtr.length - 1] ?? 0, hlast) * 100
    const from = hs.close[hn - 11] ?? hlast
    const ret10 = sym(safeDiv(Math.log(Math.max(1e-12, hlast / from)) * 100, Math.max(0.05, hAtrPct) * 3) / 2)
    const hEma50 = ema(hs.close, 50)
    const emaDist = sym(safeDiv((hlast - (hEma50[hn - 1] ?? hlast)) * 100, Math.max(1e-9, hlast) * Math.max(0.2, hAtrPct)) / 3)
    const gains: number[] = []
    const losses: number[] = []
    for (let i = 1; i < hn; i++) {
      const d = hs.close[i] - hs.close[i - 1]
      gains.push(Math.max(0, d))
      losses.push(Math.max(0, -d))
    }
    const ag = rma(gains, 14)
    const al = rma(losses, 14)
    const g = ag[ag.length - 1] ?? 0
    const l = al[al.length - 1] ?? 0
    const hrsi = l > 0 ? 100 - 100 / (1 + g / l) : g > 0 ? 100 : 50
    const hreg = linreg(hs.close.slice(-40).map((v) => Math.log(Math.max(1e-12, v))))
    return { ret10, adx: clamp01(Math.abs(hreg.slope) * 4000), rsi: clamp01(hrsi / 100), emaDist }
  }
  const htf = htfBlock(input.htf)
  const htf2 = htfBlock(input.htf2)
  const mtfAgree = sym(Math.sign(retOf(10)) === Math.sign(htf.ret10) ? (Math.sign(htf.ret10) === Math.sign(htf2.ret10) ? 1 : 0.5) : Math.sign(htf.ret10) === Math.sign(htf2.ret10) ? -0.25 : -1)

  /* benchmark relative strength */
  const bench = (() => {
    if (!input.benchmark || input.benchmark.length < 60) return { ret10: 0, corr: 0, beta: 0, rel: 0, volRatio: 0.5 }
    const bs = toSeries(input.benchmark)
    const bn = bs.close.length
    const bLast = bs.close[bn - 1]
    const bFrom = bs.close[bn - 11] ?? bLast
    const bRet10 = Math.log(Math.max(1e-12, bLast / bFrom))
    const ownRet10 = Math.log(Math.max(1e-12, last / (s.close[n - 11] ?? last)))
    const ownRets = s.logRet.slice(-50)
    const benchRets = bs.logRet.slice(-50)
    const corr = correlation(ownRets, benchRets)
    const benchSd = stdev(benchRets)
    const ownSd = stdev(ownRets)
    const beta = benchSd > 1e-12 ? (corr * ownSd) / benchSd : 0
    return {
      ret10: sym(bRet10 * 20),
      corr,
      beta: sym(beta / 3),
      rel: sym((ownRet10 - bRet10) * 20),
      volRatio: clamp01(safeDiv(ownSd, Math.max(1e-12, benchSd), 1) / 3),
    }
  })()

  /* calendar */
  const date = new Date(input.at)
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  const dow = date.getUTCDay()
  const sessionOverlap = hour >= 12 && hour < 16 ? 1 : hour >= 7 && hour < 20 ? 0.5 : 0

  const derivatives = input.derivatives
  const flow = input.orderFlow
  const macro = input.macro
  const news = input.news

  const hasDerivatives = Boolean(derivatives && (derivatives.fundingRate != null || derivatives.openInterestChangePct != null))
  const hasFlow = Boolean(flow && (flow.imbalance != null || flow.spreadBps != null))
  const hasMacro = Boolean(macro && (macro.fearGreedIndex != null || macro.btcDominance != null || macro.vix != null))
  const hasNews = Boolean(news && (news.riskScore != null || news.direction != null))
  const hasRegime = input.regimeId != null || input.volForecastNormalized != null

  let i = 0
  const put = (value: number) => {
    out[i++] = Number.isFinite(value) ? value : 0
  }

  /* returns */
  put(retOf(1))
  put(retOf(3))
  put(retOf(5))
  put(retOf(10))
  put(retOf(20))
  put(retOf(50))
  put(sym(skew / 3))
  put(sym(kurt / 6))
  /* volatility */
  put(clamp01(atrPct / 10))
  put(percentileRank(atrHistory, atrPct))
  put(clamp01(safeDiv(sd5, sd20, 1) / 3))
  put(clamp01(safeDiv(sd20, sd100, 1) / 3))
  put(clamp01(parkinson * 40))
  put(clamp01(safeDiv(stdev(volSeries), mean(volSeries), 0) / 2))
  put(clamp01(bbWidth / 12))
  put(clamp01(keltnerWidth / 12))
  put(clamp01(safeDiv(barRange, Math.max(1e-12, atr), 1) / 3))
  /* trend */
  put(sym(safeDiv((last - (ema20[n - 1] ?? last)) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 3))
  put(sym(safeDiv((last - (ema50[n - 1] ?? last)) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 4))
  put(sym(safeDiv(((ema20[n - 1] ?? last) - (ema20[n - 6] ?? last)) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 2))
  put(sym(((ema20[n - 1] ?? 0) > (ema50[n - 1] ?? 0) ? 0.5 : -0.5) + ((ema50[n - 1] ?? 0) > (ema200[n - 1] ?? 0) ? 0.5 : -0.5)))
  put(clamp01(adx / 50))
  put(sym(diDelta / 40))
  put(sym(safeDiv(macdHist * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 2))
  put(sym(safeDiv((macdHist - macdHistPrev) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct))))
  put(sym(reg.slope * 300))
  put(clamp01(reg.r2))
  put(clamp01(hurstExponent(s.logRet.slice(-128))))
  /* momentum */
  put(clamp01(rsi / 100))
  put(sym((rsi - rsiPrev) / 25))
  put(clamp01(stoch.k / 100))
  put(clamp01(stoch.d / 100))
  put(clamp01((williamsR + 100) / 100))
  put(sym(cci / 200))
  put(sym(safeDiv((last / (s.close[n - 11] ?? last) - 1) * 100, Math.max(0.2, atrPct)) / 3))
  put(clamp01(mfi / 100))
  put(clamp01(ultimate / 100))
  /* volume */
  put(clamp01(safeDiv(s.volume[n - 1], volumeMean20, 1) / 3))
  put(sym(safeDiv(s.volume[n - 1] - volumeMean20, Math.max(1e-9, volumeSd20)) / 3))
  put(sym(safeDiv(obvReg.slope, Math.max(1e-9, volumeMean20)) / 2))
  put(sym(safeDiv((last - vwap) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 3))
  put(sym(cvdProxy))
  put(clamp01(upDownVol))
  put(volumeTrendCorr)
  put(clamp01(Math.log10(1 + amihud * 1e9) / 6))
  /* structure */
  put(clamp01(safeDiv(last - donchianLow, Math.max(1e-12, donchianHigh - donchianLow), 0.5)))
  put(clamp01(safeDiv((swingHigh - last) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 6))
  put(clamp01(safeDiv((last - swingLow) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 6))
  put(clamp01(safeDiv(last - rangeLow, Math.max(1e-12, rangeHigh - rangeLow), 0.5)))
  put(clamp01(Math.abs(lastBar.close - lastBar.open) / barRange))
  put(clamp01((lastBar.high - Math.max(lastBar.close, lastBar.open)) / barRange))
  put(clamp01((Math.min(lastBar.close, lastBar.open) - lastBar.low) / barRange))
  put(sym(consecUp / 5 - (consecUp === 0 ? 0.4 : 0)))
  put(sym(safeDiv((lastBar.open - prevBar.close) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 2))
  put(clamp01((lastBar.close - lastBar.low) / barRange))
  put(sym(safeDiv((last - pivot) * 100, Math.max(1e-9, last) * Math.max(0.2, atrPct)) / 3))
  /* multi-timeframe */
  put(htf.ret10)
  put(htf.adx)
  put(htf.rsi)
  put(htf.emaDist)
  put(htf2.ret10)
  put(htf2.emaDist)
  put(mtfAgree)
  /* benchmark */
  put(bench.ret10)
  put(bench.corr)
  put(bench.beta)
  put(bench.rel)
  put(bench.volRatio)
  /* calendar */
  put(Math.sin((2 * Math.PI * hour) / 24))
  put(Math.cos((2 * Math.PI * hour) / 24))
  put(Math.sin((2 * Math.PI * dow) / 7))
  put(Math.cos((2 * Math.PI * dow) / 7))
  put(dow === 0 || dow === 6 ? 1 : 0)
  put(sessionOverlap)
  /* playbook context */
  put(clamp01((input.playbookScore ?? 50) / 100))
  put(sym((input.compositeScore ?? 0) / 100))
  put(clamp01((input.conviction ?? 50) / 100))
  put(input.side === 'SHORT' ? 0 : 1)
  /* derivatives (live-only) */
  put(hasDerivatives ? sym((derivatives?.fundingRate ?? 0) / 0.001) : 0)
  put(hasDerivatives ? sym((derivatives?.openInterestChangePct ?? 0) / 10) : 0)
  put(hasDerivatives ? sym((derivatives?.longShortRatio ?? 1) - 1) : 0)
  put(hasDerivatives ? sym((derivatives?.takerRatio ?? 1) - 1) : 0)
  put(hasDerivatives ? sym((derivatives?.basisBps ?? 0) / 50) : 0)
  /* order flow (live-only) */
  put(hasFlow ? sym(flow?.imbalance ?? 0) : 0)
  put(hasFlow ? sym(flow?.weightedImbalance ?? 0) : 0)
  put(hasFlow ? clamp01((flow?.spreadBps ?? 0) / 50) : 0)
  put(hasFlow ? sym(flow?.microSignal ?? 0) : 0)
  put(hasFlow ? clamp01(flow?.takerBuyRatio ?? 0.5) : 0)
  put(hasFlow ? clamp01(flow?.depthConcentration ?? 0.5) : 0)
  /* macro (live-only) */
  put(hasMacro ? clamp01((macro?.fearGreedIndex ?? 50) / 100) : 0)
  put(hasMacro ? sym((macro?.sentimentScore ?? 0) / 100) : 0)
  put(hasMacro ? clamp01((macro?.btcDominance ?? 50) / 100) : 0)
  put(hasMacro ? sym((macro?.marketCapChange24h ?? 0) / 10) : 0)
  put(hasMacro ? clamp01((macro?.vix ?? 20) / 50) : 0)
  put(hasMacro ? sym((macro?.dxyChange ?? 0) / 2) : 0)
  put(hasMacro ? sym(macro?.onChainScore ?? 0) : 0)
  /* news + regime */
  put(hasNews ? clamp01(news?.riskScore ?? 0) : 0)
  put(hasNews ? sym(news?.direction ?? 0) : 0)
  put(hasNews ? clamp01(news?.eventProximity ?? 0) : 0)
  put(hasRegime ? clamp01((input.regimeId ?? 2) / 4) : 0)
  put(hasRegime ? clamp01(input.volForecastNormalized ?? 0.5) : 0)
  /* availability flags */
  put(hasDerivatives ? 1 : 0)
  put(hasFlow ? 1 : 0)
  put(hasMacro ? 1 : 0)
  put(hasNews ? 1 : 0)
  put(hasRegime ? 1 : 0)

  return out
}

/** Human-readable dump, used by the UI explainer and by tests. */
export function describeFeatures(vector: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {}
  FEATURE_ORDER_V3.forEach((name, index) => {
    out[name] = Number((vector[index] ?? 0).toFixed(5))
  })
  return out
}
