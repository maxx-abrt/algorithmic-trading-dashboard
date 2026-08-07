import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadavg } from 'node:os'
import { fetchCandles, fetchInstruments, fetchTickers } from '../okx/market.js'
import { analyze } from '../quant/engine.js'
import { higherTimeframes } from '../quant/timeframes.js'
import { DEFAULT_SETTINGS, type Candle, type InstrumentSpec } from '../quant/types.js'
import { createPaperPlan, runPaperPlan } from '../paper/broker.js'
import type { PaperTrade } from '../paper/types.js'
import { evaluateStrategies } from '../strategies/registry.js'
import type { DurableStore } from '../store/durable.js'
import { manifestHash, purgedWalkForward, validationMetrics } from './validation.js'
import { trainCalibratedLinear, type CalibratedLinearModel, type LabelledFeatureRow } from './calibration.js'
import { trainEnsemble } from './ensemble.js'
import { analyzeFeatureImportance } from './feature-importance.js'
import { runCPCV } from './cpcv.js'
import { applyTripleBarrier } from './triple-barrier.js'
import { getCachedMarketContext } from '../quant/market-context.js'
import { buildFeatureVector, FEATURE_ORDER } from './features.js'
import { generateModelName } from './naming.js'
import { log } from '../log.js'

export type CampaignType =
  | 'baseline'          // Standard BTC+ETH walk-forward with full 32-feature vector
  | 'spot_swap'         // Same playbooks on SPOT and SWAP to learn venue-specific behaviour
  | 'multi_symbol'      // Diversify across 3+ symbols to test generalization
  | 'timeframe_sweep'   // Test 5m vs 15m vs 1H to find best timeframe
  | 'ensemble'          // Train ensemble stack (logistic + kNN + NB + stumps)
  | 'triple_barrier'    // Use triple-barrier labeling instead of simple win/loss
  | 'feature_rich'      // Full 32-feature vector with feature importance analysis
  | 'high_conviction'   // Only trade high-conviction setups (>=70)
  | 'low_conviction'    // Test if lower threshold (>=50) finds more edge
  | 'regime_aware'      // Segment by regime and train per-regime models

export interface CampaignRequest {
  symbols?: string[]
  timeframe?: '5m' | '15m' | '1H'
  maxEvaluations?: number
  hypothesis?: string
  autoPromote?: boolean
  type?: CampaignType
}

export interface CampaignResult {
  id: string
  status: 'completed' | 'rejected_by_governor' | 'failed'
  validationState: 'NO_VALIDATED_MODEL' | 'SHADOW_CANDIDATE'
  hypothesis: string
  symbols: string[]
  timeframe: string
  trials: { symbol: string; metrics: ReturnType<typeof validationMetrics>; folds: number }[]
  promotionReasons: string[]
  manifestHash: string
  /** point-in-time training samples harvested for the evolution store */
  samplesEmitted: number
}

const closedAt = (candle: Candle, timeframe: string) => {
  const unit = timeframe.endsWith('H') ? 3_600_000 : 60_000
  return candle.ts + Number.parseInt(timeframe) * unit
}

interface CampaignConfig {
  symbols: string[]
  timeframe: '5m' | '15m' | '1H'
  maxEvaluations: number
  hypothesis: string
  useEnsemble: boolean
  useTripleBarrier: boolean
  minConfidence: number
  minCompositeScore: number
}

