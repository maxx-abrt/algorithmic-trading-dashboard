import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableStore } from '../src/store/durable.js'
import { ChampionService } from '../src/research/champion.js'
import { loadCalibratedModel, trainCalibratedLinear } from '../src/research/calibration.js'
import { buildRiskPlan } from '../src/quant/risk.js'
import type { Indicators, EngineSettings, InstrumentSpec } from '../src/quant/types.js'
import { DEFAULT_SETTINGS } from '../src/quant/types.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function mkStore() {
  const root = mkdtempSync(join(tmpdir(), 'mycroft-champ-'))
  roots.push(root)
  return new DurableStore(join(root, 'test.sqlite'))
}

function mkIndicators(): Indicators {
  return {
    price: 100,
    ma: { ema9: 99, ema21: 98, ema50: 97, ema100: 96, ema200: 95, sma20: 99, sma50: 98, sma200: 96, ema50SlopePct: 0.1, ema200SlopePct: 0.05, ribbonWidthAtr: 1.5, stackedBull: true, stackedBear: false },
    momentum: { rsi: 55, rsiPrev: 52, rsiSma: 54, stochRsiK: 60, stochRsiD: 55, stochK: 65, stochD: 60, macd: 0.5, macdSignal: 0.3, macdHist: 0.2, macdHistPrev: 0.1, cci: 80, williamsR: -30, roc: 1.5, awesome: 0.5, awesomePrev: 0.3, trix: 0.1, score: 20 },
    volatility: { atr: 2, atrPct: 2, atrPercentile: 50, bbUpper: 104, bbMiddle: 100, bbLower: 96, bbWidthPct: 8, bbWidthPercentile: 50, percentB: 0.5, keltnerUpper: 103, keltnerMiddle: 100, keltnerLower: 97, squeeze: false, realizedVolPct: 30, choppiness: 50, efficiencyRatio: 0.4, volExpansion: 10, regime: 'TRENDING_UP' },
    volume: { volume: 1000, volumeSma: 800, volumeRatio: 1.25, obv: 5000, obvSlope: 100, mfi: 55, adl: 3000, forceIndex: 200, cvd: 500, cvdSlope: 50, vwap: 100, vwapUpper1: 102, vwapLower1: 98, vwapUpper2: 104, vwapLower2: 96, vwapDeviationPct: 0.5, vwapZ: 0.5, score: 15 },
    ichimoku: { conversion: 99, base: 98, spanA: 97, spanB: 96, cloudTop: 97, cloudBottom: 96, priceAboveCloud: true, priceBelowCloud: false, tkBull: true, tkBear: false },
    trend: { adx: 25, plusDI: 25, minusDI: 15, psar: 98, psarBull: true, supertrend: 97, supertrendBull: true, chandelierLong: 96, chandelierShort: 104, aroonUp: 70, aroonDown: 30 },
    profile: { poc: 100, vah: 102, val: 98, valueAreaPct: 70, hvn: [100], lvn: [95], insideValue: true },
    structure: { swings: [], swingHigh: 105, swingLow: 95, higherHighs: true, higherLows: true, lowerHighs: false, lowerLows: false, structure: 'UPTREND', bos: 'BULL', choch: null, rangeHigh: 105, rangeLow: 95, rangePosition: 0.5, levels: [], nearestSupport: { price: 95, strength: 80, kind: 'support', touches: 3, source: 'swing', distancePct: 5 }, nearestResistance: { price: 105, strength: 70, kind: 'resistance', touches: 2, source: 'swing', distancePct: 5 }, fib: [], fvg: [] },
    divergences: [],
    patterns: [],
    stats: { hurst: 0.55, regSlopePct: 0.01, regR2: 0.3, regTstat: 2, zScore20: 0.5, regPos: 0.5, autocorr1: 0.1, skew: 0.1, kurtosis: 3, meanReversion: 50, trendPersistence: 60, regMid: 100, regUpper: 104, regLower: 96, score: 10 },
    xvol: { forecastBarSigmaPct: 1.5, expectedMovePct: 3, parkinsonVolPct: 35, garmanKlassVolPct: 38, ewmaVolPct: 32, volOfVol: 0.2, atrExpansion: 1.1, volTrend: 'rising', climax: false, horizonBars: 12, hourVolRank: 50 },
    xtrend: { donchianUpper: 105, donchianLower: 95, donchianMid: 100, donchianPos: 0.5, vwma: 100, vwmaSpreadPct: 0.5, vortexPlus: 1.2, vortexMinus: 0.8, heikinTrend: 'bull', heikinRun: 3, elderBull: 1.5, elderBear: 0.5, kst: 0.5, kstSignal: 0.3, ultimateOsc: 55, score: 15 },
  }
}

