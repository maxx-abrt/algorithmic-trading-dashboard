/**
 * Indicator layer — every number the decision engine can reason about.
 * All maths runs locally (free); the LLM never sees raw candles.
 */
import {
  ADL,
  ADX,
  ATR,
  AwesomeOscillator,
  BollingerBands,
  CCI,
  ChandelierExit,
  EMA,
  ForceIndex,
  IchimokuCloud,
  MACD,
  MFI,
  OBV,
  PSAR,
  ROC,
  RSI,
  SMA,
  Stochastic,
  StochasticRSI,
  TRIX,
  WilliamsR,
} from 'technicalindicators'
import {
  clamp,
  last,
  lastN,
  maxOf,
  mean,
  minOf,
  percentileRank,
  safe,
  scale,
  slopePct,
  softSign,
  stdev,
  sum,
} from './math'
import type {
  Candle,
  IchimokuBlock,
  MomentumBlock,
  MovingAverages,
  Regime,
  TrendFollowBlock,
  VolatilityBlock,
  VolumeBlock,
} from './types'

/* -------------------------------------------------------------------------- */
/*  Extraction helpers                                                         */
/* -------------------------------------------------------------------------- */

export interface Ohlcv {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  ts: number[]
}

export function toOhlcv(candles: readonly Candle[]): Ohlcv {
  const n = candles.length
  const o = new Array<number>(n)
  const h = new Array<number>(n)
  const l = new Array<number>(n)
  const c = new Array<number>(n)
  const v = new Array<number>(n)
  const t = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const k = candles[i]
    o[i] = k.open
    h[i] = k.high
    l[i] = k.low
    c[i] = k.close
    v[i] = k.volume
    t[i] = k.ts
  }
  return { open: o, high: h, low: l, close: c, volume: v, ts: t }
}

/** Run a library indicator but never throw on short history. */
function guard<T>(fn: () => T[], minBars: number, have: number): T[] {
  if (have < minBars) return []
  try {
    return fn() ?? []
  } catch {
    return []
  }
}

function tail(arr: number[], fallback = 0) {
  const v = arr[arr.length - 1]
  return Number.isFinite(v) ? v : fallback
}

/* -------------------------------------------------------------------------- */
/*  Core primitives                                                            */
/* -------------------------------------------------------------------------- */

export function emaSeries(values: number[], period: number) {
  return guard(() => EMA.calculate({ period, values }), period, values.length)
}

export function smaSeries(values: number[], period: number) {
  return guard(() => SMA.calculate({ period, values }), period, values.length)
}

export function atrSeries(d: Ohlcv, period = 14) {
  return guard(
    () => ATR.calculate({ period, high: d.high, low: d.low, close: d.close }),
    period + 1,
    d.close.length,
  )
}

export function rsiSeries(values: number[], period = 14) {
  return guard(() => RSI.calculate({ period, values }), period + 1, values.length)
}

/** True range of a single bar (used by supertrend / choppiness). */
function trueRange(d: Ohlcv, i: number) {
  if (i === 0) return d.high[0] - d.low[0]
  return Math.max(
    d.high[i] - d.low[i],
    Math.abs(d.high[i] - d.close[i - 1]),
    Math.abs(d.low[i] - d.close[i - 1]),
  )
}

/* -------------------------------------------------------------------------- */
/*  Moving averages                                                            */
/* -------------------------------------------------------------------------- */

export function computeMovingAverages(d: Ohlcv, atr: number): MovingAverages {
  const c = d.close
  const price = tail(c)
  const p = (n: number) => tail(emaSeries(c, Math.min(n, Math.max(2, c.length))), price)
  const s = (n: number) => tail(smaSeries(c, Math.min(n, Math.max(2, c.length))), price)

  const ema9 = p(9)
  const ema21 = p(21)
  const ema50 = p(50)
  const ema100 = p(100)
  const ema200 = p(200)

  const ema50Hist = emaSeries(c, Math.min(50, Math.max(2, c.length)))
  const ema200Hist = emaSeries(c, Math.min(200, Math.max(2, c.length)))

  const ribbon = [ema9, ema21, ema50, ema100, ema200]
  const ribbonWidth = maxOf(ribbon) - minOf(ribbon)

  return {
    ema9,
    ema21,
    ema50,
    ema100,
    ema200,
    sma20: s(20),
    sma50: s(50),
    sma200: s(200),
    ema50SlopePct: slopePct(ema50Hist, 12),
    ema200SlopePct: slopePct(ema200Hist, 20),
    ribbonWidthAtr: atr > 0 ? ribbonWidth / atr : 0,
    stackedBull: ema9 > ema21 && ema21 > ema50 && ema50 > ema200,
    stackedBear: ema9 < ema21 && ema21 < ema50 && ema50 < ema200,
  }
}

