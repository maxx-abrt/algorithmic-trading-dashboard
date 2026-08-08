/**
 * THE ORCHESTRATOR — the part that makes the system self-driving.
 *
 * Before, improvement was spread over half a dozen independent timers that each
 * did one thing and never looked at each other: a harvester that re-downloaded
 * candles, an evolution tick that optimised a proxy metric, a research loop that
 * kept re-running the same campaign and rejecting itself with
 * `campaign_already_running`. Nothing closed the loop.
 *
 * This is one scheduler that owns the whole improvement cycle and always knows
 * what the single most valuable next action is:
 *
 *     coverage gap?      -> build more tape for the starved niche
 *     fresh evidence?    -> breed a new generation and TEST it in the arena
 *     local edge found?  -> ask the brain for a deep model on the same niche
 *     model shipped?     -> train an RL exit agent on the same paths
 *     canary proven?     -> promote it, and demote whatever it beat
 *     champion decaying? -> re-verify on fresh tape and roll it back
 *     nothing urgent?    -> refresh news, run a post-mortem, re-verify the oldest
 *
 * Every decision is bounded (one task per tick, wall-clock budget, resource
 * governor) so a long training run can never starve the live decision loop, and
 * every task is written to `orchestrator_jobs` so the dashboard can show exactly
 * what the system is doing and why.
 */
import { loadavg, freemem } from 'node:os'
import { log } from '../log.js'
import type { DurableStore } from '../store/durable.js'
import type { TapeStore } from '../store/tape-store.js'
import { ArenaStore, DEFAULT_ARENA_CONFIG, runArena } from '../arena/arena.js'
import { EXIT_LIBRARY } from '../arena/exit-sim.js'
import { PopulationStore, type SpecialistV3Row } from '../store/population-store.js'
import { FEATURE_SCHEMA_V3 } from './features-v3.js'
import {
  artifactHashV3,
  breedSpecialist,
  generateModelName,
  loadArtifact,
  nicheKey,
  nicheLabel,
  parseNicheKey,
  predictWithArtifact,
  saveArtifact,
  skillProfile,
  type Niche,
  type SpecialistArtifactV3,
} from './breeder.js'
import type { BrainClient } from '../brain/client.js'
import type { Settings } from '../settings/schema.js'

export type TaskKind =
  | 'tape_build'
  | 'breed'
  | 'arena_reverify'
  | 'brain_tabular'
  | 'brain_rl'
  | 'lifecycle'
  | 'news'
  | 'postmortem'

export interface OrchestratorTask {
  kind: TaskKind
  target: string
  priority: number
  reason: string
  payload?: Record<string, unknown>
}

export interface OrchestratorDeps {
  store: DurableStore
  tape: TapeStore
  arena: ArenaStore
  population: PopulationStore
  brain: BrainClient
  settings: () => Settings
  /** build more tape; returns how many rows were added */
  buildTape: (request: { niche?: Niche; budgetMs: number }) => Promise<{ inserted: number; detail: string }>
  refreshNews: () => Promise<string>
  runPostMortem: () => Promise<string>
  notify?: (event: { type: string; detail: string; nicheKey?: string; displayName?: string; generation?: number }) => void
}

/** All niches the system is expected to cover, whether or not evidence exists yet. */
export const PLAYBOOKS = ['trend_pullback', 'volatility_breakout', 'range_fade'] as const
export const INST_TYPES = ['SWAP', 'SPOT'] as const
export const TIMEFRAMES = ['15m', '30m', '1H', '4H'] as const

export function allNiches(): Niche[] {
  const out: Niche[] = []
  for (const playbook of PLAYBOOKS) for (const instType of INST_TYPES) for (const timeframe of TIMEFRAMES) out.push({ playbook, instType, timeframe })
  return out
}

export interface OrchestratorState {
  running: boolean
  currentTask: OrchestratorTask | null
  lastTask: (OrchestratorTask & { status: string; detail: string; durationMs: number; at: number }) | null
  queue: OrchestratorTask[]
  cycles: number
  skipped: string | null
  resources: { rssMb: number; freeMb: number; load1: number }
  brainJobs: string[]
}

const MINUTE = 60_000

export class Orchestrator {
  state: OrchestratorState = {
    running: false,
    currentTask: null,
    lastTask: null,
    queue: [],
    cycles: 0,
    skipped: null,
    resources: { rssMb: 0, freeMb: 0, load1: 0 },
    brainJobs: [],
  }
  private lastRun = new Map<string, number>()
  private artifactCache = new Map<string, SpecialistArtifactV3>()
  private pendingBrainJobs = new Map<string, { kind: 'tabular' | 'rl'; niche: Niche; startedAt: number }>()

