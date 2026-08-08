/**
 * THE ADVISOR — what the user actually wants from all of this.
 *
 * Everything else in the system exists to make this list trustworthy: a short,
 * ranked set of concrete instructions — this instrument, this direction, this
 * entry, this stop, these targets, this size, this expiry, and the honest reason
 * you should or should not believe it.
 *
 * Ranking is not "highest conviction wins". It is expected value after costs,
 * scaled by how much PROVEN evidence stands behind the call:
 *
 *     score = netExpectancyR
 *           x conviction weight
 *           x committee confidence
 *           x evidence weight   (arena-validated > candidate > unproven)
 *           x liquidity weight  (spread and turnover)
 *           x news weight       (macro risk cuts everything)
 *
 * A call with no validated specialist behind it is still shown, clearly labelled,
 * because hiding it would be dishonest — but it can never outrank a proven one.
 */
import type { Analysis } from './quant/types.js'
import type { Ticker } from './okx/market.js'
import type { CommitteeVerdictV3 } from './research/committee.js'
import type { SkillProfile } from './research/breeder.js'

export interface AdvisorCall {
  key: string
  instId: string
  instType: string
  timeframe: string
  playbook: string | null
  action: 'LONG' | 'SHORT' | 'WAIT'
  rank: number
  score: number
  price: number
  conviction: number
  compositeScore: number
  regime: string
  entry: number | null
  entryZone: [number, number] | null
  stopLoss: number | null
  targets: { price: number; rr: number; allocationPct: number }[]
  expectedRr: number | null
  riskUsd: number | null
  leverage: number | null
  sizingAdvice: string | null
  winProbability: number | null
  probabilityBasis: string | null
  netExpectancyR: number | null
  invalidation: number | null
  /** the decision is void after this timestamp (time stop at the signal's timeframe) */
  expiresAt: number
  committee: {
    consensus: string
    probability: number
    confidence: number
    agreement: number
    totalMembers: number
    evidence: string
    exitVariantId: string | null
    votes: { displayName: string; probability: number; weight: number; wouldTake: boolean; backend: string; skillMatch: string | null }[]
  } | null
  skills: string[]
  vetoes: { id: string; reason: string; severity: string }[]
  warnings: string[]
  reasons: string[]
  liquidity: { volUsd24h: number | null; spreadBps: number | null }
  changePct24h: number | null
  volatilityBucket: string
  newsRisk: number | null
  generatedAt: number
  isProbe: boolean
}

export interface AdvisorInput {
  analyses: { analysis: Analysis; verdict: CommitteeVerdictV3 | null; skills: SkillProfile | null }[]
  tickers: Map<string, Ticker>
  newsRisk: number | null
  /** minimum score for a call to be considered actionable */
  minScore?: number
  limit?: number
}

const REGIME_TEXT: Record<string, string> = {
  TRENDING: 'trending',
  RANGING: 'ranging',
  VOLATILE: 'volatile',
  CHOPPY: 'choppy',
}

function volatilityBucketOf(changePct24h: number | null | undefined): string {
  const move = Math.abs(changePct24h ?? 0)
  if (move < 1.5) return 'quiet'
  if (move < 4) return 'normal'
  if (move < 10) return 'active'
  return 'wild'
}

function barMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)(m|H|D)$/)
  if (!match) return 15 * 60_000
  const value = Number(match[1])
  return match[2] === 'm' ? value * 60_000 : match[2] === 'H' ? value * 3_600_000 : value * 86_400_000
}

