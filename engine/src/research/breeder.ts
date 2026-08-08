/**
 * THE BREEDER — evolution whose fitness function is an out-of-sample equity curve.
 *
 * What was wrong before
 * ---------------------
 * The old generational loop optimised Brier score on a holdout of rows and then
 * declared a winner. Brier score is a calibration proxy. It says nothing about
 * whether acting on the probability makes money after fees, and it is perfectly
 * possible (and it happened: every niche showed negative cumulative R) to improve
 * it while losing more.
 *
 * What this does instead
 * ----------------------
 * A genome is a complete TRADING POLICY, not just a classifier:
 *
 *     genome = { featureMask, l2, exitVariant, thresholdQuantile }
 *
 * Fitness = run that policy through the ARENA: purged walk-forward folds over the
 * decision tape, model retrained inside every fold, threshold and exit chosen on
 * the training slice only, measured on the test slice, compared against
 * take-everything, penalised for drawdown and for having too few trades.
 *
 * A generation is only accepted when it beats
 *   1. its own parent, out of sample
 *   2. the take-everything baseline, out of sample
 *   3. its own shuffled-label placebo (the search must not be finding noise)
 *
 * Every specialist therefore ships with a real equity curve, a real Sharpe, a real
 * drawdown, per-regime behaviour and a list of concrete SKILLS: the regimes,
 * volatility buckets, sessions and symbols where it is measurably good.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { predictCalibrated, trainCalibratedLinear, type CalibratedLinearModel } from './calibration.js'
import { FEATURE_COUNT_V3, FEATURE_ORDER_V3, FEATURE_SCHEMA_V3 } from './features-v3.js'
import { mutualInformation } from './feature-importance.js'
import { EXIT_LIBRARY, type ExitVariant } from '../arena/exit-sim.js'
import { runArena, DEFAULT_ARENA_CONFIG, type ArenaReport, type Scorer, type TrainFn } from '../arena/arena.js'
import { groupMetrics, type TradeSample } from '../arena/metrics.js'
import type { TapeRow } from '../store/tape-store.js'
import { specialistPath } from '../store/paths.js'
import { generateModelName } from './naming.js'

export interface Niche {
  playbook: string
  instType: string
  timeframe: string
}

export const nicheKey = (niche: Niche) => `${niche.playbook}|${niche.instType}|${niche.timeframe}`
export const parseNicheKey = (key: string): Niche => {
  const [playbook = 'any', instType = 'ANY', timeframe = '30m'] = key.split('|')
  return { playbook, instType, timeframe }
}
export const nicheLabel = (niche: Niche) => `${niche.playbook.replace(/_/g, ' ')} · ${niche.instType} · ${niche.timeframe}`

export interface Genome {
  featureMask: boolean[]
  l2: number
  exitVariantId: string
  thresholdQuantile: number
}

export interface SpecialistArtifactV3 {
  kind: 'specialist_v3'
  niche: Niche
  featureSchema: string
  featureOrder: string[]
  genome: Genome
  model: CalibratedLinearModel
  /** absolute probability cut derived from the training distribution */
  threshold: number
  generation: number
  parentHash: string | null
  trainedAt: number
}

export interface SkillProfile {
  /** contexts where the specialist is measurably good, sorted by evidence */
  regimes: { key: number; label: string; trades: number; meanR: number; sumR: number }[]
  sessions: { key: string; trades: number; meanR: number }[]
  symbols: { key: string; trades: number; meanR: number }[]
  exitReasons: { key: string; trades: number; meanR: number }[]
  /** short human sentences the UI renders as badges */
  badges: string[]
}

const REGIME_LABELS = ['calm trend', 'calm range', 'volatile trend', 'volatile range', 'crisis']