  constructor(private readonly deps: OrchestratorDeps) {
    this.lastRun = new Map(Object.entries(deps.store.getState<Record<string, number>>('orchestrator_last_run', {})))
  }

  private mark(key: string) {
    this.lastRun.set(key, Date.now())
    this.deps.store.setState('orchestrator_last_run', Object.fromEntries(this.lastRun))
  }

  private since(key: string) {
    return Date.now() - (this.lastRun.get(key) ?? 0)
  }

  loadArtifactFor(row: SpecialistV3Row): SpecialistArtifactV3 | null {
    const cached = this.artifactCache.get(row.artifact_hash)
    if (cached) return cached
    const artifact = loadArtifact(row.artifact_path)
    if (artifact) {
      if (this.artifactCache.size > 200) this.artifactCache.clear()
      this.artifactCache.set(row.artifact_hash, artifact)
    }
    return artifact
  }

  /* ------------------------------------------------------------------ plan */

  /**
   * Decide what matters most right now. Returns a priority-ordered queue; only the
   * head is executed per tick, but the whole queue is exposed so the dashboard can
   * show the system's intent, not just its history.
   */
  plan(): OrchestratorTask[] {
    const settings = this.deps.settings()
    const coverage = new Map(this.deps.tape.coverage().map((row) => [row.nicheKey, row]))
    const specialists = this.deps.population.list(400)
    const tasks: OrchestratorTask[] = []
    const minRows = Math.max(200, settings.evolution.minNicheSamples * 3)

    /* 1. coverage: a niche with no evidence can never produce a model ------ */
    const starved = allNiches()
      .map((niche) => ({ niche, rows: coverage.get(nicheKey(niche))?.rows ?? 0 }))
      .filter((entry) => entry.rows < minRows)
      .sort((a, b) => a.rows - b.rows)
    if (starved.length && this.since('tape_build') > 4 * MINUTE) {
      tasks.push({
        kind: 'tape_build',
        target: nicheKey(starved[0].niche),
        priority: 100 - starved[0].rows / 50,
        reason: `${starved.length} of ${allNiches().length} niches below ${minRows} recorded decisions`,
        payload: { niche: starved[0].niche },
      })
    } else if (this.since('tape_build') > 45 * MINUTE) {
      tasks.push({ kind: 'tape_build', target: 'top_up', priority: 42, reason: 'scheduled tape top-up keeps the evidence base current' })
    }

    /* 2. breeding: niches with enough NEW evidence and no proven champion -- */
    for (const [key, row] of coverage) {
      if (row.rows < minRows) continue
      const champion = this.deps.population.championFor(key)
      const lastBred = this.lastRun.get(`breed:${key}`) ?? 0
      const staleMs = champion ? settings.evolution.intervalMinutes * MINUTE * 4 : settings.evolution.intervalMinutes * MINUTE
      if (Date.now() - lastBred < staleMs) continue
      const noChampionPenalty = champion ? 0 : 22
      const evidenceBonus = Math.min(18, row.rows / 400)
      tasks.push({
        kind: 'breed',
        target: key,
        priority: 60 + noChampionPenalty + evidenceBonus,
        reason: champion
          ? `${row.rows} decisions available · challenging ${champion.display_name} (lift ${(champion.arena_mean_r_lift ?? 0).toFixed(3)}R)`
          : `${row.rows} decisions available · no champion yet in ${nicheLabel(parseNicheKey(key))}`,
        payload: { niche: parseNicheKey(key) },
      })
    }

    /* 3. brain: a deep model for the niches where a local edge already exists */
    if (this.deps.brain.available && this.pendingBrainJobs.size === 0) {
      const promising = this.deps.population
        .list(200)
        .filter((row) => row.backend === 'linear' && (row.arena_mean_r_lift ?? 0) > 0 && (row.arena_oos_trades ?? 0) >= 30)
        .sort((a, b) => (b.arena_mean_r_lift ?? 0) - (a.arena_mean_r_lift ?? 0))
      let queuedTabular = false
      for (const row of promising.slice(0, 4)) {
        if (this.since(`brain_tabular:${row.niche_key}`) < 90 * MINUTE) continue
        tasks.push({
          kind: 'brain_tabular',
          target: row.niche_key,
          priority: 70,
          reason: `local specialist proved +${(row.arena_mean_r_lift ?? 0).toFixed(3)}R lift — try trees and a neural net on the same evidence`,
          payload: { niche: parseNicheKey(row.niche_key) },
        })
        queuedTabular = true
        break
      }
      // Deep models are trained on EVERY sufficiently covered niche on a rotation,
      // not only where a linear model already found something: trees and nets can
      // find structure a linear gate cannot see, and that is the whole point of
      // having them.
      if (!queuedTabular) {
        const rotation = [...coverage.values()]
          .filter((row) => row.rows >= minRows)
          .sort((a, b) => (this.lastRun.get(`brain_tabular:${a.nicheKey}`) ?? 0) - (this.lastRun.get(`brain_tabular:${b.nicheKey}`) ?? 0))
        for (const row of rotation.slice(0, 1)) {
          if (this.since(`brain_tabular:${row.nicheKey}`) < 60 * MINUTE) continue
          tasks.push({
            kind: 'brain_tabular',
            target: row.nicheKey,
            priority: 58,
            reason: `${row.rows} recorded decisions — rotate a LightGBM + MLP + ensemble campaign through this niche`,
            payload: { niche: parseNicheKey(row.nicheKey) },
          })
        }
      }
      const rlTarget = [...coverage.values()]
        .filter((row) => row.rows >= minRows)
        .sort((a, b) => (this.lastRun.get(`brain_rl:${a.nicheKey}`) ?? 0) - (this.lastRun.get(`brain_rl:${b.nicheKey}`) ?? 0))[0]
      if (rlTarget && this.since(`brain_rl:${rlTarget.nicheKey}`) > 90 * MINUTE) {
        tasks.push({
          kind: 'brain_rl',
          target: rlTarget.nicheKey,
          priority: 55,
          reason: `${rlTarget.rows} recorded price paths — train the PPO exit agent on trade management`,
          payload: { niche: parseNicheKey(rlTarget.nicheKey) },
        })
      }
    }

    /* 4. re-verification: evidence decays, so champions must re-earn it ---- */
    const stale = specialists
      .filter((row) => row.lifecycle === 'champion' || row.lifecycle === 'canary')
      .filter((row) => Date.now() - (row.arena_at ?? 0) > 6 * 60 * MINUTE)
      .sort((a, b) => (a.arena_at ?? 0) - (b.arena_at ?? 0))
    if (stale.length) {
      tasks.push({
        kind: 'arena_reverify',
        target: stale[0].artifact_hash,
        priority: 64,
        reason: `${stale[0].display_name} last verified ${Math.round((Date.now() - (stale[0].arena_at ?? 0)) / MINUTE / 60)}h ago`,
        payload: { artifactHash: stale[0].artifact_hash },
      })
    }

    /* 5. lifecycle pass ---------------------------------------------------- */
    if (this.since('lifecycle') > 10 * MINUTE) {
      tasks.push({ kind: 'lifecycle', target: 'population', priority: 50, reason: 'promote, demote and attribute forward evidence' })
    }

    /* 6. news + post-mortem ------------------------------------------------ */
    if (settings.ai.enabled && this.since('news') > 45 * MINUTE) {
      tasks.push({ kind: 'news', target: 'headlines', priority: 46, reason: 'refresh the macro/news risk signal' })
    }
    if (settings.ai.enabled && this.since('postmortem') > 20 * 60 * MINUTE) {
      tasks.push({ kind: 'postmortem', target: 'daily', priority: 30, reason: 'daily what-worked / what-failed report' })
    }

    return tasks.sort((a, b) => b.priority - a.priority).slice(0, 12)
  }