const spec: InstrumentSpec = {
  instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctVal: 1, ctValCcy: 'BTC', lotSz: 0.01, minSz: 0.01, tickSz: 0.1, maxLever: 50, baseCcy: 'BTC', quoteCcy: 'USDT', isEquity: false,
}

describe('ChampionService', () => {
  it('loads with no champion when the store is empty', () => {
    const store = mkStore()
    const champ = new ChampionService(store)
    const state = champ.loadFromStore()
    expect(state.modelId).toBeNull()
    expect(champ.hasChampion).toBe(false)
    expect(champ.modelVersion).toBe('heuristic-baseline')
    store.close()
  })

  it('evaluateCandidate returns shouldCanary=true when no champion exists', () => {
    const store = mkStore()
    const champ = new ChampionService(store)
    champ.loadFromStore()
    const result = champ.evaluateCandidate({
      id: 'test', status: 'completed', validationState: 'SHADOW_CANDIDATE',
      hypothesis: 'test', symbols: ['BTC-USDT-SWAP'], timeframe: '15m',
      trials: [{ symbol: 'BTC-USDT-SWAP', metrics: { sample: 40, wins: 22, losses: 18, winRate: 0.55, meanR: 0.3, medianR: 0.2, profitFactor: 1.5, maxDrawdownR: 3, sharpe: 1.2, downsideDeviation: 0.5, bootstrapMeanR95: [0.1, 0.5], deflatedSharpe: 0.8, probabilityBacktestOverfit: 0 }, folds: 4 }],
      promotionReasons: [], manifestHash: 'abc123',
    })
    expect(result.shouldCanary).toBe(true)
    expect(result.reasons).toContain('no_current_champion_auto_canary')
    store.close()
  })

  it('evaluateCandidate returns shouldCanary=false for non-shadow candidates', () => {
    const store = mkStore()
    const champ = new ChampionService(store)
    champ.loadFromStore()
    const result = champ.evaluateCandidate({
      id: 'test', status: 'completed', validationState: 'NO_VALIDATED_MODEL',
      hypothesis: 'test', symbols: [], timeframe: '15m', trials: [], promotionReasons: ['failed'], manifestHash: 'abc',
    })
    expect(result.shouldCanary).toBe(false)
    store.close()
  })

  it('records and retrieves training rows', () => {
    const store = mkStore()
    store.registerModel({ id: 'model:test1', state: 'paper_champion', strategy: 'test', version: 'v1', metrics: {} })
    store.recordTrainingRow({ modelId: 'model:test1', observedAt: 1000, instId: 'BTC-USDT-SWAP', timeframe: '15m', features: [0.5, 0.6, 0.7], label: 1, netR: 1.5, tradeId: 't1' })
    store.recordTrainingRow({ modelId: 'model:test1', observedAt: 2000, instId: 'ETH-USDT-SWAP', timeframe: '15m', features: [0.3, 0.4, 0.5], label: 0, netR: -1.0, tradeId: 't2' })
    const rows = store.listTrainingRows('model:test1')
    expect(rows).toHaveLength(2)
    expect(rows[0].features).toEqual([0.3, 0.4, 0.5])
    expect(rows[0].label).toBe(0)
    store.close()
  })

  it('records and closes canary trades', () => {
    const store = mkStore()
    store.registerModel({ id: 'model:canary1', state: 'paper_canary', strategy: 'test', version: 'v2', metrics: {} })
    store.recordCanaryTrade('trade-1', 'model:canary1', 1000)
    store.closeCanaryTrade('trade-1', 2000, 1.5)
    const trades = store.listCanaryTrades('model:canary1')
    expect(trades).toHaveLength(1)
    expect(trades[0].net_r).toBe(1.5)
    expect(trades[0].closed_at).toBe(2000)
    store.close()
  })

  it('promotes and rolls back a champion', () => {
    const store = mkStore()
    store.registerModel({ id: 'model:test2', state: 'shadow_candidate', strategy: 'test', version: 'v2', metrics: {} })
    const champ = new ChampionService(store)
    champ.loadFromStore()
    const result = champ.promote('model:test2')
    expect(result.ok).toBe(true)
    expect(champ.modelVersion).toBe('v2')
    const rollback = champ.rollback('test_rollback')
    expect(rollback.ok).toBe(true)
    expect(champ.modelVersion).toBe('heuristic-baseline')
    store.close()
  })
})