/* -------------------------------------------------------------------------- */
/*  Momentum                                                                   */
/* -------------------------------------------------------------------------- */

export function computeMomentum(d: Ohlcv): MomentumBlock {
  const c = d.close
  const rsiArr = rsiSeries(c, 14)
  const rsi = tail(rsiArr, 50)
  const rsiPrev = rsiArr.length > 1 ? rsiArr[rsiArr.length - 2] : rsi
  const rsiSmaArr = smaSeries(rsiArr, Math.min(14, Math.max(2, rsiArr.length)))

  const srsi = guard(
    () =>
      StochasticRSI.calculate({
        values: c,
        rsiPeriod: 14,
        stochasticPeriod: 14,
        kPeriod: 3,
        dPeriod: 3,
      }),
    35,
    c.length,
  )
  const srsiLast = srsi[srsi.length - 1]

  const stoch = guard(
    () =>
      Stochastic.calculate({
        high: d.high,
        low: d.low,
        close: c,
        period: 14,
        signalPeriod: 3,
      }),
    20,
    c.length,
  )
  const stochLast = stoch[stoch.length - 1]

  const macdArr = guard(
    () =>
      MACD.calculate({
        values: c,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
      }),
    35,
    c.length,
  )
  const macdLast = macdArr[macdArr.length - 1]
  const macdPrev = macdArr[macdArr.length - 2]

  const cciArr = guard(
    () => CCI.calculate({ high: d.high, low: d.low, close: c, period: 20 }),
    21,
    c.length,
  )
  const wrArr = guard(
    () => WilliamsR.calculate({ high: d.high, low: d.low, close: c, period: 14 }),
    15,
    c.length,
  )
  const rocArr = guard(() => ROC.calculate({ values: c, period: 9 }), 10, c.length)
  const aoArr = guard(
    () =>
      AwesomeOscillator.calculate({
        high: d.high,
        low: d.low,
        fastPeriod: 5,
        slowPeriod: 34,
      }),
    35,
    c.length,
  )
  const trixArr = guard(() => TRIX.calculate({ values: c, period: 15 }), 50, c.length)

  const macd = safe(macdLast?.MACD, 0)
  const macdSignal = safe(macdLast?.signal, 0)
  const macdHist = safe(macdLast?.histogram, 0)
  const macdHistPrev = safe(macdPrev?.histogram, macdHist)
  const stochRsiK = safe(srsiLast?.k, 50)
  const stochRsiD = safe(srsiLast?.d, 50)
  const stochK = safe(stochLast?.k, 50)
  const stochD = safe(stochLast?.d, 50)
  const cci = tail(cciArr, 0)
  const williamsR = tail(wrArr, -50)
  const roc = tail(rocArr, 0)
  const awesome = tail(aoArr, 0)
  const awesomePrev = aoArr.length > 1 ? aoArr[aoArr.length - 2] : awesome
  const trix = tail(trixArr, 0)

  const price = tail(c, 1)
  // Each sub-score is normalised to -100..100 then blended.
  const parts = [
    { score: softSign(rsi - 50, 25), weight: 1.3 },
    { score: softSign(rsi - rsiPrev, 4), weight: 0.5 },
    { score: softSign(stochRsiK - 50, 40), weight: 0.8 },
    { score: softSign(stochK - 50, 35), weight: 0.6 },
    { score: softSign(macdHist, Math.max(price * 0.0015, 1e-9)), weight: 1.2 },
    { score: softSign(macdHist - macdHistPrev, Math.max(price * 0.0005, 1e-9)), weight: 0.9 },
    { score: softSign(cci, 120), weight: 0.7 },
    { score: softSign(williamsR + 50, 35), weight: 0.5 },
    { score: softSign(roc, 2.5), weight: 0.8 },
    { score: softSign(awesome, Math.max(price * 0.004, 1e-9)), weight: 0.8 },
    { score: softSign(awesome - awesomePrev, Math.max(price * 0.001, 1e-9)), weight: 0.5 },
    { score: softSign(trix, 0.25), weight: 0.4 },
  ]
  const den = sum(parts.map((p) => p.weight))
  const score = clamp(sum(parts.map((p) => p.score * p.weight)) / (den || 1), -100, 100)

  return {
    rsi,
    rsiPrev,
    rsiSma: tail(rsiSmaArr, rsi),
    stochRsiK,
    stochRsiD,
    stochK,
    stochD,
    macd,
    macdSignal,
    macdHist,
    macdHistPrev,
    cci,
    williamsR,
    roc,
    awesome,
    awesomePrev,
    trix,
    score,
  }
}