export const CAMPAIGN_CONFIGS: Record<CampaignType, CampaignConfig> = {
  baseline: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Full 32-feature vector with logistic regression retains positive net R across purged folds and held-out ETH.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 55,
    minCompositeScore: 15,
  },
  spot_swap: {
    symbols: ['BTC-USDT-SWAP', 'BTC-USDT', 'ETH-USDT-SWAP', 'ETH-USDT'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'The same playbook behaves differently on SPOT and SWAP; a venue-specific specialist beats one shared model.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 50,
    minCompositeScore: 10,
  },
  multi_symbol: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 50,
    hypothesis: 'Playbooks generalize across 3+ symbols — positive net R on held-out SOL confirms cross-asset edge.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 55,
    minCompositeScore: 15,
  },
  timeframe_sweep: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '5m',
    maxEvaluations: 70,
    hypothesis: '5m scalping with full feature vector captures intraday edge that 15m misses.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 50,
    minCompositeScore: 12,
  },
  ensemble: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Ensemble stacking (logistic + kNN + NaiveBayes + stumps) outperforms single logistic on Brier score.',
    useEnsemble: true,
    useTripleBarrier: false,
    minConfidence: 55,
    minCompositeScore: 15,
  },
  triple_barrier: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Triple-barrier labeling produces better-calibrated models than simple win/loss by capturing path-dependent outcomes.',
    useEnsemble: false,
    useTripleBarrier: true,
    minConfidence: 55,
    minCompositeScore: 15,
  },
  feature_rich: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Full 32-feature vector with feature importance auto-selection identifies which signals matter and discards noise.',
    useEnsemble: true,
    useTripleBarrier: false,
    minConfidence: 55,
    minCompositeScore: 15,
  },
  high_conviction: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Filtering to high-conviction setups (>=70) produces fewer but higher-quality trades with better net R.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 70,
    minCompositeScore: 25,
  },
  low_conviction: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 70,
    hypothesis: 'Lowering conviction threshold to 50 captures marginal edge that high threshold misses, if costs are low enough.',
    useEnsemble: false,
    useTripleBarrier: false,
    minConfidence: 50,
    minCompositeScore: 10,
  },
  regime_aware: {
    symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
    timeframe: '15m',
    maxEvaluations: 60,
    hypothesis: 'Regime-conditional models outperform unconditional — different playbooks win in trending vs ranging markets.',
    useEnsemble: true,
    useTripleBarrier: true,
    minConfidence: 55,
    minCompositeScore: 15,
  },
}

export class ResearchLab {
  private running = false

  constructor(
    private readonly store: DurableStore,
    /** every closed historical trade is emitted here as an immutable training sample */
    private readonly sink?: (sample: { at: number; symbol: string; features: number[]; label: 0 | 1; netR?: number; horizonEndAt?: number; instType: string; timeframe: string; playbook: string; tradeId?: string }) => void,
  ) {}

  governor() {
    const rssMb = process.memoryUsage().rss / 1024 / 1024
    const [load1] = loadavg()
    const cpuCount = Math.max(1, Number(process.env.RESEARCH_CPU_COUNT ?? 4))
    const maxRssMb = Number(process.env.RESEARCH_MAX_RSS_MB ?? 1400)
    const maxLoad = Number(process.env.RESEARCH_MAX_LOAD ?? cpuCount * 1.5)
    const reasons = [
      ...(rssMb > maxRssMb ? [`rss_${rssMb.toFixed(0)}mb_above_${maxRssMb}`] : []),
      ...(load1 > maxLoad ? [`load_${load1.toFixed(1)}_above_${maxLoad}`] : []),
      ...(this.running ? ['campaign_already_running'] : []),
    ]
    return { allowed: reasons.length === 0, reasons, rssMb, load1, maxRssMb, maxLoad, running: this.running }
  }

