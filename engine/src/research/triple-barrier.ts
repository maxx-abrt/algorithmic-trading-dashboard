/**
 * Triple-Barrier Labeling — López de Prado method.
 *
 * Instead of labeling a trade as binary win/loss at a fixed horizon,
 * we simulate three barriers on the price path after entry:
 *
 *  1. Upper barrier (take-profit) → label = 1
 *  2. Lower barrier (stop-loss)   → label = 0
 *  3. Vertical barrier (time stop) → label = 0.5 (ambiguous) or side-dependent
 *
 * The first barrier touched determines the label. This is far more
 * realistic than fixed-horizon labeling because it captures the
 * actual path of price, not just the endpoint.
 *
 * Meta-labeling extension: when used with a meta-model, the label
 * becomes {-1, 0, 1} where -1 means "the primary signal was wrong".
 */

export type Side = 'LONG' | 'SHORT'

export interface TripleBarrierConfig {
  /** take-profit distance in R multiples (e.g. 2.0 = 2R) */
  tpR: number
  /** stop-loss distance in R multiples (e.g. 1.0 = 1R) */
  slR: number
  /** maximum bars to hold before vertical barrier */
  maxBars: number
}

export const DEFAULT_BARRIER_CONFIG: TripleBarrierConfig = {
  tpR: 2.0,
  slR: 1.0,
  maxBars: 48,
}

export interface BarrierEvent {
  /** which barrier was hit: 'tp' | 'sl' | 'time' */
  barrier: 'tp' | 'sl' | 'time'
  /** bar index where the barrier was hit */
  barIndex: number
  /** price at the barrier touch */
  price: number
  /** R multiple at exit */
  rMultiple: number
}

/**
 * Apply triple-barrier labeling to a price path.
 *
 * @param entryPrice  entry price
 * @param side        'LONG' or 'SHORT'
 * @param stopPrice   the actual stop-loss price (determines 1R distance)
 * @param highs       array of bar highs after entry
 * @param lows        array of bar lows after entry
 * @param closes      array of bar closes after entry
 * @param config      barrier configuration
 * @returns barrier event + label
 */
export function applyTripleBarrier(
  entryPrice: number,
  side: Side,
  stopPrice: number,
  highs: number[],
  lows: number[],
  closes: number[],
  config: TripleBarrierConfig = DEFAULT_BARRIER_CONFIG,
): { event: BarrierEvent; label: 0 | 0.5 | 1; metaLabel: 0 | 1 } {
  const rDistance = Math.abs(entryPrice - stopPrice)
  if (rDistance <= 0) {
    return {
      event: { barrier: 'time', barIndex: 0, price: entryPrice, rMultiple: 0 },
      label: 0.5,
      metaLabel: 0,
    }
  }

  const tpDistance = rDistance * config.tpR
  const slDistance = rDistance * config.slR

  const tpPrice = side === 'LONG' ? entryPrice + tpDistance : entryPrice - tpDistance
  const slPrice = side === 'LONG' ? entryPrice - slDistance : entryPrice + slDistance

  const maxBars = Math.min(config.maxBars, highs.length, lows.length, closes.length)

  for (let bar = 0; bar < maxBars; bar++) {
    const high = highs[bar]
    const low = lows[bar]

    if (side === 'LONG') {
      // Check stop first (conservative: assume worst case if both hit in same bar)
      if (low <= slPrice) {
        const rMultiple = -config.slR
        return {
          event: { barrier: 'sl', barIndex: bar, price: slPrice, rMultiple },
          label: 0,
          metaLabel: 0,
        }
      }
      if (high >= tpPrice) {
        const rMultiple = config.tpR
        return {
          event: { barrier: 'tp', barIndex: bar, price: tpPrice, rMultiple },
          label: 1,
          metaLabel: 1,
        }
      }
    } else {
      // SHORT
      if (high >= slPrice) {
        const rMultiple = -config.slR
        return {
          event: { barrier: 'sl', barIndex: bar, price: slPrice, rMultiple },
          label: 0,
          metaLabel: 0,
        }
      }
      if (low <= tpPrice) {
        const rMultiple = config.tpR
        return {
          event: { barrier: 'tp', barIndex: bar, price: tpPrice, rMultiple },
          label: 1,
          metaLabel: 1,
        }
      }
    }
  }

  // Vertical (time) barrier hit — use close at last bar
  const exitPrice = closes[Math.max(0, maxBars - 1)] ?? entryPrice
  const rMultiple = side === 'LONG'
    ? (exitPrice - entryPrice) / rDistance
    : (entryPrice - exitPrice) / rDistance

  // For time barrier: label 1 if positive R, 0 if negative, 0.5 if near zero
  let label: 0 | 0.5 | 1
  let metaLabel: 0 | 1
  if (rMultiple > 0.2) {
    label = 1
    metaLabel = 1
  } else if (rMultiple < -0.2) {
    label = 0
    metaLabel = 0
  } else {
    label = 0.5
    metaLabel = 0
  }

  return {
    event: { barrier: 'time', barIndex: maxBars - 1, price: exitPrice, rMultiple },
    label,
    metaLabel,
  }
}

/**
 * Convert a triple-barrier label to a binary label for logistic training.
 * Time-barrier ambiguous (0.5) labels are excluded from training by default,
 * or can be thresholded.
 */
export function barrierLabelToBinary(label: 0 | 0.5 | 1, threshold = 0.5): 0 | 1 | null {
  if (label === 0.5) return null // exclude ambiguous
  return label >= threshold ? 1 : 0
}

/**
 * Compute the dynamic barrier widths based on current volatility.
 * Instead of fixed R multiples, scale barriers by ATR percentile.
 */
export function dynamicBarrierWidths(
  atrPct: number,
  baseTpR = 2.0,
  baseSlR = 1.0,
): TripleBarrierConfig {
  // Higher volatility → wider barriers (more room for noise)
  // Lower volatility → tighter barriers (capture smaller moves)
  const volMultiplier = Math.max(0.7, Math.min(1.8, atrPct / 3))
  return {
    tpR: baseTpR * volMultiplier,
    slR: baseSlR * volMultiplier,
    maxBars: Math.round(48 * volMultiplier),
  }
}