/* -------------------------------------------------------------------------- */
/*  Volatility + regime                                                        */
/* -------------------------------------------------------------------------- */

/** Choppiness Index — >61.8 = chop, <38.2 = trend. */
function choppinessIndex(d: Ohlcv, period = 14) {
  const n = d.close.length
  if (n < period + 2) return 50
  let atrSum = 0
  for (let i = n - period; i < n; i++) atrSum += trueRange(d, i)
  const hi = maxOf(lastN(d.high, period))
  const lo = minOf(lastN(d.low, period))
  const range = hi - lo
  if (range <= 0 || atrSum <= 0) return 50
  return clamp((100 * Math.log10(atrSum / range)) / Math.log10(period), 0, 100)
}

/** Kaufman efficiency ratio — directional travel / total travel. */
function efficiencyRatio(closes: number[], period = 20) {
  const w = lastN(closes, period + 1)
  if (w.length < 3) return 0
  const direction = Math.abs(w[w.length - 1] - w[0])
  let volatility = 0
  for (let i = 1; i < w.length; i++) volatility += Math.abs(w[i] - w[i - 1])
  return volatility === 0 ? 0 : clamp(direction / volatility, 0, 1)
}

/** Annualised realised volatility from log returns, in %. */
function realizedVol(closes: number[], barsPerYear: number, period = 30) {
  const w = lastN(closes, period + 1)
  if (w.length < 5) return 0
  const rets: number[] = []
  for (let i = 1; i < w.length; i++) {
    if (w[i - 1] > 0 && w[i] > 0) rets.push(Math.log(w[i] / w[i - 1]))
  }
  return stdev(rets) * Math.sqrt(barsPerYear) * 100
}

