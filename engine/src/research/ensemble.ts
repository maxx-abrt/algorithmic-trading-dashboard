/**
 * Ensemble Stacking — multiple diverse model types combined by a meta-learner.
 *
 * Diversity is key: each base model captures different patterns:
 *   - Ridge Logistic: linear relationships, calibrated probabilities
 *   - K-NN: local patterns in feature space (similar setups → similar outcomes)
 *   - Naive Bayes: probabilistic, good with regime-conditional independence
 *   - Decision Stumps: simple non-linear splits (captures threshold effects)
 *
 * The meta-learner (another logistic regression) learns to weight each
 * base model's prediction optimally. This is what wins Kaggle competitions.
 */

import { trainCalibratedLinear, predictCalibrated, type CalibratedLinearModel, type LabelledFeatureRow } from './calibration.js'

export type ModelKind = 'ridge_logistic' | 'knn' | 'naive_bayes' | 'decision_stump'

export interface BaseModel {
  kind: ModelKind
  predict(features: number[]): number
}

export interface EnsembleModel {
  kind: 'ensemble_stack'
  baseModels: BaseModel[]
  metaLearner: CalibratedLinearModel
  featureCount: number
  validationBrier: number | null
  trainedRows: number
}

// --- K-NN Model ---

interface KnnModel {
  kind: 'knn'
  trainFeatures: number[][]
  trainLabels: (0 | 1)[]
  k: number
}

function knnPredict(model: KnnModel, features: number[]): number {
  const dists = model.trainFeatures.map((tf, i) => ({
    dist: Math.sqrt(tf.reduce((s, v, j) => s + (v - features[j]) ** 2, 0)),
    label: model.trainLabels[i],
  }))
  dists.sort((a, b) => a.dist - b.dist)
  const neighbors = dists.slice(0, model.k)
  const wins = neighbors.filter((n) => n.label === 1).length
  // Weight by inverse distance
  const weightedWins = neighbors.reduce((s, n) => s + (n.label === 1 ? 1 / (n.dist + 1e-6) : 0), 0)
  const weightedTotal = neighbors.reduce((s, n) => s + 1 / (n.dist + 1e-6), 0)
  return weightedTotal > 0 ? weightedWins / weightedTotal : wins / model.k
}

function trainKnn(rows: LabelledFeatureRow[], k = 15): KnnModel {
  return {
    kind: 'knn',
    trainFeatures: rows.map((r) => r.features),
    trainLabels: rows.map((r) => r.label),
    k: Math.min(k, Math.max(5, Math.floor(Math.sqrt(rows.length)))),
  }
}

// --- Naive Bayes ---

interface NaiveBayesModel {
  kind: 'naive_bayes'
  means0: number[]
  vars0: number[]
  means1: number[]
  vars1: number[]
  prior0: number
  prior1: number
}

function naiveBayesPredict(model: NaiveBayesModel, features: number[]): number {
  let log0 = Math.log(model.prior0)
  let log1 = Math.log(model.prior1)

  for (let i = 0; i < features.length; i++) {
    log0 += logGaussian(features[i], model.means0[i], model.vars0[i])
    log1 += logGaussian(features[i], model.means1[i], model.vars1[i])
  }

  const sigmoid = 1 / (1 + Math.exp(log0 - log1))
  return sigmoid
}

function logGaussian(x: number, mean: number, variance: number): number {
  const v = Math.max(variance, 1e-8)
  return -0.5 * Math.log(2 * Math.PI * v) - ((x - mean) ** 2) / (2 * v)
}

function trainNaiveBayes(rows: LabelledFeatureRow[]): NaiveBayesModel {
  const dim = rows[0].features.length
  const class0 = rows.filter((r) => r.label === 0)
  const class1 = rows.filter((r) => r.label === 1)
  const n0 = class0.length || 1
  const n1 = class1.length || 1

  const means0 = Array.from({ length: dim }, (_, i) => class0.reduce((s, r) => s + r.features[i], 0) / n0)
  const means1 = Array.from({ length: dim }, (_, i) => class1.reduce((s, r) => s + r.features[i], 0) / n1)
  const vars0 = Array.from({ length: dim }, (_, i) => Math.max(1e-8, class0.reduce((s, r) => s + (r.features[i] - means0[i]) ** 2, 0) / n0))
  const vars1 = Array.from({ length: dim }, (_, i) => Math.max(1e-8, class1.reduce((s, r) => s + (r.features[i] - means1[i]) ** 2, 0) / n1))

  return {
    kind: 'naive_bayes',
    means0, vars0, means1, vars1,
    prior0: class0.length / rows.length,
    prior1: class1.length / rows.length,
  }
}

// --- Decision Stump (depth-1 decision tree) ---

interface DecisionStumpModel {
  kind: 'decision_stump'
  stumps: { featureIndex: number; threshold: number; positiveLeft: boolean }[]
}

function stumpPredict(model: DecisionStumpModel, features: number[]): number {
  let votes = 0
  for (const s of model.stumps) {
    const left = features[s.featureIndex] <= s.threshold
    const positive = s.positiveLeft ? left : !left
    if (positive) votes++
  }
  return votes / model.stumps.length
}

