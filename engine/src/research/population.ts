/**
 * Model population — specialised, generational, self-improving.
 *
 * A "specialist" is a calibrated probability model that is only allowed to speak
 * about ONE niche of the market:
 *
 *     niche = { playbook, instType, timeframe }
 *
 * e.g. `trend_pullback | SWAP | 15m` is a different animal from
 *      `range_fade | SPOT | 1H`.
 *
 * Each specialist carries a FEATURE MASK: the subset of the 32-feature vector it
 * is allowed to look at. Masks are what evolution mutates, so different members
 * of the same niche genuinely learn different views of the same data instead of
 * being 8 copies of one logistic regression.
 *
 * Evolution per niche (bounded, CPU-cheap, deterministic given a seed):
 *   1. seed a population from mutual-information rankings + random masks
 *   2. train every member on the chronological TRAIN slice only
 *   3. score every member on a purged chronological HOLDOUT slice it never saw
 *   4. keep the Pareto-ish elite (Brier skill, then net R, then simplicity)
 *   5. breed the next generation with uniform crossover + bit-flip mutation
 *   6. return the best artifact with a full trial ledger and parent lineage
 *
 * Nothing here is random-free lunch: a generation is only accepted if it beats
 * its parent OUT OF SAMPLE. `evolveNiche` can and does return `null`.
 */
import { createHash } from 'node:crypto'
import { mutualInformation } from './feature-importance.js'
import { predictCalibrated, trainCalibratedLinear, type CalibratedLinearModel } from './calibration.js'
import { FEATURE_ORDER } from './features.js'

/* -------------------------------------------------------------------------- */
/*  Niche                                                                      */
/* -------------------------------------------------------------------------- */

export interface Niche {
  playbook: string
  instType: string
  timeframe: string
}

export const nicheKey = (niche: Niche) => `${niche.playbook}|${niche.instType}|${niche.timeframe}`

export function parseNicheKey(key: string): Niche {
  const [playbook = 'any', instType = 'ANY', timeframe = '15m'] = key.split('|')
  return { playbook, instType, timeframe }
}

/** Human label used in the UI and Telegram. */
export const nicheLabel = (niche: Niche) =>
  `${niche.playbook.replace(/_/g, ' ')} · ${niche.instType} · ${niche.timeframe}`

/* -------------------------------------------------------------------------- */
/*  Samples                                                                    */
/* -------------------------------------------------------------------------- */

export interface TrainingSample {
  at: number
  symbol: string
  features: number[]
  label: 0 | 1
  /** realised net R of the trade that produced this label (used for economic scoring) */
  netR?: number
  /**
   * When the label became knowable (trade close). REQUIRED for honest validation:
   * financial labels overlap in time, so a row may only train a model whose test
   * window starts strictly after this timestamp. Without it, an AUC of 0.98 is
   * leakage, not skill.
   */
  horizonEndAt?: number
}

export interface SpecialistMetrics {
  sample: number
  trainRows: number
  holdoutRows: number
  purgedRows: number
  brier: number
  logLoss: number
  accuracy: number
  auc: number
  baselineBrier: number
  /** 1 - brier/baselineBrier. > 0 means better than always predicting the base rate. */
  brierSkill: number
  /** mean net R of holdout trades the model would have taken (p >= threshold) */
  meanRAtThreshold: number | null
  /** mean net R of ALL holdout trades — the "take everything" benchmark */
  meanRAll: number | null
  /** meanRAtThreshold - meanRAll. This is the only number that proves selection adds value. */
  meanRLift: number | null
  threshold: number
  coverage: number
  featuresUsed: number
}

export interface SpecialistArtifact {
  kind: 'specialist_v1'
  niche: Niche
  featureMask: boolean[]
  featureOrder: string[]
  model: CalibratedLinearModel
  metrics: SpecialistMetrics
  generation: number
  parentHash: string | null
  trainedAt: number
  l2: number
  seed: number
}

