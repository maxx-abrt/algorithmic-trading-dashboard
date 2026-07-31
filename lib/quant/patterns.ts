/**
 * Full candlestick pattern engine.
 *
 * Every pattern shipped by `technicalindicators` is registered here with a
 * literature-based base reliability, then re-scored against *context*:
 * location vs support/resistance, prior swing, volume, candle range vs ATR and
 * follow-through. A raw pattern is noise; a pattern at the right place with the
 * right volume is a signal — only the confirmed score reaches the decision.
 */
import * as TI from 'technicalindicators'
import { clamp, mean, lastN } from './math'
import type { Candle, Level, PatternHit, Side, StructureBlock, VolatilityBlock } from './types'

type PatternFn = (input: {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
}) => boolean

interface PatternMeta {
  fn: string
  label: string
  side: Side
  /** bars the formation spans */
  bars: number
  /** base historical reliability 0..1 */
  reliability: number
  family: 'reversal' | 'continuation' | 'indecision'
}

/* -------------------------------------------------------------------------- */
/*  Registry — 34 formations                                                   */
/* -------------------------------------------------------------------------- */

export const PATTERNS: PatternMeta[] = [
  // ── strong bullish reversals ──────────────────────────────────────────────
  { fn: 'morningstar', label: 'Morning Star', side: 'LONG', bars: 3, reliability: 0.78, family: 'reversal' },
  { fn: 'morningdojistar', label: 'Morning Doji Star', side: 'LONG', bars: 3, reliability: 0.8, family: 'reversal' },
  { fn: 'threewhitesoldiers', label: 'Three White Soldiers', side: 'LONG', bars: 3, reliability: 0.76, family: 'reversal' },
  { fn: 'bullishengulfingpattern', label: 'Bullish Engulfing', side: 'LONG', bars: 2, reliability: 0.72, family: 'reversal' },
  { fn: 'piercingline', label: 'Piercing Line', side: 'LONG', bars: 2, reliability: 0.64, family: 'reversal' },
  { fn: 'abandonedbaby', label: 'Abandoned Baby', side: 'LONG', bars: 3, reliability: 0.74, family: 'reversal' },
  { fn: 'hammerpattern', label: 'Hammer (confirmed)', side: 'LONG', bars: 5, reliability: 0.66, family: 'reversal' },
  { fn: 'bullishhammerstick', label: 'Hammer', side: 'LONG', bars: 1, reliability: 0.55, family: 'reversal' },
  { fn: 'bullishinvertedhammerstick', label: 'Inverted Hammer', side: 'LONG', bars: 1, reliability: 0.5, family: 'reversal' },
  { fn: 'dragonflydoji', label: 'Dragonfly Doji', side: 'LONG', bars: 1, reliability: 0.56, family: 'reversal' },
  { fn: 'tweezerbottom', label: 'Tweezer Bottom', side: 'LONG', bars: 2, reliability: 0.54, family: 'reversal' },
  { fn: 'bullishharami', label: 'Bullish Harami', side: 'LONG', bars: 2, reliability: 0.52, family: 'reversal' },
  { fn: 'bullishharamicross', label: 'Bullish Harami Cross', side: 'LONG', bars: 2, reliability: 0.58, family: 'reversal' },
  // ── bullish continuation ──────────────────────────────────────────────────
  { fn: 'bullishmarubozu', label: 'Bullish Marubozu', side: 'LONG', bars: 1, reliability: 0.6, family: 'continuation' },
  { fn: 'bullish', label: 'Bullish Candle Cluster', side: 'LONG', bars: 3, reliability: 0.45, family: 'continuation' },
  // ── strong bearish reversals ──────────────────────────────────────────────
  { fn: 'eveningstar', label: 'Evening Star', side: 'SHORT', bars: 3, reliability: 0.78, family: 'reversal' },
  { fn: 'eveningdojistar', label: 'Evening Doji Star', side: 'SHORT', bars: 3, reliability: 0.8, family: 'reversal' },
  { fn: 'threeblackcrows', label: 'Three Black Crows', side: 'SHORT', bars: 3, reliability: 0.76, family: 'reversal' },
  { fn: 'bearishengulfingpattern', label: 'Bearish Engulfing', side: 'SHORT', bars: 2, reliability: 0.72, family: 'reversal' },
  { fn: 'darkcloudcover', label: 'Dark Cloud Cover', side: 'SHORT', bars: 2, reliability: 0.66, family: 'reversal' },
  { fn: 'shootingstar', label: 'Shooting Star (confirmed)', side: 'SHORT', bars: 5, reliability: 0.7, family: 'reversal' },
  { fn: 'hangingman', label: 'Hanging Man (confirmed)', side: 'SHORT', bars: 5, reliability: 0.62, family: 'reversal' },
  { fn: 'bearishhammerstick', label: 'Bearish Hammer', side: 'SHORT', bars: 1, reliability: 0.48, family: 'reversal' },
  { fn: 'bearishinvertedhammerstick', label: 'Bearish Inverted Hammer', side: 'SHORT', bars: 1, reliability: 0.5, family: 'reversal' },
  { fn: 'gravestonedoji', label: 'Gravestone Doji', side: 'SHORT', bars: 1, reliability: 0.56, family: 'reversal' },
  { fn: 'tweezertop', label: 'Tweezer Top', side: 'SHORT', bars: 2, reliability: 0.54, family: 'reversal' },
  { fn: 'bearishharami', label: 'Bearish Harami', side: 'SHORT', bars: 2, reliability: 0.52, family: 'reversal' },
  { fn: 'bearishharamicross', label: 'Bearish Harami Cross', side: 'SHORT', bars: 2, reliability: 0.58, family: 'reversal' },
  // ── bearish continuation ──────────────────────────────────────────────────
  { fn: 'bearishmarubozu', label: 'Bearish Marubozu', side: 'SHORT', bars: 1, reliability: 0.6, family: 'continuation' },
  { fn: 'downsidetasukigap', label: 'Downside Tasuki Gap', side: 'SHORT', bars: 3, reliability: 0.55, family: 'continuation' },
  { fn: 'bearish', label: 'Bearish Candle Cluster', side: 'SHORT', bars: 3, reliability: 0.45, family: 'continuation' },
  // ── indecision (used as a veto / squeeze hint, side is informational) ─────
  { fn: 'doji', label: 'Doji', side: 'LONG', bars: 1, reliability: 0.2, family: 'indecision' },
  { fn: 'bullishspinningtop', label: 'Bullish Spinning Top', side: 'LONG', bars: 1, reliability: 0.28, family: 'indecision' },
  { fn: 'bearishspinningtop', label: 'Bearish Spinning Top', side: 'SHORT', bars: 1, reliability: 0.28, family: 'indecision' },
]

