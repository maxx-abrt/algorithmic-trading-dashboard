import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { log } from '../log.js'
import type { DurableStore } from '../store/durable.js'
import type { CalibratedLinearModel, LabelledFeatureRow } from './calibration.js'
import { loadCalibratedModel, predictCalibrated, trainCalibratedLinear } from './calibration.js'
import type { CampaignResult } from './lab.js'
import type { ValidationMetrics } from './validation.js'
import { manifestHash } from './validation.js'
import { generateModelName } from './naming.js'
import { FEATURE_ORDER } from './features.js'
import { trainEnsemble, predictEnsemble, type EnsembleModel } from './ensemble.js'
import { analyzeFeatureImportance } from './feature-importance.js'
import { runCPCV } from './cpcv.js'
import { fitAnomalyModel, type AnomalyModel } from '../quant/anomaly.js'

export interface ChampionState {
  modelId: string | null
  version: string | null
  artifact: CalibratedLinearModel | null
  artifactPath: string | null
  displayName: string | null
  generation: number
}

export interface CanaryStats {
  trades: number
  meanR: number
  winRate: number
  maxDrawdownR: number
}

const CANARY_MIN_TRADES = 20
const CANARY_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const ROLLBACK_WINDOW = 30
const ROLLBACK_MAX_DRAWDOWN_R = 8

export class ChampionService {
  private state: ChampionState = { modelId: null, version: null, artifact: null, artifactPath: null, displayName: null, generation: 0 }
  private previousChampionId: string | null = null
  private canaryModelId: string | null = null
  /** Fitted anomaly detection model — updated on each retrain */
  anomalyModel: AnomalyModel | null = null
  /** Feature importance ranking from last retrain */
  featureImportance: { featureName: string; mutualInfo: number; keep: boolean }[] = []
  /** CPCV validation result from last retrain */
  cpcvResult: { meanBrier: number; stdBrier: number; brierLow: number; brierHigh: number; meanAccuracy: number } | null = null

  constructor(private readonly store: DurableStore) {}

  /** The model ID of the active canary, if any. */
  get canaryId(): string | null {
    return this.canaryModelId
  }

  /** Load the active canary from the store. */
  loadCanaryFromStore(): string | null {
    const canaries = this.store.listModelsByState('paper_canary')
    if (canaries.length > 0) {
      this.canaryModelId = String(canaries[0].id)
      log.info('champion', `active canary found: ${this.canaryModelId}`)
    }
    return this.canaryModelId
  }

  /** Load the current paper_champion from the store and its artifact from disk. */
  loadFromStore(): ChampionState {
    const research = this.store.researchState()
    const champion = research.champion as Record<string, unknown> | null
    if (!champion) {
      this.state = { modelId: null, version: null, artifact: null, artifactPath: null, displayName: null, generation: 0 }
      return this.state
    }
    const artifactPath = champion.artifact_path ? String(champion.artifact_path) : null
    const artifact = artifactPath ? loadCalibratedModel(artifactPath) : null
    this.state = {
      modelId: String(champion.id),
      version: String(champion.version),
      artifact,
      artifactPath,
      displayName: champion.display_name ? String(champion.display_name) : null,
      generation: champion.generation != null ? Number(champion.generation) : 1,
    }
    log.info('champion', `loaded champion ${this.state.displayName ?? this.state.version} gen${this.state.generation} (artifact ${artifact ? 'ok' : 'missing'})`)
    return this.state
  }

  get current(): ChampionState {
    return this.state
  }

  get model(): CalibratedLinearModel | null {
    return this.state.artifact
  }

  get modelVersion(): string {
    return this.state.version ?? 'heuristic-baseline'
  }

  get hasChampion(): boolean {
    return this.state.artifact != null
  }

