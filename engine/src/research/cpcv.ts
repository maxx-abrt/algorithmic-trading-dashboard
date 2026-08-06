/**
 * Combinatorial Purged Cross-Validation (CPCV).
 *
 * López de Prado's rigorous backtesting method that prevents the
 * #1 sin in quant: overfitting to lucky folds.
 *
 * Standard k-fold CV leaks information when labels overlap (e.g.
 * triple-barrier labels span multiple bars). CPCV solves this by:
 *   1. Purging: remove labels that span the train/test boundary
 *   2. Embargoing: add a buffer after test set to prevent leakage
 *   3. Combinatorial: test on multiple fold combinations, not just one
 *
 * This gives a distribution of backtest results, not a single number,
 * so we can compute confidence intervals on performance metrics.
 */

import type { LabelledFeatureRow } from './calibration.js'
import { trainCalibratedLinear, predictCalibrated } from './calibration.js'

export interface CPCVResult {
  /** mean Brier score across all folds */
  meanBrier: number
  /** std dev of Brier scores */
  stdBrier: number
  /** 95% confidence interval lower bound */
  brierLow: number
  /** 95% confidence interval upper bound */
  brierHigh: number
  /** mean accuracy across all folds */
  meanAccuracy: number
  /** per-fold results */
  folds: { foldId: number; brier: number; accuracy: number; trainSize: number; testSize: number }[]
  /** number of purged labels */
  purgedLabels: number
  /** number of embargoed labels */
  embargoedLabels: number
}

export interface CPCVConfig {
  /** number of base groups (N) */
  numGroups: number
  /** number of groups to use as test (K) */
  numTestGroups: number
  /** embargo period in bars after test set */
  embargoBars: number
  /** label span in bars (for purging) — how many bars a label covers */
  labelSpan: number
}

export const DEFAULT_CPCV_CONFIG: CPCVConfig = {
  numGroups: 6,
  numTestGroups: 2,
  embargoBars: 10,
  labelSpan: 48, // max bars for triple-barrier
}

/**
 * Run CPCV on labeled data.
 * Returns a distribution of out-of-sample performance metrics.
 */
export function runCPCV(
  rows: LabelledFeatureRow[],
  config: CPCVConfig = DEFAULT_CPCV_CONFIG,
): CPCVResult | null {
  if (rows.length < 60) return null

  const ordered = [...rows].sort((a, b) => a.at - b.at)
  const n = ordered.length
  const groupSize = Math.floor(n / config.numGroups)

  // Generate all combinations of K groups from N
  const combinations = generateCombinations(config.numGroups, config.numTestGroups)

  const folds: CPCVResult['folds'] = []
  let totalPurged = 0
  let totalEmbargoed = 0

  for (let foldIdx = 0; foldIdx < combinations.length; foldIdx++) {
    const testGroups = combinations[foldIdx]
    const testIndices = new Set<number>()

    for (const g of testGroups) {
      const start = g * groupSize
      const end = Math.min((g + 1) * groupSize, n)
      for (let i = start; i < end; i++) testIndices.add(i)
    }

    // Purging: remove training labels that span into test set
    const purgedIndices = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (testIndices.has(i)) continue
      // Check if this label's span reaches into a test group
      const labelEnd = i + config.labelSpan
      for (const g of testGroups) {
        const testStart = g * groupSize
        const testEnd = Math.min((g + 1) * groupSize, n)
        if (labelEnd > testStart && i < testStart) {
          purgedIndices.add(i)
          totalPurged++
          break
        }
      }
    }

    // Embargoing: remove labels right after test set
    const embargoedIndices = new Set<number>()
    for (const g of testGroups) {
      const testEnd = Math.min((g + 1) * groupSize, n)
      for (let i = testEnd; i < Math.min(testEnd + config.embargoBars, n); i++) {
        if (!testIndices.has(i)) {
          embargoedIndices.add(i)
          totalEmbargoed++
        }
      }
    }

    // Build train and test sets
    const trainRows = ordered.filter((_, i) =>
      !testIndices.has(i) && !purgedIndices.has(i) && !embargoedIndices.has(i)
    )
    const testRows = ordered.filter((_, i) => testIndices.has(i))

    if (trainRows.length < 20 || testRows.length < 5) continue
    if (!trainRows.some((r) => r.label === 1) || !trainRows.some((r) => r.label === 0)) continue

    const model = trainCalibratedLinear(trainRows, { l2: 0.02, trainFraction: 1.0 })
    if (!model) continue

    // Evaluate on test set
    const probs = testRows.map((r) => predictCalibrated(model, r.features))
    const brier = probs.reduce((s, p, i) => s + (p - testRows[i].label) ** 2, 0) / testRows.length
    const accuracy = probs.filter((p, i) => (p > 0.5 ? 1 : 0) === testRows[i].label).length / testRows.length

    folds.push({
      foldId: foldIdx,
      brier,
      accuracy,
      trainSize: trainRows.length,
      testSize: testRows.length,
    })
  }

  if (folds.length === 0) return null

  const briers = folds.map((f) => f.brier)
  const accuracies = folds.map((f) => f.accuracy)
  const meanBrier = briers.reduce((s, b) => s + b, 0) / briers.length
  const stdBrier = Math.sqrt(briers.reduce((s, b) => s + (b - meanBrier) ** 2, 0) / briers.length)
  const meanAccuracy = accuracies.reduce((s, a) => s + a, 0) / accuracies.length

  // 95% CI using normal approximation
  const brierLow = meanBrier - 1.96 * stdBrier / Math.sqrt(folds.length)
  const brierHigh = meanBrier + 1.96 * stdBrier / Math.sqrt(folds.length)

  return {
    meanBrier,
    stdBrier,
    brierLow,
    brierHigh,
    meanAccuracy,
    folds,
    purgedLabels: totalPurged,
    embargoedLabels: totalEmbargoed,
  }
}

/**
 * Generate all C(N, K) combinations.
 */
function generateCombinations(n: number, k: number): number[][] {
  const result: number[][] = []
  const combo: number[] = []

  function backtrack(start: number) {
    if (combo.length === k) {
      result.push([...combo])
      return
    }
    for (let i = start; i < n; i++) {
      combo.push(i)
      backtrack(i + 1)
      combo.pop()
    }
  }

  backtrack(0)
  return result
}