const REGISTRY: { meta: PatternMeta; run: PatternFn }[] = PATTERNS.flatMap((meta) => {
  const fn = (TI as unknown as Record<string, PatternFn>)[meta.fn]
  return typeof fn === 'function' ? [{ meta, run: fn }] : []
})

/** Window fed to each detector — the library slices its own requiredCount. */
const WINDOW = 6

function windowAt(candles: readonly Candle[], endIndex: number) {
  const start = Math.max(0, endIndex - WINDOW + 1)
  const w = candles.slice(start, endIndex + 1)
  return {
    open: w.map((c) => c.open),
    high: w.map((c) => c.high),
    low: w.map((c) => c.low),
    close: w.map((c) => c.close),
  }
}

/* -------------------------------------------------------------------------- */
/*  Detection                                                                  */
/* -------------------------------------------------------------------------- */

export interface PatternContext {
  atr: number
  volatility: VolatilityBlock
  structure: StructureBlock
  /** short-term trend score of the LTF, -100..100 */
  trendScore: number
  avgVolume: number
}

/**
 * Scan the last `depth` bars for every registered formation.
 * Returns hits newest-first, already context-confirmed.
 */
export function detectPatterns(
  candles: readonly Candle[],
  ctx: PatternContext,
  depth = 12,
): PatternHit[] {
  if (candles.length < WINDOW + 2) return []
  const hits: PatternHit[] = []
  const n = candles.length
  const from = Math.max(WINDOW - 1, n - depth)

  for (let i = n - 1; i >= from; i--) {
    const w = windowAt(candles, i)
    if (w.close.length < WINDOW) continue
    for (const { meta, run } of REGISTRY) {
      let found = false
      try {
        // Fresh arrays every call: the library mutates its input on reverse.
        found = run({
          open: [...w.open],
          high: [...w.high],
          low: [...w.low],
          close: [...w.close],
        })
      } catch {
        found = false
      }
      if (!found) continue
      hits.push(score(meta, candles, i, ctx))
    }
  }

  // Deduplicate: keep the freshest occurrence of each formation.
  const seen = new Set<string>()
  return hits
    .filter((h) => {
      if (seen.has(h.name)) return false
      seen.add(h.name)
      return true
    })
    .sort((a, b) => b.confirmed - a.confirmed)
    .slice(0, 10)
}