  /* ----------------------------------------------------------------- tick */

  private resources() {
    const rssMb = process.memoryUsage().rss / 1024 / 1024
    const freeMb = freemem() / 1024 / 1024
    const load1 = loadavg()[0]
    this.state.resources = { rssMb: Math.round(rssMb), freeMb: Math.round(freeMb), load1: Number(load1.toFixed(2)) }
    return this.state.resources
  }

  private headroom(kind: TaskKind): { ok: boolean; reason: string } {
    const { rssMb, freeMb, load1 } = this.resources()
    const maxRss = Number(process.env.RESEARCH_MAX_RSS_MB || 1400)
    const maxLoad = Number(process.env.RESEARCH_MAX_LOAD || 6)
    const heavy = kind === 'breed' || kind === 'arena_reverify' || kind === 'tape_build'
    if (heavy && rssMb > maxRss) return { ok: false, reason: `engine_rss_${Math.round(rssMb)}mb_above_${maxRss}` }
    if (heavy && freeMb < 350) return { ok: false, reason: `host_free_${Math.round(freeMb)}mb` }
    if (heavy && load1 > maxLoad) return { ok: false, reason: `load_${load1.toFixed(2)}_above_${maxLoad}` }
    return { ok: true, reason: 'ok' }
  }

  async tick(): Promise<void> {
    if (this.state.running) return
    const settings = this.deps.settings()
    if (!settings.engineEnabled || !settings.evolution.enabled) {
      this.state.skipped = 'evolution disabled in settings'
      return
    }
    await this.collectBrainJobs()

    const queue = this.plan()
    this.state.queue = queue
    if (!queue.length) {
      this.state.skipped = 'nothing due'
      return
    }
    const task = queue[0]
    const headroom = this.headroom(task.kind)
    if (!headroom.ok) {
      this.state.skipped = `waiting for resources: ${headroom.reason}`
      return
    }

    this.state.running = true
    this.state.currentTask = task
    this.state.skipped = null
    const started = Date.now()
    let status = 'done'
    let detail = ''
    try {
      detail = await this.execute(task)
    } catch (error) {
      status = 'failed'
      detail = error instanceof Error ? error.message : String(error)
      log.error('orchestrator', `${task.kind} ${task.target} failed: ${detail}`)
    } finally {
      const durationMs = Date.now() - started
      this.state.running = false
      this.state.currentTask = null
      this.state.cycles++
      this.state.lastTask = { ...task, status, detail, durationMs, at: Date.now() }
      this.deps.population.logJob({ kind: task.kind, target: task.target, status, detail, durationMs, payload: { reason: task.reason, priority: Number(task.priority.toFixed(1)) } })
    }
  }

