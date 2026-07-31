/**
 * Second-generation indicator blocks: the ones that separate a decent system
 * from a good one. Advanced volatility estimators (Parkinson, Garman-Klass,
 * EWMA forecast), expected-move projection, and extra trend/flow overlays
 * (Donchian, VWMA, Elder-Ray, KST, Ultimate Oscillator, Vortex, Heikin-Ashi).
 */
import { KST, WMA } from 'technicalindicators'
import { clamp, lastN, maxOf, mean, minOf, percentileRank, safe, softSign, stdev, sum } from './math'
import type { Ohlcv } from './indicators'
import { atrSeries, emaSeries } from './indicators'
import type { Candle } from './types'

/* -------------------------------------------------------------------------- */
/*  Advanced volatility                                                        */
/* -------------------------------------------------------------------------- */

export interface AdvancedVolBlock {
  /** annualised %, high-low estimator (5x more efficient than close-to-close) */
  parkinsonVolPct: number
  /** annualised %, uses the full OHLC — best single-bar estimator */
  garmanKlassVolPct: number
  /** annualised %, RiskMetrics EWMA (λ = 0.94) */
  ewmaVolPct: number
  /** one-bar-ahead σ forecast in % of price */
  forecastBarSigmaPct: number
  /** σ of the volatility series itself — regime instability */
  volOfVol: number
  /** expected 1σ move over the planned holding horizon, % */
  expectedMovePct: number
  /** horizon used for the projection, in bars */
  horizonBars: number
  /** current ATR / 50-bar average ATR */
  atrExpansion: number
  /** rising | falling | stable */
  volTrend: 'rising' | 'falling' | 'stable'
  /** true when the last bar is a >2.5σ volume+range event */
  climax: boolean
  /** percentile of this hour-of-day realised range (0-100) */
  hourVolRank: number
}

const SQ = Math.sqrt

export function computeAdvancedVol(
  candles: readonly Candle[],
  d: Ohlcv,
  barsPerYear: number,
  horizonBars = 12,
): AdvancedVolBlock {
  const n = d.close.length
  const price = d.close[n - 1] ?? 0
  const win = Math.min(60, Math.max(10, n - 1))

  // Parkinson: sqrt( 1/(4n ln2) * sum(ln(H/L)^2) )
  let park = 0
  let gk = 0
  let count = 0
  for (let i = n - win; i < n; i++) {
    if (i < 1) continue
    const h = d.high[i]
    const l = d.low[i]
    const o = d.open[i]
    const c = d.close[i]
    if (!(h > 0 && l > 0 && o > 0 && c > 0) || h < l) continue
    const hl = Math.log(h / l)
    park += hl * hl
    gk += 0.5 * hl * hl - (2 * Math.log(2) - 1) * Math.log(c / o) ** 2
    count++
  }
  const parkinson = count > 0 ? SQ(park / (4 * Math.log(2) * count)) : 0
  const garman = count > 0 ? SQ(Math.max(0, gk / count)) : 0

  // EWMA (RiskMetrics) on log returns.
  const rets: number[] = []
  for (let i = Math.max(1, n - 120); i < n; i++) {
    if (d.close[i - 1] > 0 && d.close[i] > 0) rets.push(Math.log(d.close[i] / d.close[i - 1]))
  }
  const lambda = 0.94
  let ewmaVar = rets.length ? rets[0] ** 2 : 0
  for (const r of rets) ewmaVar = lambda * ewmaVar + (1 - lambda) * r * r
  const ewma = SQ(Math.max(ewmaVar, 0))

  const annualise = (sigmaPerBar: number) => sigmaPerBar * SQ(barsPerYear) * 100

  // Blend the three estimators for the forward-looking bar sigma.
  const blended = mean([parkinson, garman, ewma].filter((v) => v > 0))
  const forecastBarSigmaPct = blended * 100

  const atrArr = atrSeries(d, 14)
  const atrNow = atrArr[atrArr.length - 1] ?? 0
  const atrAvg = mean(lastN(atrArr, 50))
  const atrExpansion = atrAvg > 0 ? atrNow / atrAvg : 1

  const atrPctSeries = atrArr.map((a, i) => {
    const px = d.close[d.close.length - atrArr.length + i] || price
    return px > 0 ? (a / px) * 100 : 0
  })
  const volOfVol = stdev(lastN(atrPctSeries, 40))
  const recent = mean(lastN(atrPctSeries, 5))
  const older = mean(lastN(atrPctSeries.slice(0, Math.max(1, atrPctSeries.length - 5)), 20))
  const volTrend: AdvancedVolBlock['volTrend'] =
    older > 0 && recent > older * 1.15 ? 'rising' : older > 0 && recent < older * 0.85 ? 'falling' : 'stable'

  // Volume + range climax on the last closed bar.
  const vols = lastN(d.volume, 30)
  const volMean = mean(vols)
  const volSd = stdev(vols)
  const ranges = []
  for (let i = Math.max(0, n - 30); i < n; i++) ranges.push(d.high[i] - d.low[i])
  const rangeMean = mean(ranges)
  const lastRange = d.high[n - 1] - d.low[n - 1]
  const climax =
    volSd > 0 &&
    d.volume[n - 1] > volMean + 2.5 * volSd &&
    rangeMean > 0 &&
    lastRange > rangeMean * 1.8

  // Hour-of-day realised range profile (crypto has very real session effects).
  const hourNow = new Date(candles[candles.length - 1]?.ts ?? Date.now()).getUTCHours()
  const byHour: number[] = []
  const sameHour: number[] = []
  for (const c of candles.slice(-240)) {
    const rng = c.close > 0 ? ((c.high - c.low) / c.close) * 100 : 0
    byHour.push(rng)
    if (new Date(c.ts).getUTCHours() === hourNow) sameHour.push(rng)
  }
  const hourVolRank = sameHour.length >= 3 ? percentileRank(byHour, mean(sameHour)) : 50

  return {
    parkinsonVolPct: safe(annualise(parkinson)),
    garmanKlassVolPct: safe(annualise(garman)),
    ewmaVolPct: safe(annualise(ewma)),
    forecastBarSigmaPct: safe(forecastBarSigmaPct),
    volOfVol: safe(volOfVol),
    expectedMovePct: safe(forecastBarSigmaPct * SQ(Math.max(1, horizonBars))),
    horizonBars,
    atrExpansion: safe(atrExpansion, 1),
    volTrend,
    climax,
    hourVolRank: safe(hourVolRank, 50),
  }
}