function trainDecisionStumps(rows: LabelledFeatureRow[], nStumps = 20): DecisionStumpModel {
  const dim = rows[0].features.length
  const stumps: { featureIndex: number; threshold: number; positiveLeft: boolean }[] = []

  for (let s = 0; s < nStumps; s++) {
    let bestGain = -Infinity
    let bestStump = { featureIndex: 0, threshold: 0, positiveLeft: true }

    // Try a random subset of features
    const featuresToTry = Math.min(dim, 5)
    const featureIndices = Array.from({ length: dim }, (_, i) => i)
      .sort(() => Math.random() - 0.5)
      .slice(0, featuresToTry)

    for (const fi of featureIndices) {
      const values = rows.map((r) => r.features[fi]).sort((a, b) => a - b)
      // Try several thresholds
      for (let t = 0; t < 10; t++) {
        const threshold = values[Math.floor((t + 0.5) * values.length / 10)] ?? 0
        const leftRows = rows.filter((r) => r.features[fi] <= threshold)
        const rightRows = rows.filter((r) => r.features[fi] > threshold)
        if (leftRows.length < 5 || rightRows.length < 5) continue

        const leftPos = leftRows.filter((r) => r.label === 1).length / leftRows.length
        const rightPos = rightRows.filter((r) => r.label === 1).length / rightRows.length
        const gain = Math.abs(leftPos - rightPos)

        if (gain > bestGain) {
          bestGain = gain
          bestStump = {
            featureIndex: fi,
            threshold,
            positiveLeft: leftPos > rightPos,
          }
        }
      }
    }

    stumps.push(bestStump)
  }

  return { kind: 'decision_stump', stumps }
}

// --- Ensemble Training ---

export function trainEnsemble(rows: LabelledFeatureRow[], options: { l2?: number } = {}): EnsembleModel | null {
  if (rows.length < 40) return null

  const ordered = [...rows].sort((a, b) => a.at - b.at)
  const cut = Math.max(25, Math.floor(ordered.length * 0.75))
  const train = ordered.slice(0, cut)
  const validation = ordered.slice(cut)

  if (!train.some((r) => r.label === 1) || !train.some((r) => r.label === 0)) return null

  const featureCount = train[0].features.length

  // Train base models on the training set
  const ridgeModel = trainCalibratedLinear(train, { l2: options.l2 ?? 0.02 })
  const knnModel = trainKnn(train)
  const nbModel = trainNaiveBayes(train)
  const stumpModel = trainDecisionStumps(train)

  if (!ridgeModel) return null

  // Generate meta-features on the validation set
  const metaRows: LabelledFeatureRow[] = validation.map((row) => {
    const ridgePred = predictCalibrated(ridgeModel, row.features)
    const knnPred = knnPredict(knnModel, row.features)
    const nbPred = naiveBayesPredict(nbModel, row.features)
    const stumpPred = stumpPredict(stumpModel, row.features)
    return {
      at: row.at,
      symbol: row.symbol,
      features: [ridgePred, knnPred, nbPred, stumpPred],
      label: row.label,
    }
  })

  // Train meta-learner on the base model predictions
  const metaLearner = trainCalibratedLinear(metaRows, { l2: 0.01, trainFraction: 0.7 })
  if (!metaLearner) return null

  // Compute validation Brier
  const probs = validation.map((row) => {
    const ridgePred = predictCalibrated(ridgeModel, row.features)
    const knnPred = knnPredict(knnModel, row.features)
    const nbPred = naiveBayesPredict(nbModel, row.features)
    const stumpPred = stumpPredict(stumpModel, row.features)
    return predictCalibrated(metaLearner, [ridgePred, knnPred, nbPred, stumpPred])
  })
  const validationBrier = probs.reduce((s, p, i) => s + (p - validation[i].label) ** 2, 0) / validation.length

  const baseModels: BaseModel[] = [
    { kind: 'ridge_logistic', predict: (f) => predictCalibrated(ridgeModel, f) },
    { kind: 'knn', predict: (f) => knnPredict(knnModel, f) },
    { kind: 'naive_bayes', predict: (f) => naiveBayesPredict(nbModel, f) },
    { kind: 'decision_stump', predict: (f) => stumpPredict(stumpModel, f) },
  ]

  return {
    kind: 'ensemble_stack',
    baseModels,
    metaLearner,
    featureCount,
    validationBrier,
    trainedRows: train.length,
  }
}

export function predictEnsemble(model: EnsembleModel, features: number[]): number {
  const basePredictions = model.baseModels.map((bm) => bm.predict(features))
  return predictCalibrated(model.metaLearner, basePredictions)
}

/**
 * Serialize ensemble model to JSON.
 * Note: K-NN stores all training data, so this can be large.
 * For production, consider using a condensed K-NN.
 */
export function serializeEnsemble(model: EnsembleModel): string {
  // We need to serialize the internal models too
  // For now, store the base model predictions as functions
  // In practice, we'd serialize all sub-models
  return JSON.stringify({
    kind: 'ensemble_stack',
    featureCount: model.featureCount,
    validationBrier: model.validationBrier,
    trainedRows: model.trainedRows,
    metaLearner: model.metaLearner,
    // Base models are serialized by their internal state
    // This is a simplified version — full serialization would
    // need to capture all sub-model states
  })
}