  private async execute(task: OrchestratorTask): Promise<string> {
    switch (task.kind) {
      case 'tape_build':
        return this.doTapeBuild(task)
      case 'breed':
        return this.doBreed(task)
      case 'arena_reverify':
        return this.doReverify(task)
      case 'brain_tabular':
        return this.doBrainTabular(task)
      case 'brain_rl':
        return this.doBrainRl(task)
      case 'lifecycle':
        return this.lifecycle()
      case 'news': {
        this.mark('news')
        return this.deps.refreshNews()
      }
      case 'postmortem': {
        this.mark('postmortem')
        return this.deps.runPostMortem()
      }
      default:
        return 'unknown task'
    }
  }

  /* ------------------------------------------------------------- executors */

  private async doTapeBuild(task: OrchestratorTask): Promise<string> {
    this.mark('tape_build')
    const niche = task.payload?.niche as Niche | undefined
    const result = await this.deps.buildTape({ niche, budgetMs: 4 * MINUTE })
    return `${result.inserted} new decisions recorded · ${result.detail}`
  }

  private async doBreed(task: OrchestratorTask): Promise<string> {
    const niche = task.payload?.niche as Niche
    const key = nicheKey(niche)
    this.mark(`breed:${key}`)
    const settings = this.deps.settings()

    const rows = this.deps.tape.list({
      playbook: niche.playbook,
      instType: niche.instType,
      timeframe: niche.timeframe,
      featureSchema: FEATURE_SCHEMA_V3,
      limit: 24_000,
    })
    if (rows.length < 200) return `skipped: only ${rows.length} decisions on the tape`

    const symbols = [...new Set(rows.map((row) => row.symbol))]
    // Hold out the least-represented symbol entirely: a model that only works on the
    // instrument it was fitted to is worthless.
    const holdout = symbols.length >= 3 ? [symbols[symbols.length - 1]] : []

    const parentRow = this.deps.population.championFor(key)
    const parent = parentRow ? this.loadArtifactFor(parentRow) : null

    const result = await breedSpecialist(rows, niche, {
      populationSize: settings.evolution.populationSize,
      generations: settings.evolution.generations,
      seed: (Date.now() / 60_000) | 0,
      parent,
      holdoutSymbols: holdout,
      searchFolds: 3,
      finalFolds: 4,
      placebo: settings.evolution.placebo,
      budgetMs: 100_000,
      minLift: 0.015,
    })

    if (!result.best) {
      this.deps.population.event({
        type: 'rejected',
        nicheKey: key,
        detail: `no specialist born for ${nicheLabel(niche)}: ${result.rejectionReason}`,
        payload: { trials: result.trials.length, rows: result.rows, placeboFitness: result.placeboFitness, parentFitness: result.parentFitness },
      })
      return `rejected: ${result.rejectionReason} (${result.trials.length} policies tested on ${result.rows} decisions in ${(result.elapsedMs / 1000).toFixed(1)}s)`
    }

    const { artifact, report, fitness } = result.best
    const hash = artifactHashV3(artifact)
    if (this.deps.population.get(hash)) return 'identical policy already registered'

    const path = saveArtifact(hash, artifact)
    const runId = this.deps.arena.save(report, hash, 'breed')
    const skills = skillProfile(report)
    const displayName = `${generateModelName()}-G${artifact.generation}`
    // A newborn with proven arena evidence goes straight to canary so it starts
    // producing FORWARD evidence. Without arena evidence it would not exist at all.
    this.deps.population.upsert({
      artifact_hash: hash,
      niche_key: key,
      playbook: niche.playbook,
      inst_type: niche.instType,
      timeframe: niche.timeframe,
      feature_schema: FEATURE_SCHEMA_V3,
      backend: 'linear',
      brain_model_id: null,
      generation: artifact.generation,
      parent_hash: artifact.parentHash,
      display_name: displayName,
      lifecycle: 'canary',
      artifact_path: path,
      genome_json: JSON.stringify({ ...artifact.genome, featureMask: artifact.genome.featureMask.map((bit) => (bit ? 1 : 0)).join('') }),
      metrics_json: JSON.stringify({ fitness, threshold: artifact.threshold, featuresUsed: artifact.genome.featureMask.filter(Boolean).length, trials: result.trials.length, placeboFitness: result.placeboFitness, parentFitness: result.parentFitness }),
      arena_json: JSON.stringify({ folds: report.folds.map((fold) => ({ fold: fold.fold, sumR: fold.policy.sumR, trades: fold.policy.trades, coverage: fold.coverage })), byRegime: report.byRegime.map((row) => ({ key: row.key, meanR: row.metrics.meanR, trades: row.metrics.trades })) }),
      arena_run_id: runId,
      arena_verdict: report.verdict,
      arena_mean_r: report.policy.meanR,
      arena_mean_r_lift: report.meanRLift,
      arena_oos_trades: report.policy.trades,
      arena_folds_positive: report.foldsPositive,
      arena_folds_total: report.folds.length,
      arena_sharpe: report.policy.sharpe,
      arena_max_dd_r: report.policy.maxDrawdownR,
      arena_p_value: report.policy.pValue,
      arena_at: Date.now(),
      skills_json: JSON.stringify(skills),
      created_at: Date.now(),
      rejection_reason: null,
      trials: result.trials.length,
      placebo_score: result.placeboFitness,
    })

    const detail = `${displayName} born · ${nicheLabel(niche)} · +${report.meanRLift.toFixed(3)}R lift over baseline · ${report.policy.trades} out-of-sample trades · ${report.foldsPositive}/${report.folds.length} folds positive · sharpe ${report.policy.sharpe.toFixed(2)} · exit ${artifact.genome.exitVariantId} · ${artifact.genome.featureMask.filter(Boolean).length} features`
    this.deps.population.event({ type: 'born', nicheKey: key, artifactHash: hash, detail, payload: { fitness, runId, skills: skills.badges } })
    this.deps.notify?.({ type: 'born', detail, nicheKey: key, displayName, generation: artifact.generation })
    log.info('breeder', detail)
    return detail
  }

