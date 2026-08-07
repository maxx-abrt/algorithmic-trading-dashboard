/**
 * EvolutionService — the autonomous, generational, mixture-of-experts brain.
 *
 * Responsibilities
 *   • absorb every closed real outcome as an immutable point-in-time sample
 *   • decide WHEN a niche has enough new evidence to be worth re-evolving
 *   • run the bounded evolutionary search and only give birth to a specialist
 *     that beats both its parent and its own shuffled-label placebo
 *   • move specialists through shadow → canary → champion on FORWARD evidence
 *   • roll a champion back automatically when its live evidence deteriorates
 *   • route live decisions to the qualified experts (sparse MoE gating)
 *
 * What it explicitly refuses to do
 *   • change the active policy because of a single win or loss
 *   • promote anything on in-sample numbers
 *   • invent a model when the honest answer is "no validated edge here"
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from '../log.js'
import type { DurableStore } from '../store/durable.js'
import { EvolutionStore, type SpecialistRow } from '../store/evolution-store.js'
import { specialistPath } from '../store/paths.js'
import { generateModelName } from './naming.js'
import {
  artifactHash,
  committeeVerdict,
  evolveNiche,
  nicheKey,
  nicheLabel,
  parseNicheKey,
  type CommitteeMember,
  type CommitteeVerdict,
  type Niche,
  type SpecialistArtifact,
  type TrainingSample,
} from './population.js'
import type { Settings } from '../settings/schema.js'
import type { PaperTrade } from '../paper/types.js'
import { attributeTrade } from '../paper/attribution.js'
import { barMinutes } from '../quant/timeframes.js'

export interface EvolutionNotice {
  type: 'born' | 'promoted' | 'canary' | 'retired' | 'rolled_back' | 'rejected'
  nicheKey: string
  detail: string
  displayName?: string
  generation?: number
}

export interface RouteContext {
  playbook: string
  instType: string
  timeframe: string
}

const LIFECYCLE_ACTIVE: SpecialistRow['lifecycle'][] = ['champion', 'canary', 'shadow']

export class EvolutionService {
  readonly store: EvolutionStore
  private cache = new Map<string, SpecialistArtifact>()
  private lastEvolvedAt = new Map<string, number>()
  private lastSampleCount = new Map<string, number>()
  onNotice: ((notice: EvolutionNotice) => void) | null = null

  constructor(private readonly durable: DurableStore) {
    this.store = new EvolutionStore(durable.db)
    this.lastEvolvedAt = new Map(Object.entries(durable.getState<Record<string, number>>('evolution_last_run', {})))
    this.lastSampleCount = new Map(Object.entries(durable.getState<Record<string, number>>('evolution_last_count', {})))
  }

  /* ---- artifacts -------------------------------------------------------- */

  private saveArtifact(hash: string, artifact: SpecialistArtifact): string {
    const path = specialistPath(hash)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(artifact, null, 2))
    this.cache.set(hash, artifact)
    return path
  }

  loadArtifact(row: SpecialistRow): SpecialistArtifact | null {
    const cached = this.cache.get(row.artifact_hash)
    if (cached) return cached
    if (!row.artifact_path) return null
    try {
      const parsed = JSON.parse(readFileSync(row.artifact_path, 'utf8')) as SpecialistArtifact
      if (parsed?.kind !== 'specialist_v1') return null
      this.cache.set(row.artifact_hash, parsed)
      return parsed
    } catch {
      return null
    }
  }

  /* ---- ingestion -------------------------------------------------------- */

  /**
   * Absorb one closed trade. `features` MUST be the vector that was frozen at
   * decision time, never recomputed from the current market.
   */
  recordOutcome(trade: PaperTrade, features: number[] | undefined, meta: { instType: string; playbook: string; winProbability?: number | null }) {
    const attribution = attributeTrade(trade, { winProbability: meta.winProbability })
    this.store.recordAttribution({
      trade_id: trade.id,
      at: trade.closedAt ?? Date.now(),
      inst_id: trade.plan.instId,
      playbook: meta.playbook,
      reason_code: attribution.reasonCode,
      detail: attribution.detail,
      expected_r: trade.plan.targets.length ? trade.plan.targets.reduce((sum, target) => sum + target.allocation * Math.abs(target.price - trade.plan.entry) / Math.max(1e-9, Math.abs(trade.plan.entry - trade.plan.stopLoss)), 0) : null,
      realised_r: trade.netRealizedR,
      mfe_r: trade.mfeR,
      mae_r: trade.maeR,
    })

    // Only FILLED trades carry information about the prediction. An unfilled entry
    // says something about execution, not about direction, so it is attributed but
    // never used as a supervised label.
    if (!features?.length || trade.status !== 'closed' || trade.filledAt == null) return attribution
    this.store.recordSample({
      at: trade.plan.signalAt,
      symbol: trade.plan.instId,
      instType: meta.instType,
      timeframe: trade.plan.timeframe,
      playbook: meta.playbook,
      features,
      label: trade.netRealizedR > 0 ? 1 : 0,
      netR: trade.netRealizedR,
      horizonEndAt: trade.closedAt ?? trade.plan.signalAt,
      tradeId: trade.id,
      source: 'live_paper',
    })
    return attribution
  }

  /** Bulk ingestion used by historical backfill campaigns. */
  recordBackfillSample(sample: TrainingSample & { instType: string; timeframe: string; playbook: string; tradeId?: string }) {
    this.store.recordSample({ ...sample, source: 'backfill' })
  }

  /* ---- evolution -------------------------------------------------------- */

  /** Which niches have accumulated enough NEW evidence to justify CPU time. */
  eligibleNiches(settings: Settings): { niche: Niche; samples: number; newSamples: number }[] {
    const out: { niche: Niche; samples: number; newSamples: number }[] = []
    for (const row of this.store.nicheCounts()) {
      if (row.samples < settings.evolution.minNicheSamples) continue
      const seen = this.lastSampleCount.get(row.nicheKey) ?? 0
      const newSamples = row.samples - seen
      const intervalMs = settings.evolution.intervalMinutes * 60_000
      const dueByTime = Date.now() - (this.lastEvolvedAt.get(row.nicheKey) ?? 0) > intervalMs
      const overdueMs = intervalMs * 3
      const overdue = Date.now() - (this.lastEvolvedAt.get(row.nicheKey) ?? 0) > overdueMs
      if (newSamples < settings.evolution.minNewSamples && !(dueByTime && seen === 0) && !overdue) continue
      out.push({ niche: { playbook: row.playbook, instType: row.instType, timeframe: row.timeframe }, samples: row.samples, newSamples })
    }
    return out.sort((a, b) => b.newSamples - a.newSamples)
  }

  /** Evolve ONE niche. Returns the newborn specialist, or null with an honest reason. */
  evolveOne(niche: Niche, settings: Settings): { born: SpecialistRow | null; reason: string } {
    const key = nicheKey(niche)
    const samples = this.store.listSamples({ playbook: niche.playbook, instType: niche.instType, timeframe: niche.timeframe, limit: 8000 })
    const parentRow = this.store.championFor(key)
    const parent = parentRow ? this.loadArtifact(parentRow) : null

    const result = evolveNiche(samples, niche, {
      populationSize: settings.evolution.populationSize,
      generations: settings.evolution.generations,
      seed: (Date.now() / 60_000) | 0,
      parent,
      minBrierSkill: settings.evolution.minBrierSkill,
      placebo: settings.evolution.placebo,
    })

    this.lastEvolvedAt.set(key, Date.now())
    this.lastSampleCount.set(key, samples.length)
    this.durable.setState('evolution_last_run', Object.fromEntries(this.lastEvolvedAt))
    this.durable.setState('evolution_last_count', Object.fromEntries(this.lastSampleCount))

    if (!result.best) {
      const reason = result.rejectionReason ?? 'unknown'
      this.store.recordEvent({
        type: 'rejected',
        nicheKey: key,
        detail: `no specialist born for ${nicheLabel(niche)}: ${reason}`,
        payload: { trials: result.trials.length, placeboSkill: result.placeboSkill, samples: samples.length },
      })
      this.onNotice?.({ type: 'rejected', nicheKey: key, detail: reason })
      log.info('evolution', `${key}: rejected — ${reason} (${result.trials.length} trials, ${samples.length} samples)`)
      return { born: null, reason }
    }

    const hash = artifactHash(result.best)
    if (this.store.getSpecialist(hash)) return { born: this.store.getSpecialist(hash), reason: 'identical_artifact_already_registered' }

    const path = this.saveArtifact(hash, result.best)
    const displayName = `${generateModelName()}-G${result.best.generation}`
    // A newborn always starts in shadow: it must earn forward evidence before it
    // can influence anything. The exception is an empty niche, where a shadow model
    // is immediately made canary so the niche can start producing evidence at all.
    const emptyNiche = !parentRow
    this.store.upsertSpecialist({
      artifactHash: hash,
      artifact: result.best,
      displayName,
      lifecycle: emptyNiche ? 'canary' : 'shadow',
      artifactPath: path,
      trials: result.trials.length,
      placeboSkill: result.placeboSkill ?? null,
    })
    if (emptyNiche) this.store.setLifecycle(hash, 'canary')

    const metrics = result.best.metrics
    const detail = `${displayName} · gen ${result.best.generation} · ${nicheLabel(niche)} · brier ${metrics.brier.toFixed(4)} (skill ${(metrics.brierSkill * 100).toFixed(1)}%, placebo ${((result.placeboSkill ?? 0) * 100).toFixed(1)}%) · auc ${metrics.auc.toFixed(3)} · R-lift ${metrics.meanRLift?.toFixed(3) ?? 'n/a'} · ${metrics.featuresUsed}/${result.best.featureOrder.length} features · ${metrics.trainRows}/${metrics.holdoutRows} rows`
    this.store.recordEvent({ type: 'born', nicheKey: key, artifactHash: hash, detail, payload: { metrics, trials: result.trials.length } })
    this.onNotice?.({ type: 'born', nicheKey: key, detail, displayName, generation: result.best.generation })
    log.info('evolution', detail)
    return { born: this.store.getSpecialist(hash), reason: 'born' }
  }

  /* ---- lifecycle -------------------------------------------------------- */

  /**
   * Update every specialist's FORWARD statistics from real closed trades, then
   * promote or roll back. Forward evidence is never backfilled: a specialist is
   * only credited with trades that closed after it was registered.
   */
  lifecycle(settings: Settings) {
    const closed = this.durable.listTrades(3000, 'closed')
    const rows = this.store.listSpecialists(400)

    for (const row of rows) {
      if (!LIFECYCLE_ACTIVE.includes(row.lifecycle)) continue
      const mine = closed.filter((trade) => trade.plan.modelVersion === row.artifact_hash.slice(0, 12) && (trade.closedAt ?? 0) > row.created_at)
      if (mine.length) {
        const returns = mine.map((trade) => trade.netRealizedR)
        const meanR = returns.reduce((sum, value) => sum + value, 0) / returns.length
        const winRate = returns.filter((value) => value > 0).length / returns.length
        let equity = 0
        let peak = 0
        let maxDrawdownR = 0
        for (const value of returns) {
          equity += value
          peak = Math.max(peak, equity)
          maxDrawdownR = Math.max(maxDrawdownR, peak - equity)
        }
        this.store.updateLiveStats(row.artifact_hash, { trades: returns.length, meanR, winRate, maxDrawdownR, sumR: equity })
        row.live_trades = returns.length
        row.live_mean_r = meanR
        row.live_win_rate = winRate
        row.live_max_dd_r = maxDrawdownR
      }

      // Canary → champion, on forward evidence only.
      if (row.lifecycle === 'canary' && row.live_trades >= settings.evolution.canaryMinTrades) {
        const current = this.store.championFor(nicheNormalise(row.niche_key))
        const incumbent = current && current.artifact_hash !== row.artifact_hash && current.lifecycle === 'champion' ? current : null
        const beatsIncumbent = !incumbent || (row.live_mean_r ?? -Infinity) > (incumbent.live_mean_r ?? -Infinity)
        if ((row.live_mean_r ?? 0) > 0 && beatsIncumbent && (row.live_max_dd_r ?? 0) < settings.evolution.rollbackMaxDrawdownR) {
          if (incumbent) {
            this.store.setLifecycle(incumbent.artifact_hash, 'retired', 'superseded_by_canary')
            this.store.recordEvent({ type: 'retired', nicheKey: incumbent.niche_key, artifactHash: incumbent.artifact_hash, detail: `${incumbent.display_name} retired, superseded by ${row.display_name}` })
          }
          this.store.setLifecycle(row.artifact_hash, 'champion')
          const detail = `${row.display_name} promoted to champion of ${row.niche_key} on ${row.live_trades} real trades · mean ${(row.live_mean_r ?? 0).toFixed(2)}R · win ${((row.live_win_rate ?? 0) * 100).toFixed(0)}%`
          this.store.recordEvent({ type: 'promoted', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.onNotice?.({ type: 'promoted', nicheKey: row.niche_key, detail, displayName: row.display_name, generation: row.generation })
          log.info('evolution', detail)
          continue
        }
        if ((row.live_mean_r ?? 0) <= 0 && row.live_trades >= settings.evolution.canaryMinTrades * 2) {
          this.store.setLifecycle(row.artifact_hash, 'retired', `canary_mean_r_${(row.live_mean_r ?? 0).toFixed(2)}`)
          const detail = `${row.display_name} canary retired: mean ${(row.live_mean_r ?? 0).toFixed(2)}R over ${row.live_trades} real trades`
          this.store.recordEvent({ type: 'retired', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.onNotice?.({ type: 'retired', nicheKey: row.niche_key, detail, displayName: row.display_name })
          continue
        }
      }

      // Shadow → canary once a shadow has a better validation profile than the champion.
      if (row.lifecycle === 'shadow') {
        const champion = this.store.championFor(row.niche_key)
        const metrics = JSON.parse(row.metrics_json || '{}') as { brier?: number }
        const championMetrics = champion ? (JSON.parse(champion.metrics_json || '{}') as { brier?: number }) : null
        if (!champion || (metrics.brier != null && championMetrics?.brier != null && metrics.brier < championMetrics.brier)) {
          this.store.setLifecycle(row.artifact_hash, 'canary')
          const detail = `${row.display_name} entered canary for ${row.niche_key} (offline brier ${metrics.brier?.toFixed(4)} vs champion ${championMetrics?.brier?.toFixed(4) ?? 'none'})`
          this.store.recordEvent({ type: 'canary', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.onNotice?.({ type: 'canary', nicheKey: row.niche_key, detail, displayName: row.display_name, generation: row.generation })
        }
      }

      // Automatic rollback of a degrading champion.
      if (row.lifecycle === 'champion' && row.live_trades >= settings.evolution.rollbackWindow) {
        const failing = (row.live_mean_r ?? 0) < 0 || (row.live_max_dd_r ?? 0) > settings.evolution.rollbackMaxDrawdownR
        if (failing) {
          this.store.setLifecycle(row.artifact_hash, 'retired', `rollback_mean_r_${(row.live_mean_r ?? 0).toFixed(2)}_dd_${(row.live_max_dd_r ?? 0).toFixed(1)}R`)
          const detail = `${row.display_name} rolled back: mean ${(row.live_mean_r ?? 0).toFixed(2)}R, drawdown ${(row.live_max_dd_r ?? 0).toFixed(1)}R over ${row.live_trades} real trades. Niche falls back to deterministic playbook gating.`
          this.store.recordEvent({ type: 'rolled_back', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.onNotice?.({ type: 'rolled_back', nicheKey: row.niche_key, detail, displayName: row.display_name })
          log.error('evolution', detail)
        }
      }
    }
  }

  /* ---- mixture-of-experts routing --------------------------------------- */

  /**
   * Sparse gating: pick the experts qualified to speak about THIS context.
   *   exact niche                  → trust 1.00
   *   same playbook, other mkt     → trust 0.55  (the pattern transfers, the venue does not)
   *   same market + timeframe      → trust 0.30  (venue behaviour transfers, the setup does not)
   *   same playbook + mkt, adj TF  → trust 0.35  (e.g., 15m specialist on 30m signal)
   *   same playbook, adjacent TF   → trust 0.25  (pattern transfers across timeframes)
   *   same mkt, adjacent TF        → trust 0.15  (venue transfers across timeframes)
   *   same timeframe only          → trust 0.12  (weak signal, but better than nothing)
   * Adjacent = within 4x timeframe ratio (15m↔30m, 30m↔1H, 1H↔4H).
   */
  route(context: RouteContext): CommitteeMember[] {
    const members: CommitteeMember[] = []
    const rows = [...this.store.listByLifecycle('champion'), ...this.store.listByLifecycle('canary')]
    for (const row of rows) {
      const samePlaybook = row.playbook === context.playbook
      const sameInstType = row.inst_type === context.instType
      const sameTimeframe = row.timeframe === context.timeframe
      const tfMin = barMinutes(row.timeframe)
      const ctxTfMin = barMinutes(context.timeframe)
      const tfRatio = Math.max(tfMin, ctxTfMin) / Math.min(tfMin, ctxTfMin)
      const adjacentTf = !sameTimeframe && tfRatio <= 4

      const trust =
        samePlaybook && sameInstType && sameTimeframe ? 1.0
        : samePlaybook && sameTimeframe ? 0.55
        : sameInstType && sameTimeframe ? 0.30
        : samePlaybook && sameInstType && adjacentTf ? 0.35
        : samePlaybook && adjacentTf ? 0.25
        : sameInstType && adjacentTf ? 0.15
        : sameTimeframe ? 0.12
        : 0
      if (trust === 0) continue
      const artifact = this.loadArtifact(row)
      if (!artifact) continue
      members.push({
        id: row.artifact_hash,
        displayName: row.display_name,
        generation: row.generation,
        niche: parseNicheKey(row.niche_key),
        artifact,
        liveMeanR: row.live_mean_r,
        liveTrades: row.live_trades,
        trust,
      })
    }
    return members
  }

  /** The committee's verdict for a live candidate. `null` = no qualified expert. */
  verdict(context: RouteContext, features: readonly number[]): (CommitteeVerdict & { members: CommitteeMember[] }) | null {
    const members = this.route(context)
    if (!members.length) return null
    const verdict = committeeVerdict(members, features)
    return verdict ? { ...verdict, members } : null
  }

  /** The artifact hash that should be stamped onto a trade for forward attribution. */
  primaryModelVersion(context: RouteContext): string {
    const members = this.route(context)
    const exact = members.find((member) => member.trust === 1) ?? members[0]
    return exact ? exact.id.slice(0, 12) : 'deterministic-playbook'
  }

  /* ---- reporting -------------------------------------------------------- */

  snapshot() {
    const specialists = this.store.listSpecialists(200).map((row) => ({
      artifactHash: row.artifact_hash,
      shortHash: row.artifact_hash.slice(0, 12),
      nicheKey: row.niche_key,
      nicheLabel: nicheLabel(parseNicheKey(row.niche_key)),
      playbook: row.playbook,
      instType: row.inst_type,
      timeframe: row.timeframe,
      generation: row.generation,
      parentHash: row.parent_hash,
      displayName: row.display_name,
      lifecycle: row.lifecycle,
      createdAt: row.created_at,
      promotedAt: row.promoted_at,
      retiredAt: row.retired_at,
      liveTrades: row.live_trades,
      liveMeanR: row.live_mean_r,
      liveWinRate: row.live_win_rate,
      liveMaxDrawdownR: row.live_max_dd_r,
      liveSumR: row.live_sum_r,
      rejectionReason: row.rejection_reason,
      trials: row.trials,
      placeboSkill: row.placebo_skill,
      metrics: JSON.parse(row.metrics_json || '{}'),
    }))
    return {
      specialists,
      niches: this.store.nicheCounts(),
      events: this.store.listEvents(80),
      attribution: this.store.attributionSummary(),
      summary: this.store.summary(),
      validationState: specialists.some((row) => row.lifecycle === 'champion') ? 'VALIDATED' : 'NO_VALIDATED_MODEL',
    }
  }
}

function nicheNormalise(key: string) {
  return key
}