export function artifactHashV3(artifact: Omit<SpecialistArtifactV3, 'trainedAt'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        niche: artifact.niche,
        schema: artifact.featureSchema,
        mask: artifact.genome.featureMask,
        l2: artifact.genome.l2,
        exit: artifact.genome.exitVariantId,
        q: artifact.genome.thresholdQuantile,
        weights: artifact.model.weights.map((value) => Number(value.toFixed(8))),
        bias: Number(artifact.model.bias.toFixed(8)),
        generation: artifact.generation,
      }),
    )
    .digest('hex')
}

export function applyMask(features: readonly number[], mask: readonly boolean[]): number[] {
  const out = new Array<number>(features.length)
  for (let index = 0; index < features.length; index++) out[index] = mask[index] === false ? 0 : features[index]
  return out
}

export function saveArtifact(hash: string, artifact: SpecialistArtifactV3): string {
  const path = specialistPath(hash)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(artifact))
  return path
}

export function loadArtifact(path: string | null): SpecialistArtifactV3 | null {
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SpecialistArtifactV3
    return parsed?.kind === 'specialist_v3' ? parsed : null
  } catch {
    return null
  }
}

export function predictWithArtifact(artifact: SpecialistArtifactV3, features: readonly number[]): number | null {
  try {
    return predictCalibrated(artifact.model, applyMask(features, artifact.genome.featureMask))
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Deterministic RNG                                                         */
/* -------------------------------------------------------------------------- */

function rng(seed: number) {
  let state = (seed || 1) >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/* -------------------------------------------------------------------------- */
/*  Genome operators                                                          */
/* -------------------------------------------------------------------------- */

const L2_GRID = [0.005, 0.02, 0.05, 0.2, 0.8]
const QUANTILE_GRID = [0.4, 0.5, 0.6, 0.7, 0.8, 0.88]

function seedGenomes(rows: readonly TapeRow[], size: number, random: () => number, parent?: Genome | null): Genome[] {
  const mi = mutualInformation(
    rows.slice(-4000).map((row) => ({ at: row.at, symbol: row.symbol, features: row.features, label: (row.baselineLabel === 1 ? 1 : 0) as 0 | 1 })),
    [...FEATURE_ORDER_V3],
  )
  const ranked = mi
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.index)
  const topK = (k: number) => {
    const mask = new Array<boolean>(FEATURE_COUNT_V3).fill(false)
    for (const index of ranked.slice(0, k)) mask[index] = true
    return mask
  }
  const genomes: Genome[] = []
  if (parent) {
    genomes.push({ ...parent, featureMask: [...parent.featureMask] })
    genomes.push({ ...parent, featureMask: mutateMask(parent.featureMask, random, 2) })
    genomes.push({ ...parent, featureMask: mutateMask(parent.featureMask, random, 6), exitVariantId: EXIT_LIBRARY[Math.floor(random() * EXIT_LIBRARY.length)].id })
  }
  genomes.push(
    { featureMask: new Array<boolean>(FEATURE_COUNT_V3).fill(true), l2: 0.05, exitVariantId: 'plan', thresholdQuantile: 0.7 },
    { featureMask: topK(48), l2: 0.02, exitVariantId: 'ladder_1_2_3', thresholdQuantile: 0.6 },
    { featureMask: topK(24), l2: 0.05, exitVariantId: 'wide_runner', thresholdQuantile: 0.7 },
    { featureMask: topK(12), l2: 0.2, exitVariantId: 'tight_1r', thresholdQuantile: 0.8 },
  )
  while (genomes.length < size) {
    const mask = Array.from({ length: FEATURE_COUNT_V3 }, () => random() < 0.45)
    if (!mask.some(Boolean)) mask[ranked[0] ?? 0] = true
    genomes.push({
      featureMask: mask,
      l2: L2_GRID[Math.floor(random() * L2_GRID.length)],
      exitVariantId: EXIT_LIBRARY[Math.floor(random() * EXIT_LIBRARY.length)].id,
      thresholdQuantile: QUANTILE_GRID[Math.floor(random() * QUANTILE_GRID.length)],
    })
  }
  return genomes.slice(0, size)
}

function mutateMask(mask: readonly boolean[], random: () => number, flips: number): boolean[] {
  const child = [...mask]
  for (let flip = 0; flip < flips; flip++) {
    const index = Math.floor(random() * child.length)
    child[index] = !child[index]
  }
  if (!child.some(Boolean)) child[Math.floor(random() * child.length)] = true
  return child
}

function breed(a: Genome, b: Genome, random: () => number): Genome {
  const mask = a.featureMask.map((bit, index) => (random() < 0.5 ? bit : (b.featureMask[index] ?? bit)))
  if (!mask.some(Boolean)) mask[0] = true
  return {
    featureMask: mutateMask(mask, random, 1 + Math.floor(random() * 3)),
    l2: random() < 0.5 ? a.l2 : b.l2,
    exitVariantId: random() < 0.5 ? a.exitVariantId : b.exitVariantId,
    thresholdQuantile: random() < 0.5 ? a.thresholdQuantile : b.thresholdQuantile,
  }
}

/* -------------------------------------------------------------------------- */
/*  Fitness                                                                   */
/* -------------------------------------------------------------------------- */

function trainerFor(genome: Genome): TrainFn {
  return (rows) => {
    const model = trainCalibratedLinear(
      rows.map((row) => ({ at: row.at, symbol: row.symbol, features: applyMask(row.features, genome.featureMask), label: (row.baselineLabel === 1 ? 1 : 0) as 0 | 1 })),
      { l2: genome.l2 },
    )
    if (!model) return null
    const scorer: Scorer = (features) => {
      try {
        return predictCalibrated(model, applyMask(features, genome.featureMask))
      } catch {
        return null
      }
    }
    return { scorer, info: { l2: genome.l2, featuresUsed: genome.featureMask.filter(Boolean).length, trainedRows: model.trainedRows } }
  }
}

function variantById(id: string): ExitVariant {
  return EXIT_LIBRARY.find((variant) => variant.id === id) ?? EXIT_LIBRARY[0]
}

/**
 * The objective the whole system climbs.
 *
 * It is deliberately conservative: expectancy is the core term, but it is scaled by
 * the square root of the sample size (so 12 lucky trades cannot beat 400 solid
 * ones), it requires the lift over the baseline to be real, it pays for
 * consistency across folds, and it subtracts drawdown.
 */
export function arenaFitness(report: ArenaReport): number {
  if (report.policy.trades < 25) return -10 + report.policy.trades / 100
  const expectancy = report.policy.meanR
  const lift = report.meanRLift
  const consistency = report.folds.length ? report.foldsPositive / report.folds.length : 0
  const drawdownPenalty = Math.min(1, report.policy.maxDrawdownR / Math.max(4, report.policy.trades * 0.35))
  const sampleWeight = Math.min(1.6, Math.sqrt(report.policy.trades / 120))
  const holdoutBonus = report.holdout && report.holdout.trades >= 20 ? Math.max(-0.3, Math.min(0.3, report.holdout.meanR)) : 0
  const significance = Math.max(0, 1 - report.policy.pValue)
  return (
    expectancy * 1.4 * sampleWeight +
    lift * 1.6 +
    consistency * 0.5 +
    holdoutBonus * 0.8 +
    significance * 0.25 -
    drawdownPenalty * 0.6
  )
}

export interface BreedOptions {
  populationSize?: number
  generations?: number
  seed?: number
  parent?: SpecialistArtifactV3 | null
  /** folds used during the search (cheap); the winner is re-run with more */
  searchFolds?: number
  finalFolds?: number
  holdoutSymbols?: string[]
  placebo?: boolean
  /** minimum out-of-sample lift over the baseline for a birth to be allowed */
  minLift?: number
  /** wall-clock budget in ms; the search stops cleanly when exceeded */
  budgetMs?: number
}

export interface BreedTrial {
  ordinal: number
  generation: number
  featuresUsed: number
  l2: number
  exitVariantId: string
  thresholdQuantile: number
  fitness: number
  meanR: number
  meanRLift: number
  oosTrades: number
  foldsPositive: number
  verdict: string
  accepted: boolean
}

export interface BreedResult {
  niche: Niche
  best: { artifact: SpecialistArtifactV3; report: ArenaReport; genome: Genome; fitness: number } | null
  trials: BreedTrial[]
  placeboFitness: number | null
  parentFitness: number | null
  rejectionReason: string | null
  rows: number
  elapsedMs: number
}

/** Everything the arena knows about WHERE a specialist is good. */
export function skillProfile(report: ArenaReport): SkillProfile {
  const trades = report.trades as (TradeSample & { exitReason: string })[]
  const sessionOf = (at: number) => {
    const hour = new Date(at).getUTCHours()
    if (hour >= 0 && hour < 7) return 'asia'
    if (hour >= 7 && hour < 12) return 'europe'
    if (hour >= 12 && hour < 16) return 'eu/us overlap'
    if (hour >= 16 && hour < 21) return 'us'
    return 'late us'
  }
  const regimes = groupMetrics(trades, (trade) => trade.regimeId ?? null)
    .filter((row) => row.metrics.trades >= 8)
    .map((row) => ({ key: Number(row.key), label: REGIME_LABELS[Number(row.key)] ?? `regime ${row.key}`, trades: row.metrics.trades, meanR: row.metrics.meanR, sumR: row.metrics.sumR }))
  const sessions = groupMetrics(trades, (trade) => sessionOf(trade.at))
    .filter((row) => row.metrics.trades >= 8)
    .map((row) => ({ key: String(row.key), trades: row.metrics.trades, meanR: row.metrics.meanR }))
  const symbols = groupMetrics(trades, (trade) => trade.symbol ?? null)
    .filter((row) => row.metrics.trades >= 6)
    .map((row) => ({ key: String(row.key), trades: row.metrics.trades, meanR: row.metrics.meanR }))
  const exitReasons = groupMetrics(trades, (trade) => (trade as { exitReason?: string }).exitReason ?? null).map((row) => ({ key: String(row.key), trades: row.metrics.trades, meanR: row.metrics.meanR }))

  const badges: string[] = []
  const bestRegime = regimes.filter((row) => row.meanR > 0).sort((a, b) => b.meanR - a.meanR)[0]
  if (bestRegime) badges.push(`${bestRegime.label} +${bestRegime.meanR.toFixed(2)}R (${bestRegime.trades})`)
  const bestSession = sessions.filter((row) => row.meanR > 0).sort((a, b) => b.meanR - a.meanR)[0]
  if (bestSession) badges.push(`${bestSession.key} session +${bestSession.meanR.toFixed(2)}R`)
  const bestSymbol = symbols.filter((row) => row.meanR > 0).sort((a, b) => b.meanR - a.meanR)[0]
  if (bestSymbol) badges.push(`${bestSymbol.key} +${bestSymbol.meanR.toFixed(2)}R`)
  if (report.holdout && report.holdout.trades >= 20) badges.push(`held-out symbol ${report.holdout.meanR >= 0 ? '+' : ''}${report.holdout.meanR.toFixed(2)}R`)
  if (report.info?.variant) badges.push(`exit: ${String(report.info.variant)}`)
  return { regimes, sessions, symbols, exitReasons, badges }
}

/** Shuffle labels AND outcomes together so the placebo keeps the same marginals. */
function shuffleRows(rows: readonly TapeRow[], seed: number): TapeRow[] {
  const random = rng(seed)
  const order = rows.map((_, index) => index)
  for (let index = order.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[order[index], order[swap]] = [order[swap], order[index]]
  }
  return rows.map((row, index) => {
    const donor = rows[order[index]]
    return { ...row, features: donor.features }
  })
}

/**
 * Run one bounded evolutionary search. Deterministic for a given seed, so any
 * result in the UI can be reproduced exactly.
 */
/** Hand the event loop back so the live HTTP API and the WebSocket feed never stall. */
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export async function breedSpecialist(rows: readonly TapeRow[], niche: Niche, options: BreedOptions = {}): Promise<BreedResult> {
  const started = Date.now()
  const populationSize = Math.max(4, Math.min(options.populationSize ?? 8, 24))
  const generations = Math.max(1, Math.min(options.generations ?? 3, 8))
  const seed = options.seed ?? 0x5eed
  const random = rng(seed)
  const searchFolds = Math.max(2, Math.min(options.searchFolds ?? 3, 6))
  const finalFolds = Math.max(searchFolds, Math.min(options.finalFolds ?? 4, 8))
  const budgetMs = Math.max(5_000, options.budgetMs ?? 90_000)
  const minLift = options.minLift ?? 0.02
  const trials: BreedTrial[] = []

  if (rows.length < 200) {
    return { niche, best: null, trials, placeboFitness: null, parentFitness: null, rejectionReason: `insufficient_rows(${rows.length})`, rows: rows.length, elapsedMs: Date.now() - started }
  }

  const holdoutSymbols = options.holdoutSymbols ?? []
  const evaluate = (genome: Genome, folds: number, label: string, data: readonly TapeRow[] = rows) =>
    runArena(data, trainerFor(genome), {
      ...DEFAULT_ARENA_CONFIG,
      label,
      nicheKey: nicheKey(niche),
      folds,
      variants: [variantById(genome.exitVariantId)],
      thresholdGrid: [genome.thresholdQuantile],
      holdoutSymbols,
      minCoverage: 0.06,
    })

  let genomes = seedGenomes(rows, populationSize, random, options.parent?.genome ?? null)
  let ordinal = 0
  let best: { genome: Genome; report: ArenaReport; fitness: number } | null = null

  for (let generation = 0; generation < generations; generation++) {
    const evaluated: { genome: Genome; report: ArenaReport; fitness: number }[] = []
    for (const genome of genomes) {
      if (Date.now() - started > budgetMs) break
      const report = evaluate(genome, searchFolds, `gen${generation}`)
      await yieldToLoop()
      const fitness = arenaFitness(report)
      ordinal++
      trials.push({
        ordinal,
        generation,
        featuresUsed: genome.featureMask.filter(Boolean).length,
        l2: genome.l2,
        exitVariantId: genome.exitVariantId,
        thresholdQuantile: genome.thresholdQuantile,
        fitness,
        meanR: report.policy.meanR,
        meanRLift: report.meanRLift,
        oosTrades: report.policy.trades,
        foldsPositive: report.foldsPositive,
        verdict: report.verdict,
        accepted: false,
      })
      evaluated.push({ genome, report, fitness })
      if (!best || fitness > best.fitness) best = { genome, report, fitness }
    }
    if (!evaluated.length || Date.now() - started > budgetMs) break
    evaluated.sort((a, b) => b.fitness - a.fitness)
    const elite = evaluated.slice(0, Math.max(2, Math.floor(populationSize / 3))).map((entry) => entry.genome)
    const next: Genome[] = [...elite]
    while (next.length < populationSize) {
      const a = elite[Math.floor(random() * elite.length)]
      const b = elite[Math.floor(random() * elite.length)]
      next.push(breed(a, b, random))
    }
    genomes = next
  }

  if (!best) {
    return { niche, best: null, trials, placeboFitness: null, parentFitness: null, rejectionReason: 'all_trials_failed', rows: rows.length, elapsedMs: Date.now() - started }
  }

  /* ---- final, more expensive verification of the winner ------------------ */
  const finalReport = evaluate(best.genome, finalFolds, 'final')
  await yieldToLoop()
  const finalFitness = arenaFitness(finalReport)

  /* ---- placebo: the same search on shuffled features -------------------- */
  let placeboFitness: number | null = null
  if (options.placebo !== false) {
    const shuffled = shuffleRows(rows, seed ^ 0x9e3779b9)
    const placeboReport = evaluate(best.genome, searchFolds, 'placebo', shuffled)
    await yieldToLoop()
    placeboFitness = arenaFitness(placeboReport)
  }

  /* ---- parent comparison ------------------------------------------------ */
  let parentFitness: number | null = null
  if (options.parent) {
    const parentReport = evaluate(options.parent.genome, finalFolds, 'parent')
    await yieldToLoop()
    parentFitness = arenaFitness(parentReport)
  }

  const reasons: string[] = []
  if (finalReport.policy.trades < 30) reasons.push(`too_few_oos_trades(${finalReport.policy.trades})`)
  if (finalReport.meanRLift < minLift) reasons.push(`lift_${finalReport.meanRLift.toFixed(3)}_below_${minLift}`)
  if (finalReport.policy.meanR <= 0) reasons.push(`mean_r_${finalReport.policy.meanR.toFixed(3)}_not_positive`)
  if (finalReport.foldsPositive < Math.ceil(finalReport.folds.length / 2)) reasons.push(`only_${finalReport.foldsPositive}/${finalReport.folds.length}_folds_positive`)
  if (placeboFitness != null && finalFitness <= placeboFitness + 0.05) reasons.push(`placebo_fitness_${placeboFitness.toFixed(3)}_matches_real_${finalFitness.toFixed(3)}`)
  if (parentFitness != null && finalFitness <= parentFitness) reasons.push(`fitness_${finalFitness.toFixed(3)}_not_better_than_parent_${parentFitness.toFixed(3)}`)

  if (reasons.length) {
    return { niche, best: null, trials, placeboFitness, parentFitness, rejectionReason: reasons.join(', '), rows: rows.length, elapsedMs: Date.now() - started }
  }

  /* ---- fit the shipped model on ALL rows -------------------------------- */
  const shippedModel = trainCalibratedLinear(
    rows.map((row) => ({ at: row.at, symbol: row.symbol, features: applyMask(row.features, best!.genome.featureMask), label: (row.baselineLabel === 1 ? 1 : 0) as 0 | 1 })),
    { l2: best.genome.l2 },
  )
  if (!shippedModel) {
    return { niche, best: null, trials, placeboFitness, parentFitness, rejectionReason: 'final_fit_failed', rows: rows.length, elapsedMs: Date.now() - started }
  }

  // Absolute probability cut, derived from the training distribution so the live
  // path never has to re-derive a quantile.
  const scores = rows
    .map((row) => {
      try {
        return predictCalibrated(shippedModel, applyMask(row.features, best!.genome.featureMask))
      } catch {
        return null
      }
    })
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b)
  const threshold = scores.length ? scores[Math.min(scores.length - 1, Math.floor((scores.length - 1) * best.genome.thresholdQuantile))] : 0.5

  const artifact: SpecialistArtifactV3 = {
    kind: 'specialist_v3',
    niche,
    featureSchema: FEATURE_SCHEMA_V3,
    featureOrder: [...FEATURE_ORDER_V3],
    genome: best.genome,
    model: shippedModel,
    threshold,
    generation: (options.parent?.generation ?? 0) + 1,
    parentHash: options.parent ? artifactHashV3(options.parent) : null,
    trainedAt: Date.now(),
  }

  const acceptedTrial = trials.find((trial) => trial.exitVariantId === best!.genome.exitVariantId && trial.featuresUsed === best!.genome.featureMask.filter(Boolean).length)
  if (acceptedTrial) acceptedTrial.accepted = true

  return {
    niche,
    best: { artifact, report: finalReport, genome: best.genome, fitness: finalFitness },
    trials,
    placeboFitness,
    parentFitness,
    rejectionReason: null,
    rows: rows.length,
    elapsedMs: Date.now() - started,
  }
}

export { generateModelName }