  private async doReverify(task: OrchestratorTask): Promise<string> {
    const hash = String(task.payload?.artifactHash ?? '')
    const row = this.deps.population.get(hash)
    if (!row) return 'specialist no longer exists'
    const artifact = this.loadArtifactFor(row)
    if (!artifact) return 'artifact missing on disk'
    const niche = parseNicheKey(row.niche_key)
    const rows = this.deps.tape.list({
      playbook: niche.playbook,
      instType: niche.instType,
      timeframe: niche.timeframe,
      featureSchema: FEATURE_SCHEMA_V3,
      limit: 24_000,
    })
    if (rows.length < 200) return `skipped: only ${rows.length} decisions on the tape`

    const symbols = [...new Set(rows.map((row) => row.symbol))]
    const holdout = symbols.length >= 3 ? [symbols[symbols.length - 1]] : []
    const variant = EXIT_LIBRARY.find((entry) => entry.id === artifact.genome.exitVariantId) ?? EXIT_LIBRARY[0]

    // The shipped model is FROZEN here: no refitting, no threshold search. This
    // measures the artifact that is actually making live decisions.
    const report = runArena(
      rows,
      () => ({
        scorer: (features) => {
          try {
            return predictWithArtifact(artifact, features)
          } catch {
            return null
          }
        },
        info: { frozen: true },
      }),
      {
        ...DEFAULT_ARENA_CONFIG,
        label: `reverify ${row.display_name}`,
        nicheKey: row.niche_key,
        folds: 4,
        variants: [variant],
        thresholdGrid: [artifact.genome.thresholdQuantile],
        holdoutSymbols: holdout,
        minCoverage: 0.05,
      },
    )
    const runId = this.deps.arena.save(report, hash, 'reverify')
    this.deps.population.upsert({
      ...row,
      arena_json: JSON.stringify({ folds: report.folds.map((fold) => ({ fold: fold.fold, sumR: fold.policy.sumR, trades: fold.policy.trades, coverage: fold.coverage })) }),
      arena_run_id: runId,
      arena_verdict: report.verdict,
      arena_mean_r: report.policy.meanR,
      arena_mean_r_lift: report.meanRLift,
      arena_oos_trades: report.policy.trades,
      arena_folds_positive: report.foldsPositive,
      arena_folds_total: report.folds.length,
      arena_sharpe: report.policy.sharpe,
      arena_max_dd_r: report.policy.maxDrawdownR,
      arena_p_value: report.policy.pValue,
      arena_at: Date.now(),
      skills_json: JSON.stringify(skillProfile(report)),
    })

    if (report.verdict !== 'edge' && row.lifecycle === 'champion' && report.policy.trades >= 40) {
      this.deps.population.setLifecycle(hash, 'retired', `reverify_${report.reasons.slice(0, 2).join('_')}`)
      const detail = `${row.display_name} retired: re-verification on fresh evidence gave ${report.policy.meanR.toFixed(3)}R (${report.reasons.join(', ')})`
      this.deps.population.event({ type: 'rolled_back', nicheKey: row.niche_key, artifactHash: hash, detail })
      this.deps.notify?.({ type: 'rolled_back', detail, nicheKey: row.niche_key, displayName: row.display_name })
      return detail
    }
    return `${row.display_name} re-verified: ${report.policy.meanR.toFixed(3)}R over ${report.policy.trades} trades · lift ${report.meanRLift.toFixed(3)}R · ${report.verdict}`
  }