export interface EvolutionTrial {
  ordinal: number
  generation: number
  l2: number
  featuresUsed: number
  brier: number
  brierSkill: number
  auc: number
  meanRAtThreshold: number | null
  accepted: boolean
}

export interface EvolutionResult {
  niche: Niche
  best: SpecialistArtifact | null
  trials: EvolutionTrial[]
  generations: number
  populationSize: number
  rejectionReason: string | null
  parentBrier: number | null
  improvedOverParent: boolean
  /** best Brier skill the identical search achieved on shuffled labels, when the placebo ran */
  placeboSkill?: number | null
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const FEATURE_COUNT = FEATURE_ORDER.length

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

/** Masked features keep the vector length so every artifact stays schema-compatible. */
export function applyMask(features: readonly number[], mask: readonly boolean[]): number[] {
  const out: number[] = []
  for (let index = 0; index < features.length; index++) out.push(mask[index] === false ? 0 : features[index])
  return out
}

export function artifactHash(artifact: Omit<SpecialistArtifact, 'trainedAt'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        niche: artifact.niche,
        mask: artifact.featureMask,
        weights: artifact.model.weights.map((w) => Number(w.toFixed(8))),
        bias: Number(artifact.model.bias.toFixed(8)),
        plattA: Number(artifact.model.plattA.toFixed(8)),
        plattB: Number(artifact.model.plattB.toFixed(8)),
        generation: artifact.generation,
      }),
    )
    .digest('hex')
}

function auc(probabilities: number[], labels: number[]): number {
  const positives = probabilities.filter((_, index) => labels[index] === 1)
  const negatives = probabilities.filter((_, index) => labels[index] === 0)
  if (!positives.length || !negatives.length) return 0.5
  let wins = 0
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0
  return wins / (positives.length * negatives.length)
}

/* -------------------------------------------------------------------------- */
/*  Train + evaluate one member                                                */
/* -------------------------------------------------------------------------- */

export interface TrainOptions {
  /** fraction of chronological rows used for training (rest is purged holdout) */
  trainFraction?: number
  /** extra embargo applied on top of the label-horizon purge, in ms */
  embargoMs?: number
  /**
   * Economic score coverage. Instead of a fixed 0.5 cut (which a calibrated model
   * with a low base rate never crosses) we act on the top `1 - topQuantile` of
   * holdout predictions and measure the realised net R of exactly those trades.
   * That answers the only question that matters: does the ranking make money?
   */
  topQuantile?: number
}

