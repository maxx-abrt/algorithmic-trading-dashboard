import { describe, expect, it } from 'vitest'
import { applySettingsPatch, DEFAULT_RUNTIME_SETTINGS, hydrateSettings } from '../src/settings/schema.js'
import { attributeTrade, hypothesisFromAttribution } from '../src/paper/attribution.js'
import { applyMask, committeeVerdict, evolveNiche, memberWeight, nicheKey, parseNicheKey, shuffleLabels, trainSpecialist, type SpecialistArtifact, type TrainingSample } from '../src/research/population.js'
import type { PaperTrade } from '../src/paper/types.js'
import { FEATURE_ORDER } from '../src/research/features.js'

const N = FEATURE_ORDER.length

/* -------------------------------------------------------------------------- */
/*  Settings: the bug that reverted every user edit                            */
/* -------------------------------------------------------------------------- */

describe('settings persistence contract', () => {
  it('accepts a valid nested patch and keeps everything else intact', () => {
    const result = applySettingsPatch(DEFAULT_RUNTIME_SETTINGS, { scanner: { universeSize: 150 }, minConfidence: 55 })
    expect(result.ok).toBe(true)
    expect(result.settings.scanner.universeSize).toBe(150)
    expect(result.settings.minConfidence).toBe(55)
    expect(result.settings.scanner.instTypes).toEqual(DEFAULT_RUNTIME_SETTINGS.scanner.instTypes)
  })

  it('rejects an out-of-range value without mutating the current settings', () => {
    const result = applySettingsPatch(DEFAULT_RUNTIME_SETTINGS, { riskPerTradePct: 500 })
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('riskPerTradePct')
    expect(result.settings).toBe(DEFAULT_RUNTIME_SETTINGS)
  })

  it('silently drops unknown keys instead of throwing them away wholesale', () => {
    const result = applySettingsPatch(DEFAULT_RUNTIME_SETTINGS, { thisFieldDoesNotExist: 1, minAdx: 20 })
    expect(result.ok).toBe(true)
    expect(result.settings.minAdx).toBe(20)
    expect('thisFieldDoesNotExist' in result.settings).toBe(false)
  })

  it('heals a partially corrupted stored document instead of resetting everything', () => {
    const healed = hydrateSettings({ minConfidence: 61, riskPerTradePct: 'not a number', scanner: { universeSize: 77 } })
    expect(healed.minConfidence).toBe(61)
    expect(healed.scanner.universeSize).toBe(77)
    expect(healed.riskPerTradePct).toBe(DEFAULT_RUNTIME_SETTINGS.riskPerTradePct)
  })

  it('round-trips through JSON exactly, which is what SQLite stores', () => {
    const patched = applySettingsPatch(DEFAULT_RUNTIME_SETTINGS, { evolution: { populationSize: 12 } })
    expect(patched.ok).toBe(true)
    expect(hydrateSettings(JSON.parse(JSON.stringify(patched.settings)))).toEqual(patched.settings)
  })
})

/* -------------------------------------------------------------------------- */
/*  Attribution                                                               */
/* -------------------------------------------------------------------------- */

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 't1',
    plan: {
      id: 't1', instId: 'BTC-USDT-SWAP', timeframe: '15m', side: 'LONG', signalAt: 1000,
      policyVersion: 'v', modelVersion: 'm', playbook: 'trend_pullback',
      entry: 100, entryZone: [99, 101], stopLoss: 95,
      targets: [{ price: 105, allocation: 0.5 }, { price: 110, allocation: 0.5 }],
      quantity: 1, riskUsd: 100, maxEntryBars: 3, maxHoldBars: 12, feeBps: 5, slippageBps: 0,
      atrAtEntry: 2, trailAtrMult: 2,
    },
    status: 'closed', submittedAt: 1000, filledAt: 1100, closedAt: 2000, fillPrice: 100,
    currentStop: 95, targets: [{ price: 105, allocation: 0.5, filled: false }, { price: 110, allocation: 0.5, filled: false }],
    remaining: 0, barsPending: 1, barsHeld: 5, grossRealizedR: 0, netRealizedR: 0, feesR: 0, fundingR: 0,
    mfeR: 0, maeR: 0, lastProcessedTs: 2000, events: [],
    ...overrides,
  }
}