  private async doBrainTabular(task: OrchestratorTask): Promise<string> {
    const niche = task.payload?.niche as Niche
    const key = nicheKey(niche)
    this.mark(`brain_tabular:${key}`)
    const rows = this.deps.tape.count({ playbook: niche.playbook, instType: niche.instType, timeframe: niche.timeframe, featureSchema: FEATURE_SCHEMA_V3 })
    if (rows < 200) return `skipped: only ${rows} decisions on the tape`
    const symbols = this.deps.tape.symbols({ playbook: niche.playbook, instType: niche.instType, timeframe: niche.timeframe })
    const holdout = symbols.length >= 3 ? [symbols[symbols.length - 1]] : []
    const started = await this.deps.brain.trainTabular(niche, { limit: 24_000, folds: 4, holdoutSymbols: holdout })
    if (!started?.jobId) return 'brain unavailable'
    this.pendingBrainJobs.set(started.jobId, { kind: 'tabular', niche, startedAt: Date.now() })
    this.state.brainJobs = [...this.pendingBrainJobs.keys()]
    return `brain job ${started.jobId} queued for ${nicheLabel(niche)} (${rows} decisions, holding out ${holdout.join(',') || 'nothing'})`
  }

  private async doBrainRl(task: OrchestratorTask): Promise<string> {
    const niche = task.payload?.niche as Niche
    const key = nicheKey(niche)
    this.mark(`brain_rl:${key}`)
    const started = await this.deps.brain.trainRl(niche, { limit: 9_000, epochs: 16 })
    if (!started?.jobId) return 'brain unavailable'
    this.pendingBrainJobs.set(started.jobId, { kind: 'rl', niche, startedAt: Date.now() })
    this.state.brainJobs = [...this.pendingBrainJobs.keys()]
    return `PPO exit-agent job ${started.jobId} queued for ${nicheLabel(niche)}`
  }