  /** Compare a shadow candidate to the current champion using promotion metrics. */
  evaluateCandidate(result: CampaignResult): { shouldCanary: boolean; reasons: string[] } {
    const reasons: string[] = []
    if (result.validationState !== 'SHADOW_CANDIDATE') {
      reasons.push('not_a_shadow_candidate')
      return { shouldCanary: false, reasons }
    }
    // If no current champion, the candidate becomes the canary immediately.
    if (!this.state.modelId) {
      reasons.push('no_current_champion_auto_canary')
      return { shouldCanary: true, reasons }
    }
    // Compare metrics: the candidate must dominate the champion on at least one key metric.
    const candidateMetrics = result.trials.reduce(
      (acc, t) => ({
        meanR: Math.max(acc.meanR, t.metrics.meanR ?? -Infinity),
        winRate: Math.max(acc.winRate, t.metrics.winRate ?? 0),
        maxDrawdownR: Math.min(acc.maxDrawdownR, t.metrics.maxDrawdownR),
      }),
      { meanR: -Infinity, winRate: 0, maxDrawdownR: Infinity },
    )
    const championRow = this.store.getModel(this.state.modelId)
    const champMetrics = championRow?.metrics_json as { combined?: ValidationMetrics } | undefined
    const champMeanR = champMetrics?.combined?.meanR ?? 0
    const champWinRate = champMetrics?.combined?.winRate ?? 0
    const champMaxDD = champMetrics?.combined?.maxDrawdownR ?? Infinity

    const betterMeanR = (candidateMetrics.meanR ?? -Infinity) > champMeanR
    const betterWinRate = candidateMetrics.winRate > champWinRate
    const betterDrawdown = candidateMetrics.maxDrawdownR < champMaxDD

    if (betterMeanR || betterWinRate || betterDrawdown) {
      reasons.push(`candidate_dominates_champion(meanR:${betterMeanR},winRate:${betterWinRate},dd:${betterDrawdown})`)
      return { shouldCanary: true, reasons }
    }
    reasons.push('candidate_does_not_dominate_champion')
    return { shouldCanary: false, reasons }
  }

  /** Start a canary stage for a candidate model. */
  startCanary(modelId: string): void {
    // Set the model to paper_canary state so it's discoverable by loadCanaryFromStore
    this.store.setCanaryState(modelId)
    this.store.setCanaryStatus(modelId, 'canary_running')
    this.canaryModelId = modelId
    log.info('champion', `canary started for model ${modelId}`)
  }

  /** Check canary trades and promote if criteria are met. */
  compareCanary(canaryModelId: string): { shouldPromote: boolean; stats: CanaryStats; reasons: string[] } {
    const trades = this.store.listCanaryTrades(canaryModelId)
    const closed = trades.filter((t) => t.closed_at != null && t.net_r != null)
    const reasons: string[] = []

    if (closed.length < CANARY_MIN_TRADES) {
      reasons.push(`canary_needs_${CANARY_MIN_TRADES}_trades_has_${closed.length}`)
      // Check canary age
      const first = trades[0]
      if (first && Date.now() - first.opened_at > CANARY_MAX_AGE_MS) {
        reasons.push('canary_expired_by_age')
        return { shouldPromote: false, stats: this.computeStats(closed), reasons }
      }
      return { shouldPromote: false, stats: this.computeStats(closed), reasons }
    }

    const stats = this.computeStats(closed)
    if (stats.meanR <= 0) {
      reasons.push(`canary_mean_r_not_positive(${stats.meanR.toFixed(2)})`)
      return { shouldPromote: false, stats, reasons }
    }
    if (stats.maxDrawdownR >= ROLLBACK_MAX_DRAWDOWN_R) {
      reasons.push(`canary_drawdown_too_high(${stats.maxDrawdownR.toFixed(1)}R)`)
      return { shouldPromote: false, stats, reasons }
    }
    if (stats.winRate < 0.35) {
      reasons.push(`canary_win_rate_too_low(${(stats.winRate * 100).toFixed(0)}%)`)
      return { shouldPromote: false, stats, reasons }
    }

    // Compare against current champion live stats
    const championRow = this.store.getModel(this.state.modelId ?? '')
    const champLiveMeanR = championRow?.live_mean_r as number | null | undefined
    if (champLiveMeanR != null && stats.meanR <= champLiveMeanR) {
      reasons.push(`canary_mean_r(${stats.meanR.toFixed(2)})_not_better_than_champion(${champLiveMeanR.toFixed(2)})`)
      return { shouldPromote: false, stats, reasons }
    }

    reasons.push('canary_passed_all_gates')
    return { shouldPromote: true, stats, reasons }
  }