/* -------------------------------------------------------------------------- */
/*  Extra trend / flow overlays                                                */
/* -------------------------------------------------------------------------- */

export interface ExtraTrendBlock {
  donchianUpper: number
  donchianLower: number
  donchianMid: number
  /** 0..1 position inside the 20-bar Donchian channel */
  donchianPos: number
  vwma: number
  /** % distance between price and the volume-weighted MA */
  vwmaSpreadPct: number
  /** Elder-Ray bull power (high - EMA13) in ATR units */
  elderBull: number
  elderBear: number
  kst: number
  kstSignal: number
  ultimateOsc: number
  vortexPlus: number
  vortexMinus: number
  heikinTrend: 'bull' | 'bear' | 'flat'
  /** consecutive Heikin-Ashi candles in the current direction */
  heikinRun: number
  score: number
}

function ultimateOscillator(d: Ohlcv) {
  const n = d.close.length
  if (n < 30) return 50
  const bp: number[] = []
  const tr: number[] = []
  for (let i = 1; i < n; i++) {
    const trueLow = Math.min(d.low[i], d.close[i - 1])
    bp.push(d.close[i] - trueLow)
    tr.push(Math.max(d.high[i], d.close[i - 1]) - trueLow)
  }
  const avg = (p: number) => {
    const b = sum(lastN(bp, p))
    const t = sum(lastN(tr, p))
    return t > 0 ? b / t : 0.5
  }
  return clamp((4 * avg(7) + 2 * avg(14) + avg(28)) / 7 * 100, 0, 100)
}

function vortex(d: Ohlcv, period = 14) {
  const n = d.close.length
  if (n < period + 2) return { plus: 1, minus: 1 }
  let vmPlus = 0
  let vmMinus = 0
  let trSum = 0
  for (let i = n - period; i < n; i++) {
    if (i < 1) continue
    vmPlus += Math.abs(d.high[i] - d.low[i - 1])
    vmMinus += Math.abs(d.low[i] - d.high[i - 1])
    trSum += Math.max(
      d.high[i] - d.low[i],
      Math.abs(d.high[i] - d.close[i - 1]),
      Math.abs(d.low[i] - d.close[i - 1]),
    )
  }
  return { plus: trSum > 0 ? vmPlus / trSum : 1, minus: trSum > 0 ? vmMinus / trSum : 1 }
}

