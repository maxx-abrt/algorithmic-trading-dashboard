/**
 * Empirical edge — the reality check.
 *
 * Instead of trusting that "RSI + engulfing at support" works, we go and look:
 * the engine fingerprints the *current* context, scans the instrument's own
 * history for bars whose context matches, then simulates the exact trade we are
 * about to suggest (same ATR stop, same R:R, same horizon) bar by bar.
 *
 * The output is a real hit rate, a real average R and a sample size — which then
 * calibrates conviction and position size. Cheap (O(bars × horizon)) and 100%
 * local, so it costs nothing per evaluation.
 */
import { clamp, lastN, mean } from './math'
import { atrSeries, emaSeries, rsiSeries, toOhlcv } from './indicators'
import type { Candle, Side } from './types'

export interface EdgeBlock {
  /** how many historical analogues were found */
  sample: number
  /** % of analogues that reached the target before the stop */
  winRate: number
  /** average realised R across analogues */
  avgR: number
  expectancyR: number
  avgMfeR: number
  avgMaeR: number
  /** bars used for the forward walk */
  horizonBars: number
  /** 0..1 — how much the sample can be trusted */
  confidence: number
  /** win rate shrunk toward the base rate by sample size (Bayesian-ish) */
  adjustedWinRate: number
  note: string
}

interface Fingerprint {
  trend: number // -1 below both EMAs, 0 mixed, 1 above both
  rsi: number // bucket 0..4
  vol: number // bucket 0..2 (ATR percentile)
  flow: number // bucket 0..2 (volume vs average)
  pos: number // bucket 0..3 (position in 60-bar range)
}

function bucket(value: number, edges: number[]) {
  let b = 0
  for (const e of edges) if (value >= e) b++
  return b
}

function distance(a: Fingerprint, b: Fingerprint) {
  return (
    (a.trend === b.trend ? 0 : 1.5) +
    Math.abs(a.rsi - b.rsi) * 0.8 +
    Math.abs(a.vol - b.vol) * 0.6 +
    Math.abs(a.flow - b.flow) * 0.5 +
    Math.abs(a.pos - b.pos) * 0.7
  )
}

export interface EdgeInput {
  candles: readonly Candle[]
  side: Side
  /** stop distance in ATR units (matches the live risk plan) */
  stopAtr: number
  /** target in R multiples */
  targetR: number
  horizonBars?: number
}

const BASE_RATE = 0.42