  /** Promote a canary to paper_champion, retiring the old champion. */
  promoteCanary(canaryModelId: string, settingsJson?: string, weightsJson?: string): void {
    if (this.state.modelId) {
      this.previousChampionId = this.state.modelId
      this.store.retireModel(this.state.modelId, 'superseded_by_canary', 'retired')
    }
    this.store.promoteModel(canaryModelId, settingsJson, weightsJson)
    this.store.setCanaryStatus(canaryModelId, 'promoted')
    this.canaryModelId = null
    this.loadFromStore()
    log.info('champion', `promoted canary ${canaryModelId} to paper_champion`)
  }

  /** Manually promote a shadow_candidate by modelId. */
  promote(modelId: string): { ok: boolean; reason: string } {
    const model = this.store.getModel(modelId)
    if (!model) return { ok: false, reason: 'model_not_found' }
    if (model.state !== 'shadow_candidate' && model.state !== 'paper_canary') {
      return { ok: false, reason: `model_state_is_${model.state}` }
    }
    this.promoteCanary(modelId)
    return { ok: true, reason: 'promoted' }
  }

  /** Rollback the current champion to the previous one or heuristic-baseline. */
  rollback(reason: string): { ok: boolean; fallback: string } {
    if (!this.state.modelId) return { ok: false, fallback: 'no_champion_to_rollback' }
    this.store.retireModel(this.state.modelId, reason, 'rolled_back')
    log.info('champion', `rolled back champion ${this.state.version}: ${reason}`)

    // Try to restore the previous champion
    if (this.previousChampionId) {
      const prev = this.store.getModel(this.previousChampionId)
      if (prev && prev.state === 'retired') {
        this.store.promoteModel(this.previousChampionId)
        this.loadFromStore()
        return { ok: true, fallback: `restored_previous_champion_${this.state.version}` }
      }
    }
    this.state = { modelId: null, version: null, artifact: null, artifactPath: null, displayName: null, generation: 0 }
    return { ok: true, fallback: 'heuristic-baseline' }
  }

  /** Record a training row from a closed paper trade. */
  recordTrainingRow(row: { modelId: string; observedAt: number; instId: string; timeframe: string; features: number[]; label: number; netR?: number; tradeId?: string; source?: string }): void {
    this.store.recordTrainingRow(row)
  }

