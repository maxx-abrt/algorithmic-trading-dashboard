/**
 * Statistical layer — the part most retail systems never compute.
 *
 * It answers three questions the indicator soup cannot:
 *   1. is this series trending or mean-reverting right now?  (Hurst exponent)
 *   2. how statistically real is the trend?                  (regression R² / t-stat)
 *   3. how stretched is price versus its own distribution?    (z-score, skew)
 */
import { clamp, lastN, mean, safe, softSign, stdev } from './math'
import type { Ohlcv } from './indicators'

export interface StatsBlock {
  /** 0.5 = random walk, >0.55 trending/persistent, <0.45 mean-reverting */
  hurst: number
  /** least-squares slope of log price, % per bar */
  regSlopePct: number
  /** goodness of fit 0..1 — how clean the trend is */
  regR2: number
  /** slope significance; |t| > 2 means the drift is unlikely to be noise */
  regTstat: number
  regMid: number
  regUpper: number
  regLower: number
  /** position inside the ±2σ regression channel, 0..1 */
  regPos: number
  /** (price - SMA20) / σ20 */
  zScore20: number
  /** lag-1 autocorrelation of returns — negative = choppy reversion */
  autocorr1: number
  skew: number
  kurtosis: number
  /** -100 (strongly trending) .. +100 (strongly mean-reverting) */
  meanReversion: number
  /** 0..100 confidence that the current drift persists */
  trendPersistence: number
  /** directional score -100..100 blending drift quality and stretch */
  score: number
}

function returnsOf(closes: number[]) {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]))
  }
  return out
}

/**
 * Hurst exponent via the aggregated absolute-difference scaling law:
 *   E|X(t+k) - X(t)| ~ k^H
 * Robust on short windows (unlike full R/S) and cheap.
 */
export function hurstExponent(closes: number[]): number {
  const w = lastN(closes, 240).filter((v) => v > 0)
  if (w.length < 64) return 0.5
  const logs = w.map((v) => Math.log(v))
  const lags = [2, 4, 8, 16, 32, 64].filter((k) => k < logs.length / 2)
  const xs: number[] = []
  const ys: number[] = []
  for (const k of lags) {
    let acc = 0
    let n = 0
    for (let i = k; i < logs.length; i++) {
      acc += Math.abs(logs[i] - logs[i - k])
      n++
    }
    if (!n) continue
    const md = acc / n
    if (md <= 0) continue
    xs.push(Math.log(k))
    ys.push(Math.log(md))
  }
  if (xs.length < 3) return 0.5
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return clamp(den === 0 ? 0.5 : num / den, 0.05, 0.95)
}

/** Least-squares channel on log price. */
export function regressionChannel(closes: number[], lookback = 100) {
  const w = lastN(closes, lookback).filter((v) => v > 0)
  const n = w.length
  if (n < 12) {
    const p = w[n - 1] ?? 0
    return { slopePct: 0, r2: 0, tstat: 0, mid: p, upper: p, lower: p, pos: 0.5 }
  }
  const y = w.map((v) => Math.log(v))
  const xm = (n - 1) / 2
  const ym = mean(y)
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - xm) * (y[i] - ym)
    sxx += (i - xm) ** 2
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = ym - slope * xm
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    const fit = intercept + slope * i
    ssRes += (y[i] - fit) ** 2
    ssTot += (y[i] - ym) ** 2
  }
  const r2 = ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1)
  const sigma = Math.sqrt(ssRes / Math.max(1, n - 2))
  const seSlope = sxx > 0 ? sigma / Math.sqrt(sxx) : 0
  const tstat = seSlope > 0 ? slope / seSlope : 0
  const midLog = intercept + slope * (n - 1)
  const mid = Math.exp(midLog)
  const upper = Math.exp(midLog + 2 * sigma)
  const lower = Math.exp(midLog - 2 * sigma)
  const price = w[n - 1]
  const pos = upper > lower ? clamp((price - lower) / (upper - lower), -0.5, 1.5) : 0.5
  return { slopePct: slope * 100, r2, tstat, mid, upper, lower, pos }
}

export function computeStats(d: Ohlcv): StatsBlock {
  const c = d.close
  const price = c[c.length - 1] ?? 0
  const rets = returnsOf(lastN(c, 120))
  const hurst = hurstExponent(c)
  const reg = regressionChannel(c, 100)

  const sma20 = mean(lastN(c, 20))
  const sd20 = stdev(lastN(c, 20))
  const zScore20 = sd20 > 0 ? (price - sma20) / sd20 : 0

  let autocorr1 = 0
  if (rets.length > 12) {
    const m = mean(rets)
    let num = 0
    let den = 0
    for (let i = 1; i < rets.length; i++) num += (rets[i] - m) * (rets[i - 1] - m)
    for (const r of rets) den += (r - m) ** 2
    autocorr1 = den > 0 ? clamp(num / den, -1, 1) : 0
  }

  const sd = stdev(rets)
  const m = mean(rets)
  let skew = 0
  let kurt = 3
  if (rets.length > 12 && sd > 0) {
    skew = mean(rets.map((r) => ((r - m) / sd) ** 3))
    kurt = mean(rets.map((r) => ((r - m) / sd) ** 4))
  }

  // Reversion pressure: sub-random-walk Hurst + negative autocorrelation.
  const meanReversion = clamp((0.5 - hurst) * 320 + -autocorr1 * 60, -100, 100)
  const trendPersistence = clamp((hurst - 0.5) * 260 + reg.r2 * 45, 0, 100)

  // Directional: a statistically clean drift, faded when price is stretched
  // beyond the channel in a reverting regime.
  const drift = softSign(reg.slopePct * (0.4 + reg.r2), 0.35) * clamp(Math.abs(reg.tstat) / 3, 0.2, 1)
  const stretch = meanReversion > 25 ? -softSign(zScore20, 2.2) * 0.8 : 0
  const score = clamp(drift * 0.75 + stretch * 25 + softSign(reg.pos - 0.5, 0.8) * 0.15 * (trendPersistence / 100) * 100, -100, 100)

  return {
    hurst: safe(hurst, 0.5),
    regSlopePct: safe(reg.slopePct),
    regR2: safe(reg.r2),
    regTstat: safe(reg.tstat),
    regMid: safe(reg.mid, price),
    regUpper: safe(reg.upper, price),
    regLower: safe(reg.lower, price),
    regPos: safe(reg.pos, 0.5),
    zScore20: safe(zScore20),
    autocorr1: safe(autocorr1),
    skew: safe(skew),
    kurtosis: safe(kurt, 3),
    meanReversion: safe(meanReversion),
    trendPersistence: safe(trendPersistence),
    score: safe(score),
  }
}