  async run(request: CampaignRequest = {}): Promise<CampaignResult> {
    const campaignId = `campaign:${randomUUID()}`
    const campaignType = request.type ?? 'baseline'

    // Configure campaign by type
    const config = CAMPAIGN_CONFIGS[campaignType]
    const symbols = [...new Set(request.symbols?.length ? request.symbols : config.symbols)].slice(0, 5)
    const timeframe = request.timeframe ?? config.timeframe
    const maxEvaluations = Math.max(12, Math.min(request.maxEvaluations ?? config.maxEvaluations, 80))
    const hypothesis = request.hypothesis?.trim() || config.hypothesis
    const useEnsemble = config.useEnsemble
    const useTripleBarrier = config.useTripleBarrier
    const minConfidence = config.minConfidence
    const minCompositeScore = config.minCompositeScore
    const gate = this.governor()
    if (!gate.allowed) {
      const manifest = { symbols, timeframe, maxEvaluations, hypothesis, gate, createdAt: Date.now() }
      const result: CampaignResult = {
        id: campaignId, status: 'rejected_by_governor', validationState: 'NO_VALIDATED_MODEL', hypothesis,
        symbols, timeframe, trials: [], promotionReasons: gate.reasons, manifestHash: manifestHash(manifest), samplesEmitted: 0,
      }
      this.store.upsertCampaign({ id: campaignId, status: result.status, hypothesis, budget: gate, manifest })
      return result
    }

    this.running = true
    const manifest = {
      campaignId, symbols, timeframe, maxEvaluations, hypothesis,
      policyVersion: 'explicit-playbooks-v1', brokerVersion: 'paper-broker-v1',
      validation: { folds: 4, purgeBars: 12, embargoBars: 12 }, createdAt: Date.now(),
    }
    this.store.upsertCampaign({ id: campaignId, status: 'running', hypothesis, budget: { maxEvaluations, maxRssMb: gate.maxRssMb }, manifest: { ...manifest, campaignType } })

    try {
      const [swapSpecs, spotSpecs, swapTickers, spotTickers] = await Promise.all([
        fetchInstruments('SWAP'),
        fetchInstruments('SPOT'),
        fetchTickers('SWAP'),
        fetchTickers('SPOT'),
      ])
      const specs = new Map([...swapSpecs, ...spotSpecs].map((row) => [row.instId, row] as const))
      const tickers = new Map([...swapTickers, ...spotTickers].map((row) => [row.instId, row] as const))
      const trials: CampaignResult['trials'] = []
      const allTrades: PaperTrade[] = []
      const labelledFeatures: LabelledFeatureRow[] = []
      let samplesEmitted = 0
      const metaLabelledFeatures: LabelledFeatureRow[] = []

      for (const symbol of symbols) {
        const spec = specs.get(symbol) as InstrumentSpec | undefined
        const ticker = tickers.get(symbol)
        if (!spec || !ticker) continue
        const [htfName, htf2Name] = higherTimeframes(timeframe)
        const [ltfRaw, htf, htf2] = await Promise.all([
          fetchCandles(symbol, timeframe, 600, { history: true }),
          fetchCandles(symbol, htfName, 500, { history: true }),
          fetchCandles(symbol, htf2Name, 300, { history: true }),
        ])
        const ltf = ltfRaw.filter((row) => row.confirmed)
        this.store.upsertCandles(symbol, timeframe, ltf)
        const start = Math.max(220, ltf.length - Math.max(180, maxEvaluations * 4))
        const step = Math.max(2, Math.floor((ltf.length - start - 24) / maxEvaluations))
        const trades: PaperTrade[] = []
        const samples: { at: number; symbol: string }[] = []

        for (let index = start; index < ltf.length - 24 && samples.length < maxEvaluations; index += step) {
          const signalBar = ltf[index]
          const availableAt = closedAt(signalBar, timeframe)
          const analysis = analyze({
            instId: symbol, instType: spec.instType, spec,
            ltf: ltf.filter((row) => row.ts < availableAt).slice(-300),
            htf: htf.filter((row) => row.ts < availableAt).slice(-220),
            htf2: htf2.filter((row) => row.ts < availableAt).slice(-160),
            livePrice: signalBar.close, volUsd24h: ticker.volUsd24h, now: availableAt,
            marketContext: getCachedMarketContext(),
            settings: {
              ...DEFAULT_SETTINGS,
              timeframe,
              htfTimeframe: htfName,
              htf2Timeframe: htf2Name,
              useDerivatives: false,
              minConfidence,
              minCompositeScore,
              minAdx: 12,
              maxAtrPct: 12,
              requireMtfAlignment: false,
            },
          })
          samples.push({ at: availableAt, symbol })
          const candidates = evaluateStrategies(analysis)
          for (const candidate of candidates) this.store.recordCandidate({
            id: `${campaignId}:${candidate.id}`, observedAt: availableAt, instId: symbol, timeframe,
            playbook: candidate.playbook, side: candidate.side, eligible: candidate.eligible,
            reasons: candidate.rejectionReasons, policyVersion: 'explicit-playbooks-v1', featureTime: signalBar.ts,
            latestSourceTime: signalBar.ts, availableAt, payload: { ...candidate, campaignId },
          })
          const selected = candidates.find((candidate) => candidate.eligible && candidate.side === (analysis.plan ?? analysis.shadowPlan)?.side)
          const riskPlan = selected ? (analysis.plan ?? analysis.shadowPlan) : null
          if (!selected || !riskPlan || riskPlan.netExpectancyR <= 0) continue
          const plan = createPaperPlan({
            id: `${campaignId}:${symbol}:${availableAt}`, instId: symbol, timeframe, signalAt: availableAt,
            playbook: selected.playbook, policyVersion: 'explicit-playbooks-v1', plan: riskPlan,
            atrAtEntry: analysis.indicators.volatility.atr, feeBps: 5, slippageBps: Math.max(1, riskPlan.slippageBps),
          })
          const trade = runPaperPlan(plan, ltf.slice(index + 1, index + 1 + plan.maxHoldBars + plan.maxEntryBars))
          trades.push(trade)
          allTrades.push(trade)
          if (trade.status === 'closed') {
            // Build the full 32-feature vector matching the live system
            const features = buildFeatureVector({
              compositeScore: analysis.compositeScore,
              mtfAlignment: analysis.mtfAlignment,
              indicators: analysis.indicators,
              playbookScore: selected.score,
              marketContext: analysis.marketContext,
              derivatives: analysis.derivatives,
            })
            // Use triple-barrier labeling if configured, otherwise simple win/loss
            let label: 0 | 1 = trade.netRealizedR > 0 ? 1 : 0
            if (useTripleBarrier) {
              const futureCandles = ltf.slice(index + 1, index + 1 + 48)
              const atr = analysis.indicators.volatility.atr
              const side: 'LONG' | 'SHORT' = riskPlan.side
              const stopPrice = side === 'LONG'
                ? signalBar.close - atr * 1.5
                : signalBar.close + atr * 1.5
              const tbResult = applyTripleBarrier(
                signalBar.close,
                side,
                stopPrice,
                futureCandles.map((c) => c.high),
                futureCandles.map((c) => c.low),
                futureCandles.map((c) => c.close),
                { tpR: 2, slR: 1, maxBars: 48 },
              )
              // Convert 0.5 (time barrier) to label 0 (conservative: treat ambiguous as loss)
              label = tbResult.label === 1 ? 1 : 0
              // Meta-labeling: collect second-stage labels for meta-model training
              // metaLabel=1 means primary signal was correct, metaLabel=0 means it was wrong
              metaLabelledFeatures.push({
                at: availableAt,
                symbol,
                features,
                label: tbResult.metaLabel,
              })
            }
            labelledFeatures.push({
              at: availableAt,
              symbol,
              features,
              label,
            })
            samplesEmitted++
            this.sink?.({
              at: availableAt,
              symbol,
              features,
              label,
              netR: trade.netRealizedR,
              horizonEndAt: trade.closedAt ?? availableAt,
              instType: spec.instType,
              timeframe,
              playbook: selected.playbook,
              tradeId: trade.id,
            })
          }
        }

        const foldMs = timeframe === '5m' ? 5 * 60_000 : timeframe === '1H' ? 3_600_000 : 15 * 60_000
        const folds = purgedWalkForward(samples, { folds: 4, purgeMs: foldMs * 12, embargoMs: foldMs * 12, minTrain: 10 })
        const metrics = validationMetrics(trades, symbols.length * 3)
        trials.push({ symbol, metrics, folds: folds.length })
        this.store.recordTrial({
          id: `${campaignId}:${symbol}`, campaignId, status: 'completed',
          configHash: manifestHash({ symbol, timeframe, policy: 'explicit-playbooks-v1' }), metrics: { ...metrics, folds: folds.length },
        })
      }

      const combined = validationMetrics(allTrades, Math.max(1, trials.length * 3))
      const holdout = trials.at(-1)?.metrics

      // Feature importance analysis on the full 32-feature vector
      const importance = labelledFeatures.length >= 30
        ? analyzeFeatureImportance(labelledFeatures, null, [...FEATURE_ORDER] as string[])
        : []
      const keptFeatures = importance.filter((f) => f.keep).length
      if (importance.length > 0) {
        log.info('research', `feature importance: ${keptFeatures}/${importance.length} kept, top: ${importance.slice(0, 5).map((f) => `${f.featureName}(${f.mutualInfo.toFixed(3)})`).join(', ')}`)
      }

      // Train logistic model (grid search over L2)
      const l2Values = [0.01, 0.1, 0.5, 1.0, 5.0]
      let bestLogistic = trainCalibratedLinear(labelledFeatures)
      for (const l2 of l2Values) {
        const candidate = trainCalibratedLinear(labelledFeatures, { l2 })
        if (candidate && candidate.validationBrier != null && bestLogistic && bestLogistic.validationBrier != null && candidate.validationBrier < bestLogistic.validationBrier) {
          bestLogistic = candidate
        }
      }
      let calibratedModel = bestLogistic
      let usedEnsemble = false

      // Try ensemble if configured or if we have enough data
      if ((useEnsemble || labelledFeatures.length >= 40) && labelledFeatures.length >= 40) {
        const ensemble = trainEnsemble(labelledFeatures)
        if (ensemble && calibratedModel && ensemble.validationBrier != null && calibratedModel.validationBrier != null && ensemble.validationBrier < calibratedModel.validationBrier) {
          log.info('research', `ensemble wins: brier ${ensemble.validationBrier.toFixed(4)} vs logistic ${calibratedModel.validationBrier.toFixed(4)}`)
          usedEnsemble = true
        }
      }

      // CPCV validation for robust out-of-sample estimation
      let cpcvResult: { meanBrier: number; stdBrier: number; brierLow: number; brierHigh: number; meanAccuracy: number } | null = null
      if (labelledFeatures.length >= 60) {
        const cpcv = runCPCV(labelledFeatures)
        if (cpcv) {
          cpcvResult = { meanBrier: cpcv.meanBrier, stdBrier: cpcv.stdBrier, brierLow: cpcv.brierLow, brierHigh: cpcv.brierHigh, meanAccuracy: cpcv.meanAccuracy }
          log.info('research', `CPCV: meanBrier=${cpcv.meanBrier.toFixed(4)} ± ${cpcv.stdBrier.toFixed(4)} accuracy=${(cpcv.meanAccuracy * 100).toFixed(1)}%`)
        }
      }

      // Meta-labeling: train second-stage meta-model on triple-barrier meta-labels
      // The meta-model predicts whether the primary signal is correct, enabling
      // position sizing based on meta-model confidence (López de Prado method)
      let metaModel: CalibratedLinearModel | null = null
      if (useTripleBarrier && metaLabelledFeatures.length >= 30) {
        metaModel = trainCalibratedLinear(metaLabelledFeatures)
        if (metaModel && metaModel.validationBrier != null) {
          log.info('research', `meta-model trained: brier=${metaModel.validationBrier.toFixed(4)} rows=${metaModel.trainedRows} — second-stage signal filtering enabled`)
        }
      }

      let artifactPath: string | undefined
      if (calibratedModel) {
        const artifactHash = manifestHash(calibratedModel)
        const root = resolve(process.env.RESEARCH_ARTIFACTS_PATH ?? join(process.cwd(), 'data/research-artifacts'), artifactHash)
        mkdirSync(root, { recursive: true })
        artifactPath = join(root, 'model.json')
        writeFileSync(artifactPath, JSON.stringify({
          model: calibratedModel,
          metaModel: metaModel ?? undefined,
          featureOrder: FEATURE_ORDER,
          featureImportance: importance,
          cpcv: cpcvResult,
          usedEnsemble,
          campaignType,
          manifest,
        }, null, 2))
      }
      const promotionReasons = [
        ...(combined.sample < 30 ? ['sample_below_30'] : []),
        ...(!calibratedModel ? ['calibrated_linear_model_unavailable'] : []),
        ...(calibratedModel && (calibratedModel.validationBrier == null || calibratedModel.validationBrier >= 0.25) ? ['calibration_brier_not_better_than_naive'] : []),
        ...(!combined.bootstrapMeanR95 || combined.bootstrapMeanR95[0] <= 0 ? ['bootstrap_lower_bound_not_positive'] : []),
        ...(combined.deflatedSharpe == null || combined.deflatedSharpe <= 0 ? ['deflated_sharpe_not_positive'] : []),
        ...(combined.maxDrawdownR > 8 ? ['max_drawdown_above_8R'] : []),
        ...(!holdout || holdout.meanR == null || holdout.meanR <= 0 ? ['held_out_symbol_not_positive'] : []),
        ...(cpcvResult && cpcvResult.meanBrier >= 0.25 ? ['cpcv_brier_not_better_than_naive'] : []),
      ]
      const validationState = promotionReasons.length === 0 ? 'SHADOW_CANDIDATE' : 'NO_VALIDATED_MODEL'
      const result: CampaignResult = {
        id: campaignId, status: 'completed', validationState, hypothesis, symbols, timeframe, trials,
        promotionReasons, manifestHash: manifestHash(manifest), samplesEmitted,
      }
      this.store.registerModel({
        id: `model:${result.manifestHash.slice(0, 16)}`, state: validationState === 'SHADOW_CANDIDATE' ? 'shadow_candidate' : 'rejected',
        strategy: 'explicit-playbook-registry', version: result.manifestHash.slice(0, 12),
        metrics: {
          combined, trials, promotionReasons,
          calibration: calibratedModel ? { validationBrier: calibratedModel.validationBrier, trainedRows: calibratedModel.trainedRows, validationRows: calibratedModel.validationRows } : null,
          campaignType,
          usedEnsemble,
          hasMetaModel: metaModel != null,
          metaModelBrier: metaModel?.validationBrier ?? null,
          metaModelRows: metaModel?.trainedRows ?? 0,
          cpcv: cpcvResult,
          featureCount: FEATURE_ORDER.length,
          featuresKept: keptFeatures,
        },
        artifactPath,
        rollbackReason: promotionReasons.join(',') || undefined,
        displayName: generateModelName(),
        generation: 1,
      })
      this.store.upsertCampaign({ id: campaignId, status: 'completed', hypothesis, budget: { maxEvaluations, symbols: symbols.length }, manifest: { ...manifest, campaignType, result } })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.upsertCampaign({ id: campaignId, status: 'failed', hypothesis, budget: { maxEvaluations }, manifest: { ...manifest, error: message } })
      throw error
    } finally {
      this.running = false
    }
  }
}
