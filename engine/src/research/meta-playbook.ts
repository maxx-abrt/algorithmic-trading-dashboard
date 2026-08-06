/**
 * Meta-Learning Playbook Selection.
 *
 * Instead of fixed playbook scoring, learns which playbook works best
 * in which market regime. The system discovers its own optimal strategy
 * allocation per regime through historical performance.
 *
 * For each (regime, playbook) pair, we track:
 *   - win rate
 *   - mean R
 *   - sample count
 *   - Bayesian shrinkage estimate (shrinks toward prior with small samples)
 *
 * When a new trade is evaluated, we look up the current regime and
 * boost/reduce playbook scores based on historical regime-conditional
 * performance.
 */

export interface PlaybookPerformance {
  playbookId: string
  regimeId: number
  wins: number
  losses: number
  totalR: number
  meanR: number
  winRate: number
  sampleCount: number
  /** Bayesian shrunk estimate of expected R */
  bayesianExpectedR: number
  /** confidence 0..1 based on sample size */
  confidence: number
}

export interface MetaPlaybookModel {
  /** performance matrix: [regime][playbook] → performance */
  matrix: Map<string, PlaybookPerformance>
  /** global prior (across all regimes) */
  globalPriors: Map<string, { meanR: number; winRate: number; sampleCount: number }>
  /** last updated */
  updatedAt: number
}

export interface PlaybookAdjustment {
  playbookId: string
  originalScore: number
  adjustedScore: number
  regimeId: number
  expectedR: number
  confidence: number
  reason: string
}

/**
 * Create a new meta-playbook model.
 */
export function createMetaPlaybookModel(): MetaPlaybookModel {
  return {
    matrix: new Map(),
    globalPriors: new Map(),
    updatedAt: Date.now(),
  }
}

/**
 * Record a trade outcome for a playbook in a specific regime.
 */
export function recordPlaybookOutcome(
  model: MetaPlaybookModel,
  playbookId: string,
  regimeId: number,
  won: boolean,
  rMultiple: number,
): void {
  const key = `${regimeId}:${playbookId}`
  const existing = model.matrix.get(key)

  if (existing) {
    existing.wins += won ? 1 : 0
    existing.losses += won ? 0 : 1
    existing.totalR += rMultiple
    existing.sampleCount = existing.wins + existing.losses
    existing.meanR = existing.totalR / existing.sampleCount
    existing.winRate = existing.wins / existing.sampleCount
    updateBayesianEstimate(existing, model.globalPriors.get(playbookId))
  } else {
    const perf: PlaybookPerformance = {
      playbookId,
      regimeId,
      wins: won ? 1 : 0,
      losses: won ? 0 : 1,
      totalR: rMultiple,
      meanR: rMultiple,
      winRate: won ? 1 : 0,
      sampleCount: 1,
      bayesianExpectedR: rMultiple,
      confidence: 0.1,
    }
    updateBayesianEstimate(perf, model.globalPriors.get(playbookId))
    model.matrix.set(key, perf)
  }

  // Update global prior
  const prior = model.globalPriors.get(playbookId) ?? { meanR: 0, winRate: 0.5, sampleCount: 0 }
  prior.sampleCount++
  prior.meanR = (prior.meanR * (prior.sampleCount - 1) + rMultiple) / prior.sampleCount
  prior.winRate = (prior.winRate * (prior.sampleCount - 1) + (won ? 1 : 0)) / prior.sampleCount
  model.globalPriors.set(playbookId, prior)

  model.updatedAt = Date.now()
}

/**
 * Get playbook adjustments for the current regime.
 * Boosts playbooks with strong regime-conditional performance,
 * reduces playbooks with poor regime-conditional performance.
 */
