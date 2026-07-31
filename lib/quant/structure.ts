/**
 * Market structure: fractal swings, trend structure (HH/HL, BOS, CHoCH),
 * confluence S/R levels, Fibonacci, fair-value gaps and volume profile.
 */
import { clamp, lastN, maxOf, mean, minOf, percentileRank, slopePct } from './math'
import type {
  Candle,
  Divergence,
  Level,
  StructureBlock,
  SwingPoint,
  VolumeProfileBlock,
} from './types'
import { atrSeries, rsiSeries, toOhlcv, type Ohlcv } from './indicators'
import { MACD, OBV } from 'technicalindicators'

/* -------------------------------------------------------------------------- */
/*  Fractal swings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Williams fractals: a swing high needs `strength` lower highs on both sides.
 * The last `strength` bars can never be confirmed swings, which is exactly the
 * behaviour you want — no repainting into the decision.
 */
export function findSwings(candles: readonly Candle[], strength = 3): SwingPoint[] {
  const out: SwingPoint[] = []
  const n = candles.length
  for (let i = strength; i < n - strength; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= strength; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) out.push({ ts: c.ts, index: i, price: c.high, kind: 'high' })
    if (isLow) out.push({ ts: c.ts, index: i, price: c.low, kind: 'low' })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Volume profile                                                             */
/* -------------------------------------------------------------------------- */

export function computeVolumeProfile(
  candles: readonly Candle[],
  lookback = 180,
  buckets = 64,
): VolumeProfileBlock {
  const w = candles.slice(-lookback)
  const price = w[w.length - 1]?.close ?? 0
  if (w.length < 10) {
    return {
      poc: price,
      vah: price,
      val: price,
      valueAreaPct: 0,
      hvn: [],
      lvn: [],
      insideValue: true,
    }
  }
  const hi = maxOf(w.map((c) => c.high))
  const lo = minOf(w.map((c) => c.low))
  if (!(hi > lo)) {
    return { poc: price, vah: price, val: price, valueAreaPct: 0, hvn: [], lvn: [], insideValue: true }
  }
  const step = (hi - lo) / buckets
  const profile = new Float64Array(buckets)

  // Spread each candle's volume across the price cells it actually traded in.
  for (const c of w) {
    const from = Math.max(0, Math.floor((c.low - lo) / step))
    const to = Math.min(buckets - 1, Math.floor((c.high - lo) / step))
    const cells = to - from + 1
    const per = c.volume / cells
    for (let i = from; i <= to; i++) profile[i] += per
  }

  let pocIdx = 0
  for (let i = 1; i < buckets; i++) if (profile[i] > profile[pocIdx]) pocIdx = i
  const total = profile.reduce((s, v) => s + v, 0)

  // Expand around the POC until 70% of volume is captured (value area).
  let lower = pocIdx
  let upper = pocIdx
  let acc = profile[pocIdx]
  while (acc < total * 0.7 && (lower > 0 || upper < buckets - 1)) {
    const below = lower > 0 ? profile[lower - 1] : -1
    const above = upper < buckets - 1 ? profile[upper + 1] : -1
    if (above >= below) {
      upper++
      acc += Math.max(above, 0)
    } else {
      lower--
      acc += Math.max(below, 0)
    }
  }

  const priceAt = (i: number) => lo + (i + 0.5) * step
  const avg = total / buckets
  const hvn: number[] = []
  const lvn: number[] = []
  for (let i = 1; i < buckets - 1; i++) {
    const isPeak = profile[i] > profile[i - 1] && profile[i] > profile[i + 1]
    const isTrough = profile[i] < profile[i - 1] && profile[i] < profile[i + 1]
    if (isPeak && profile[i] > avg * 1.4) hvn.push(priceAt(i))
    if (isTrough && profile[i] < avg * 0.45) lvn.push(priceAt(i))
  }

  const val = priceAt(lower)
  const vah = priceAt(upper)
  return {
    poc: priceAt(pocIdx),
    vah,
    val,
    valueAreaPct: hi > lo ? ((vah - val) / (hi - lo)) * 100 : 0,
    hvn: hvn.slice(0, 6),
    lvn: lvn.slice(0, 6),
    insideValue: price >= val && price <= vah,
  }
}

/* -------------------------------------------------------------------------- */
/*  Fair value gaps (3-candle imbalances)                                      */
/* -------------------------------------------------------------------------- */

function findFvg(candles: readonly Candle[], limit = 4) {
  const out: { top: number; bottom: number; ts: number; side: 'LONG' | 'SHORT' }[] = []
  const n = candles.length
  for (let i = n - 2; i >= Math.max(2, n - 120); i--) {
    const a = candles[i - 2]
    const c = candles[i]
    // Bullish gap: candle i low > candle i-2 high (unfilled to the downside)
    if (c.low > a.high) {
      const top = c.low
      const bottom = a.high
      const filled = candles.slice(i + 1).some((k) => k.low <= bottom)
      if (!filled) out.push({ top, bottom, ts: c.ts, side: 'LONG' })
    } else if (c.high < a.low) {
      const top = a.low
      const bottom = c.high
      const filled = candles.slice(i + 1).some((k) => k.high >= top)
      if (!filled) out.push({ top, bottom, ts: c.ts, side: 'SHORT' })
    }
    if (out.length >= limit) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Confluence levels                                                          */
/* -------------------------------------------------------------------------- */

function roundNumbers(price: number) {
  if (price <= 0) return []
  const mag = 10 ** Math.floor(Math.log10(price))
  const steps = [mag * 0.25, mag * 0.5, mag]
  const out = new Set<number>()
  for (const s of steps) {
    out.add(Math.floor(price / s) * s)
    out.add(Math.ceil(price / s) * s)
  }
  return [...out].filter((p) => p > 0)
}

/**
 * Cluster raw candidate levels that sit within `tolerance` of each other and
 * score them by touch count, source quality and recency.
 */
function clusterLevels(
  raw: { price: number; weight: number; source: Level['source'] }[],
  price: number,
  tolerance: number,
): Level[] {
  const sorted = [...raw].sort((a, b) => a.price - b.price)
  const clusters: { prices: number[]; weight: number; sources: Set<Level['source']> }[] = []
  for (const r of sorted) {
    const cur = clusters[clusters.length - 1]
    if (cur && Math.abs(mean(cur.prices) - r.price) <= tolerance) {
      cur.prices.push(r.price)
      cur.weight += r.weight
      cur.sources.add(r.source)
    } else {
      clusters.push({ prices: [r.price], weight: r.weight, sources: new Set([r.source]) })
    }
  }
  return clusters
    .map((c) => {
      const p = mean(c.prices)
      const strength = clamp(c.weight * 12 + (c.sources.size - 1) * 14 + (c.prices.length - 1) * 8, 5, 100)
      return {
        price: p,
        strength,
        kind: (p < price ? 'support' : 'resistance') as Level['kind'],
        touches: c.prices.length,
        source: [...c.sources][0],
        distancePct: price > 0 ? ((p - price) / price) * 100 : 0,
      }
    })
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
}

/* -------------------------------------------------------------------------- */
/*  Structure block                                                            */
/* -------------------------------------------------------------------------- */

export function computeStructure(
  candles: readonly Candle[],
  profile: VolumeProfileBlock,
  atr: number,
  htfSwings: number[] = [],
): StructureBlock {
  const price = candles[candles.length - 1]?.close ?? 0
  const swings = findSwings(candles, 3)
  const highs = swings.filter((s) => s.kind === 'high')
  const lows = swings.filter((s) => s.kind === 'low')

  const h = highs.slice(-3)
  const l = lows.slice(-3)
  const higherHighs = h.length >= 2 && h[h.length - 1].price > h[h.length - 2].price
  const lowerHighs = h.length >= 2 && h[h.length - 1].price < h[h.length - 2].price
  const higherLows = l.length >= 2 && l[l.length - 1].price > l[l.length - 2].price
  const lowerLows = l.length >= 2 && l[l.length - 1].price < l[l.length - 2].price

  let structure: StructureBlock['structure'] = 'RANGE'
  if (higherHighs && higherLows) structure = 'UPTREND'
  else if (lowerHighs && lowerLows) structure = 'DOWNTREND'

  // BOS: close beyond the last confirmed swing in the direction of structure.
  const lastHigh = h[h.length - 1]?.price ?? maxOf(lastN(candles.map((c) => c.high), 20))
  const lastLow = l[l.length - 1]?.price ?? minOf(lastN(candles.map((c) => c.low), 20))
  const recentCloses = lastN(candles.map((c) => c.close), 3)
  let bos: StructureBlock['bos'] = null
  if (recentCloses.some((c) => c > lastHigh)) bos = 'BULL'
  else if (recentCloses.some((c) => c < lastLow)) bos = 'BEAR'

  // CHoCH: a break against the prevailing structure = character change.
  let choch: StructureBlock['choch'] = null
  if (structure === 'UPTREND' && bos === 'BEAR') choch = 'BEAR'
  if (structure === 'DOWNTREND' && bos === 'BULL') choch = 'BULL'

  const window = candles.slice(-120)
  const rangeHigh = maxOf(window.map((c) => c.high))
  const rangeLow = minOf(window.map((c) => c.low))
  const rangePosition = rangeHigh > rangeLow ? clamp((price - rangeLow) / (rangeHigh - rangeLow), 0, 1) : 0.5

  /* ---- confluence levels ------------------------------------------------ */
  const raw: { price: number; weight: number; source: Level['source'] }[] = []
  for (const s of swings.slice(-24)) {
    // Recency-weighted: newer swings matter more.
    const age = candles.length - s.index
    raw.push({ price: s.price, weight: clamp(2.2 - age / 90, 0.5, 2.2), source: 'swing' })
  }
  raw.push({ price: profile.poc, weight: 3, source: 'poc' })
  raw.push({ price: profile.vah, weight: 2, source: 'vah' })
  raw.push({ price: profile.val, weight: 2, source: 'val' })
  for (const p of profile.hvn) raw.push({ price: p, weight: 1.2, source: 'poc' })
  for (const p of roundNumbers(price)) raw.push({ price: p, weight: 1, source: 'round' })
  for (const p of htfSwings) raw.push({ price: p, weight: 3, source: 'htf_swing' })

  const tolerance = Math.max(atr * 0.5, price * 0.0015)
  const levels = clusterLevels(raw, price, tolerance).slice(0, 14)
  const nearestSupport = levels.find((x) => x.price < price * 0.9995) ?? null
  const nearestResistance = levels.find((x) => x.price > price * 1.0005) ?? null

  /* ---- Fibonacci of the dominant leg ------------------------------------ */
  const legHigh = rangeHigh
  const legLow = rangeLow
  const up = structure !== 'DOWNTREND'
  const fibRatios = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 1.272, 1.618]
  const fib = fibRatios.map((r) => ({
    level: r,
    price: up ? legHigh - (legHigh - legLow) * r : legLow + (legHigh - legLow) * r,
  }))

  return {
    swings: swings.slice(-40),
    swingHigh: lastHigh,
    swingLow: lastLow,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    structure,
    bos,
    choch,
    rangeHigh,
    rangeLow,
    rangePosition,
    levels,
    nearestSupport,
    nearestResistance,
    fib,
    fvg: findFvg(candles),
  }
}

/* -------------------------------------------------------------------------- */
/*  Divergences                                                                */
/* -------------------------------------------------------------------------- */

/** Align an indicator array to candle indices (library outputs are shorter). */
function aligned(values: number[], barCount: number) {
  const offset = barCount - values.length
  return (index: number) => (index - offset >= 0 ? values[index - offset] : Number.NaN)
}

/**
 * Regular divergence  : price makes a new extreme, oscillator does not (reversal)
 * Hidden divergence   : oscillator makes a new extreme, price does not (continuation)
 */
export function findDivergences(candles: readonly Candle[], d?: Ohlcv): Divergence[] {
  const out: Divergence[] = []
  const data = d ?? toOhlcv(candles)
  const n = candles.length
  if (n < 40) return out

  const swings = findSwings(candles, 3)
  const highs = swings.filter((s) => s.kind === 'high').slice(-4)
  const lows = swings.filter((s) => s.kind === 'low').slice(-4)

  const sources: { key: Divergence['source']; get: (i: number) => number }[] = []

  const rsi = rsiSeries(data.close, 14)
  if (rsi.length) sources.push({ key: 'rsi', get: aligned(rsi, n) })

  try {
    const macd = MACD.calculate({
      values: data.close,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    })
      .map((m) => m.histogram ?? 0)
      .filter((v) => Number.isFinite(v))
    if (macd.length) sources.push({ key: 'macd', get: aligned(macd, n) })
  } catch {
    /* not enough bars */
  }

  try {
    const obv = OBV.calculate({ close: data.close, volume: data.volume })
    if (obv.length) sources.push({ key: 'obv', get: aligned(obv, n) })
  } catch {
    /* ignore */
  }

  for (const src of sources) {
    // Bullish: lower low in price, higher low in oscillator.
    if (lows.length >= 2) {
      const a = lows[lows.length - 2]
      const b = lows[lows.length - 1]
      const oa = src.get(a.index)
      const ob = src.get(b.index)
      if (Number.isFinite(oa) && Number.isFinite(ob)) {
        if (b.price < a.price && ob > oa) {
          out.push({
            kind: 'regular',
            side: 'LONG',
            source: src.key,
            strength: clamp(Math.abs(ob - oa) * 2 + 30, 25, 95),
            barsAgo: n - 1 - b.index,
          })
        } else if (b.price > a.price && ob < oa) {
          out.push({
            kind: 'hidden',
            side: 'LONG',
            source: src.key,
            strength: clamp(Math.abs(ob - oa) + 20, 20, 70),
            barsAgo: n - 1 - b.index,
          })
        }
      }
    }
    // Bearish: higher high in price, lower high in oscillator.
    if (highs.length >= 2) {
      const a = highs[highs.length - 2]
      const b = highs[highs.length - 1]
      const oa = src.get(a.index)
      const ob = src.get(b.index)
      if (Number.isFinite(oa) && Number.isFinite(ob)) {
        if (b.price > a.price && ob < oa) {
          out.push({
            kind: 'regular',
            side: 'SHORT',
            source: src.key,
            strength: clamp(Math.abs(ob - oa) * 2 + 30, 25, 95),
            barsAgo: n - 1 - b.index,
          })
        } else if (b.price < a.price && ob > oa) {
          out.push({
            kind: 'hidden',
            side: 'SHORT',
            source: src.key,
            strength: clamp(Math.abs(ob - oa) + 20, 20, 70),
            barsAgo: n - 1 - b.index,
          })
        }
      }
    }
  }

  // Only divergences that are still fresh can influence a decision.
  return out.filter((x) => x.barsAgo <= 12)
}

/** Volatility-normalised distance between two prices, in ATR units. */
export function atrDistance(a: number, b: number, atr: number) {
  return atr > 0 ? Math.abs(a - b) / atr : 0
}

export { atrSeries, percentileRank, slopePct }