export function trainSpecialist(
  rows: readonly TrainingSample[],
  mask: readonly boolean[],
  l2: number,
  niche: Niche,
  generation: number,
  parentHash: string | null,
  seed: number,
  options: TrainOptions = {},
): SpecialistArtifact | null {
  const ordered = [...rows].sort((a, b) => a.at - b.at)
  if (ordered.length < 40) return null
  const trainFraction = options.trainFraction ?? 0.7
  const embargoMs = options.embargoMs ?? 0
  const topQuantile = Math.min(0.95, Math.max(0.4, options.topQuantile ?? 0.7))

  const cut = Math.floor(ordered.length * trainFraction)
  const holdout = ordered.slice(cut)
  if (holdout.length < 8) return null
  const holdoutStartAt = holdout[0].at
  // PURGE: a training row may only be used if its label was already knowable
  // before the holdout window opens. This is what kills overlapping-label leakage.
  const trainPool = ordered.slice(0, cut)
  const train = trainPool.filter((row) => (row.horizonEndAt ?? row.at) + embargoMs < holdoutStartAt)
  const purgedRows = trainPool.length - train.length
  if (train.length < 30) return null
  if (!holdout.some((row) => row.label === 1) || !holdout.some((row) => row.label === 0)) return null

  const masked = train.map((row) => ({ at: row.at, symbol: row.symbol, features: applyMask(row.features, mask), label: row.label }))
  const model = trainCalibratedLinear(masked, { l2 })
  if (!model) return null

  const probabilities = holdout.map((row) => {
    try {
      return predictCalibrated(model, applyMask(row.features, mask))
    } catch {
      return 0.5
    }
  })
  const labels = holdout.map((row) => row.label)
  const brier = probabilities.reduce((sum, p, index) => sum + (p - labels[index]) ** 2, 0) / holdout.length
  const logLoss =
    -probabilities.reduce((sum, p, index) => {
      const clipped = Math.min(1 - 1e-6, Math.max(1e-6, p))
      return sum + (labels[index] === 1 ? Math.log(clipped) : Math.log(1 - clipped))
    }, 0) / holdout.length
  const accuracy = probabilities.reduce((sum, p, index) => sum + ((p >= 0.5 ? 1 : 0) === labels[index] ? 1 : 0), 0) / holdout.length
  const baseRate = train.reduce((sum, row) => sum + row.label, 0) / train.length
  const baselineBrier = holdout.reduce((sum, row) => sum + (baseRate - row.label) ** 2, 0) / holdout.length

  const sortedProbabilities = [...probabilities].sort((a, b) => a - b)
  const threshold = sortedProbabilities[Math.min(sortedProbabilities.length - 1, Math.floor((sortedProbabilities.length - 1) * topQuantile))]
  const taken = holdout.filter((_, index) => probabilities[index] >= threshold)
  const takenWithR = taken.filter((row) => Number.isFinite(row.netR))
  const meanRAtThreshold = takenWithR.length ? takenWithR.reduce((sum, row) => sum + (row.netR ?? 0), 0) / takenWithR.length : null
  const allWithR = holdout.filter((row) => Number.isFinite(row.netR))
  const meanRAll = allWithR.length ? allWithR.reduce((sum, row) => sum + (row.netR ?? 0), 0) / allWithR.length : null
  const meanRLift = meanRAtThreshold != null && meanRAll != null ? meanRAtThreshold - meanRAll : null

  const metrics: SpecialistMetrics = {
    sample: ordered.length,
    trainRows: train.length,
    holdoutRows: holdout.length,
    purgedRows,
    brier,
    logLoss,
    accuracy,
    auc: auc(probabilities, labels),
    baselineBrier,
    brierSkill: baselineBrier > 0 ? 1 - brier / baselineBrier : 0,
    meanRAtThreshold,
    meanRAll,
    meanRLift,
    threshold,
    coverage: taken.length / holdout.length,
    featuresUsed: mask.filter(Boolean).length,
  }

  return {
    kind: 'specialist_v1',
    niche,
    featureMask: [...mask],
    featureOrder: [...FEATURE_ORDER],
    model,
    metrics,
    generation,
    parentHash,
    trainedAt: Date.now(),
    l2,
    seed,
  }
}