describe('failure attribution', () => {
  it('flags an unfilled entry rather than pretending it was a loss', () => {
    expect(attributeTrade(trade({ status: 'expired', exitReason: 'entry_expired', filledAt: undefined })).reasonCode).toBe('UNFILLED_ENTRY')
  })

  it('separates a clean stop from a gapped stop', () => {
    expect(attributeTrade(trade({ exitReason: 'stop_loss', netRealizedR: -1, mfeR: 0.05 })).reasonCode).toBe('ADVERSE_SELECTION')
    expect(attributeTrade(trade({ exitReason: 'stop_loss', netRealizedR: -1.9, mfeR: 0.05 })).reasonCode).toBe('STOP_GAP_SLIPPAGE')
  })

  it('detects a cost-dominated trade', () => {
    expect(attributeTrade(trade({ exitReason: 'time_stop', grossRealizedR: 0.2, netRealizedR: -0.05, feesR: 0.25 })).reasonCode).toBe('COST_DOMINATED')
  })

  it('blames the model when a confident prediction died immediately', () => {
    expect(attributeTrade(trade({ exitReason: 'stop_loss', netRealizedR: -1, mfeR: 0.05 }), { winProbability: 0.8 }).reasonCode).toBe('MODEL_FALSE_POSITIVE')
  })

  it('turns a dominant failure signature into a concrete hypothesis', () => {
    const hypothesis = hypothesisFromAttribution([
      { reasonCode: 'UNFILLED_ENTRY', count: 40, meanR: 0 },
      { reasonCode: 'TARGET_COMPLETE', count: 10, meanR: 1.4 },
    ])
    expect(hypothesis?.reasonCode).toBe('UNFILLED_ENTRY')
    expect(hypothesis?.hypothesis).toContain('passive')
  })

  it('refuses to generate a hypothesis from a tiny sample', () => {
    expect(hypothesisFromAttribution([{ reasonCode: 'UNFILLED_ENTRY', count: 3, meanR: 0 }])).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/*  Population: leakage, placebo, lineage, MoE gating                         */
/* -------------------------------------------------------------------------- */

const niche = { playbook: 'trend_pullback', instType: 'SWAP', timeframe: '15m' }

/** Rows whose label is a deterministic function of feature 0 — a learnable signal. */
function learnableRows(count: number, holdBars = 20): TrainingSample[] {
  const rows: TrainingSample[] = []
  for (let index = 0; index < count; index++) {
    const signal = index % 7 / 7
    const features = Array.from({ length: N }, (_, f) => (f === 0 ? signal : ((index * (f + 3)) % 11) / 11))
    rows.push({
      at: index * 60_000,
      symbol: 'BTC-USDT-SWAP',
      features,
      label: signal > 0.5 ? 1 : 0,
      netR: signal > 0.5 ? 1.2 : -1,
      horizonEndAt: (index + holdBars) * 60_000,
    })
  }
  return rows
}

describe('point-in-time purging (the leakage fix)', () => {
  it('drops every training row whose label horizon reaches into the holdout window', () => {
    const rows = learnableRows(120, 40)
    const artifact = trainSpecialist(rows, Array(N).fill(true), 0.1, niche, 1, null, 1)
    expect(artifact).not.toBeNull()
    expect(artifact!.metrics.purgedRows).toBeGreaterThan(0)
    // every surviving training row must be fully resolved before the holdout starts
    const holdoutStart = rows[Math.floor(rows.length * 0.7)].at
    const illegal = rows.slice(0, Math.floor(rows.length * 0.7)).filter((row) => (row.horizonEndAt ?? row.at) >= holdoutStart)
    expect(illegal.length).toBe(artifact!.metrics.purgedRows)
  })

  it('keeps the feature vector width stable so artifacts stay schema-compatible', () => {
    const mask = Array.from({ length: N }, (_, index) => index % 2 === 0)
    const masked = applyMask(Array(N).fill(0.7), mask)
    expect(masked.length).toBe(N)
    expect(masked[1]).toBe(0)
    expect(masked[0]).toBe(0.7)
  })
})

describe('placebo guard', () => {
  it('shuffles labels without touching features or timestamps', () => {
    const rows = learnableRows(60)
    const shuffled = shuffleLabels(rows, 7)
    expect(shuffled.map((row) => row.at)).toEqual(rows.map((row) => row.at))
    expect(shuffled.map((row) => row.features)).toEqual(rows.map((row) => row.features))
    expect(shuffled.reduce((sum, row) => sum + row.label, 0)).toBe(rows.reduce((sum, row) => sum + row.label, 0))
  })

  it('is deterministic for a given seed', () => {
    const rows = learnableRows(60)
    expect(shuffleLabels(rows, 42).map((row) => row.label)).toEqual(shuffleLabels(rows, 42).map((row) => row.label))
  })

  it('refuses to promote anything from pure noise', () => {
    const noise: TrainingSample[] = Array.from({ length: 140 }, (_, index) => ({
      at: index * 60_000,
      symbol: 'X',
      features: Array.from({ length: N }, (_, f) => ((index * 7919 + f * 104729) % 1000) / 1000),
      label: (index * 2654435761) % 2 === 0 ? 1 : 0,
      netR: (index * 2654435761) % 2 === 0 ? 1 : -1,
      horizonEndAt: (index + 5) * 60_000,
    }))
    const result = evolveNiche(noise, niche, { populationSize: 4, generations: 1, seed: 3, minBrierSkill: 0.05, placebo: true })
    expect(result.best).toBeNull()
    expect(result.rejectionReason).toBeTruthy()
  })
})

describe('generational lineage', () => {
  it('records the parent hash and increments the generation', () => {
    const rows = learnableRows(160, 5)
    const gen1 = evolveNiche(rows, niche, { populationSize: 5, generations: 1, seed: 11, minBrierSkill: -1 })
    expect(gen1.best).not.toBeNull()
    expect(gen1.best!.generation).toBe(1)
    expect(gen1.best!.parentHash).toBeNull()

    const gen2 = evolveNiche(rows, niche, { populationSize: 5, generations: 1, seed: 12, parent: gen1.best, minBrierSkill: -1 })
    // gen2 may be honestly rejected, but if born it must be generation 2 with a parent
    if (gen2.best) {
      expect(gen2.best.generation).toBe(2)
      expect(gen2.best.parentHash).toBeTruthy()
    } else {
      expect(gen2.rejectionReason).toContain('not_better_than_parent')
    }
  })

  it('refuses to train a niche with too little evidence', () => {
    const result = evolveNiche(learnableRows(20), niche, {})
    expect(result.best).toBeNull()
    expect(result.rejectionReason).toContain('insufficient_rows')
  })
})

describe('mixture-of-experts gating', () => {
  const artifact = (brierSkill: number, holdoutRows = 60): SpecialistArtifact => ({
    kind: 'specialist_v1',
    niche,
    featureMask: Array(N).fill(true),
    featureOrder: [...FEATURE_ORDER],
    model: { kind: 'ridge_logistic_platt', featureCount: N, means: Array(N).fill(0), scales: Array(N).fill(1), weights: Array(N).fill(0), bias: 0, plattA: 1, plattB: 0, validationBrier: 0.2, trainedRows: 100, validationRows: 30 },
    metrics: { sample: 100, trainRows: 70, holdoutRows, purgedRows: 0, brier: 0.2, logLoss: 0.6, accuracy: 0.6, auc: 0.65, baselineBrier: 0.25, brierSkill, meanRAtThreshold: 0.2, meanRAll: 0, meanRLift: 0.2, threshold: 0.5, coverage: 0.3, featuresUsed: N },
    generation: 1,
    parentHash: null,
    trainedAt: Date.now(),
    l2: 0.1,
    seed: 1,
  })

  it('weights an unproven expert below a forward-proven one', () => {
    const base = { id: 'a', displayName: 'A', generation: 1, niche, artifact: artifact(0.1) }
    const unproven = memberWeight({ ...base, liveMeanR: null, liveTrades: 0 })
    const proven = memberWeight({ ...base, liveMeanR: 0.6, liveTrades: 40 })
    expect(proven).toBeGreaterThan(unproven)
  })

  it('discounts an adjacent expert through the trust factor', () => {
    const base = { id: 'a', displayName: 'A', generation: 1, niche, artifact: artifact(0.1), liveMeanR: null, liveTrades: 0 }
    expect(memberWeight({ ...base, trust: 0.3 })).toBeLessThan(memberWeight({ ...base, trust: 1 }))
  })

  it('produces a verdict and shrinks size when experts disagree', () => {
    const bull = { id: 'a', displayName: 'BULL', generation: 1, niche, artifact: artifact(0.15), liveMeanR: null, liveTrades: 0, trust: 1 }
    const bear = { id: 'b', displayName: 'BEAR', generation: 2, niche, artifact: { ...artifact(0.15), model: { ...artifact(0.15).model, bias: -4 } }, liveMeanR: null, liveTrades: 0, trust: 1 }
    const verdict = committeeVerdict([bull, bear], Array(N).fill(0.5))
    expect(verdict).not.toBeNull()
    expect(verdict!.totalMembers).toBe(2)
    expect(verdict!.sizeMultiplier).toBeLessThanOrEqual(1.4)
  })

  it('round-trips a niche key', () => {
    expect(parseNicheKey(nicheKey(niche))).toEqual(niche)
  })
})