export function adjustPlaybooksForRegime(
  model: MetaPlaybookModel,
  regimeId: number,
  playbookScores: { playbookId: string; score: number }[],
): PlaybookAdjustment[] {
  return playbookScores.map(({ playbookId, score }) => {
    const key = `${regimeId}:${playbookId}`
    const perf = model.matrix.get(key)
    const prior = model.globalPriors.get(playbookId)

    if (!perf || perf.sampleCount < 5) {
      // Not enough data — use prior or no adjustment
      if (prior && prior.sampleCount >= 10) {
        const priorR = prior.meanR
        const adjustment = Math.max(-20, Math.min(20, priorR * 10))
        return {
          playbookId,
          originalScore: score,
          adjustedScore: Math.max(0, Math.min(100, score + adjustment)),
          regimeId,
          expectedR: priorR,
          confidence: Math.min(0.5, prior.sampleCount / 100),
          reason: `global prior: ${priorR.toFixed(2)}R over ${prior.sampleCount} trades`,
        }
      }
      return {
        playbookId,
        originalScore: score,
        adjustedScore: score,
        regimeId,
        expectedR: 0,
        confidence: 0,
        reason: 'insufficient regime data',
      }
    }

    // Adjust based on regime-conditional performance
    const expectedR = perf.bayesianExpectedR
    const adjustment = Math.max(-30, Math.min(30, expectedR * 15))
    const adjustedScore = Math.max(0, Math.min(100, score + adjustment))

    return {
      playbookId,
      originalScore: score,
      adjustedScore,
      regimeId,
      expectedR,
      confidence: perf.confidence,
      reason: `regime ${regimeId}: ${perf.winRate.toFixed(0)}% win, ${perf.meanR.toFixed(2)}R over ${perf.sampleCount} trades`,
    }
  })
}

/**
 * Get the best playbook for a given regime.
 */
export function bestPlaybookForRegime(
  model: MetaPlaybookModel,
  regimeId: number,
  candidatePlaybooks: string[],
): { playbookId: string; expectedR: number; confidence: number } | null {
  let best: { playbookId: string; expectedR: number; confidence: number } | null = null

  for (const pb of candidatePlaybooks) {
    const key = `${regimeId}:${pb}`
    const perf = model.matrix.get(key)
    if (!perf || perf.sampleCount < 3) continue

    if (!best || perf.bayesianExpectedR > best.expectedR) {
      best = {
        playbookId: pb,
        expectedR: perf.bayesianExpectedR,
        confidence: perf.confidence,
      }
    }
  }

  return best
}

/**
 * Serialize/deserialize for persistence.
 */
export function serializeMetaPlaybook(model: MetaPlaybookModel): string {
  const matrix: [string, PlaybookPerformance][] = Array.from(model.matrix.entries())
  const priors: [string, { meanR: number; winRate: number; sampleCount: number }][] = Array.from(model.globalPriors.entries())
  return JSON.stringify({ matrix, globalPriors: priors, updatedAt: model.updatedAt })
}

export function deserializeMetaPlaybook(json: string): MetaPlaybookModel | null {
  try {
    const parsed = JSON.parse(json)
    return {
      matrix: new Map(parsed.matrix),
      globalPriors: new Map(parsed.globalPriors),
      updatedAt: parsed.updatedAt ?? Date.now(),
    }
  } catch {
    return null
  }
}

// --- Internal ---

function updateBayesianEstimate(
  perf: PlaybookPerformance,
  prior: { meanR: number; winRate: number; sampleCount: number } | undefined,
): void {
  const priorMeanR = prior?.meanR ?? 0
  const priorStrength = Math.min(20, prior?.sampleCount ?? 5) // shrinkage strength

  // Bayesian shrinkage: weighted average of observed and prior
  const totalWeight = perf.sampleCount + priorStrength
  perf.bayesianExpectedR = (perf.meanR * perf.sampleCount + priorMeanR * priorStrength) / totalWeight

  // Confidence based on sample size (saturates at ~50 samples)
  perf.confidence = Math.min(1, perf.sampleCount / 50)
}