/* -------------------------------------------------------------------------- */
/*  Context confirmation                                                       */
/* -------------------------------------------------------------------------- */

function score(
  meta: PatternMeta,
  candles: readonly Candle[],
  index: number,
  ctx: PatternContext,
): PatternHit {
  const c = candles[index]
  const notes: string[] = []
  let mult = 1

  const atr = ctx.atr > 0 ? ctx.atr : Math.max(c.close * 0.002, 1e-9)
  const range = c.high - c.low
  const body = Math.abs(c.close - c.open)

  /* 1. Significance: a formation on a doji-sized bar is meaningless. */
  const rangeAtr = range / atr
  if (rangeAtr >= 1.1) {
    mult *= 1.18
    notes.push(`range ${rangeAtr.toFixed(2)}×ATR (significant)`)
  } else if (rangeAtr < 0.45) {
    mult *= 0.62
    notes.push(`range only ${rangeAtr.toFixed(2)}×ATR (low significance)`)
  }

  /* 2. Volume confirmation. */
  const volRatio = ctx.avgVolume > 0 ? c.volume / ctx.avgVolume : 1
  if (volRatio >= 1.5) {
    mult *= 1.22
    notes.push(`volume ${volRatio.toFixed(2)}× average`)
  } else if (volRatio >= 1.15) {
    mult *= 1.1
    notes.push(`volume ${volRatio.toFixed(2)}× average`)
  } else if (volRatio < 0.7) {
    mult *= 0.78
    notes.push(`thin volume ${volRatio.toFixed(2)}×`)
  }

  /* 3. Prior swing: a reversal needs something to reverse. */
  const priorWindow = candles.slice(Math.max(0, index - 10), index)
  if (priorWindow.length >= 4) {
    const priorMove = ((c.close - priorWindow[0].close) / priorWindow[0].close) * 100
    if (meta.family === 'reversal') {
      const needsDrop = meta.side === 'LONG'
      const aligned = needsDrop ? priorMove < -0.4 : priorMove > 0.4
      if (aligned) {
        mult *= 1.25
        notes.push(`prior ${priorMove.toFixed(2)}% leg to reverse`)
      } else {
        mult *= 0.6
        notes.push('no exhausted leg into the pattern')
      }
    } else if (meta.family === 'continuation') {
      const aligned = meta.side === 'LONG' ? priorMove > 0 : priorMove < 0
      mult *= aligned ? 1.15 : 0.65
      notes.push(aligned ? 'continuation aligned with prior leg' : 'continuation against prior leg')
    }
  }

  /* 4. Location: at a level the formation is worth far more. */
  const level =
    meta.side === 'LONG' ? ctx.structure.nearestSupport : ctx.structure.nearestResistance
  const locScore = locationScore(meta.side, c, level, ctx)
  if (locScore > 0) {
    mult *= 1 + locScore * 0.45
    notes.push(...locationNotes(meta.side, c, level, ctx))
  } else {
    mult *= 0.85
    notes.push('no level confluence at the formation')
  }

  /* 5. Trend context: reversals into a strong opposing trend fail often. */
  if (meta.family === 'reversal') {
    const against = meta.side === 'LONG' ? ctx.trendScore < -55 : ctx.trendScore > 55
    if (against) {
      mult *= 0.72
      notes.push('counter-trend against a strong LTF trend')
    }
  } else if (meta.family === 'continuation') {
    const with_ = meta.side === 'LONG' ? ctx.trendScore > 25 : ctx.trendScore < -25
    if (with_) {
      mult *= 1.15
      notes.push('continuation aligned with LTF trend')
    }
  }

  /* 6. Follow-through on the bars after the formation. */
  const after = candles.slice(index + 1)
  if (after.length) {
    const move = ((after[after.length - 1].close - c.close) / c.close) * 100
    const good = meta.side === 'LONG' ? move > 0 : move < 0
    mult *= good ? 1.12 : 0.8
    notes.push(good ? `follow-through ${move.toFixed(2)}%` : `no follow-through (${move.toFixed(2)}%)`)
  } else {
    notes.push('forming bar — awaiting close')
    mult *= 0.9
  }

  /* 7. Indecision formations never carry directional weight. */
  if (meta.family === 'indecision') mult *= 0.5

  /* 8. Decay with age. */
  const barsAgo = candles.length - 1 - index
  mult *= clamp(1 - barsAgo * 0.05, 0.5, 1)

  // Wick quality for single-bar rejection candles.
  if (meta.bars === 1 && range > 0) {
    const upperWick = c.high - Math.max(c.open, c.close)
    const lowerWick = Math.min(c.open, c.close) - c.low
    const wick = meta.side === 'LONG' ? lowerWick : upperWick
    if (wick / range > 0.55 && body / range < 0.4) {
      mult *= 1.15
      notes.push('dominant rejection wick')
    }
  }

  return {
    name: meta.fn,
    label: meta.label,
    side: meta.side,
    reliability: meta.reliability,
    confirmed: clamp(meta.reliability * mult, 0, 1),
    barsAgo,
    ts: c.ts,
    price: c.close,
    notes,
  }
}

