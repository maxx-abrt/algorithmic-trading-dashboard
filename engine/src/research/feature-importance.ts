/**
 * Feature Importance & Auto-Selection.
 *
 * Uses mutual information (MI) to score each feature's predictive power
 * relative to the label. Features with low MI are noise and should be
 * dropped to improve generalization.
 *
 * Also computes permutation importance on a validation set: shuffle
 * each feature and measure the degradation in model performance.
 */

import { predictCalibrated, type CalibratedLinearModel } from './calibration.js'
import type { LabelledFeatureRow } from './calibration.js'

export interface FeatureImportance {
  featureName: string
  mutualInfo: number
  permutationImportance: number
  rank: number
  keep: boolean
}

/**
 * Compute mutual information between each feature and the binary label.
 * MI measures how much knowing the feature reduces uncertainty about the label.
 */
export function mutualInformation(rows: LabelledFeatureRow[], featureNames: string[]): number[] {
  const n = rows.length
  if (n === 0) return featureNames.map(() => 0)

  const labels = rows.map((r) => r.label)
  const p1 = labels.filter((l) => l === 1).length / n
  const p0 = 1 - p1
  const entropyLabel = -p0 * Math.log2(p0 + 1e-10) - p1 * Math.log2(p1 + 1e-10)

  const dim = rows[0].features.length
  const miScores: number[] = []

  for (let f = 0; f < dim; f++) {
    const values = rows.map((r) => r.features[f])
    // Discretize into bins
    const nBins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(n))))
    const min = Math.min(...values)
    const max = Math.max(...values)
    const binWidth = (max - min) / nBins || 1

    // Compute joint and marginal distributions
    let mi = 0
    for (let bin = 0; bin < nBins; bin++) {
      const binStart = min + bin * binWidth
      const binEnd = binStart + binWidth
      const inBin = rows.filter((r, i) => values[i] >= binStart && (values[i] < binEnd || bin === nBins - 1))
      const pBin = inBin.length / n
      if (pBin === 0) continue

      const p1GivenBin = inBin.filter((r) => r.label === 1).length / inBin.length
      const p0GivenBin = 1 - p1GivenBin

      // MI contribution: p(bin) * [p(1|bin) * log2(p(1|bin)/p1) + p(0|bin) * log2(p(0|bin)/p0)]
      const contrib1 = p1GivenBin > 0 ? p1GivenBin * Math.log2(p1GivenBin / (p1 + 1e-10)) : 0
      const contrib0 = p0GivenBin > 0 ? p0GivenBin * Math.log2(p0GivenBin / (p0 + 1e-10)) : 0
      mi += pBin * (contrib1 + contrib0)
    }

    miScores.push(Math.max(0, mi / (entropyLabel + 1e-10))) // normalized MI 0..1
  }

  return miScores
}

/**
 * Compute permutation importance on a validation set.
 * Shuffles each feature and measures Brier score degradation.
 */
export function permutationImportance(
  model: CalibratedLinearModel,
  validationRows: LabelledFeatureRow[],
  featureNames: string[],
): number[] {
  const dim = validationRows[0]?.features.length ?? 0
  if (dim === 0) return []

  // Baseline Brier score
  const baselineProbs = validationRows.map((r) => predictCalibrated(model, r.features))
  const baselineBrier = baselineProbs.reduce((s, p, i) => s + (p - validationRows[i].label) ** 2, 0) / validationRows.length

  const importances: number[] = []

  for (let f = 0; f < dim; f++) {
    // Shuffle feature f
    const shuffledIndices = Array.from({ length: validationRows.length }, (_, i) => i)
      .sort(() => Math.random() - 0.5)

    const shuffledProbs = validationRows.map((r, i) => {
      const shuffledFeatures = [...r.features]
      shuffledFeatures[f] = validationRows[shuffledIndices[i]].features[f]
      return predictCalibrated(model, shuffledFeatures)
    })

    const shuffledBrier = shuffledProbs.reduce((s, p, i) => s + (p - validationRows[i].label) ** 2, 0) / validationRows.length
    // Importance = increase in Brier when feature is shuffled
    importances.push(Math.max(0, shuffledBrier - baselineBrier))
  }

  return importances
}

/**
 * Full feature importance analysis with auto-selection.
 */
export function analyzeFeatureImportance(
  rows: LabelledFeatureRow[],
  model: CalibratedLinearModel | null,
  featureNames: string[],
  options: { miThreshold?: number; maxDrop?: number } = {},
): FeatureImportance[] {
  const miThreshold = options.miThreshold ?? 0.02
  const maxDrop = options.maxDrop ?? 5

  const miScores = mutualInformation(rows, featureNames)

  let permScores: number[] = []
  if (model) {
    // Use last 25% as validation for permutation importance
    const ordered = [...rows].sort((a, b) => a.at - b.at)
    const cut = Math.floor(ordered.length * 0.75)
    const validation = ordered.slice(cut)
    if (validation.length > 10) {
      permScores = permutationImportance(model, validation, featureNames)
    }
  }

  if (permScores.length === 0) permScores = featureNames.map(() => 0)

  // Combined score: weighted average of MI and permutation importance
  const combined = miScores.map((mi, i) => ({
    index: i,
    score: mi * 0.6 + (permScores[i] ?? 0) * 0.4,
    mi,
    perm: permScores[i] ?? 0,
  }))

  combined.sort((a, b) => b.score - a.score)

  // Determine which features to keep
  const dropCount = Math.min(maxDrop, combined.filter((c) => c.mi < miThreshold).length)

  return combined.map((c, rank) => ({
    featureName: featureNames[c.index] ?? `feature_${c.index}`,
    mutualInfo: c.mi,
    permutationImportance: c.perm,
    rank: rank + 1,
    keep: rank < combined.length - dropCount && c.mi >= miThreshold * 0.5,
  }))
}

/**
 * Get the list of feature indices to keep (for training a reduced model).
 */
export function selectFeatures(importance: FeatureImportance[]): number[] {
  return importance.filter((f) => f.keep).map((f) => importance.indexOf(f))
}
