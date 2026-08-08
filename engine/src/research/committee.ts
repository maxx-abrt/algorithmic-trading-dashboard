/**
 * The committee — sparse mixture of experts with SKILL-AWARE gating.
 *
 * Three things make this different from the old version:
 *
 *  1. Weights come from ARENA evidence (out-of-sample net R lift, consistency
 *     across folds, held-out symbols) rather than from a calibration proxy. A
 *     specialist that never proved it makes money barely gets a whisper.
 *  2. Gating is skill-aware. Every specialist ships a skill profile listing the
 *     regimes, sessions and symbols where it measurably works. When the current
 *     context matches a proven skill its weight is amplified; when the context is
 *     one where it measurably loses, its weight is cut. This is what makes
 *     "specialists that complete each other" real rather than decorative.
 *  3. The brain (LightGBM / MLP / ensemble) votes as a first-class member when it
 *     has a usable model for the niche, and simply abstains when it does not.
 */
import { barMinutes } from '../quant/timeframes.js'
import type { SpecialistV3Row } from '../store/population-store.js'
import { nicheLabel, parseNicheKey, predictWithArtifact, type Niche, type SkillProfile, type SpecialistArtifactV3 } from './breeder.js'

export interface CommitteeContext {
  playbook: string
  instType: string
  timeframe: string
  symbol: string
  regimeId: number | null
  /** UTC hour of the decision */
  hour: number
}

export interface CommitteeMemberV3 {
  id: string
  displayName: string
  generation: number
  niche: Niche
  nicheKey: string
  lifecycle: string
  backend: string
  artifact: SpecialistArtifactV3 | null
  brainModelId: string | null
  threshold: number
  arenaMeanR: number | null
  arenaLift: number | null
  arenaTrades: number | null
  arenaSharpe: number | null
  arenaFoldsPositive: number | null
  arenaFoldsTotal: number | null
  liveMeanR: number | null
  liveTrades: number
  skills: SkillProfile | null
  trust: number
  skillMultiplier: number
}

export interface CommitteeVoteV3 {
  id: string
  displayName: string
  generation: number
  niche: string
  backend: string
  probability: number
  weight: number
  threshold: number
  /** true when this member alone would take the trade */
  wouldTake: boolean
  skillMatch: string | null
}

export interface CommitteeVerdictV3 {
  probability: number
  confidence: number
  agreement: number
  totalMembers: number
  consensus: 'take' | 'reduce' | 'skip'
  sizeMultiplier: number
  votes: CommitteeVoteV3[]
  /** exit variant recommended by the highest-trust member that has one */
  exitVariantId: string | null
  /** the strongest member's absolute probability cut */
  threshold: number | null
  hasExactExpert: boolean
  evidence: 'arena_validated' | 'arena_candidate' | 'unproven'
}

const SESSION_OF = (hour: number) => {
  if (hour >= 0 && hour < 7) return 'asia'
  if (hour >= 7 && hour < 12) return 'europe'
  if (hour >= 12 && hour < 16) return 'eu/us overlap'
  if (hour >= 16 && hour < 21) return 'us'
  return 'late us'
}

/**
 * How much this expert is allowed to say about THIS context.
 *   exact niche                      1.00
 *   same playbook + timeframe        0.55  (the pattern transfers, the venue does not)
 *   same market + timeframe          0.30  (venue behaviour transfers, the setup does not)
 *   same playbook + market, adj TF   0.35
 *   same playbook, adjacent TF       0.25
 *   same market, adjacent TF         0.15
 *   same timeframe only              0.10
 */
export function routingTrust(row: { playbook: string; inst_type: string; timeframe: string }, context: CommitteeContext): number {
  const samePlaybook = row.playbook === context.playbook
  const sameInstType = row.inst_type === context.instType
  const sameTimeframe = row.timeframe === context.timeframe
  const ratio = Math.max(barMinutes(row.timeframe), barMinutes(context.timeframe)) / Math.max(1, Math.min(barMinutes(row.timeframe), barMinutes(context.timeframe)))
  const adjacent = !sameTimeframe && ratio <= 4
  if (samePlaybook && sameInstType && sameTimeframe) return 1
  if (samePlaybook && sameTimeframe) return 0.55
  if (samePlaybook && sameInstType && adjacent) return 0.35
  if (sameInstType && sameTimeframe) return 0.3
  if (samePlaybook && adjacent) return 0.25
  if (sameInstType && adjacent) return 0.15
  if (sameTimeframe) return 0.1
  return 0
}