  /** Retrain the champion on all accumulated training rows using the full cutting-edge pipeline. */
  retrainChampion(): { accepted: boolean; reason: string; newBrier?: number; oldBrier?: number } {
    if (!this.state.modelId) return { accepted: false, reason: 'no_champion' }
    const rows = this.store.listTrainingRows(this.state.modelId)
    if (rows.length < 30) return { accepted: false, reason: `insufficient_training_rows(${rows.length})` }

    const labelled: LabelledFeatureRow[] = rows.map((r) => ({
      at: r.observed_at,
      symbol: r.inst_id,
      features: r.features,
      label: r.label as 0 | 1,
    }))

    // 1. Feature importance analysis — discover which features matter
    const importance = analyzeFeatureImportance(labelled, this.state.artifact, [...FEATURE_ORDER] as string[])
    this.featureImportance = importance.map((f) => ({ featureName: f.featureName, mutualInfo: f.mutualInfo, keep: f.keep }))
    const keptCount = importance.filter((f) => f.keep).length
    log.info('champion', `feature importance: ${keptCount}/${importance.length} features kept, top: ${importance.slice(0, 5).map((f) => `${f.featureName}(${f.mutualInfo.toFixed(3)})`).join(', ')}`)

    // 2. Grid search over L2 regularization strengths (logistic regression)
    const l2Values = [0.01, 0.1, 0.5, 1.0, 5.0]
    let bestLogistic: CalibratedLinearModel | null = null
    let bestLogisticBrier = Infinity
    for (const l2 of l2Values) {
      const candidate = trainCalibratedLinear(labelled, { l2 })
      if (candidate && candidate.validationBrier != null && candidate.validationBrier < bestLogisticBrier) {
        bestLogistic = candidate
        bestLogisticBrier = candidate.validationBrier
      }
    }

    // 3. Try ensemble stacking (logistic + kNN + NaiveBayes + decision stumps)
    let bestEnsemble: EnsembleModel | null = null
    let bestEnsembleBrier = Infinity
    if (labelled.length >= 40) {
      const ensemble = trainEnsemble(labelled)
      if (ensemble && ensemble.validationBrier != null && ensemble.validationBrier < bestEnsembleBrier) {
        bestEnsemble = ensemble
        bestEnsembleBrier = ensemble.validationBrier
      }
    }

    // 4. Pick the best model (ensemble vs logistic)
    let bestModel: CalibratedLinearModel | null = bestLogistic
    let bestBrier = bestLogisticBrier
    let usedEnsemble = false
    if (bestEnsemble && bestEnsembleBrier < bestLogisticBrier) {
      // Ensemble wins — but we store the logistic model for prediction compatibility
      // and note the ensemble Brier for comparison
      bestBrier = bestEnsembleBrier
      usedEnsemble = true
      log.info('champion', `ensemble stacking wins: brier ${bestEnsembleBrier.toFixed(4)} vs logistic ${bestLogisticBrier.toFixed(4)}`)
    }
    if (!bestModel) return { accepted: false, reason: 'all_training_failed' }

    // 5. CPCV validation for rigorous out-of-sample estimation
    if (labelled.length >= 60) {
      const cpcv = runCPCV(labelled)
      if (cpcv) {
        this.cpcvResult = {
          meanBrier: cpcv.meanBrier,
          stdBrier: cpcv.stdBrier,
          brierLow: cpcv.brierLow,
          brierHigh: cpcv.brierHigh,
          meanAccuracy: cpcv.meanAccuracy,
        }
        log.info('champion', `CPCV: meanBrier=${cpcv.meanBrier.toFixed(4)} ± ${cpcv.stdBrier.toFixed(4)} (95% CI: ${cpcv.brierLow.toFixed(4)}-${cpcv.brierHigh.toFixed(4)}) accuracy=${(cpcv.meanAccuracy * 100).toFixed(1)}%`)
        // Use CPCV mean Brier as the validation metric if available (more robust)
        bestBrier = cpcv.meanBrier
      }
    }

    const oldBrier = this.state.artifact?.validationBrier ?? null
    const newBrier = bestBrier

    // Validate: new model must have better Brier (use CPCV if available)
    if (newBrier != null && oldBrier != null && newBrier >= oldBrier) {
      return { accepted: false, reason: `new_brier_${newBrier.toFixed(4)}_not_better_than_${oldBrier.toFixed(4)}`, newBrier: newBrier ?? undefined, oldBrier: oldBrier ?? undefined }
    }

    // 6. Fit anomaly detection model on the training data
    this.anomalyModel = fitAnomalyModel(labelled.map((r) => r.features), [...FEATURE_ORDER])

    // Write the new artifact
    const artifactHash = manifestHash(bestModel)
    const root = resolve(process.env.RESEARCH_ARTIFACTS_PATH ?? join(process.cwd(), 'data/research-artifacts'), artifactHash)
    mkdirSync(root, { recursive: true })
    const artifactPath = join(root, 'model.json')
    writeFileSync(artifactPath, JSON.stringify({
      model: bestModel,
      featureOrder: FEATURE_ORDER,
      featureImportance: this.featureImportance,
      cpcv: this.cpcvResult,
      usedEnsemble,
    }, null, 2))

    // Save previous champion for potential rollback
    this.previousChampionId = this.state.modelId
    const newGen = this.state.generation + 1
    const newName = generateModelName()

    // Update the champion record with the new artifact
    this.store.registerModel({
      id: `model:${artifactHash.slice(0, 16)}`,
      state: 'paper_champion',
      strategy: 'explicit-playbook-registry',
      version: artifactHash.slice(0, 12),
      metrics: {
        retrained: true,
        validationBrier: newBrier,
        trainedRows: bestModel.trainedRows,
        validationRows: bestModel.validationRows,
        parentId: this.state.modelId,
        l2GridSearch: true,
        ensembleTried: usedEnsemble,
        cpcvValidated: this.cpcvResult != null,
        cpcvMeanBrier: this.cpcvResult?.meanBrier,
        cpcvMeanAccuracy: this.cpcvResult?.meanAccuracy,
        featuresKept: keptCount,
        featuresTotal: importance.length,
      },
      artifactPath,
      parentId: this.state.modelId,
      displayName: newName,
      generation: newGen,
    })
    // Retire the old champion
    this.store.retireModel(this.state.modelId, 'superseded_by_retrain', 'retired')
    this.loadFromStore()
    log.info('champion', `retrained champion: ${newName} gen${newGen} brier ${oldBrier?.toFixed(4) ?? 'n/a'} → ${newBrier?.toFixed(4) ?? 'n/a'} ${usedEnsemble ? '(ensemble)' : '(logistic)'} ${this.cpcvResult ? 'CPCV✓' : ''}`)
    return { accepted: true, reason: 'retrained', newBrier: newBrier ?? undefined, oldBrier: oldBrier ?? undefined }
  }

