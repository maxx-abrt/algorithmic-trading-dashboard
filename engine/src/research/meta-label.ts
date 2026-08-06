/**
 * Meta-Labeling — López de Prado's two-stage model architecture.
 *
 * Stage 1 (Primary Model): Predicts direction — LONG / SHORT / WAIT
 *   This is the existing champion model (ridge logistic regression).
 *
 * Stage 2 (Meta-Model): Predicts whether the primary model's signal
 *   will be correct for this specific instance.
 *   Input:  same features + primary model's prediction + confidence
 *   Output: probability that the primary signal is correct (0..1)
 *
 * The meta-model learns the *context* in which the primary model is
 * reliable. When the meta-model disagrees, we either:
 *   - Skip the trade (meta probability < threshold)
 *   - Reduce position size (meta probability between threshold and 0.5)
 *   - Full size (meta probability > 0.5)
 *
 * This can dramatically improve precision: the primary model might be
 * right 55% of the time, but the meta-model can identify the 70% of
 * trades where the primary is right 65% of the time, and the 30% where
 * it's right only 40% of the time.
 */

import { trainCalibratedLinear, predictCalibrated, type CalibratedLinearModel, type LabelledFeatureRow } from './calibration.js'

export interface MetaModelInput {
  /** original feature vector */
  features: number[]
  /** primary model's predicted probability */
  primaryProbability: number
  /** primary model's confidence (0..1) */
  primaryConfidence: number
  /** current regime label (0..N) */
  regimeId: number
  /** volatility forecast (normalized 0..1) */
  volForecast: number
}

export interface MetaModelRow {
  at: number
  symbol: string
  /** augmented features: original + meta features */
  features: number[]
  /** 1 = primary was correct, 0 = primary was wrong */
  label: 0 | 1
}

export interface MetaModel {
  kind: 'meta_label'
  primaryFeatureCount: number
  model: CalibratedLinearModel
  /** threshold below which we skip the trade entirely */
  skipThreshold: number
  /** threshold below which we reduce position size */
  reduceThreshold: number
  validationPrecision: number | null
  validationRecall: number | null
}

/**
 * Build augmented feature vector for the meta-model.
 * Original features + [primaryProb, primaryConfidence, regimeId/n, volForecast]
 */
export function buildMetaFeatures(input: MetaModelInput, primaryFeatureCount: number, regimeCount: number): number[] {
  const regimeOneHot = Array.from({ length: Math.max(1, regimeCount) }, (_, i) => i === input.regimeId ? 1 : 0)
  return [
    ...input.features,
    input.primaryProbability,
    input.primaryConfidence,
    ...regimeOneHot,
    input.volForecast,
  ]
}

/**
 * Train the meta-model from historical primary model predictions and outcomes.
 *
 * @param rows  historical data: features at decision time + whether primary was correct
 * @param primaryFeatureCount  number of features in the primary model
 * @param regimeCount  number of distinct regimes
 */
export function trainMetaModel(
  rows: readonly MetaModelRow[],
  primaryFeatureCount: number,
  regimeCount: number,
): MetaModel | null {
  if (rows.length < 30) return null

  const labelled: LabelledFeatureRow[] = rows.map((r) => ({
    at: r.at,
    symbol: r.symbol,
    features: r.features,
    label: r.label,
  }))

  const model = trainCalibratedLinear(labelled, { l2: 0.05, trainFraction: 0.75 })
  if (!model) return null

  // Compute precision/recall on validation set for threshold calibration
  const ordered = [...rows].sort((a, b) => a.at - b.at)
  const cut = Math.floor(ordered.length * 0.75)
  const validation = ordered.slice(cut)

  let truePos = 0, falsePos = 0, trueNeg = 0, falseNeg = 0
  for (const row of validation) {
    const pred = predictCalibrated(model, row.features)
    const predicted = pred > 0.5 ? 1 : 0
    if (predicted === 1 && row.label === 1) truePos++
    else if (predicted === 1 && row.label === 0) falsePos++
    else if (predicted === 0 && row.label === 0) trueNeg++
    else falseNeg++
  }

  const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : null
  const recall = truePos + falseNeg > 0 ? truePos / (truePos + falseNeg) : null

  // Set thresholds based on precision
  // Skip trades where meta-model is very unsure
  const skipThreshold = 0.35
  const reduceThreshold = 0.5

  return {
    kind: 'meta_label',
    primaryFeatureCount,
    model,
    skipThreshold,
    reduceThreshold,
    validationPrecision: precision,
    validationRecall: recall,
  }
}

/**
 * Use the meta-model to decide whether to take a trade and at what size.
 *
 * @returns { take: boolean, sizeMultiplier: number, metaProbability: number }
 */
export function evaluateMetaModel(
  metaModel: MetaModel,
  input: MetaModelInput,
  regimeCount: number,
): { take: boolean; sizeMultiplier: number; metaProbability: number } {
  const features = buildMetaFeatures(input, metaModel.primaryFeatureCount, regimeCount)
  const metaProb = predictCalibrated(metaModel.model, features)

  if (metaProb < metaModel.skipThreshold) {
    return { take: false, sizeMultiplier: 0, metaProbability: metaProb }
  }

  if (metaProb < metaModel.reduceThreshold) {
    // Linear interpolation: at skipThreshold → 0.3x, at reduceThreshold → 1.0x
    const t = (metaProb - metaModel.skipThreshold) / (metaModel.reduceThreshold - metaModel.skipThreshold)
    const sizeMultiplier = 0.3 + 0.7 * t
    return { take: true, sizeMultiplier, metaProbability: metaProb }
  }

  // Above reduce threshold: full size, potentially boosted
  const boost = metaProb > 0.7 ? 1.0 + (metaProb - 0.7) * 0.5 : 1.0
  return { take: true, sizeMultiplier: Math.min(boost, 1.3), metaProbability: metaProb }
}

/**
 * Save/load meta-model to/from JSON.
 */
export function serializeMetaModel(metaModel: MetaModel): string {
  return JSON.stringify(metaModel)
}

export function deserializeMetaModel(json: string): MetaModel | null {
  try {
    const parsed = JSON.parse(json)
    if (parsed.kind !== 'meta_label') return null
    return parsed as MetaModel
  } catch {
    return null
  }
}