describe('loadCalibratedModel', () => {
  it('loads a valid model artifact from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'mycroft-model-'))
    roots.push(root)
    const rows = Array.from({ length: 48 }, (_, index) => ({
      at: index * 60_000,
      symbol: index % 2 ? 'BTC' : 'ETH',
      features: [index / 48, Math.sin(index / 5), index % 3],
      label: (index > 22 ? 1 : 0) as 0 | 1,
    }))
    const model = trainCalibratedLinear(rows)!
    const modelPath = join(root, 'model.json')
    writeFileSync(modelPath, JSON.stringify({ model, featureOrder: ['a', 'b', 'c'] }))
    const loaded = loadCalibratedModel(modelPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.kind).toBe('ridge_logistic_platt')
    expect(loaded!.featureCount).toBe(3)
  })

  it('returns null for a corrupted or missing file', () => {
    expect(loadCalibratedModel('/nonexistent/path/model.json')).toBeNull()
    const root = mkdtempSync(join(tmpdir(), 'mycroft-bad-'))
    roots.push(root)
    const badPath = join(root, 'model.json')
    writeFileSync(badPath, 'not json')
    expect(loadCalibratedModel(badPath)).toBeNull()
  })

  it('returns null for a non-ridge-logistic model', () => {
    const root = mkdtempSync(join(tmpdir(), 'mycroft-wrong-'))
    roots.push(root)
    const wrongPath = join(root, 'model.json')
    writeFileSync(wrongPath, JSON.stringify({ model: { kind: 'something_else' } }))
    expect(loadCalibratedModel(wrongPath)).toBeNull()
  })
})

describe('buildRiskPlan champion blend', () => {
  it('blends champion model probability into winProbability', () => {
    const indicators = mkIndicators()
    const settings: EngineSettings = { ...DEFAULT_SETTINGS, instId: 'BTC-USDT-SWAP' }
    const rows = Array.from({ length: 48 }, (_, index) => ({
      at: index * 60_000,
      symbol: 'BTC',
      features: [index / 48, Math.sin(index / 5), index % 3, index / 100, 0.5, 1.2, 0.6],
      label: (index > 22 ? 1 : 0) as 0 | 1,
    }))
    const championModel = trainCalibratedLinear(rows, { trainFraction: 0.75 })!
    expect(championModel).not.toBeNull()

    const planWithChampion = buildRiskPlan({
      side: 'LONG', entry: 100, indicators, settings, spec,
      conviction: 65, playbook: 'trend_pullback', equityUsd: 10_000,
      championModel, compositeScore: 30, mtfAlignment: 70, playbookScore: 80,
    })
    const planWithoutChampion = buildRiskPlan({
      side: 'LONG', entry: 100, indicators, settings, spec,
      conviction: 65, playbook: 'trend_pullback', equityUsd: 10_000,
      compositeScore: 30, mtfAlignment: 70, playbookScore: 80,
    })

    expect(planWithChampion.probabilityBasis).toBe('champion_calibrated_blend')
    expect(planWithoutChampion.probabilityBasis).not.toBe('champion_calibrated_blend')
    // The win probability should be different when the champion is blended in
    expect(planWithChampion.winProbability).not.toEqual(planWithoutChampion.winProbability)
    // Both should be within bounds
    expect(planWithChampion.winProbability).toBeGreaterThanOrEqual(0.25)
    expect(planWithChampion.winProbability).toBeLessThanOrEqual(0.75)
  })

  it('falls back gracefully when no champion model is provided', () => {
    const indicators = mkIndicators()
    const settings: EngineSettings = { ...DEFAULT_SETTINGS, instId: 'BTC-USDT-SWAP' }
    const plan = buildRiskPlan({
      side: 'LONG', entry: 100, indicators, settings, spec,
      conviction: 65, playbook: 'trend_pullback', equityUsd: 10_000,
    })
    expect(plan.winProbability).toBeGreaterThanOrEqual(0.25)
    expect(plan.winProbability).toBeLessThanOrEqual(0.75)
    expect(plan.probabilityBasis).not.toBe('champion_calibrated_blend')
  })
})