  /**
   * Poll finished brain jobs and register a usable deep model as a first-class
   * specialist so it competes with, and can beat, the local linear population.
   */
  private async collectBrainJobs(): Promise<void> {
    if (!this.pendingBrainJobs.size) return
    for (const [jobId, meta] of [...this.pendingBrainJobs.entries()]) {
      const job = await this.deps.brain.job(jobId)
      if (!job) {
        if (Date.now() - meta.startedAt > 30 * MINUTE) this.pendingBrainJobs.delete(jobId)
        continue
      }
      if (job.status === 'queued' || job.status === 'running') continue
      this.pendingBrainJobs.delete(jobId)
      this.state.brainJobs = [...this.pendingBrainJobs.keys()]
      const result = (job.result ?? {}) as Record<string, unknown>
      const key = nicheKey(meta.niche)

      if (job.status !== 'done') {
        this.deps.population.event({ type: 'brain_failed', nicheKey: key, detail: `${meta.kind} job ${jobId} ${job.status}: ${job.error ?? 'no result'}` })
        continue
      }

      if (meta.kind === 'tabular') {
        const usable = Boolean(result.usable)
        const modelId = String(result.modelId ?? '')
        const champion = String(result.champion ?? '?')
        const metrics = (result.results ?? {}) as Record<string, { auc?: number; meanRLift?: number; oosRows?: number; threshold?: number }>
        const best = metrics[champion] ?? {}
        const detail = `brain ${modelId} · ${champion} · auc ${best.auc?.toFixed(3) ?? '?'} · lift ${best.meanRLift?.toFixed(3) ?? '?'}R over ${best.oosRows ?? 0} rows · ${usable ? 'USABLE' : 'not usable'}`
        this.deps.population.event({ type: usable ? 'brain_model' : 'brain_rejected', nicheKey: key, detail, payload: { modelId, metrics } })
        if (usable && modelId) {
          this.registerBrainSpecialist(meta.niche, modelId, best.meanRLift ?? 0, best.oosRows ?? 0, best.threshold ?? 0.5, champion)
        }
        log.info('brain', detail)
      } else {
        const detail = `PPO exit agent ${String(result.modelId ?? '?')} · agent ${Number(result.agentMeanR ?? 0).toFixed(3)}R vs plan ${Number(result.baselineMeanR ?? 0).toFixed(3)}R vs random ${Number(result.randomMeanR ?? 0).toFixed(3)}R over ${result.testEpisodes ?? 0} held-out episodes`
        this.deps.population.event({ type: result.usable ? 'rl_agent' : 'rl_rejected', nicheKey: key, detail, payload: result })
        if (result.usable) this.deps.store.setState(`rl_agent:${key}`, { modelId: result.modelId, lift: result.meanRLift, at: Date.now() })
        log.info('brain', detail)
      }
    }
  }