export function computeVolatility(
  d: Ohlcv,
  barsPerYear: number,
  adx: number,
  emaSlope: number,
): VolatilityBlock {
  const c = d.close
  const price = tail(c)
  const atrArr = atrSeries(d, 14)
  const atr = tail(atrArr, 0)
  const atrPctArr = atrArr.map((a, i) => {
    const px = c[c.length - atrArr.length + i] || price
    return px > 0 ? (a / px) * 100 : 0
  })
  const atrPct = price > 0 ? (atr / price) * 100 : 0

  const bbArr = guard(
    () => BollingerBands.calculate({ period: 20, stdDev: 2, values: c }),
    21,
    c.length,
  )
  const bb = bbArr[bbArr.length - 1]
  const bbUpper = safe(bb?.upper, price)
  const bbMiddle = safe(bb?.middle, price)
  const bbLower = safe(bb?.lower, price)
  const bbWidthPct = bbMiddle > 0 ? ((bbUpper - bbLower) / bbMiddle) * 100 : 0
  const bbWidthHist = bbArr.map((b) => (b.middle > 0 ? ((b.upper - b.lower) / b.middle) * 100 : 0))
  const percentB =
    bbUpper - bbLower > 0 ? clamp((price - bbLower) / (bbUpper - bbLower), -0.5, 1.5) : 0.5

  // Keltner: EMA20 close ± 1.5 ATR20 (standard definition, computed locally so
  // the basis stays an EMA of closes rather than typical price).
  const kMid = tail(emaSeries(c, Math.min(20, Math.max(2, c.length))), price)
  const kAtr = tail(atrSeries(d, 20), atr)
  const keltnerUpper = kMid + 1.5 * kAtr
  const keltnerLower = kMid - 1.5 * kAtr

  const squeeze = bbUpper < keltnerUpper && bbLower > keltnerLower

  const atrAvg = mean(lastN(atrArr, 50))
  const volExpansion = atrAvg > 0 ? clamp((atr / atrAvg) * 50, 0, 200) : 50

  const chop = choppinessIndex(d, 14)
  const eff = efficiencyRatio(c, 20)
  const atrPercentile = percentileRank(lastN(atrPctArr, 120), atrPct)
  const bbWidthPercentile = percentileRank(lastN(bbWidthHist, 120), bbWidthPct)

  let regime: Regime = 'RANGING'
  if (squeeze && bbWidthPercentile < 25) regime = 'SQUEEZE'
  else if (chop > 61.8 && adx < 20) regime = 'CHOPPY'
  else if (adx >= 23 && eff > 0.3 && emaSlope > 0) regime = 'TRENDING_UP'
  else if (adx >= 23 && eff > 0.3 && emaSlope < 0) regime = 'TRENDING_DOWN'
  else if (atrPercentile > 82 && volExpansion > 70) regime = 'EXPANSION'

  return {
    atr,
    atrPct,
    atrPercentile,
    bbUpper,
    bbMiddle,
    bbLower,
    bbWidthPct,
    bbWidthPercentile,
    percentB,
    keltnerUpper,
    keltnerMiddle: kMid,
    keltnerLower,
    squeeze,
    realizedVolPct: realizedVol(c, barsPerYear),
    choppiness: chop,
    efficiencyRatio: eff,
    volExpansion,
    regime,
  }
}

/* -------------------------------------------------------------------------- */
/*  Volume                                                                     */
/* -------------------------------------------------------------------------- */

const INTRADAY_BARS = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H'])

/**
 * Anchored VWAP with standard-deviation bands.
 * Intraday bars anchor to the UTC session (OKX settlement); higher timeframes
 * use the whole visible window.
 */
export function computeVwap(candles: readonly Candle[], timeframe: string) {
  if (!candles.length) {
    return { vwap: 0, sd: 0, slice: candles }
  }
  let slice = candles
  if (INTRADAY_BARS.has(timeframe)) {
    const lastTs = candles[candles.length - 1].ts
    const dayStart = Math.floor(lastTs / 86_400_000) * 86_400_000
    const session = candles.filter((c) => c.ts >= dayStart)
    slice = session.length >= 12 ? session : candles.slice(-60)
  }
  let pv = 0
  let vol = 0
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3
    pv += typical * c.volume
    vol += c.volume
  }
  const vwap = vol > 0 ? pv / vol : slice[slice.length - 1].close

  // Volume-weighted variance around the VWAP for the deviation bands.
  let varAcc = 0
  for (const c of slice) {
    const typical = (c.high + c.low + c.close) / 3
    varAcc += c.volume * (typical - vwap) ** 2
  }
  const sd = vol > 0 ? Math.sqrt(varAcc / vol) : 0
  return { vwap, sd, slice }
}