function heikinAshi(d: Ohlcv) {
  const n = d.close.length
  if (n < 4) return { trend: 'flat' as const, run: 0 }
  let haOpen = (d.open[0] + d.close[0]) / 2
  let haClose = (d.open[0] + d.high[0] + d.low[0] + d.close[0]) / 4
  const dirs: number[] = []
  for (let i = 1; i < n; i++) {
    haOpen = (haOpen + haClose) / 2
    haClose = (d.open[i] + d.high[i] + d.low[i] + d.close[i]) / 4
    dirs.push(Math.sign(haClose - haOpen))
  }
  const lastDir = dirs[dirs.length - 1] ?? 0
  let run = 0
  for (let i = dirs.length - 1; i >= 0 && dirs[i] === lastDir && lastDir !== 0; i--) run++
  return { trend: lastDir > 0 ? ('bull' as const) : lastDir < 0 ? ('bear' as const) : ('flat' as const), run }
}

export function computeExtraTrend(d: Ohlcv, atr: number): ExtraTrendBlock {
  const n = d.close.length
  const price = d.close[n - 1] ?? 0
  const unit = atr > 0 ? atr : Math.max(price * 0.002, 1e-9)

  const dcHigh = maxOf(lastN(d.high, 20))
  const dcLow = minOf(lastN(d.low, 20))
  const dcMid = (dcHigh + dcLow) / 2
  const dcPos = dcHigh > dcLow ? clamp((price - dcLow) / (dcHigh - dcLow), 0, 1) : 0.5

  const volWin = lastN(d.volume, 20)
  const pxWin = lastN(d.close, 20)
  const volSum = sum(volWin)
  const vwma = volSum > 0 ? sum(pxWin.map((p, i) => p * volWin[i])) / volSum : price

  const ema13 = emaSeries(d.close, Math.min(13, Math.max(2, n)))
  const e13 = ema13[ema13.length - 1] ?? price
  const elderBull = (d.high[n - 1] - e13) / unit
  const elderBear = (d.low[n - 1] - e13) / unit

  let kst = 0
  let kstSignal = 0
  try {
    if (n > 60) {
      const rows = KST.calculate({
        values: d.close,
        ROCPer1: 10,
        ROCPer2: 15,
        ROCPer3: 20,
        ROCPer4: 30,
        SMAROCPer1: 10,
        SMAROCPer2: 10,
        SMAROCPer3: 10,
        SMAROCPer4: 15,
        signalPeriod: 9,
      }) as unknown as { kst: number; signal: number }[]
      const l = rows[rows.length - 1]
      kst = safe(l?.kst)
      kstSignal = safe(l?.signal)
    }
  } catch {
    /* short history */
  }

  const uo = ultimateOscillator(d)
  const vx = vortex(d)
  const ha = heikinAshi(d)

  const parts = [
    { s: softSign(dcPos - 0.5, 0.4), w: 1 },
    { s: softSign(((price - vwma) / unit), 1.5), w: 0.9 },
    { s: softSign(elderBull + elderBear, 1.2), w: 0.8 },
    { s: softSign(kst - kstSignal, Math.max(Math.abs(kst) * 0.3, 1)), w: 0.9 },
    { s: softSign(uo - 50, 22), w: 0.8 },
    { s: softSign(vx.plus - vx.minus, 0.25), w: 1.1 },
    { s: ha.trend === 'bull' ? clamp(40 + ha.run * 8, 0, 90) : ha.trend === 'bear' ? -clamp(40 + ha.run * 8, 0, 90) : 0, w: 1 },
  ]
  const den = sum(parts.map((p) => p.w))
  const score = clamp(sum(parts.map((p) => p.s * p.w)) / (den || 1), -100, 100)

  return {
    donchianUpper: dcHigh,
    donchianLower: dcLow,
    donchianMid: dcMid,
    donchianPos: dcPos,
    vwma,
    vwmaSpreadPct: vwma > 0 ? ((price - vwma) / vwma) * 100 : 0,
    elderBull: safe(elderBull),
    elderBear: safe(elderBear),
    kst,
    kstSignal,
    ultimateOsc: safe(uo, 50),
    vortexPlus: safe(vx.plus, 1),
    vortexMinus: safe(vx.minus, 1),
    heikinTrend: ha.trend,
    heikinRun: ha.run,
    score: safe(score),
  }
}

export { WMA }