/**
 * Amplify or cut a member based on whether the current context is one of its
 * PROVEN skills. Returns [multiplier, matchedLabel].
 */
export function skillMultiplier(skills: SkillProfile | null, context: CommitteeContext): [number, string | null] {
  if (!skills) return [1, null]
  let multiplier = 1
  let matched: string | null = null
  const regime = context.regimeId == null ? null : skills.regimes.find((row) => row.key === context.regimeId)
  if (regime && regime.trades >= 8) {
    if (regime.meanR > 0.05) {
      multiplier *= 1 + Math.min(0.6, regime.meanR)
      matched = `${regime.label} +${regime.meanR.toFixed(2)}R`
    } else if (regime.meanR < -0.05) {
      multiplier *= Math.max(0.25, 1 + regime.meanR)
    }
  }
  const session = skills.sessions.find((row) => row.key === SESSION_OF(context.hour))
  if (session && session.trades >= 8) {
    if (session.meanR > 0.05) {
      multiplier *= 1 + Math.min(0.35, session.meanR * 0.6)
      matched = matched ?? `${session.key} +${session.meanR.toFixed(2)}R`
    } else if (session.meanR < -0.05) {
      multiplier *= Math.max(0.5, 1 + session.meanR * 0.5)
    }
  }
  const symbol = skills.symbols.find((row) => row.key === context.symbol)
  if (symbol && symbol.trades >= 6) {
    if (symbol.meanR > 0.05) {
      multiplier *= 1 + Math.min(0.3, symbol.meanR * 0.5)
      matched = matched ?? `${symbol.key} +${symbol.meanR.toFixed(2)}R`
    } else if (symbol.meanR < -0.1) {
      multiplier *= Math.max(0.4, 1 + symbol.meanR * 0.4)
    }
  }
  return [Math.max(0.15, Math.min(2.2, multiplier)), matched]
}

/**
 * Weight = proven economics × sample confidence × routing trust × skill match.
 * A member with no arena evidence at all can still vote, very quietly, so a brand
 * new niche is not permanently silent.
 */
export function memberWeight(member: CommitteeMemberV3): number {
  const lift = member.arenaLift ?? 0
  const economics = Math.max(0, Math.min(2, 0.35 + lift * 2.2 + (member.arenaMeanR ?? 0) * 0.8))
  const sample = member.arenaTrades ? member.arenaTrades / (member.arenaTrades + 60) : 0.2
  const consistency = member.arenaFoldsTotal ? (member.arenaFoldsPositive ?? 0) / member.arenaFoldsTotal : 0.4
  const forward =
    member.liveTrades >= 8 && member.liveMeanR != null ? Math.max(0.3, Math.min(1.8, 1 + member.liveMeanR / 1.2)) : 0.85
  const lifecycleBoost = member.lifecycle === 'champion' ? 1.25 : member.lifecycle === 'canary' ? 1 : 0.5
  return economics * (0.35 + 0.65 * sample) * (0.5 + 0.5 * consistency) * forward * member.trust * member.skillMultiplier * lifecycleBoost
}

export interface BrainVote {
  modelId: string
  nicheKey: string
  probability: number
  threshold: number
  lift: number
  rows: number
}

export function buildMembers(
  rows: readonly SpecialistV3Row[],
  loadArtifactFor: (row: SpecialistV3Row) => SpecialistArtifactV3 | null,
  context: CommitteeContext,
): CommitteeMemberV3[] {
  const members: CommitteeMemberV3[] = []
  for (const row of rows) {
    const trust = routingTrust(row, context)
    if (trust === 0) continue
    const artifact = loadArtifactFor(row)
    if (!artifact && !row.brain_model_id) continue
    const skills = row.skills_json ? (JSON.parse(row.skills_json) as SkillProfile) : null
    const [multiplier, matched] = skillMultiplier(skills, context)
    members.push({
      id: row.artifact_hash,
      displayName: row.display_name,
      generation: row.generation,
      niche: parseNicheKey(row.niche_key),
      nicheKey: row.niche_key,
      lifecycle: row.lifecycle,
      backend: row.backend,
      artifact,
      brainModelId: row.brain_model_id,
      threshold: artifact?.threshold ?? 0.5,
      arenaMeanR: row.arena_mean_r,
      arenaLift: row.arena_mean_r_lift,
      arenaTrades: row.arena_oos_trades,
      arenaSharpe: row.arena_sharpe,
      arenaFoldsPositive: row.arena_folds_positive,
      arenaFoldsTotal: row.arena_folds_total,
      liveMeanR: row.live_mean_r,
      liveTrades: row.live_trades,
      skills,
      trust,
      skillMultiplier: multiplier,
    })
    void matched
  }
  return members.sort((a, b) => b.trust * b.skillMultiplier - a.trust * a.skillMultiplier)
}