export function computeVolume(
  candles: readonly Candle[],
  d: Ohlcv,
  timeframe: string,
): VolumeBlock {
  const c = d.close
  const price = tail(c)
  const volume = tail(d.volume)
  const volumeSma = mean(lastN(d.volume, 20))

  const obvArr = guard(() => OBV.calculate({ close: c, volume: d.volume }), 3, c.length)
  const mfiArr = guard(
    () => MFI.calculate({ high: d.high, low: d.low, close: c, volume: d.volume, period: 14 }),
    15,
    c.length,
  )
  const adlArr = guard(
    () => ADL.calculate({ high: d.high, low: d.low, close: c, volume: d.volume }),
    3,
    c.length,
  )
  const fiArr = guard(
    () => ForceIndex.calculate({ close: c, volume: d.volume, period: 13 }),
    14,
    c.length,
  )

  // Cumulative volume delta proxy: signed volume by body position in range.
  let cvd = 0
  const cvdHist: number[] = []
  for (let i = Math.max(0, candles.length - 120); i < candles.length; i++) {
    const k = candles[i]
    const range = k.high - k.low
    const bodyBias = range > 0 ? ((k.close - k.low) - (k.high - k.close)) / range : 0
    cvd += k.volume * bodyBias
    cvdHist.push(cvd)
  }

  const { vwap, sd } = computeVwap(candles, timeframe)
  const vwapDeviationPct = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0
  const vwapZ = sd > 0 ? (price - vwap) / sd : 0

  const obvSlope = slopePct(obvArr, 14)
  const cvdSlope = slopePct(cvdHist, 14)
  const mfi = tail(mfiArr, 50)
  const forceIndex = tail(fiArr, 0)
  const volumeRatio = volumeSma > 0 ? volume / volumeSma : 1

  const parts = [
    { score: softSign(obvSlope, 1.5), weight: 1.2 },
    { score: softSign(cvdSlope, 2), weight: 1.0 },
    { score: softSign(mfi - 50, 25), weight: 0.9 },
    { score: softSign(forceIndex, Math.max(Math.abs(mean(lastN(fiArr, 40))) * 2, 1e-9)), weight: 0.6 },
    { score: softSign(-vwapZ, 2), weight: 0.4 }, // stretched from VWAP = fade pressure
  ]
  const den = sum(parts.map((p) => p.weight))
  const score = clamp(sum(parts.map((p) => p.score * p.weight)) / (den || 1), -100, 100)

  return {
    volume,
    volumeSma,
    volumeRatio,
    obv: tail(obvArr, 0),
    obvSlope,
    mfi,
    adl: tail(adlArr, 0),
    forceIndex,
    cvd,
    cvdSlope,
    vwap,
    vwapUpper1: vwap + sd,
    vwapLower1: vwap - sd,
    vwapUpper2: vwap + 2 * sd,
    vwapLower2: vwap - 2 * sd,
    vwapDeviationPct,
    vwapZ,
    score,
  }
}

/* -------------------------------------------------------------------------- */
/*  Ichimoku                                                                   */
/* -------------------------------------------------------------------------- */

export function computeIchimoku(d: Ohlcv): IchimokuBlock {
  const price = tail(d.close)
  const arr = guard(
    () =>
      IchimokuCloud.calculate({
        high: d.high,
        low: d.low,
        conversionPeriod: 9,
        basePeriod: 26,
        spanPeriod: 52,
        displacement: 26,
      }),
    60,
    d.close.length,
  )
  const l = arr[arr.length - 1]
  const conversion = safe(l?.conversion, price)
  const base = safe(l?.base, price)
  const spanA = safe(l?.spanA, price)
  const spanB = safe(l?.spanB, price)
  const cloudTop = Math.max(spanA, spanB)
  const cloudBottom = Math.min(spanA, spanB)
  const prev = arr[arr.length - 2]
  return {
    conversion,
    base,
    spanA,
    spanB,
    cloudTop,
    cloudBottom,
    priceAboveCloud: price > cloudTop,
    priceBelowCloud: price < cloudBottom,
    tkBull: conversion > base && safe(prev?.conversion, conversion) <= safe(prev?.base, base),
    tkBear: conversion < base && safe(prev?.conversion, conversion) >= safe(prev?.base, base),
  }
}

/* -------------------------------------------------------------------------- */
/*  Trend-following overlays                                                   */
/* -------------------------------------------------------------------------- */

/** Supertrend (ATR 10, factor 3) computed iteratively. */
function supertrend(d: Ohlcv, period = 10, factor = 3) {
  const atrArr = atrSeries(d, period)
  const n = d.close.length
  if (!atrArr.length) return { value: tail(d.close), bull: true }
  const offset = n - atrArr.length
  let upper = 0
  let lower = 0
  let bull = true
  for (let i = 0; i < atrArr.length; i++) {
    const idx = offset + i
    const mid = (d.high[idx] + d.low[idx]) / 2
    const basicUpper = mid + factor * atrArr[i]
    const basicLower = mid - factor * atrArr[i]
    const prevClose = d.close[idx - 1] ?? d.close[idx]
    upper = i === 0 || basicUpper < upper || prevClose > upper ? basicUpper : upper
    lower = i === 0 || basicLower > lower || prevClose < lower ? basicLower : lower
    if (d.close[idx] > upper) bull = true
    else if (d.close[idx] < lower) bull = false
  }
  return { value: bull ? lower : upper, bull }
}

