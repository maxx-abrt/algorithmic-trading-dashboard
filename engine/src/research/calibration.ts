export interface LabelledFeatureRow {
  at: number
  symbol: string
  features: number[]
  label: 0 | 1
}

export interface CalibratedLinearModel {
  kind: 'ridge_logistic_platt'
  featureCount: number
  means: number[]
  scales: number[]
  weights: number[]
  bias: number
  plattA: number
  plattB: number
  validationBrier: number | null
  trainedRows: number
  validationRows: number
}

const sigmoid = (value: number) => {
  const clipped = Math.max(-30, Math.min(30, value))
  return 1 / (1 + Math.exp(-clipped))
}

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)

export function trainCalibratedLinear(rows: readonly LabelledFeatureRow[], options: { iterations?: number; learningRate?: number; l2?: number; trainFraction?: number } = {}): CalibratedLinearModel | null {
  if (rows.length < 30) return null
  const ordered = [...rows].sort((a, b) => a.at - b.at)
  const featureCount = ordered[0]?.features.length ?? 0
  if (!featureCount || ordered.some((row) => row.features.length !== featureCount || row.features.some((value) => !Number.isFinite(value)))) return null
  const cut = Math.max(20, Math.min(ordered.length - 8, Math.floor(ordered.length * (options.trainFraction ?? 0.75))))
  const train = ordered.slice(0, cut)
  const validation = ordered.slice(cut)
  if (!train.some((row) => row.label === 1) || !train.some((row) => row.label === 0)) return null

  const means = Array.from({ length: featureCount }, (_, index) => train.reduce((sum, row) => sum + row.features[index], 0) / train.length)
  const scales = means.map((mean, index) => Math.max(1e-6, Math.sqrt(train.reduce((sum, row) => sum + (row.features[index] - mean) ** 2, 0) / train.length)))
  const normalize = (features: readonly number[]) => features.map((value, index) => (value - means[index]) / scales[index])
  let weights = Array(featureCount).fill(0) as number[]
  let bias = 0
  const iterations = options.iterations ?? 800
  const learningRate = options.learningRate ?? 0.04
  const l2 = options.l2 ?? 0.02
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = Array(featureCount).fill(0) as number[]
    let biasGradient = 0
    for (const row of train) {
      const x = normalize(row.features)
      const error = sigmoid(dot(weights, x) + bias) - row.label
      for (let index = 0; index < featureCount; index++) gradient[index] += error * x[index]
      biasGradient += error
    }
    weights = weights.map((weight, index) => weight - learningRate * (gradient[index] / train.length + l2 * weight))
    bias -= learningRate * biasGradient / train.length
  }

  // Platt calibration is fit only on the chronological validation tail.
  let plattA = 1
  let plattB = 0
  if (validation.some((row) => row.label === 1) && validation.some((row) => row.label === 0)) {
    for (let iteration = 0; iteration < 400; iteration++) {
      let gradA = 0
      let gradB = 0
      for (const row of validation) {
        const logit = dot(weights, normalize(row.features)) + bias
        const error = sigmoid(plattA * logit + plattB) - row.label
        gradA += error * logit
        gradB += error
      }
      plattA -= 0.02 * gradA / validation.length
      plattB -= 0.02 * gradB / validation.length
    }
  }
  const probabilities = validation.map((row) => sigmoid(plattA * (dot(weights, normalize(row.features)) + bias) + plattB))
  const validationBrier = validation.length
    ? probabilities.reduce((sum, probability, index) => sum + (probability - validation[index].label) ** 2, 0) / validation.length
    : null
  return { kind: 'ridge_logistic_platt', featureCount, means, scales, weights, bias, plattA, plattB, validationBrier, trainedRows: train.length, validationRows: validation.length }
}

export function predictCalibrated(model: CalibratedLinearModel, features: readonly number[]) {
  if (features.length !== model.featureCount) throw new Error('feature count mismatch')
  const normalized = features.map((value, index) => (value - model.means[index]) / model.scales[index])
  return sigmoid(model.plattA * (dot(model.weights, normalized) + model.bias) + model.plattB)
}
