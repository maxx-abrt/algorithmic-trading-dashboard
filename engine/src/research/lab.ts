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
import { trainCalibratedLinear, type LabelledFeatureRow } from './calibration.js'

export interface CampaignRequest {
  symbols?: string[]
  timeframe?: '5m' | '15m' | '1H'
  maxEvaluations?: number
  hypothesis?: string
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
}

const closedAt = (candle: Candle, timeframe: string) => {
  const unit = timeframe.endsWith('H') ? 3_600_000 : 60_000
  return candle.ts + Number.parseInt(timeframe) * unit
}

export class ResearchLab {
  private running = false

  constructor(private readonly store: DurableStore) {}

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
    const symbols = [...new Set(request.symbols?.length ? request.symbols : ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])].slice(0, 3)
    const timeframe = request.timeframe ?? '15m'
    const maxEvaluations = Math.max(12, Math.min(request.maxEvaluations ?? 40, 80))
    const hypothesis = request.hypothesis?.trim() || 'Explicit playbooks retain positive net R across purged chronological folds and a held-out symbol.'
    const gate = this.governor()
    if (!gate.allowed) {
      const manifest = { symbols, timeframe, maxEvaluations, hypothesis, gate, createdAt: Date.now() }
      const result: CampaignResult = {
        id: campaignId, status: 'rejected_by_governor', validationState: 'NO_VALIDATED_MODEL', hypothesis,
        symbols, timeframe, trials: [], promotionReasons: gate.reasons, manifestHash: manifestHash(manifest),
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
    this.store.upsertCampaign({ id: campaignId, status: 'running', hypothesis, budget: { maxEvaluations, maxRssMb: gate.maxRssMb }, manifest })

    try {
      const [specRows, tickerRows] = await Promise.all([fetchInstruments('SWAP'), fetchTickers('SWAP')])
      const specs = new Map(specRows.map((row) => [row.instId, row] as const))
      const tickers = new Map(tickerRows.map((row) => [row.instId, row] as const))
      const trials: CampaignResult['trials'] = []
      const allTrades: PaperTrade[] = []
      const labelledFeatures: LabelledFeatureRow[] = []

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
            settings: {
              ...DEFAULT_SETTINGS,
              timeframe,
              htfTimeframe: htfName,
              htf2Timeframe: htf2Name,
              useDerivatives: false,
              minConfidence: 45,
              minCompositeScore: 15,
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
          if (trade.status === 'closed') labelledFeatures.push({
            at: availableAt,
            symbol,
            features: [analysis.compositeScore / 100, analysis.mtfAlignment / 100, analysis.indicators.trend.adx / 50,
              analysis.indicators.momentum.rsi / 100, analysis.indicators.volatility.atrPct / 10,
              analysis.indicators.volume.volumeRatio / 3, selected.score / 100],
            label: trade.netRealizedR > 0 ? 1 : 0,
          })
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
      const calibratedModel = trainCalibratedLinear(labelledFeatures)
      let artifactPath: string | undefined
      if (calibratedModel) {
        const artifactHash = manifestHash(calibratedModel)
        const root = resolve(process.env.RESEARCH_ARTIFACTS_PATH ?? join(process.cwd(), 'data/research-artifacts'), artifactHash)
        mkdirSync(root, { recursive: true })
        artifactPath = join(root, 'model.json')
        writeFileSync(artifactPath, JSON.stringify({ model: calibratedModel, featureOrder: ['composite', 'mtf', 'adx', 'rsi', 'atrPct', 'volumeRatio', 'playbookScore'], manifest }, null, 2))
      }
      const promotionReasons = [
        ...(combined.sample < 30 ? ['sample_below_30'] : []),
        ...(!calibratedModel ? ['calibrated_linear_model_unavailable'] : []),
        ...(calibratedModel && (calibratedModel.validationBrier == null || calibratedModel.validationBrier >= 0.25) ? ['calibration_brier_not_better_than_naive'] : []),
        ...(!combined.bootstrapMeanR95 || combined.bootstrapMeanR95[0] <= 0 ? ['bootstrap_lower_bound_not_positive'] : []),
        ...(combined.deflatedSharpe == null || combined.deflatedSharpe <= 0 ? ['deflated_sharpe_not_positive'] : []),
        ...(combined.maxDrawdownR > 8 ? ['max_drawdown_above_8R'] : []),
        ...(!holdout || holdout.meanR == null || holdout.meanR <= 0 ? ['held_out_symbol_not_positive'] : []),
      ]
      const validationState = promotionReasons.length === 0 ? 'SHADOW_CANDIDATE' : 'NO_VALIDATED_MODEL'
      const result: CampaignResult = {
        id: campaignId, status: 'completed', validationState, hypothesis, symbols, timeframe, trials,
        promotionReasons, manifestHash: manifestHash(manifest),
      }
      this.store.registerModel({
        id: `model:${result.manifestHash.slice(0, 16)}`, state: validationState === 'SHADOW_CANDIDATE' ? 'shadow_candidate' : 'rejected',
        strategy: 'explicit-playbook-registry', version: result.manifestHash.slice(0, 12),
        metrics: { combined, trials, promotionReasons, calibration: calibratedModel ? { validationBrier: calibratedModel.validationBrier, trainedRows: calibratedModel.trainedRows, validationRows: calibratedModel.validationRows } : null },
        artifactPath,
        rollbackReason: promotionReasons.join(',') || undefined,
      })
      this.store.upsertCampaign({ id: campaignId, status: 'completed', hypothesis, budget: { maxEvaluations, symbols: symbols.length }, manifest: { ...manifest, result } })
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