/** Aroon up/down over `period` bars. */
function aroon(d: Ohlcv, period = 25) {
  const hi = lastN(d.high, period + 1)
  const lo = lastN(d.low, period + 1)
  if (hi.length < 3) return { up: 50, down: 50 }
  let hIdx = 0
  let lIdx = 0
  for (let i = 0; i < hi.length; i++) {
    if (hi[i] >= hi[hIdx]) hIdx = i
    if (lo[i] <= lo[lIdx]) lIdx = i
  }
  const len = hi.length - 1
  return {
    up: ((len - (len - hIdx)) / len) * 100,
    down: ((len - (len - lIdx)) / len) * 100,
  }
}

export function computeTrendFollow(d: Ohlcv): TrendFollowBlock {
  const price = tail(d.close)
  const adxArr = guard(
    () => ADX.calculate({ high: d.high, low: d.low, close: d.close, period: 14 }),
    30,
    d.close.length,
  )
  const a = adxArr[adxArr.length - 1]

  const psarArr = guard(
    () => PSAR.calculate({ high: d.high, low: d.low, step: 0.02, max: 0.2 }),
    10,
    d.close.length,
  )
  const psar = tail(psarArr, price)

  // NOTE: the library's .d.ts claims `number[]`, but the runtime returns
  // `{ exitLong, exitShort }[]`. Cast through unknown to use the real shape.
  const ce = guard(
    () =>
      ChandelierExit.calculate({
        high: d.high,
        low: d.low,
        close: d.close,
        period: 22,
        multiplier: 3,
      }) as unknown as number[],
    25,
    d.close.length,
  ) as unknown as { exitLong?: number; exitShort?: number }[]
  const ceLast = ce[ce.length - 1]
  const st = supertrend(d)
  const ar = aroon(d)

  return {
    adx: safe(a?.adx, 15),
    plusDI: safe(a?.pdi, 20),
    minusDI: safe(a?.mdi, 20),
    psar,
    psarBull: price > psar,
    supertrend: st.value,
    supertrendBull: st.bull,
    chandelierLong: safe(ceLast?.exitLong, price),
    chandelierShort: safe(ceLast?.exitShort, price),
    aroonUp: ar.up,
    aroonDown: ar.down,
  }
}

/* -------------------------------------------------------------------------- */
/*  Trend score (one number for the MTF matrix)                                */
/* -------------------------------------------------------------------------- */

export function trendScore(
  price: number,
  ma: MovingAverages,
  trend: TrendFollowBlock,
  ich: IchimokuBlock,
  atr: number,
) {
  const unit = atr > 0 ? atr : Math.max(price * 0.002, 1e-9)
  const parts = [
    { score: softSign((price - ma.ema200) / unit, 3), weight: 1.6 },
    { score: softSign((price - ma.ema50) / unit, 2), weight: 1.2 },
    { score: softSign(ma.ema50SlopePct, 0.35), weight: 1.2 },
    { score: softSign(ma.ema200SlopePct, 0.15), weight: 0.9 },
    { score: ma.stackedBull ? 70 : ma.stackedBear ? -70 : 0, weight: 1.0 },
    { score: softSign(trend.plusDI - trend.minusDI, 15) * scale(trend.adx, 12, 35, 0.3, 1), weight: 1.4 },
    { score: trend.supertrendBull ? 60 : -60, weight: 0.9 },
    { score: trend.psarBull ? 40 : -40, weight: 0.5 },
    { score: softSign(trend.aroonUp - trend.aroonDown, 60), weight: 0.6 },
    {
      score: ich.priceAboveCloud ? 60 : ich.priceBelowCloud ? -60 : 0,
      weight: 0.9,
    },
    { score: ich.conversion > ich.base ? 30 : -30, weight: 0.4 },
  ]
  const den = sum(parts.map((p) => p.weight))
  return clamp(sum(parts.map((p) => p.score * p.weight)) / (den || 1), -100, 100)
}

export function biasFromScore(score: number, threshold = 18): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (score >= threshold) return 'BULLISH'
  if (score <= -threshold) return 'BEARISH'
  return 'NEUTRAL'
}

export { last, lastN }