export function computeEdge(input: EdgeInput): EdgeBlock {
  const { candles, side, stopAtr, targetR } = input
  const horizon = clamp(Math.round(input.horizonBars ?? 16), 4, 60)
  const empty: EdgeBlock = {
    sample: 0,
    winRate: 0,
    avgR: 0,
    expectancyR: 0,
    avgMfeR: 0,
    avgMaeR: 0,
    horizonBars: horizon,
    confidence: 0,
    adjustedWinRate: BASE_RATE * 100,
    note: 'not enough history for a statistical read',
  }
  const n = candles.length
  if (n < 140) return empty

  const d = toOhlcv(candles)
  const atr = atrSeries(d, 14)
  const atrOffset = n - atr.length
  const rsi = rsiSeries(d.close, 14)
  const rsiOffset = n - rsi.length
  const ema50 = emaSeries(d.close, 50)
  const e50Offset = n - ema50.length
  const ema200 = emaSeries(d.close, Math.min(200, Math.max(20, n - 5)))
  const e200Offset = n - ema200.length

  const atrAt = (i: number) => atr[i - atrOffset] ?? 0
  const rsiAt = (i: number) => rsi[i - rsiOffset] ?? 50
  const e50At = (i: number) => ema50[i - e50Offset] ?? d.close[i]
  const e200At = (i: number) => ema200[i - e200Offset] ?? d.close[i]

  const atrPctSeries: number[] = []
  for (let i = 0; i < n; i++) {
    const a = atrAt(i)
    atrPctSeries.push(d.close[i] > 0 && a > 0 ? (a / d.close[i]) * 100 : 0)
  }
  const atrEdges = [
    quantile(atrPctSeries.filter((v) => v > 0), 0.33),
    quantile(atrPctSeries.filter((v) => v > 0), 0.66),
  ]

  const print = (i: number): Fingerprint => {
    const px = d.close[i]
    const above50 = px > e50At(i)
    const above200 = px > e200At(i)
    const volAvg = mean(d.volume.slice(Math.max(0, i - 20), i + 1))
    const win = d.close.slice(Math.max(0, i - 60), i + 1)
    const hi = Math.max(...d.high.slice(Math.max(0, i - 60), i + 1))
    const lo = Math.min(...d.low.slice(Math.max(0, i - 60), i + 1))
    return {
      trend: above50 && above200 ? 1 : !above50 && !above200 ? -1 : 0,
      rsi: bucket(rsiAt(i), [35, 45, 55, 65]),
      vol: bucket(atrPctSeries[i], atrEdges),
      flow: bucket(volAvg > 0 ? d.volume[i] / volAvg : 1, [0.85, 1.4]),
      pos: bucket(hi > lo ? (px - lo) / (hi - lo) : 0.5, [0.25, 0.5, 0.75]),
      ...(win.length ? {} : {}),
    }
  }

  const current = print(n - 1)
  const dir = side === 'LONG' ? 1 : -1

  const results: { r: number; mfe: number; mae: number; win: boolean }[] = []
  // Leave the last `horizon` bars out: their outcome is not known yet.
  for (let i = 80; i < n - horizon - 1; i++) {
    const a = atrAt(i)
    if (!(a > 0)) continue
    if (distance(print(i), current) > 1.6) continue

    const entry = d.close[i]
    const risk = stopAtr * a
    if (!(risk > 0)) continue
    const stop = entry - dir * risk
    const target = entry + dir * risk * targetR

    let mfe = 0
    let mae = 0
    let closed: number | null = null
    for (let j = i + 1; j <= i + horizon; j++) {
      const fav = dir > 0 ? d.high[j] - entry : entry - d.low[j]
      const adv = dir > 0 ? entry - d.low[j] : d.high[j] - entry
      mfe = Math.max(mfe, fav / risk)
      mae = Math.max(mae, adv / risk)
      const hitStop = dir > 0 ? d.low[j] <= stop : d.high[j] >= stop
      const hitTarget = dir > 0 ? d.high[j] >= target : d.low[j] <= target
      // Conservative: when a bar tags both, assume the stop came first.
      if (hitStop) {
        closed = -1
        break
      }
      if (hitTarget) {
        closed = targetR
        break
      }
    }
    const exit = d.close[Math.min(n - 1, i + horizon)]
    const r = closed ?? ((exit - entry) * dir) / risk
    results.push({ r, mfe, mae, win: r > 0 })
    if (results.length >= 120) break
  }

  if (results.length < 6) {
    return { ...empty, note: `only ${results.length} analogue(s) — treat the read as unproven` }
  }

  const wins = results.filter((r) => r.win).length
  const winRate = (wins / results.length) * 100
  const avgR = mean(results.map((r) => r.r))
  const confidence = clamp(results.length / 40, 0, 1)
  // Shrink toward the base rate when the sample is small.
  const adjusted = (winRate / 100) * confidence + BASE_RATE * (1 - confidence)

  return {
    sample: results.length,
    winRate,
    avgR,
    expectancyR: adjusted * targetR - (1 - adjusted),
    avgMfeR: mean(results.map((r) => r.mfe)),
    avgMaeR: mean(results.map((r) => r.mae)),
    horizonBars: horizon,
    confidence,
    adjustedWinRate: adjusted * 100,
    note: `${results.length} historical analogues of this exact context on this instrument`,
  }
}

function quantile(arr: number[], q: number) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = clamp(q * (s.length - 1), 0, s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export { lastN }
