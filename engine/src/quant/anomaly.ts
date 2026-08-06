/**
 * Anomaly Detection — Mahalanobis distance & isolation forest.
 *
 * Detects when current market conditions are unlike anything in the
 * training data. When the model is in "unknown territory", we reduce
 * exposure to minimum — this prevents the #1 cause of blowouts:
 * trading in conditions the model has never seen.
 *
 * Methods:
 *   1. Mahalanobis distance: measures how many standard deviations
 *      the current point is from the training distribution center.
 *   2. Isolation Forest: builds random trees, anomalies have shorter
 *      path lengths (easier to isolate).
 *   3. Feature range check: simple but effective — if any feature
 *      is outside [min, max] of training data, flag it.
 */

export interface AnomalyResult {
  isAnomaly: boolean
  /** Mahalanobis distance (higher = more anomalous) */
  mahalanobisDist: number
  /** normalized anomaly score 0..1 (1 = extreme anomaly) */
  anomalyScore: number
  /** which features are out of range */
  outOfRangeFeatures: string[]
  /** recommended action */
  action: 'normal' | 'caution' | 'reduce' | 'skip'
  /** reason string */
  reason: string
}

export interface AnomalyModel {
  means: number[]
  invCovDiag: number[] // diagonal inverse covariance (simplified)
  featureMin: number[]
  featureMax: number[]
  featureNames: string[]
  threshold: number
}

/**
 * Fit anomaly detection model from training data.
 */
export function fitAnomalyModel(
  features: number[][],
  featureNames: string[],
  threshold = 3.5, // 3.5 sigma = 0.05% false positive rate
): AnomalyModel {
  const n = features.length
  const dim = features[0]?.length ?? 0

  const means = Array.from({ length: dim }, (_, d) =>
    features.reduce((s, f) => s + f[d], 0) / n
  )

  const variances = Array.from({ length: dim }, (_, d) => {
    const v = features.reduce((s, f) => s + (f[d] - means[d]) ** 2, 0) / n
    return Math.max(v, 1e-8)
  })

  const invCovDiag = variances.map((v) => 1 / v)

  const featureMin = Array.from({ length: dim }, (_, d) => Math.min(...features.map((f) => f[d])))
  const featureMax = Array.from({ length: dim }, (_, d) => Math.max(...features.map((f) => f[d])))

  return { means, invCovDiag, featureMin, featureMax, featureNames, threshold }
}

/**
 * Detect anomalies in a feature vector.
 */
export function detectAnomaly(model: AnomalyModel, features: number[]): AnomalyResult {
  const dim = model.means.length

  // Mahalanobis distance (diagonal approximation)
  let mahalaSq = 0
  for (let i = 0; i < dim; i++) {
    const diff = features[i] - model.means[i]
    mahalaSq += diff * diff * model.invCovDiag[i]
  }
  const mahalanobisDist = Math.sqrt(mahalaSq)

  // Out-of-range features
  const outOfRangeFeatures: string[] = []
  for (let i = 0; i < dim; i++) {
    if (features[i] < model.featureMin[i] || features[i] > model.featureMax[i]) {
      outOfRangeFeatures.push(model.featureNames[i] ?? `feature_${i}`)
    }
  }

  // Normalized anomaly score
  const anomalyScore = Math.min(1, mahalanobisDist / (model.threshold * 2))

  // Determine action
  let action: AnomalyResult['action'] = 'normal'
  let reason = 'normal conditions'

  if (mahalanobisDist > model.threshold * 2 || outOfRangeFeatures.length >= 3) {
    action = 'skip'
    reason = `extreme anomaly (dist=${mahalanobisDist.toFixed(2)}, ${outOfRangeFeatures.length} features OOR)`
  } else if (mahalanobisDist > model.threshold || outOfRangeFeatures.length >= 1) {
    action = 'reduce'
    reason = `anomaly detected (dist=${mahalanobisDist.toFixed(2)}, OOR: ${outOfRangeFeatures.join(', ')})`
  } else if (mahalanobisDist > model.threshold * 0.7) {
    action = 'caution'
    reason = `elevated distance (${mahalanobisDist.toFixed(2)})`
  }

  return {
    isAnomaly: action !== 'normal',
    mahalanobisDist,
    anomalyScore,
    outOfRangeFeatures,
    action,
    reason,
  }
}

/**
 * Isolation Forest — simplified version.
 * Builds N random trees, measures average path length to isolate each point.
 * Anomalies have shorter paths (easier to isolate).
 */
export class IsolationForest {
  private trees: { splits: { featureIndex: number; threshold: number; left: number; right: number }[] }[] = []
  private readonly nTrees: number
  private readonly maxDepth: number

  constructor(nTrees = 50, maxDepth = 8) {
    this.nTrees = nTrees
    this.maxDepth = maxDepth
  }

  fit(data: number[][]): void {
    const dim = data[0]?.length ?? 0
    if (dim === 0 || data.length === 0) return

    this.trees = []
    for (let t = 0; t < this.nTrees; t++) {
      // Sample subset
      const sampleSize = Math.min(data.length, Math.max(16, Math.floor(data.length * 0.7)))
      const sample = [...data].sort(() => Math.random() - 0.5).slice(0, sampleSize)
      this.trees.push(this.buildTree(sample, 0))
    }
  }

  score(features: number[]): number {
    if (this.trees.length === 0) return 0

    // Average path length across all trees
    let totalDepth = 0
    for (const tree of this.trees) {
      totalDepth += this.pathLength(tree, features, 0)
    }
    const avgDepth = totalDepth / this.trees.length

    // Normalize: c(n) = 2 * H(n-1) - 2*(n-1)/n where H is harmonic number
    // Simplified: anomaly score = 1 - 2^(-avgDepth / c)
    const c = 2 * (Math.log(this.trees.length + 0.5) + 0.5772) - 2 * this.trees.length / (this.trees.length + 1)
    const score = 1 - Math.pow(2, -avgDepth / c)
    return Math.max(0, Math.min(1, score))
  }

  private buildTree(data: number[][], depth: number): { splits: { featureIndex: number; threshold: number; left: number; right: number }[] } {
    const splits: { featureIndex: number; threshold: number; left: number; right: number }[] = []
    if (depth >= this.maxDepth || data.length <= 2) {
      return { splits }
    }

    const dim = data[0].length
    const featureIndex = Math.floor(Math.random() * dim)
    const values = data.map((d) => d[featureIndex])
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (min === max) return { splits }

    const threshold = min + Math.random() * (max - min)
    const leftData = data.filter((d) => d[featureIndex] < threshold)
    const rightData = data.filter((d) => d[featureIndex] >= threshold)

    splits.push({ featureIndex, threshold, left: splits.length + 1, right: splits.length + 2 })

    // Recursively build (simplified — store as flat array)
    const leftTree = this.buildTree(leftData, depth + 1)
    const rightTree = this.buildTree(rightData, depth + 1)
    splits.push(...leftTree.splits, ...rightTree.splits)

    return { splits }
  }

  private pathLength(tree: { splits: { featureIndex: number; threshold: number; left: number; right: number }[] }, features: number[], nodeIndex: number): number {
    if (nodeIndex >= tree.splits.length) return 1
    const split = tree.splits[nodeIndex]
    if (features[split.featureIndex] < split.threshold) {
      return 1 + this.pathLength(tree, features, split.left)
    } else {
      return 1 + this.pathLength(tree, features, split.right)
    }
  }
}
