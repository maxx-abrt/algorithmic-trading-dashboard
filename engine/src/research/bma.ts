/**
 * Bayesian Model Averaging (BMA).
 *
 * Instead of picking a single champion model, weight ALL viable models
 * by their posterior probability. This is more robust because:
 *   - If 3 models agree, you trade with confidence
 *   - If models disagree, you reduce position size
 *   - No single point of failure
 *
 * Posterior ∝ Likelihood × Prior
 *   P(M_i | D) ∝ P(D | M_i) × P(M_i)
 *
 * We approximate the posterior using each model's validation Brier score:
 *   weight_i ∝ exp(-Brier_i / temperature)
 *
 * The ensemble prediction is:
 *   P(y=1 | x, D) = Σ_i P(y=1 | x, M_i) × P(M_i | D)
 */

import { predictCalibrated, type CalibratedLinearModel } from './calibration.js'
import { predictEnsemble, type EnsembleModel } from './ensemble.js'

export interface ModelCandidate {
  id: string
  displayName: string
  generation: number
  validationBrier: number | null
  model: CalibratedLinearModel | EnsembleModel
  isEnsemble: boolean
}

export interface BMAResult {
  /** weighted average prediction */
  prediction: number
  /** prediction variance (disagreement among models) */
  predictionVariance: number
  /** confidence 0..1 (1 = all models agree) */
  confidence: number
  /** per-model contributions */
  modelContributions: { id: string; name: string; weight: number; prediction: number }[]
  /** recommended action based on consensus */
  consensus: 'strong_long' | 'weak_long' | 'neutral' | 'weak_short' | 'strong_short' | 'skip'
  /** number of models agreeing */
  agreement: number
  /** total models */
  totalModels: number
}

/**
 * Compute BMA prediction from multiple model candidates.
 */
export function bayesianModelAverage(
  candidates: ModelCandidate[],
  features: number[],
  options: { temperature?: number; minAgreement?: number } = {},
): BMAResult | null {
  if (candidates.length === 0) return null

  const temperature = options.temperature ?? 0.05
  const minAgreement = options.minAgreement ?? 0.6

  // Compute predictions and weights
  const predictions: { id: string; name: string; prediction: number; weight: number }[] = []

  for (const candidate of candidates) {
    let pred: number
    try {
      if (candidate.isEnsemble) {
        pred = predictEnsemble(candidate.model as EnsembleModel, features)
      } else {
        pred = predictCalibrated(candidate.model as CalibratedLinearModel, features)
      }
    } catch {
      continue // skip broken models
    }

    // Weight from validation Brier (lower Brier = higher weight)
    const brier = candidate.validationBrier ?? 0.25
    const weight = Math.exp(-brier / temperature)

    predictions.push({
      id: candidate.id,
      name: candidate.displayName,
      prediction: pred,
      weight,
    })
  }

  if (predictions.length === 0) return null

  // Normalize weights
  const totalWeight = predictions.reduce((s, p) => s + p.weight, 0)
  for (const p of predictions) p.weight /= totalWeight

  // Weighted average prediction
  const weightedPred = predictions.reduce((s, p) => s + p.prediction * p.weight, 0)

  // Prediction variance (disagreement)
  const variance = predictions.reduce((s, p) => s + p.weight * (p.prediction - weightedPred) ** 2, 0)
  const stdDev = Math.sqrt(variance)

  // Confidence: inverse of normalized variance
  // Max variance for Bernoulli is 0.25 (at p=0.5)
  const confidence = Math.max(0, 1 - (variance / 0.25))

  // Agreement: fraction of models that agree with the weighted prediction
  const direction = weightedPred > 0.5 ? 1 : 0
  const agreement = predictions.filter((p) => (p.prediction > 0.5 ? 1 : 0) === direction).length
  const agreementRatio = agreement / predictions.length

  // Determine consensus
  let consensus: BMAResult['consensus']
  if (agreementRatio < minAgreement) {
    consensus = 'skip'
  } else if (weightedPred > 0.65 && confidence > 0.6) {
    consensus = 'strong_long'
  } else if (weightedPred > 0.55) {
    consensus = 'weak_long'
  } else if (weightedPred < 0.35 && confidence > 0.6) {
    consensus = 'strong_short'
  } else if (weightedPred < 0.45) {
    consensus = 'weak_short'
  } else {
    consensus = 'neutral'
  }

  return {
    prediction: weightedPred,
    predictionVariance: variance,
    confidence,
    modelContributions: predictions.sort((a, b) => b.weight - a.weight),
    consensus,
    agreement,
    totalModels: predictions.length,
  }
}

/**
 * Compute position size multiplier from BMA consensus.
 * Strong consensus → full size
 * Weak consensus → reduced size
 * No consensus → skip
 */
export function bmaSizeMultiplier(result: BMAResult): number {
  switch (result.consensus) {
    case 'strong_long':
    case 'strong_short':
      return Math.min(1.3, 0.8 + result.confidence * 0.5)
    case 'weak_long':
    case 'weak_short':
      return 0.4 + result.confidence * 0.3
    case 'neutral':
      return 0.2
    case 'skip':
      return 0
  }
}