function locationScore(side: Side, c: Candle, level: Level | null, ctx: PatternContext) {
  const atr = ctx.atr > 0 ? ctx.atr : c.close * 0.002
  let s = 0
  if (level) {
    const dist = Math.abs(c.close - level.price) / atr
    if (dist < 1.2) s += (1 - dist / 1.2) * (level.strength / 100)
  }
  const v = ctx.volatility
  if (side === 'LONG') {
    if (c.low <= v.bbLower * 1.001) s += 0.35
    if (c.low <= v.keltnerLower * 1.001) s += 0.2
    if (ctx.structure.rangePosition < 0.25) s += 0.25
    if (ctx.structure.fvg.some((f) => f.side === 'LONG' && c.low <= f.top && c.low >= f.bottom)) s += 0.3
  } else {
    if (c.high >= v.bbUpper * 0.999) s += 0.35
    if (c.high >= v.keltnerUpper * 0.999) s += 0.2
    if (ctx.structure.rangePosition > 0.75) s += 0.25
    if (ctx.structure.fvg.some((f) => f.side === 'SHORT' && c.high >= f.bottom && c.high <= f.top)) s += 0.3
  }
  return clamp(s, 0, 1.4)
}

function locationNotes(side: Side, c: Candle, level: Level | null, ctx: PatternContext) {
  const notes: string[] = []
  if (level) {
    notes.push(
      `at ${level.kind} ${level.price.toPrecision(6)} (${level.source}, strength ${level.strength.toFixed(0)})`,
    )
  }
  const v = ctx.volatility
  if (side === 'LONG' && c.low <= v.bbLower * 1.001) notes.push('tagged lower Bollinger band')
  if (side === 'SHORT' && c.high >= v.bbUpper * 0.999) notes.push('tagged upper Bollinger band')
  if (side === 'LONG' && ctx.structure.rangePosition < 0.25) notes.push('bottom quartile of the range')
  if (side === 'SHORT' && ctx.structure.rangePosition > 0.75) notes.push('top quartile of the range')
  return notes
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Net directional pattern pressure, -100..100.
 * Confirmed strength is used, freshness weighted, indecision excluded.
 */
export function patternScore(hits: PatternHit[]) {
  if (!hits.length) return { score: 0, top: null as PatternHit | null }
  let bull = 0
  let bear = 0
  for (const h of hits) {
    const w = h.confirmed * clamp(1 - h.barsAgo * 0.06, 0.4, 1)
    if (h.side === 'LONG') bull += w
    else bear += w
  }
  const net = bull - bear
  const top = [...hits].sort((a, b) => b.confirmed - a.confirmed)[0] ?? null
  return { score: clamp(net * 55, -100, 100), top }
}

/** Average volume helper so callers do not recompute it. */
export function averageVolume(candles: readonly Candle[], period = 20) {
  return mean(lastN(candles.map((c) => c.volume), period))
}