export function committeeVerdict(members: readonly CommitteeMemberV3[], features: readonly number[], brainVote: BrainVote | null): CommitteeVerdictV3 | null {
  const votes: CommitteeVoteV3[] = []
  let weighted = 0
  let weightSum = 0

  for (const member of members) {
    if (!member.artifact) continue
    const probability = predictWithArtifact(member.artifact, features)
    if (probability == null) continue
    const weight = memberWeight(member)
    if (!(weight > 0)) continue
    const [, matched] = skillMultiplier(member.skills, {
      playbook: member.niche.playbook,
      instType: member.niche.instType,
      timeframe: member.niche.timeframe,
      symbol: '',
      regimeId: null,
      hour: 0,
    })
    votes.push({
      id: member.id,
      displayName: member.displayName,
      generation: member.generation,
      niche: member.nicheKey,
      backend: member.backend,
      probability,
      weight,
      threshold: member.threshold,
      wouldTake: probability >= member.threshold,
      skillMatch: matched,
    })
    weighted += probability * weight
    weightSum += weight
  }

  if (brainVote) {
    // The brain's weight is derived from its own measured out-of-sample lift, so a
    // weak deep model cannot shout down a proven linear specialist.
    const weight = Math.max(0.15, Math.min(2.2, 0.4 + brainVote.lift * 3)) * (brainVote.rows / (brainVote.rows + 400))
    votes.push({
      id: brainVote.modelId,
      displayName: `brain:${brainVote.modelId.split('-').slice(0, 2).join('-')}`,
      generation: 0,
      niche: brainVote.nicheKey,
      backend: 'brain',
      probability: brainVote.probability,
      weight,
      threshold: brainVote.threshold,
      wouldTake: brainVote.probability >= brainVote.threshold,
      skillMatch: 'deep ensemble',
    })
    weighted += brainVote.probability * weight
    weightSum += weight
  }

  if (!votes.length) return null

  const probability = weightSum > 0 ? weighted / weightSum : votes.reduce((sum, vote) => sum + vote.probability, 0) / votes.length
  const takers = votes.filter((vote) => vote.wouldTake)
  const takeWeight = takers.reduce((sum, vote) => sum + vote.weight, 0)
  const agreement = takers.length
  const spread = Math.max(...votes.map((vote) => vote.probability)) - Math.min(...votes.map((vote) => vote.probability))
  const confidence = Math.max(0, Math.min(1, (weightSum > 0 ? takeWeight / weightSum : 0) * (1 - Math.min(0.9, spread))))

  const strongest = members.find((member) => member.trust === 1) ?? members[0] ?? null
  const hasExactExpert = members.some((member) => member.trust === 1)
  const arenaValidated = members.some((member) => member.trust >= 0.55 && (member.arenaLift ?? 0) > 0.02 && (member.arenaTrades ?? 0) >= 30)

  const consensus: CommitteeVerdictV3['consensus'] =
    takeWeight <= 0 ? 'skip' : confidence < 0.22 ? 'skip' : confidence < 0.45 ? 'reduce' : 'take'
  const sizeMultiplier = consensus === 'skip' ? 0 : consensus === 'reduce' ? 0.5 : Math.min(1.5, 0.75 + confidence * 0.75)

  return {
    probability,
    confidence,
    agreement,
    totalMembers: votes.length,
    consensus,
    sizeMultiplier,
    votes: votes.sort((a, b) => b.weight - a.weight),
    exitVariantId: strongest?.artifact?.genome.exitVariantId ?? null,
    threshold: strongest?.threshold ?? null,
    hasExactExpert,
    evidence: arenaValidated ? 'arena_validated' : members.some((member) => (member.arenaTrades ?? 0) >= 20) ? 'arena_candidate' : 'unproven',
  }
}

export { nicheLabel }