  private registerBrainSpecialist(niche: Niche, modelId: string, lift: number, rows: number, threshold: number, champion: string) {
    const key = nicheKey(niche)
    const hash = `brain:${modelId}`
    const existing = this.deps.population.get(hash)
    const generation = (this.deps.population.championFor(key)?.generation ?? 0) + 1
    this.deps.population.upsert({
      artifact_hash: hash,
      niche_key: key,
      playbook: niche.playbook,
      inst_type: niche.instType,
      timeframe: niche.timeframe,
      feature_schema: FEATURE_SCHEMA_V3,
      backend: 'brain',
      brain_model_id: modelId,
      generation,
      parent_hash: null,
      display_name: existing?.display_name ?? `${generateModelName()}-B${generation}`,
      lifecycle: 'canary',
      artifact_path: null,
      genome_json: JSON.stringify({ backend: champion, threshold }),
      metrics_json: JSON.stringify({ champion, threshold, rows }),
      arena_json: null,
      arena_run_id: null,
      arena_verdict: lift > 0 ? 'edge' : 'no_edge',
      arena_mean_r: null,
      arena_mean_r_lift: lift,
      arena_oos_trades: rows,
      arena_folds_positive: null,
      arena_folds_total: null,
      arena_sharpe: null,
      arena_max_dd_r: null,
      arena_p_value: null,
      arena_at: Date.now(),
      skills_json: null,
      created_at: existing?.created_at ?? Date.now(),
      rejection_reason: null,
      trials: 0,
      placebo_score: null,
    })
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Promotion and demotion, on evidence only.
   *
   *   shadow  -> canary    : arena verdict `edge` (already granted at birth)
   *   canary  -> champion  : arena edge AND positive forward evidence from real
   *                          closed paper trades attributed to this artifact
   *   champion-> retired   : forward evidence turns negative, or the drawdown
   *                          budget is breached, or re-verification fails
   */
  lifecycle(): string {
    this.mark('lifecycle')
    const settings = this.deps.settings()
    const closed = this.deps.store.listTrades(4000, 'closed')
    const rows = this.deps.population.list(400)
    const actions: string[] = []

    for (const row of rows) {
      if (row.lifecycle === 'retired' || row.lifecycle === 'rejected') continue
      const shortHash = row.artifact_hash.slice(0, 12)
      const mine = closed.filter((trade) => trade.plan.modelVersion === shortHash && (trade.closedAt ?? 0) > row.created_at)
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
        this.deps.population.updateLive(row.artifact_hash, { trades: returns.length, meanR, winRate, maxDrawdownR, sumR: equity })
        row.live_trades = returns.length
        row.live_mean_r = meanR
        row.live_win_rate = winRate
        row.live_max_dd_r = maxDrawdownR
      }

      const arenaEdge = row.arena_verdict === 'edge' && (row.arena_mean_r_lift ?? 0) > 0

      if (row.lifecycle === 'canary' && arenaEdge && row.live_trades >= settings.evolution.canaryMinTrades) {
        if ((row.live_mean_r ?? 0) > 0 && (row.live_max_dd_r ?? 0) < settings.evolution.rollbackMaxDrawdownR) {
          const incumbent = this.deps.population.championFor(row.niche_key)
          if (incumbent && incumbent.artifact_hash !== row.artifact_hash && incumbent.lifecycle === 'champion') {
            if ((incumbent.live_mean_r ?? -Infinity) >= (row.live_mean_r ?? 0)) continue
            this.deps.population.setLifecycle(incumbent.artifact_hash, 'retired', 'superseded')
            this.deps.population.event({ type: 'retired', nicheKey: incumbent.niche_key, artifactHash: incumbent.artifact_hash, detail: `${incumbent.display_name} superseded by ${row.display_name}` })
          }
          this.deps.population.setLifecycle(row.artifact_hash, 'champion')
          const detail = `${row.display_name} promoted to champion of ${nicheLabel(parseNicheKey(row.niche_key))} · arena lift +${(row.arena_mean_r_lift ?? 0).toFixed(3)}R · forward ${row.live_trades} trades mean ${(row.live_mean_r ?? 0).toFixed(2)}R win ${((row.live_win_rate ?? 0) * 100).toFixed(0)}%`
          this.deps.population.event({ type: 'promoted', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.deps.notify?.({ type: 'promoted', detail, nicheKey: row.niche_key, displayName: row.display_name, generation: row.generation })
          actions.push(`promoted ${row.display_name}`)
          continue
        }
        if ((row.live_mean_r ?? 0) <= 0 && row.live_trades >= settings.evolution.canaryMinTrades * 2) {
          this.deps.population.setLifecycle(row.artifact_hash, 'retired', `canary_forward_mean_r_${(row.live_mean_r ?? 0).toFixed(2)}`)
          const detail = `${row.display_name} canary retired: forward evidence ${(row.live_mean_r ?? 0).toFixed(2)}R over ${row.live_trades} real trades contradicts its arena result`
          this.deps.population.event({ type: 'retired', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.deps.notify?.({ type: 'retired', detail, nicheKey: row.niche_key, displayName: row.display_name })
          actions.push(`retired ${row.display_name}`)
          continue
        }
      }

      if (row.lifecycle === 'champion' && row.live_trades >= settings.evolution.rollbackWindow) {
        const failing = (row.live_mean_r ?? 0) < 0 || (row.live_max_dd_r ?? 0) > settings.evolution.rollbackMaxDrawdownR
        if (failing) {
          this.deps.population.setLifecycle(row.artifact_hash, 'retired', `rollback_mean_r_${(row.live_mean_r ?? 0).toFixed(2)}_dd_${(row.live_max_dd_r ?? 0).toFixed(1)}R`)
          const detail = `${row.display_name} rolled back: ${(row.live_mean_r ?? 0).toFixed(2)}R mean and ${(row.live_max_dd_r ?? 0).toFixed(1)}R drawdown over ${row.live_trades} real trades`
          this.deps.population.event({ type: 'rolled_back', nicheKey: row.niche_key, artifactHash: row.artifact_hash, detail })
          this.deps.notify?.({ type: 'rolled_back', detail, nicheKey: row.niche_key, displayName: row.display_name })
          actions.push(`rolled back ${row.display_name}`)
        }
      }
    }

    const summary = this.deps.population.summary()
    return actions.length
      ? `${actions.join(', ')} · ${summary.champions} champions / ${summary.canaries} canaries`
      : `no change · ${summary.champions} champions, ${summary.canaries} canaries, ${summary.withArenaEdge} with proven arena edge`
  }

  /** Manual trigger used by the UI: breed one niche right now and report the result. */
  async breedNow(niche: Niche): Promise<string> {
    return this.doBreed({ kind: 'breed', target: nicheKey(niche), priority: 999, reason: 'manual request', payload: { niche } })
  }

  snapshot() {
    this.resources()
    return {
      state: this.state,
      lastRuns: Object.fromEntries([...this.lastRun.entries()].map(([key, at]) => [key, at])),
      jobs: this.deps.population.jobs(60),
      summary: this.deps.population.summary(),
      coverage: this.deps.tape.coverage(),
      niches: allNiches().map((niche) => nicheKey(niche)),
      pendingBrainJobs: [...this.pendingBrainJobs.entries()].map(([jobId, meta]) => ({ jobId, kind: meta.kind, nicheKey: nicheKey(meta.niche), startedAt: meta.startedAt })),
    }
  }
}