export function predictSpecialist(artifact: SpecialistArtifact, features: readonly number[]): number | null {
  try {
    return predictCalibrated(artifact.model, applyMask(features, artifact.featureMask))
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Fitness + evolution                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fitness is deliberately multi-objective and lexicographic:
 *   1. calibration skill (does the probability mean anything?)
 *   2. economics (does acting on it make net R?)
 *   3. simplicity (fewer features wins ties — anti-overfit)
 */
export function fitness(metrics: SpecialistMetrics): number {
  const skill = metrics.brierSkill
  const economics = metrics.meanRLift == null ? 0 : Math.max(-1, Math.min(1, metrics.meanRLift / 0.5))
  const discrimination = (metrics.auc - 0.5) * 2
  const simplicity = 1 - metrics.featuresUsed / Math.max(1, FEATURE_COUNT)
  return skill * 1.0 + economics * 0.8 + discrimination * 0.4 + simplicity * 0.08
}

function seedMasks(rows: readonly TrainingSample[], populationSize: number, random: () => number, warmStart?: readonly boolean[] | null): boolean[][] {
  const mi = mutualInformation(
    rows.map((row) => ({ at: row.at, symbol: row.symbol, features: row.features, label: row.label })),
    [...FEATURE_ORDER],
  )
  const rankedIndices = mi.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value).map((row) => row.index)
  const topK = (k: number) => {
    const mask = Array(FEATURE_COUNT).fill(false) as boolean[]
    for (const index of rankedIndices.slice(0, k)) mask[index] = true
    return mask
  }
  const masks: boolean[][] = []
  // Warm start: a child generation always begins from its parent's genome so it can
  // only differ by deliberate mutation, never by throwing the parent away.
  if (warmStart?.length === FEATURE_COUNT) {
    masks.push([...warmStart])
    masks.push(mutate(warmStart, random, 1))
    masks.push(mutate(warmStart, random, 3))
  }
  masks.push(
    Array(FEATURE_COUNT).fill(true) as boolean[],
    topK(Math.max(6, Math.round(FEATURE_COUNT * 0.75))),
    topK(Math.max(6, Math.round(FEATURE_COUNT * 0.5))),
    topK(Math.max(5, Math.round(FEATURE_COUNT * 0.3))),
  )
  while (masks.length < populationSize) {
    const mask = Array.from({ length: FEATURE_COUNT }, () => random() < 0.55)
    // never allow an empty genome
    if (!mask.some(Boolean)) mask[rankedIndices[0] ?? 0] = true
    masks.push(mask)
  }
  return masks.slice(0, populationSize)
}

function crossover(a: readonly boolean[], b: readonly boolean[], random: () => number): boolean[] {
  const child = a.map((bit, index) => (random() < 0.5 ? bit : b[index] ?? bit))
  if (!child.some(Boolean)) child[0] = true
  return child
}

function mutate(mask: readonly boolean[], random: () => number, flips = 2): boolean[] {
  const child = [...mask]
  for (let flip = 0; flip < flips; flip++) {
    const index = Math.floor(random() * child.length)
    child[index] = !child[index]
  }
  if (!child.some(Boolean)) child[Math.floor(random() * child.length)] = true
  return child
}

export interface EvolveOptions extends TrainOptions {
  populationSize?: number
  generations?: number
  seed?: number
  /** artifact the challenger must beat out of sample; null when the niche is empty */
  parent?: SpecialistArtifact | null
  /** minimum out-of-sample Brier skill for a candidate to be usable at all */
  minBrierSkill?: number
  l2Grid?: number[]
  /**
   * Run the same search on label-shuffled data and require the real winner to beat
   * the placebo by `placeboMargin`. This is the cheapest defence against
   * "the search found noise" and it is on by default for scheduled campaigns.
   */
  placebo?: boolean
  placeboMargin?: number
}

/** Deterministically shuffle labels while keeping features and timestamps — the placebo. */
export function shuffleLabels(rows: readonly TrainingSample[], seed: number): TrainingSample[] {
  const random = rng(seed)
  const labels = rows.map((row) => row.label)
  for (let index = labels.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[labels[index], labels[swap]] = [labels[swap], labels[index]]
  }
  return rows.map((row, index) => ({ ...row, label: labels[index], netR: undefined }))
}

/**
 * Run a bounded evolutionary search for the best specialist of one niche.
 * Deterministic for a given seed so a campaign can be reproduced exactly.
 */
export function evolveNiche(rows: readonly TrainingSample[], niche: Niche, options: EvolveOptions = {}): EvolutionResult {
  const populationSize = Math.max(4, Math.min(options.populationSize ?? 8, 16))
  const generations = Math.max(1, Math.min(options.generations ?? 3, 6))
  const seed = options.seed ?? 0x5eed
  const minBrierSkill = options.minBrierSkill ?? 0.0
  const l2Grid = options.l2Grid ?? [0.01, 0.05, 0.2, 1.0]
  const random = rng(seed)
  const trials: EvolutionTrial[] = []
  const parentBrier = options.parent?.metrics.brier ?? null

  if (rows.length < 40) {
    return {
      niche,
      best: null,
      trials,
      generations: 0,
      populationSize,
      rejectionReason: `insufficient_rows(${rows.length}<40)`,
      parentBrier,
      improvedOverParent: false,
    }
  }

  let masks = seedMasks(rows, populationSize, random, options.parent?.featureMask ?? null)
  let ordinal = 0
  let best: SpecialistArtifact | null = null
  let bestFitness = -Infinity
  const parentHash = options.parent ? artifactHash(options.parent) : null
  const baseGeneration = (options.parent?.generation ?? 0) + 1

  for (let generation = 0; generation < generations; generation++) {
    const evaluated: { mask: boolean[]; artifact: SpecialistArtifact; score: number }[] = []
    for (const mask of masks) {
      const l2 = l2Grid[Math.floor(random() * l2Grid.length)]
      const artifact = trainSpecialist(rows, mask, l2, niche, baseGeneration, parentHash, seed + ordinal, options)
      ordinal++
      if (!artifact) {
        trials.push({ ordinal, generation, l2, featuresUsed: mask.filter(Boolean).length, brier: Number.NaN, brierSkill: Number.NaN, auc: Number.NaN, meanRAtThreshold: null, accepted: false })
        continue
      }
      const score = fitness(artifact.metrics)
      evaluated.push({ mask, artifact, score })
      trials.push({
        ordinal,
        generation,
        l2,
        featuresUsed: artifact.metrics.featuresUsed,
        brier: artifact.metrics.brier,
        brierSkill: artifact.metrics.brierSkill,
        auc: artifact.metrics.auc,
        meanRAtThreshold: artifact.metrics.meanRAtThreshold,
        accepted: false,
      })
      if (score > bestFitness) {
        bestFitness = score
        best = artifact
      }
    }
    if (!evaluated.length) break
    evaluated.sort((a, b) => b.score - a.score)
    const elite = evaluated.slice(0, Math.max(2, Math.floor(populationSize / 3))).map((row) => row.mask)
    const next: boolean[][] = [...elite]
    while (next.length < populationSize) {
      const a = elite[Math.floor(random() * elite.length)]
      const b = elite[Math.floor(random() * elite.length)]
      next.push(mutate(crossover(a, b, random), random, 1 + Math.floor(random() * 3)))
    }
    masks = next
  }

  if (!best) {
    return { niche, best: null, trials, generations, populationSize, rejectionReason: 'all_trials_failed', parentBrier, improvedOverParent: false }
  }

  const rejectionReasons: string[] = []
  if (best.metrics.brierSkill < minBrierSkill) rejectionReasons.push(`brier_skill_${best.metrics.brierSkill.toFixed(3)}_below_${minBrierSkill}`)
  if (best.metrics.auc <= 0.5) rejectionReasons.push(`auc_${best.metrics.auc.toFixed(3)}_not_above_chance`)
  const improvedOverParent = parentBrier == null ? true : best.metrics.brier < parentBrier
  if (!improvedOverParent) rejectionReasons.push(`brier_${best.metrics.brier.toFixed(4)}_not_better_than_parent_${parentBrier?.toFixed(4)}`)

  // Placebo: the identical search on shuffled labels must NOT look as good.
  let placeboSkill: number | null = null
  if (options.placebo) {
    const placeboRows = shuffleLabels(rows, seed ^ 0x9e3779b9)
    const placeboResult = evolveNiche(placeboRows, niche, {
      ...options,
      placebo: false,
      parent: null,
      minBrierSkill: -Infinity,
      seed: seed ^ 0x2545f491,
      populationSize,
      generations: Math.max(1, generations - 1),
    })
    placeboSkill = placeboResult.best?.metrics.brierSkill ?? placeboResult.trials.reduce((max, trial) => (Number.isFinite(trial.brierSkill) ? Math.max(max, trial.brierSkill) : max), -Infinity)
    if (Number.isFinite(placeboSkill) && best.metrics.brierSkill <= (placeboSkill as number) + (options.placeboMargin ?? 0.02)) {
      rejectionReasons.push(`placebo_skill_${(placeboSkill as number).toFixed(3)}_matches_real_${best.metrics.brierSkill.toFixed(3)}`)
    }
  }

  const acceptedTrial = trials.find((trial) => trial.brier === best!.metrics.brier)
  if (acceptedTrial) acceptedTrial.accepted = rejectionReasons.length === 0

  return {
    niche,
    best: rejectionReasons.length === 0 ? best : null,
    trials,
    generations,
    populationSize,
    rejectionReason: rejectionReasons.length ? rejectionReasons.join(', ') : null,
    parentBrier,
    improvedOverParent,
    placeboSkill,
  }
}

/* -------------------------------------------------------------------------- */
/*  Committee — specialists working together                                   */
/* -------------------------------------------------------------------------- */

export interface CommitteeMember {
  id: string
  displayName: string
  generation: number
  niche: Niche
  artifact: SpecialistArtifact
  /** forward evidence measured on real closed trades, null when unproven */
  liveMeanR: number | null
  liveTrades: number
  /**
   * MoE gating trust: 1.0 for an exact niche match, lower for an adjacent expert
   * that is only partially qualified to speak about this context.
   */
  trust?: number
}

export interface CommitteeVote {
  id: string
  displayName: string
  generation: number
  niche: string
  probability: number
  weight: number
}

export interface CommitteeVerdict {
  probability: number
  /** 0..1 — how strongly the members agree */
  confidence: number
  agreement: number
  totalMembers: number
  consensus: 'take' | 'reduce' | 'skip'
  sizeMultiplier: number
  votes: CommitteeVote[]
}

/**
 * Weight = out-of-sample calibration skill × sample-size shrinkage × forward evidence.
 * A model with no forward evidence still votes, but quietly.
 */
export function memberWeight(member: CommitteeMember): number {
  const skill = Math.max(0, member.artifact.metrics.brierSkill)
  const shrink = member.artifact.metrics.holdoutRows / (member.artifact.metrics.holdoutRows + 25)
  const forward =
    member.liveMeanR == null || member.liveTrades < 5
      ? 0.7
      : Math.max(0.2, Math.min(1.6, 1 + member.liveMeanR / 1.5)) * Math.min(1, member.liveTrades / 30 + 0.5)
  return skill * shrink * forward * (member.trust ?? 1)
}

export function committeeVerdict(members: readonly CommitteeMember[], features: readonly number[], takeThreshold = 0.5): CommitteeVerdict | null {
  const votes: CommitteeVote[] = []
  let weighted = 0
  let weightSum = 0
  for (const member of members) {
    const probability = predictSpecialist(member.artifact, features)
    if (probability == null) continue
    const weight = memberWeight(member)
    votes.push({
      id: member.id,
      displayName: member.displayName,
      generation: member.generation,
      niche: nicheKey(member.niche),
      probability,
      weight,
    })
    weighted += probability * weight
    weightSum += weight
  }
  if (!votes.length) return null
  const probability = weightSum > 0 ? weighted / weightSum : votes.reduce((sum, vote) => sum + vote.probability, 0) / votes.length
  const agreement = votes.filter((vote) => (vote.probability >= takeThreshold) === (probability >= takeThreshold)).length
  const spread = Math.max(...votes.map((v) => v.probability)) - Math.min(...votes.map((v) => v.probability))
  const confidence = Math.max(0, Math.min(1, (agreement / votes.length) * (1 - spread)))

  const consensus: CommitteeVerdict['consensus'] =
    votes.length >= 2 && agreement / votes.length < 0.5
      ? 'skip'
      : probability < takeThreshold
        ? 'skip'
        : confidence < 0.35
          ? 'reduce'
          : 'take'

  const sizeMultiplier = consensus === 'skip' ? 0 : consensus === 'reduce' ? 0.5 : Math.min(1.4, 0.7 + confidence * 0.7)

  return { probability, confidence, agreement, totalMembers: votes.length, consensus, sizeMultiplier, votes }
}
