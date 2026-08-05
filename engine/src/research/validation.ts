import { createHash } from 'node:crypto'
import type { PaperTrade } from '../paper/types.js'

export interface TimedSample {
  at: number
  symbol: string
}

export interface WalkForwardFold {
  fold: number
  train: number[]
  test: number[]
  trainStart: number
  trainEnd: number
  testStart: number
  testEnd: number
}

export interface ValidationMetrics {
  sample: number
  wins: number
  losses: number
  winRate: number | null
  meanR: number | null
  medianR: number | null
  profitFactor: number | null
  maxDrawdownR: number
  sharpe: number | null
  downsideDeviation: number | null
  bootstrapMeanR95: [number, number] | null
  deflatedSharpe: number | null
  probabilityBacktestOverfit: number | null
}

export function purgedWalkForward(samples: readonly TimedSample[], options: { folds?: number; purgeMs: number; embargoMs: number; minTrain?: number }): WalkForwardFold[] {
  const ordered = samples.map((sample, index) => ({ ...sample, index })).sort((a, b) => a.at - b.at)
  const folds = Math.max(2, Math.min(options.folds ?? 4, 10))
  const minTrain = Math.max(1, options.minTrain ?? Math.floor(ordered.length * 0.4))
  const testSize = Math.max(1, Math.floor((ordered.length - minTrain) / folds))
  const out: WalkForwardFold[] = []
  for (let fold = 0; fold < folds; fold++) {
    const testStartIndex = minTrain + fold * testSize
    const testEndIndex = fold === folds - 1 ? ordered.length : Math.min(ordered.length, testStartIndex + testSize)
    const testRows = ordered.slice(testStartIndex, testEndIndex)
    if (!testRows.length) continue
    const testStart = testRows[0].at
    const testEnd = testRows.at(-1)!.at
    const trainRows = ordered.slice(0, testStartIndex).filter((row) => row.at < testStart - options.purgeMs)
    const embargoEnd = testEnd + options.embargoMs
    const contaminated = trainRows.some((row) => row.at >= testStart - options.purgeMs && row.at <= embargoEnd)
    if (contaminated || !trainRows.length) continue
    out.push({
      fold, train: trainRows.map((row) => row.index), test: testRows.map((row) => row.index),
      trainStart: trainRows[0].at, trainEnd: trainRows.at(-1)!.at, testStart, testEnd,
    })
  }
  return out
}

function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))]
}

export function validationMetrics(trades: readonly PaperTrade[], trialCount = 1): ValidationMetrics {
  const returns = trades
    .filter((trade) => trade.status === 'closed')
    .map((trade) => trade.netRealizedR)
    .filter(Number.isFinite)
  if (!returns.length) {
    return { sample: 0, wins: 0, losses: 0, winRate: null, meanR: null, medianR: null, profitFactor: null, maxDrawdownR: 0, sharpe: null, downsideDeviation: null, bootstrapMeanR95: null, deflatedSharpe: null, probabilityBacktestOverfit: null }
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, returns.length - 1)
  const sd = Math.sqrt(variance)
  const downside = returns.filter((value) => value < 0)
  const downsideDeviation = Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, downside.length))
  const wins = returns.filter((value) => value > 0)
  const losses = returns.filter((value) => value < 0)
  const grossWin = wins.reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0))
  let equity = 0
  let peak = 0
  let maxDrawdownR = 0
  for (const value of returns) {
    equity += value
    peak = Math.max(peak, equity)
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity)
  }
  const random = seeded(0x5eed)
  const means: number[] = []
  for (let iteration = 0; iteration < Math.min(2000, Math.max(400, returns.length * 40)); iteration++) {
    let sum = 0
    for (let index = 0; index < returns.length; index++) sum += returns[Math.floor(random() * returns.length)]
    means.push(sum / returns.length)
  }
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(Math.min(252, returns.length)) : null
  const multipleTestingPenalty = Math.sqrt(2 * Math.log(Math.max(2, trialCount))) / Math.sqrt(Math.max(2, returns.length))
  const deflatedSharpe = sharpe == null ? null : sharpe - multipleTestingPenalty
  const losingHalves = returns.length >= 4
    ? Number(returns.slice(Math.floor(returns.length / 2)).reduce((sum, value) => sum + value, 0) <= 0)
    : 1
  return {
    sample: returns.length, wins: wins.length, losses: losses.length,
    winRate: wins.length / returns.length, meanR: mean, medianR: percentile(returns, 0.5),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
    maxDrawdownR, sharpe, downsideDeviation,
    bootstrapMeanR95: [percentile(means, 0.025), percentile(means, 0.975)],
    deflatedSharpe,
    probabilityBacktestOverfit: losingHalves,
  }
}

export function manifestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
