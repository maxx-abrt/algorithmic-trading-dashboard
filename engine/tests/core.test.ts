import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processPaperBar, runPaperPlan, submitPaperPlan } from '../src/paper/broker.js'
import { assessPaperRisk } from '../src/paper/risk.js'
import type { PaperPlan, PaperTrade } from '../src/paper/types.js'
import { DurableStore } from '../src/store/durable.js'
import { purgedWalkForward, validationMetrics } from '../src/research/validation.js'
import { predictCalibrated, trainCalibratedLinear } from '../src/research/calibration.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function plan(overrides: Partial<PaperPlan> = {}): PaperPlan {
  return {
    id: 'trade-1', instId: 'BTC-USDT-SWAP', timeframe: '15m', side: 'LONG', signalAt: 1_000,
    policyVersion: 'test-v1', modelVersion: 'baseline', playbook: 'trend_pullback',
    entry: 100, entryZone: [99, 101], stopLoss: 95,
    targets: [{ price: 105, allocation: 0.4 }, { price: 110, allocation: 0.35 }, { price: 115, allocation: 0.25 }],
    quantity: 1, riskUsd: 100, maxEntryBars: 3, maxHoldBars: 12,
    feeBps: 5, slippageBps: 0, atrAtEntry: 2, trailAtrMult: 2,
    ...overrides,
  }
}

const candle = (ts: number, open: number, high: number, low: number, close: number) => ({
  ts, open, high, low, close, volume: 10, quoteVolume: 1_000, confirmed: true,
})

describe('paper broker invariants', () => {
  it('uses stop-first ordering when a fill bar touches stop and target', () => {
    const trade = runPaperPlan(plan(), [candle(2_000, 100, 106, 94, 102)])
    expect(trade.status).toBe('closed')
    expect(trade.exitReason).toBe('stop_loss')
    expect(trade.grossRealizedR).toBeCloseTo(-1)
  })

  it('keeps TP1 state and applies break-even on the following bar', () => {
    let trade = submitPaperPlan(plan())
    trade = processPaperBar(trade, candle(2_000, 100, 106, 99, 104)).trade
    expect(trade.status).toBe('open')
    expect(trade.targets[0].filled).toBe(true)
    expect(trade.currentStop).toBe(trade.fillPrice)
    trade = processPaperBar(trade, candle(3_000, 104, 104.5, 99, 100)).trade
    expect(trade.status).toBe('closed')
    expect(trade.exitReason).toBe('breakeven_stop')
    expect(trade.grossRealizedR).toBeCloseTo(0.4)
  })

  it('is idempotent for duplicate and unconfirmed bars', () => {
    let trade = submitPaperPlan(plan())
    const first = processPaperBar(trade, candle(2_000, 100, 101, 99, 100))
    trade = first.trade
    const duplicate = processPaperBar(trade, candle(2_000, 100, 110, 90, 100))
    const unconfirmed = processPaperBar(trade, { ...candle(3_000, 100, 110, 90, 100), confirmed: false })
    expect(duplicate.changed).toBe(false)
    expect(unconfirmed.changed).toBe(false)
    expect(duplicate.trade.events).toEqual(trade.events)
  })

  it('never loosens a long stop after TP2', () => {
    fc.assert(fc.property(fc.double({ min: 110, max: 180, noNaN: true }), (close) => {
      let trade = submitPaperPlan(plan())
      trade = processPaperBar(trade, candle(2_000, 100, 111, 99, 110)).trade
      const before = trade.currentStop
      trade = processPaperBar(trade, candle(3_000, close, close + 1, Math.max(before + 0.1, close - 1), close)).trade
      return trade.status !== 'open' || trade.currentStop >= before
    }))
  })
})

describe('risk, persistence, and validation', () => {
  it('enforces portfolio and duplicate exposure limits', () => {
    const openTrade = submitPaperPlan(plan())
    const decision = assessPaperRisk(plan({ id: 'trade-2' }), {
      equityUsd: 10_000, openRiskUsd: 100, openNotionalUsd: 100, realizedDailyR: 0, openTrades: [openTrade],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reasons).toContain('duplicate_instrument_exposure')
  })

  it('recovers active paper state from SQLite WAL', () => {
    const root = mkdtempSync(join(tmpdir(), 'mycroft-test-'))
    roots.push(root)
    let store = new DurableStore(join(root, 'test.sqlite'))
    const trade = processPaperBar(submitPaperPlan(plan()), candle(2_000, 100, 101, 99, 100)).trade
    store.saveTrade(trade)
    store.close()
    store = new DurableStore(join(root, 'test.sqlite'))
    expect(store.loadActiveTrades()).toHaveLength(1)
    expect(store.loadActiveTrades()[0].lastProcessedTs).toBe(2_000)
    store.close()
  })

  it('creates chronological purged folds with no overlap', () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({ at: index * 60_000, symbol: 'BTC' }))
    const folds = purgedWalkForward(samples, { folds: 3, purgeMs: 120_000, embargoMs: 120_000, minTrain: 20 })
    expect(folds.length).toBeGreaterThanOrEqual(2)
    for (const fold of folds) expect(fold.trainEnd).toBeLessThan(fold.testStart - 120_000)
  })

  it('reports insufficient evidence rather than invented statistics', () => {
    const metrics = validationMetrics([] as PaperTrade[])
    expect(metrics.sample).toBe(0)
    expect(metrics.meanR).toBeNull()
    expect(metrics.winRate).toBeNull()
  })
})


describe('local calibrated model', () => {
  it('trains chronologically and returns bounded probabilities', () => {
    const rows = Array.from({ length: 48 }, (_, index) => ({
      at: index * 60_000,
      symbol: index % 2 ? 'BTC' : 'ETH',
      features: [index / 48, Math.sin(index / 5), index % 3],
      label: (index > 22 ? 1 : 0) as 0 | 1,
    }))
    const model = trainCalibratedLinear(rows)
    expect(model).not.toBeNull()
    const low = predictCalibrated(model!, [0.1, 0, 1])
    const high = predictCalibrated(model!, [0.9, 0, 1])
    expect(low).toBeGreaterThanOrEqual(0)
    expect(high).toBeLessThanOrEqual(1)
    expect(high).toBeGreaterThan(low)
  })

  it('refuses to train on an inadequate sample', () => {
    expect(trainCalibratedLinear([])).toBeNull()
  })
})