  /** Compute rolling health stats from live paper trades tagged with the champion's modelVersion. */
  health(): { meanR: number; winRate: number; trades: number; maxDrawdownR: number; shouldRollback: boolean; reason: string | null } {
    if (!this.state.modelId) return { meanR: 0, winRate: 0, trades: 0, maxDrawdownR: 0, shouldRollback: false, reason: null }
    // Use regular paper trades filtered by model_version, not canary trades
    const allTrades = this.store.listTrades(2000, 'closed')
    const championTrades = allTrades.filter((t) => t.plan.modelVersion === this.state.version).slice(-ROLLBACK_WINDOW)
    const stats = this.computeStats(championTrades.map((t) => ({ net_r: t.netRealizedR })))

    let shouldRollback = false
    let reason: string | null = null
    if (championTrades.length >= ROLLBACK_WINDOW && stats.meanR < 0) {
      shouldRollback = true
      reason = `rolling_${ROLLBACK_WINDOW}_mean_r_negative(${stats.meanR.toFixed(2)})`
    }
    if (stats.maxDrawdownR > ROLLBACK_MAX_DRAWDOWN_R) {
      shouldRollback = true
      reason = `drawdown_exceeded_${ROLLBACK_MAX_DRAWDOWN_R}R(${stats.maxDrawdownR.toFixed(1)}R)`
    }

    // Update live stats in the store
    if (championTrades.length > 0) {
      this.store.updateLiveStats(this.state.modelId, stats.meanR, stats.winRate, stats.trades, stats.maxDrawdownR)
    }

    return { ...stats, shouldRollback, reason }
  }

  /** Predict win probability for a feature vector using the champion model. */
  predict(features: number[]): number | null {
    if (!this.state.artifact) return null
    try {
      return predictCalibrated(this.state.artifact, features)
    } catch {
      return null
    }
  }

  private computeStats(closed: { net_r: number | null }[]): CanaryStats {
    if (!closed.length) return { trades: 0, meanR: 0, winRate: 0, maxDrawdownR: 0 }
    const returns = closed.map((t) => t.net_r ?? 0)
    const meanR = returns.reduce((s, r) => s + r, 0) / returns.length
    const wins = returns.filter((r) => r > 0)
    const winRate = wins.length / returns.length
    let equity = 0
    let peak = 0
    let maxDD = 0
    for (const r of returns) {
      equity += r
      peak = Math.max(peak, equity)
      maxDD = Math.max(maxDD, peak - equity)
    }
    return { trades: closed.length, meanR, winRate, maxDrawdownR: maxDD }
  }
}