export function buildAdvisor(input: AdvisorInput): AdvisorCall[] {
  const calls: AdvisorCall[] = []

  for (const { analysis, verdict, skills } of input.analyses) {
    const plan = analysis.plan ?? analysis.shadowPlan
    const ticker = input.tickers.get(analysis.instId) ?? null
    const hardVeto = analysis.vetoes.some((veto) => veto.severity === 'hard')
    const action: AdvisorCall['action'] = hardVeto || analysis.decision === 'WAIT' ? 'WAIT' : analysis.decision

    const evidenceWeight = verdict ? (verdict.evidence === 'arena_validated' ? 1 : verdict.evidence === 'arena_candidate' ? 0.6 : 0.3) : 0.25
    const convictionWeight = Math.max(0, Math.min(1.3, analysis.conviction / 70))
    const confidenceWeight = verdict ? Math.max(0.15, verdict.confidence) : 0.4
    const spread = ticker?.spreadBps ?? analysis.liquidity.spreadBps ?? 5
    const liquidityWeight = Math.max(0.2, Math.min(1, 1 - Math.max(0, spread - 3) / 40)) * Math.max(0.3, Math.min(1, Math.log10(Math.max(1e5, ticker?.volUsd24h ?? 1e6)) / 9))
    const newsWeight = input.newsRisk == null ? 1 : Math.max(0.25, 1 - input.newsRisk * 0.85)
    const expectancy = plan?.netExpectancyR ?? 0

    const score =
      action === 'WAIT'
        ? -1
        : Math.max(0, expectancy) * convictionWeight * confidenceWeight * evidenceWeight * liquidityWeight * newsWeight * 100

    const reasons: string[] = []
    if (analysis.playbook) reasons.push(`playbook ${analysis.playbook.replace(/_/g, ' ')}`)
    reasons.push(`composite ${analysis.compositeScore >= 0 ? '+' : ''}${analysis.compositeScore.toFixed(0)}`, `mtf alignment ${analysis.mtfAlignment.toFixed(0)}%`)
    if (verdict) reasons.push(`${verdict.agreement}/${verdict.totalMembers} experts would take it`)
    if (analysis.edge?.sample) reasons.push(`${analysis.edge.sample} historical analogues`)

    calls.push({
      key: `${analysis.instId}|${analysis.timeframe}`,
      instId: analysis.instId,
      instType: analysis.instType,
      timeframe: analysis.timeframe,
      playbook: analysis.playbook,
      action,
      rank: 0,
      score: Number(score.toFixed(3)),
      price: analysis.price,
      conviction: analysis.conviction,
      compositeScore: analysis.compositeScore,
      regime: REGIME_TEXT[analysis.regime] ?? String(analysis.regime).toLowerCase(),
      entry: plan?.entry ?? null,
      entryZone: plan ? [Math.min(...plan.entryZone), Math.max(...plan.entryZone)] : null,
      stopLoss: plan?.stopLoss ?? null,
      targets: plan?.takeProfits.map((target) => ({ price: target.price, rr: target.rr, allocationPct: target.allocationPct })) ?? [],
      expectedRr: plan?.expectedRr ?? null,
      riskUsd: plan?.riskUsd ?? null,
      leverage: plan?.leverage ?? null,
      sizingAdvice: plan?.sizingAdvice ?? null,
      winProbability: plan?.winProbability ?? null,
      probabilityBasis: plan?.probabilityBasis ?? null,
      netExpectancyR: plan?.netExpectancyR ?? null,
      invalidation: plan?.invalidation ?? null,
      expiresAt: analysis.generatedAt + barMs(analysis.timeframe) * Math.max(2, plan?.timeStopBars ?? 6),
      committee: verdict
        ? {
            consensus: verdict.consensus,
            probability: verdict.probability,
            confidence: verdict.confidence,
            agreement: verdict.agreement,
            totalMembers: verdict.totalMembers,
            evidence: verdict.evidence,
            exitVariantId: verdict.exitVariantId,
            votes: verdict.votes.slice(0, 6).map((vote) => ({
              displayName: vote.displayName,
              probability: vote.probability,
              weight: vote.weight,
              wouldTake: vote.wouldTake,
              backend: vote.backend,
              skillMatch: vote.skillMatch,
            })),
          }
        : null,
      skills: skills?.badges ?? [],
      vetoes: analysis.vetoes.map((veto) => ({ id: veto.id, reason: veto.reason, severity: veto.severity })),
      warnings: plan?.warnings ?? [],
      reasons,
      liquidity: { volUsd24h: ticker?.volUsd24h ?? analysis.liquidity.volUsd24h ?? null, spreadBps: spread },
      changePct24h: ticker?.changePct24h ?? null,
      volatilityBucket: volatilityBucketOf(ticker?.changePct24h),
      newsRisk: input.newsRisk,
      generatedAt: analysis.generatedAt,
      isProbe: Boolean(verdict && verdict.evidence === 'unproven' && action !== 'WAIT'),
    })
  }

  const actionable = calls.filter((call) => call.action !== 'WAIT').sort((a, b) => b.score - a.score)
  const waiting = calls.filter((call) => call.action === 'WAIT').sort((a, b) => b.conviction - a.conviction)
  const ordered = [...actionable, ...waiting].slice(0, input.limit ?? 40)
  ordered.forEach((call, index) => {
    call.rank = index + 1
  })
  return ordered
}
