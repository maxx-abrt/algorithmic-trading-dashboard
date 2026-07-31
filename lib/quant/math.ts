/** Small, dependency-free numeric helpers used across the quant core. */

export function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** Never let NaN/Infinity leak into a decision. */
export function safe(n: number | null | undefined, fallback = 0) {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

export function last<T>(arr: readonly T[], fallback?: T): T {
  const v = arr[arr.length - 1]
  return (v ?? fallback) as T
}

export function lastN(arr: readonly number[], n: number) {
  return arr.slice(Math.max(0, arr.length - n))
}

export function mean(arr: readonly number[]) {
  if (!arr.length) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

export function stdev(arr: readonly number[]) {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let acc = 0
  for (const v of arr) acc += (v - m) ** 2
  return Math.sqrt(acc / (arr.length - 1))
}

export function sum(arr: readonly number[]) {
  let s = 0
  for (const v of arr) s += v
  return s
}

export function maxOf(arr: readonly number[]) {
  let m = -Infinity
  for (const v of arr) if (v > m) m = v
  return Number.isFinite(m) ? m : 0
}

export function minOf(arr: readonly number[]) {
  let m = Infinity
  for (const v of arr) if (v < m) m = v
  return Number.isFinite(m) ? m : 0
}

/** Percentile rank (0-100) of `value` inside `arr`. */
export function percentileRank(arr: readonly number[], value: number) {
  if (!arr.length) return 50
  let below = 0
  for (const v of arr) if (v <= value) below++
  return (below / arr.length) * 100
}

/** Value at percentile p (0-100). */
export function percentile(arr: readonly number[], p: number) {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = clamp((p / 100) * (s.length - 1), 0, s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

/** Least-squares slope of a series, normalised to % of the mean per bar. */
export function slopePct(arr: readonly number[], lookback = 10) {
  const w = lastN(arr, lookback)
  if (w.length < 3) return 0
  const n = w.length
  const xm = (n - 1) / 2
  const ym = mean(w)
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (w[i] - ym)
    den += (i - xm) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  return ym === 0 ? 0 : (slope / Math.abs(ym)) * 100
}

/** Pearson correlation of two equal-length series. */
export function correlation(a: readonly number[], b: readonly number[]) {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  const x = a.slice(a.length - n)
  const y = b.slice(b.length - n)
  const mx = mean(x)
  const my = mean(y)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  const den = Math.sqrt(dx * dy)
  return den === 0 ? 0 : num / den
}

/** Map a value from one range to another, clamped. */
export function scale(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
) {
  if (inMax === inMin) return outMin
  const t = clamp((value - inMin) / (inMax - inMin), 0, 1)
  return outMin + t * (outMax - outMin)
}

/** Smooth step used to soften score cliffs. */
export function softSign(value: number, saturation: number) {
  if (saturation <= 0) return 0
  return clamp((value / saturation) * 100, -100, 100)
}

export function roundTo(n: number, decimals: number) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** Decimals implied by an OKX tick/lot size string like "0.001". */
export function decimalsOf(step: number | string) {
  const s = String(step)
  if (s.includes('e-')) return Number(s.split('e-')[1])
  return (s.split('.')[1] ?? '').length
}

export function roundToTick(price: number, tickSz: number) {
  if (!Number.isFinite(tickSz) || tickSz <= 0) return price
  return roundTo(Math.round(price / tickSz) * tickSz, decimalsOf(tickSz))
}

export function floorToLot(size: number, lotSz: number) {
  if (!Number.isFinite(lotSz) || lotSz <= 0) return Math.floor(size)
  return roundTo(Math.floor(size / lotSz) * lotSz, decimalsOf(lotSz))
}

/** Weighted mean that ignores zero-weight entries. */
export function weightedMean(items: { score: number; weight: number }[]) {
  let num = 0
  let den = 0
  for (const it of items) {
    if (!Number.isFinite(it.score) || it.weight <= 0) continue
    num += it.score * it.weight
    den += it.weight
  }
  return den === 0 ? 0 : num / den
}
