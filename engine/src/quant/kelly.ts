/**
 * Adaptive Kelly Position Sizing.
 *
 * Instead of fixed-fraction sizing, we use the Kelly criterion adjusted
 * for model uncertainty. The Kelly fraction maximizes long-run geometric
 * growth rate.
 *
 * Full Kelly: f* = (p * b - q) / b
 *   p = win probability
 *   q = 1 - p (loss probability)
 *   b = win/loss ratio (average R win / average R loss)
 *
 * We use fractional Kelly (typically 0.25-0.5x) for safety, and further
 * adjust by:
 *   - Model uncertainty (higher variance → smaller size)
 *   - Regime size multiplier (crisis → minimal size)
 *   - Meta-model confidence (if available)
 *   - Drawdown penalty (reduce size after consecutive losses)
 *   - Volatility forecast (higher forecasted vol → smaller size)
 */

export interface KellyInput {
  /** estimated win probability (0..1) */
  winProbability: number
  /** average win in R multiples (e.g. 2.0) */
  avgWinR: number
  /** average loss in R multiples (e.g. 1.0) */
  avgLossR: number
  /** model uncertainty / prediction variance (0..1, 0 = certain) */
  uncertainty: number
  /** regime size multiplier (0..1.5) */
  regimeMultiplier: number
  /** meta-model confidence (0..1, optional) */
  metaConfidence?: number
  /** current consecutive losses */
  consecutiveLosses: number
  /** current drawdown in R */
  currentDrawdownR: number
  /** maximum allowed drawdown in R before emergency stop */
  maxDrawdownR: number
  /** volatility forecast normalized (0..1, 0 = calm) */
  volForecast: number
  /** Kelly fraction (0.25 = quarter Kelly, 0.5 = half Kelly) */
  kellyFraction?: number
}

export interface KellyResult {
  /** recommended fraction of equity to risk (0..1) */
  riskFraction: number
  /** raw Kelly fraction before adjustments */
  rawKelly: number
  /** final position size multiplier (0..1.5) */
  sizeMultiplier: number
  /** reasons for the sizing decision */
  reasons: string[]
}

export function computeKellySize(input: KellyInput): KellyResult {
  const reasons: string[] = []
  const p = Math.max(0.01, Math.min(0.99, input.winProbability))
  const q = 1 - p
  const b = input.avgWinR / Math.max(0.01, input.avgLossR)

  // Raw Kelly fraction
  const rawKelly = (p * b - q) / b
  reasons.push(`raw Kelly: ${rawKelly.toFixed(4)} (p=${p.toFixed(2)}, b=${b.toFixed(2)})`)

  // Fractional Kelly (default 0.25 = quarter Kelly for safety)
  const fraction = input.kellyFraction ?? 0.25
  let kelly = rawKelly * fraction
  reasons.push(`fractional Kelly (${fraction}x): ${kelly.toFixed(4)}`)

  // Uncertainty penalty: reduce size when model is uncertain
  // uncertainty of 0 → no penalty, uncertainty of 1 → 50% reduction
  const uncertaintyPenalty = 1 - input.uncertainty * 0.5
  kelly *= uncertaintyPenalty
  if (input.uncertainty > 0.3) {
    reasons.push(`uncertainty penalty (${(input.uncertainty * 100).toFixed(0)}%): ${(uncertaintyPenalty).toFixed(2)}x`)
  }

  // Meta-model confidence adjustment
  if (input.metaConfidence != null) {
    const metaAdjust = 0.5 + input.metaConfidence * 0.5 // 0.5x at 0 confidence, 1.0x at 1.0
    kelly *= metaAdjust
    if (input.metaConfidence < 0.5) {
      reasons.push(`meta-model confidence (${(input.metaConfidence * 100).toFixed(0)}%): ${metaAdjust.toFixed(2)}x`)
    }
  }

  // Regime multiplier
  kelly *= input.regimeMultiplier
  if (input.regimeMultiplier < 0.8) {
    reasons.push(`regime multiplier: ${input.regimeMultiplier.toFixed(2)}x`)
  }

  // Volatility forecast penalty
  // Higher forecasted vol → smaller position
  const volPenalty = 1 - input.volForecast * 0.3
  kelly *= volPenalty
  if (input.volForecast > 0.5) {
    reasons.push(`vol forecast penalty: ${volPenalty.toFixed(2)}x`)
  }

  // Drawdown penalty: reduce size as drawdown approaches max
  const drawdownRatio = Math.max(0, input.currentDrawdownR / Math.max(1, input.maxDrawdownR))
  const drawdownPenalty = Math.max(0.1, 1 - drawdownRatio * 0.7)
  kelly *= drawdownPenalty
  if (drawdownRatio > 0.3) {
    reasons.push(`drawdown penalty (${(drawdownRatio * 100).toFixed(0)}% of max): ${drawdownPenalty.toFixed(2)}x`)
  }

  // Consecutive loss penalty
  const lossPenalty = Math.max(0.3, 1 - input.consecutiveLosses * 0.15)
  kelly *= lossPenalty
  if (input.consecutiveLosses >= 3) {
    reasons.push(`consecutive loss penalty (${input.consecutiveLosses}): ${lossPenalty.toFixed(2)}x`)
  }

  // Clamp to safe range
  const riskFraction = Math.max(0, Math.min(0.02, kelly)) // never risk more than 2% per trade
  const sizeMultiplier = Math.max(0, Math.min(1.5, kelly / 0.01)) // normalize to 0..1.5

  if (riskFraction <= 0) {
    reasons.push('final: skip trade (risk fraction = 0)')
  } else if (riskFraction < 0.005) {
    reasons.push(`final: minimal size (${(riskFraction * 100).toFixed(2)}% risk)`)
  } else {
    reasons.push(`final: ${(riskFraction * 100).toFixed(2)}% risk, ${sizeMultiplier.toFixed(2)}x size`)
  }

  return { riskFraction, rawKelly, sizeMultiplier, reasons }
}

/**
 * Estimate model uncertainty from prediction variance.
 * Uses bootstrap-like approach: if the model's prediction is near 0.5,
 * uncertainty is high. If it's near 0 or 1, uncertainty is low.
 */
export function estimateUncertainty(winProbability: number): number {
  // Uncertainty peaks at p=0.5, is 0 at p=0 or p=1
  return 1 - Math.abs(winProbability - 0.5) * 2
}

/**
 * Compute optimal Kelly fraction dynamically based on recent performance.
 * If recent trades are winning, increase fraction. If losing, decrease.
 */
export function dynamicKellyFraction(
  recentWinRate: number,
  recentTradeCount: number,
  baseFraction = 0.25,
): number {
  if (recentTradeCount < 10) return baseFraction

  // Adjust fraction based on recent win rate vs expected
  const expectedWinRate = 0.55
  const adjustment = (recentWinRate - expectedWinRate) * 0.5
  const adjusted = baseFraction + adjustment

  // Clamp to safe range [0.1, 0.5]
  return Math.max(0.1, Math.min(0.5, adjusted))
}
