/**
 * Engine HTTP API (node:http, zero framework).
 *
 * The dashboard always calls the relative `/api/*` prefix:
 *   • locally / on a VPS   → Next.js rewrites /api/* to this port
 *   • on the Emergent host → the ingress routes /api/* to backend/server.py,
 *                            a thin proxy in front of this very port
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { ENV } from './env.js'
import { log } from './log.js'
import { runtime } from './runtime.js'
import { convex } from './convex/client.js'
import { candleStore } from './store/candles.js'
import { buildChartPayload } from './api/chart.js'
import { normalizeBar, OKX_BARS } from './quant/timeframes.js'
import { ALERT_TYPES, ALERT_TYPE_LABELS } from './alerts/rules.js'
import { signalCard, statusCard } from './telegram/cards.js'
import { fetchDerivatives } from './okx/market.js'
import { diskUsage, listBackups } from './store/backup.js'
import { REASON_LABELS } from './paper/attribution.js'
import { runArena, DEFAULT_ARENA_CONFIG } from './arena/arena.js'
import { EXIT_LIBRARY } from './arena/exit-sim.js'
import { FEATURE_SCHEMA_V3, FEATURE_ORDER_V3, FEATURE_COUNT_V3 } from './research/features-v3.js'
import { predictWithArtifact, nicheKey as nicheKeyV3, nicheLabel as nicheLabelV3, parseNicheKey as parseNicheKeyV3 } from './research/breeder.js'
import { allNiches } from './research/orchestrator.js'

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown> | unknown

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const num = (v: string | null, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                     */
/* -------------------------------------------------------------------------- */

const routes: Record<string, Handler> = {
  'GET /api/health': () => ({ ...runtime.health(), now: Date.now() }),

  'GET /api/state': async () => ({
    settings: runtime.settings,
    health: runtime.health(),
    watchlist: runtime.watchlist,
    rules: runtime.rules,
    bars: OKX_BARS,
    alertTypes: ALERT_TYPES.map((t) => ({ type: t, label: ALERT_TYPE_LABELS[t] })),
    telemetry: (await convex.listTelemetry()) ?? [],
  }),

  'GET /api/universe': (_req, _res, url) =>
    runtime.searchUniverse(
      url.searchParams.get('q') ?? '',
      url.searchParams.get('instType') ?? undefined,
      num(url.searchParams.get('limit'), 60),
    ),

  'GET /api/chart': async (_req, _res, url) => {
    const instId = runtime.resolveInstId(url.searchParams.get('instId') ?? runtime.settings.instId)
    if (!instId) throw new Error('unknown instrument')
    const bar = normalizeBar(url.searchParams.get('bar') ?? runtime.settings.timeframe)
    const limit = num(url.searchParams.get('limit'), 320)
    const candles = await candleStore.ensure(instId, bar, 480)
    const analysis = runtime.analyses.get(runtime.key(instId, bar)) ?? null
    return buildChartPayload(instId, bar, candles, analysis, limit)
  },

  'GET /api/analysis': async (_req, _res, url) => {
    const instId = runtime.resolveInstId(url.searchParams.get('instId') ?? runtime.settings.instId)
    if (!instId) throw new Error('unknown instrument')
    const bar = normalizeBar(url.searchParams.get('bar') ?? runtime.settings.timeframe)
    const force = url.searchParams.get('force') === '1'
    const key = runtime.key(instId, bar)
    const cached = runtime.analyses.get(key)
    if (!force && cached && Date.now() - cached.generatedAt < 4000) return cached
    const fresh = await runtime.analyzeInstrument(instId, bar, { withAi: false, silent: !force })
    return fresh ?? cached ?? null
  },

  'POST /api/analysis/ai': async (req) => {
    const body = await readBody(req)
    const instId = runtime.resolveInstId(String(body.instId ?? runtime.settings.instId))
    if (!instId) throw new Error('unknown instrument')
    const bar = normalizeBar(String(body.bar ?? runtime.settings.timeframe))
    const key = runtime.key(instId, bar)
    const analysis = runtime.analyses.get(key) ?? (await runtime.analyzeInstrument(instId, bar, { withAi: false, silent: true }))
    if (!analysis) throw new Error('no analysis available')
    const usage = runtime.store.aiUsageThisMonth()
    if (usage.spend >= runtime.settings.aiMonthlyBudgetEur) throw new Error('monthly AI budget reached')
    if (!runtime.gemini.configured) throw new Error('GEMINI_API_KEY is not configured')
    const opinion = await runtime.gemini.decide(analysis, runtime.settings.ai)
    analysis.ai = opinion
    runtime.analyses.set(key, analysis)
    if (opinion) {
      runtime.store.recordAiUsage(opinion.model, opinion.tokensIn, opinion.tokensOut, (opinion.tokensIn * 0.3 + opinion.tokensOut * 2.5) / 1_000_000)
      log.ai('gemini', `manual review ${instId} ${bar} → ${opinion.decision} @ ${opinion.confidence}%`, { instId, timeframe: bar })
    }
    return { opinion, analysis }
  },

  'GET /api/scanner': () => ({
    at: runtime.scan.at,
    scanned: runtime.scan.scanned,
    running: runtime.scan.running,
    rows: runtime.scan.rows,
    config: runtime.settings.scanner,
  }),

  'POST /api/scanner/run': async () => {
    runtime.scan.at = 0
    return { queued: true, targets: runtime.scanTargets().length }
  },

  'GET /api/watchlist': () =>
    runtime.watchlist.map((w) => {
      const a = runtime.analyses.get(runtime.key(w.instId, w.timeframe || runtime.settings.timeframe))
      const t = runtime.tickers.get(w.instId)
      return {
        ...w,
        last: t?.last ?? null,
        changePct24h: t?.changePct24h ?? null,
        volUsd24h: t?.volUsd24h ?? null,
        decision: a?.decision ?? null,
        conviction: a?.conviction ?? null,
        regime: a?.regime ?? null,
        bias: a?.bias ?? null,
        composite: a?.compositeScore ?? null,
        mtfAlignment: a?.mtfAlignment ?? null,
        playbook: a?.playbook ?? null,
        analysedAt: a?.generatedAt ?? null,
        plan: a?.plan
          ? {
              entry: a.plan.entry,
              stopLoss: a.plan.stopLoss,
              takeProfits: a.plan.takeProfits.map((x) => x.price),
              expectedRr: a.plan.expectedRr,
              netExpectancyR: a.plan.netExpectancyR,
            }
          : null,
      }
    }),

  'POST /api/watchlist': async (req) => {
    const body = await readBody(req)
    const instId = runtime.resolveInstId(String(body.instId ?? ''))
    if (!instId) throw new Error('unknown instrument')
    const spec = runtime.universe.get(instId)
    await runtime.addWatch(instId, spec?.instType ?? 'SWAP', normalizeBar(String(body.timeframe ?? runtime.settings.timeframe)), body.note ? String(body.note) : undefined)
    runtime.syncSubscriptions()
    void runtime.analyzeInstrument(instId, String(body.timeframe ?? runtime.settings.timeframe), { withAi: false, silent: true })
    return { ok: true, instId }
  },

  'DELETE /api/watchlist': async (_req, _res, url) => {
    const instId = url.searchParams.get('instId')
    if (!instId) throw new Error('instId required')
    await runtime.removeWatch(instId)
    runtime.syncSubscriptions()
    return { ok: true }
  },

  'PATCH /api/watchlist': async (req) => {
    const body = await readBody(req)
    const instId = String(body.instId ?? '')
    if (!instId) throw new Error('instId required')
    const patch: Record<string, unknown> = {}
    for (const k of ['enabled', 'alertsEnabled', 'timeframe', 'note']) {
      if (body[k] !== undefined) patch[k] = body[k]
    }
    await runtime.patchWatch(instId, patch as never)
    return { ok: true }
  },

  'GET /api/settings': () => ({ ...runtime.settings, savedAt: runtime.settingsSavedAt }),

  'POST /api/settings': async (req, res) => {
    const body = await readBody(req)
    const result = runtime.updateSettings(body)
    if (!result.ok) {
      json(res, 422, { ok: false, errors: result.errors, settings: result.settings, savedAt: result.savedAt })
      return
    }
    if (body.instId || body.timeframe) {
      void runtime.analyzeInstrument(result.settings.instId, result.settings.timeframe, { withAi: false, silent: true })
    }
    return { ...result.settings, savedAt: result.savedAt, ok: true, errors: [] as string[] }
  },

  'GET /api/alerts': async (_req, _res, url) => ({
    rules: runtime.rules,
    events: runtime.store.listAlerts(num(url.searchParams.get('limit'), 60)),
    types: ALERT_TYPES.map((t) => ({ type: t, label: ALERT_TYPE_LABELS[t] })),
  }),

  'POST /api/alerts/rules': async (req) => {
    const body = await readBody(req)
    const rule = {
      id: body.id ? String(body.id) : undefined,
      name: String(body.name ?? 'Untitled rule'),
      scope: String(body.scope ?? '*'),
      type: String(body.type ?? 'signal'),
      timeframe: String(body.timeframe ?? 'any'),
      params: {
        threshold: body.threshold !== undefined && body.threshold !== null ? Number(body.threshold) : undefined,
        direction: body.direction ? String(body.direction) : undefined,
        value: body.value !== undefined && body.value !== null ? Number(body.value) : undefined,
        text: body.text ? String(body.text) : undefined,
      },
      cooldownMs: Number(body.cooldownMs ?? 30 * 60_000),
      telegram: body.telegram !== false,
      enabled: body.enabled !== false,
    }
    const id = await runtime.upsertAlertRule(rule as never)
    return { ok: Boolean(id), id }
  },

  'DELETE /api/alerts/rules': async (_req, _res, url) => {
    const id = url.searchParams.get('id')
    if (!id) throw new Error('id required')
    await runtime.deleteAlertRule(id)
    return { ok: true }
  },

  'POST /api/alerts/test': async (req) => {
    const body = await readBody(req)
    const instId = runtime.resolveInstId(String(body.instId ?? runtime.settings.instId))
    if (!instId) throw new Error('unknown instrument')
    const bar = normalizeBar(String(body.bar ?? runtime.settings.timeframe))
    const a =
      runtime.analyses.get(runtime.key(instId, bar)) ??
      (await runtime.analyzeInstrument(instId, bar, { withAi: false, silent: true }))
    if (!a) throw new Error('no analysis available yet')
    const chats = runtime.activeChats()
    if (!chats.length) throw new Error('no Telegram chat registered — send /start to the bot first')
    const delivered = await runtime.bot.broadcast(chats, signalCard(a))
    return { delivered, chats: chats.length }
  },

  'GET /api/journal': async (_req, _res, url) => ({
    trades: runtime.store.listTrades(num(url.searchParams.get('limit'), 120), url.searchParams.get('status') ?? 'all'),
    stats: runtime.store.paperStats(),
  }),

  'GET /api/candidates': (_req, _res, url) => ({
    rows: runtime.store.listCandidates(num(url.searchParams.get('limit'), 200), url.searchParams.get('instId') ?? undefined),
    live: [...runtime.latestCandidates.entries()].map(([key, candidates]) => ({ key, candidates })),
  }),

  'GET /api/paper': (_req, _res, url) => ({
    trades: runtime.store.listTrades(num(url.searchParams.get('limit'), 200), url.searchParams.get('status') ?? 'all'),
    stats: runtime.store.paperStats(),
    killSwitch: runtime.paperKillSwitch,
    lastRiskDecision: runtime.store.getState('last_risk_decision', null),
    policy: {
      maxOpenPositions: runtime.settings.maxOpenPositions,
      maxDailyLossPct: runtime.settings.maxDailyLossPct,
      maxOpenRiskPct: runtime.settings.maxOpenRiskPct,
      maxGrossExposurePct: runtime.settings.maxGrossExposurePct,
    },
  }),

  'POST /api/paper/kill': async (req) => {
    const body = await readBody(req)
    runtime.paperKillSwitch = body.enabled === undefined ? !runtime.paperKillSwitch : Boolean(body.enabled)
    runtime.store.setState('paper_kill_switch', runtime.paperKillSwitch)
    return { enabled: runtime.paperKillSwitch, note: 'Paper candidate arming only; no exchange orders exist' }
  },

  'GET /api/research': () => ({
    ...runtime.store.researchState(),
    governor: runtime.research.governor(),
    schedule: { enabled: runtime.settings.autoResearchEnabled, intervalHours: runtime.settings.researchIntervalHours },
  }),

  'POST /api/research/run': async (req) => {
    const body = await readBody(req)
    return await runtime.research.run({
      symbols: Array.isArray(body.symbols) ? body.symbols.map(String) : undefined,
      timeframe: ['5m', '15m', '1H'].includes(String(body.timeframe)) ? String(body.timeframe) as '5m' | '15m' | '1H' : undefined,
      maxEvaluations: body.maxEvaluations == null ? undefined : Number(body.maxEvaluations),
      hypothesis: body.hypothesis ? String(body.hypothesis) : undefined,
      autoPromote: body.autoPromote == null ? undefined : Boolean(body.autoPromote),
    })
  },

  'GET /api/evolution': () => {
    const snapshot = runtime.evolution.snapshot()
    return {
      ...snapshot,
      settings: runtime.settings.evolution,
      lineage: snapshot.specialists.map((row) => ({ hash: row.artifactHash, parent: row.parentHash, generation: row.generation, niche: row.nicheKey, name: row.displayName, lifecycle: row.lifecycle })),
    }
  },

  'GET /api/harvest': () => ({
    progress: runtime.harvester.progress,
    last: runtime.store.getState('harvest_last', null),
    niches: runtime.evolution.store.nicheCounts(),
    tape: { rows: runtime.tape.count(), coverage: runtime.tape.coverage(), targetNiches: allNiches().map((niche) => nicheKeyV3(niche)) },
  }),

  'POST /api/harvest/run': async (req) => {
    const body = await readBody(req)
    if (runtime.harvester.progress.running) return { queued: false, reason: 'already running', progress: runtime.harvester.progress }
    void runtime.harvester.run({
      symbols: Array.isArray(body.symbols) ? body.symbols.map(String) : undefined,
      timeframes: Array.isArray(body.timeframes) ? body.timeframes.map(String) : undefined,
      perType: body.perType == null ? undefined : Number(body.perType),
      barsPerSymbol: body.barsPerSymbol == null ? undefined : Number(body.barsPerSymbol),
      maxWallMs: body.maxWallMs == null ? undefined : Number(body.maxWallMs),
    })
    return { queued: true, progress: runtime.harvester.progress }
  },

  'POST /api/harvest/reset': () => {
    const wasRunning = runtime.harvester.progress.running
    runtime.harvester.progress = { ...runtime.harvester.progress, running: false, finishedAt: Date.now(), lastError: wasRunning ? 'manually reset' : '' }
    return { reset: true, wasRunning }
  },

  'POST /api/evolution/run': async (req) => {
    const body = await readBody(req)
    const eligible = runtime.evolution.eligibleNiches(runtime.settings)
    const explicit = body.playbook && body.instType && body.timeframe
      ? { playbook: String(body.playbook), instType: String(body.instType), timeframe: String(body.timeframe) }
      : null
    const target = explicit ?? eligible[0]?.niche
    if (!target) {
      const counts = runtime.evolution.store.nicheCounts()
      throw new Error(`no niche has ${runtime.settings.evolution.minNicheSamples}+ labelled outcomes yet (largest: ${counts[0] ? `${counts[0].nicheKey} = ${counts[0].samples}` : 'none'})`)
    }
    return runtime.evolution.evolveOne(target, runtime.settings)
  },

  'POST /api/evolution/lifecycle': async (req) => {
    const body = await readBody(req)
    const hash = String(body.artifactHash ?? '')
    const lifecycle = String(body.lifecycle ?? '')
    if (!hash || !['shadow', 'canary', 'champion', 'retired', 'rejected'].includes(lifecycle)) throw new Error('artifactHash and a valid lifecycle are required')
    const row = runtime.evolution.store.getSpecialist(hash)
    if (!row) throw new Error('specialist not found')
    runtime.evolution.store.setLifecycle(hash, lifecycle as 'champion', body.reason ? String(body.reason) : 'manual')
    runtime.evolution.store.recordEvent({ type: lifecycle === 'champion' ? 'promoted' : 'retired', nicheKey: row.niche_key, artifactHash: hash, detail: `manual transition to ${lifecycle}` })
    return { ok: true, artifactHash: hash, lifecycle }
  },

  /* ---- V3: advisor, arena, brain, tape, orchestrator -------------------- */

  'GET /api/advisor': (_req, _res, url) => {
    const limit = num(url.searchParams.get('limit'), 24)
    const actionableOnly = url.searchParams.get('actionable') === '1'
    const calls = actionableOnly ? runtime.advisor.filter((call) => call.action !== 'WAIT') : runtime.advisor
    return {
      generatedAt: runtime.advisorAt,
      news: runtime.news,
      regime: runtime.regime,
      population: runtime.population.summary(),
      execution: runtime.executionDiagnosis(),
      calls: calls.slice(0, limit),
      watchlist: runtime.watchlist.map((row) => row.instId),
      counters: runtime.counters,
    }
  },

  'GET /api/arena': (_req, _res, url) => ({
    runs: runtime.arenaStore.list(num(url.searchParams.get('limit'), 60), url.searchParams.get('nicheKey') ?? undefined),
    coverage: runtime.tape.coverage(),
    variants: EXIT_LIBRARY.map((variant) => ({ id: variant.id, label: variant.label })),
    tapeRows: runtime.tape.count(),
  }),

  'GET /api/arena/run': (_req, _res, url) => {
    const id = num(url.searchParams.get('id'), 0)
    const run = runtime.arenaStore.get(id)
    if (!run) throw new Error('arena run not found')
    return run
  },

  'POST /api/arena/run': async (req) => {
    const body = await readBody(req)
    const playbook = String(body.playbook ?? '')
    const instType = String(body.instType ?? '')
    const timeframe = String(body.timeframe ?? '')
    if (!playbook || !instType || !timeframe) throw new Error('playbook, instType and timeframe are required')
    const artifactHash = body.artifactHash ? String(body.artifactHash) : null
    const rows = runtime.tape.list({ playbook, instType, timeframe, featureSchema: FEATURE_SCHEMA_V3, limit: 30_000 })
    if (rows.length < 200) throw new Error(`only ${rows.length} recorded decisions for that niche — need at least 200`)
    const symbols = [...new Set(rows.map((row) => row.symbol))]
    const holdout = symbols.length >= 3 ? [symbols[symbols.length - 1]] : []
    const variantId = body.variantId ? String(body.variantId) : null

    if (artifactHash) {
      const specialist = runtime.population.get(artifactHash)
      if (!specialist) throw new Error('specialist not found')
      const artifact = runtime.orchestrator.loadArtifactFor(specialist)
      if (!artifact) throw new Error('specialist artifact is not on disk')
      const variant = EXIT_LIBRARY.find((entry) => entry.id === (variantId ?? artifact.genome.exitVariantId)) ?? EXIT_LIBRARY[0]
      const report = runArena(
        rows,
        () => ({ scorer: (features) => predictWithArtifact(artifact, features), info: { frozen: true, artifactHash } }),
        { ...DEFAULT_ARENA_CONFIG, label: `manual ${specialist.display_name}`, nicheKey: `${playbook}|${instType}|${timeframe}`, folds: num(String(body.folds ?? ''), 4), variants: [variant], thresholdGrid: [artifact.genome.thresholdQuantile], holdoutSymbols: holdout },
      )
      const id = runtime.arenaStore.save(report, artifactHash, 'manual')
      return { id, report }
    }

    // Baseline campaign: no model, every exit variant compared head to head.
    const report = runArena(rows, () => ({ scorer: () => 1, info: { baseline: true } }), {
      ...DEFAULT_ARENA_CONFIG,
      label: 'manual baseline sweep',
      nicheKey: `${playbook}|${instType}|${timeframe}`,
      folds: num(String(body.folds ?? ''), 4),
      variants: variantId ? EXIT_LIBRARY.filter((entry) => entry.id === variantId) : EXIT_LIBRARY,
      holdoutSymbols: holdout,
    })
    const id = runtime.arenaStore.save(report, null, 'manual')
    return { id, report }
  },

  'GET /api/population': (_req, _res, url) => {
    const rows = runtime.population.list(num(url.searchParams.get('limit'), 300))
    return {
      summary: runtime.population.summary(),
      validationState: runtime.population.summary().champions > 0 ? 'VALIDATED' : runtime.population.summary().withArenaEdge > 0 ? 'ARENA_VALIDATED_PENDING_FORWARD' : 'NO_VALIDATED_MODEL',
      specialists: rows.map((row) => ({
        artifactHash: row.artifact_hash,
        shortHash: row.artifact_hash.slice(0, 12),
        nicheKey: row.niche_key,
        nicheLabel: nicheLabelV3(parseNicheKeyV3(row.niche_key)),
        playbook: row.playbook,
        instType: row.inst_type,
        timeframe: row.timeframe,
        backend: row.backend,
        brainModelId: row.brain_model_id,
        generation: row.generation,
        parentHash: row.parent_hash,
        displayName: row.display_name,
        lifecycle: row.lifecycle,
        createdAt: row.created_at,
        promotedAt: row.promoted_at,
        retiredAt: row.retired_at,
        arena: {
          verdict: row.arena_verdict,
          meanR: row.arena_mean_r,
          meanRLift: row.arena_mean_r_lift,
          oosTrades: row.arena_oos_trades,
          foldsPositive: row.arena_folds_positive,
          foldsTotal: row.arena_folds_total,
          sharpe: row.arena_sharpe,
          maxDrawdownR: row.arena_max_dd_r,
          pValue: row.arena_p_value,
          at: row.arena_at,
          runId: row.arena_run_id,
        },
        live: { trades: row.live_trades, meanR: row.live_mean_r, winRate: row.live_win_rate, maxDrawdownR: row.live_max_dd_r, sumR: row.live_sum_r },
        skills: row.skills_json ? JSON.parse(row.skills_json) : null,
        genome: JSON.parse(row.genome_json || '{}'),
        metrics: JSON.parse(row.metrics_json || '{}'),
        trials: row.trials,
        placeboScore: row.placebo_score,
        rejectionReason: row.rejection_reason,
      })),
      generations: runtime.population.generationStats(),
      events: runtime.population.events(80),
      coverage: runtime.tape.coverage(),
      targetNiches: allNiches().map((niche) => nicheKeyV3(niche)),
      settings: runtime.settings.evolution,
      legacy: { specialists: runtime.evolution.store.summary().specialists, note: 'v2 population kept for historical reference only; it is not used for live decisions' },
    }
  },

  'POST /api/population/lifecycle': async (req) => {
    const body = await readBody(req)
    const hash = String(body.artifactHash ?? '')
    const lifecycle = String(body.lifecycle ?? '')
    if (!hash || !['shadow', 'canary', 'champion', 'retired', 'rejected'].includes(lifecycle)) throw new Error('artifactHash and a valid lifecycle are required')
    const row = runtime.population.get(hash)
    if (!row) throw new Error('specialist not found')
    runtime.population.setLifecycle(hash, lifecycle as 'champion', body.reason ? String(body.reason) : 'manual override')
    runtime.population.event({ type: lifecycle === 'champion' ? 'promoted' : 'retired', nicheKey: row.niche_key, artifactHash: hash, detail: `manual transition to ${lifecycle}` })
    return { ok: true, artifactHash: hash, lifecycle }
  },

  'GET /api/orchestrator': () => ({ ...runtime.orchestrator.snapshot(), plan: runtime.orchestrator.plan(), settings: { enabled: runtime.settings.orchestratorEnabled, intervalSec: runtime.settings.orchestratorIntervalSec } }),

  'POST /api/orchestrator/run': async (req) => {
    const body = await readBody(req)
    const kind = String(body.kind ?? '')
    if (kind === 'tape_build') {
      const niche = body.playbook && body.instType && body.timeframe ? { playbook: String(body.playbook), instType: String(body.instType), timeframe: String(body.timeframe) } : undefined
      const result = await runtime.buildTapeTask({ niche, budgetMs: num(String(body.budgetMs ?? ''), 120_000) })
      runtime.population.logJob({ kind: 'tape_build', target: niche ? `${niche.playbook}|${niche.instType}|${niche.timeframe}` : 'manual', status: 'done', detail: result.detail })
      return result
    }
    if (kind === 'news') return { detail: await runtime.refreshNews() }
    if (kind === 'postmortem') return { detail: await runtime.runPostMortem() }
    if (kind === 'lifecycle') return { detail: runtime.orchestrator.lifecycle() }
    if (kind === 'tick') {
      await runtime.orchestrator.tick()
      return { detail: runtime.orchestrator.state.lastTask?.detail ?? 'nothing due', task: runtime.orchestrator.state.lastTask }
    }
    if (kind === 'breed') {
      const playbook = String(body.playbook ?? '')
      const instType = String(body.instType ?? '')
      const timeframe = String(body.timeframe ?? '')
      if (!playbook || !instType || !timeframe) throw new Error('playbook, instType and timeframe are required')
      const detail = await runtime.orchestrator.breedNow({ playbook, instType, timeframe })
      return { detail }
    }
    throw new Error('kind must be one of tick, tape_build, breed, lifecycle, news, postmortem')
  },

  'GET /api/tape': (_req, _res, url) => {
    const playbook = url.searchParams.get('playbook') ?? undefined
    const instType = url.searchParams.get('instType') ?? undefined
    const timeframe = url.searchParams.get('timeframe') ?? undefined
    const rows = runtime.tape.listLight({ playbook, instType, timeframe, featureSchema: FEATURE_SCHEMA_V3, limit: num(url.searchParams.get('limit'), 400), desc: true })
    return {
      total: runtime.tape.count(),
      coverage: runtime.tape.coverage(),
      targetNiches: allNiches().map((niche) => nicheKeyV3(niche)),
      featureSchema: FEATURE_SCHEMA_V3,
      featureCount: FEATURE_COUNT_V3,
      featureOrder: FEATURE_ORDER_V3,
      rows: rows.map((row) => ({ at: row.at, symbol: row.symbol, netR: row.netR, label: row.label, regimeId: row.regimeId })),
    }
  },

  'GET /api/brain': async (_req, _res, url) => {
    const [health, jobs, models] = await Promise.all([runtime.brain.health(true), runtime.brain.jobs(num(url.searchParams.get('limit'), 30)), runtime.brain.models(120)])
    return {
      health,
      jobs: jobs?.jobs ?? [],
      running: jobs?.running ?? 0,
      queued: jobs?.queued ?? 0,
      models: models?.models ?? [],
      url: runtime.brain.url,
      featureOrder: FEATURE_ORDER_V3,
      rlAgents: allNiches()
        .map((niche) => ({ nicheKey: nicheKeyV3(niche), agent: runtime.store.getState<{ modelId: string; lift: number; at: number } | null>(`rl_agent:${nicheKeyV3(niche)}`, null) }))
        .filter((row) => row.agent),
    }
  },

  'POST /api/brain/train': async (req) => {
    const body = await readBody(req)
    const niche = { playbook: String(body.playbook ?? ''), instType: String(body.instType ?? ''), timeframe: String(body.timeframe ?? '') }
    if (!niche.playbook || !niche.instType || !niche.timeframe) throw new Error('playbook, instType and timeframe are required')
    const kind = String(body.kind ?? 'tabular')
    const started = kind === 'rl' ? await runtime.brain.trainRl(niche, { epochs: num(String(body.epochs ?? ''), 16) }) : await runtime.brain.trainTabular(niche, { folds: num(String(body.folds ?? ''), 4) })
    if (!started) throw new Error('brain is not reachable')
    return started
  },

  'POST /api/brain/cancel': async (req) => {
    const body = await readBody(req)
    const jobId = String(body.jobId ?? '')
    if (!jobId) throw new Error('jobId is required')
    return (await runtime.brain.cancel(jobId)) ?? { error: 'brain unreachable' }
  },

  'GET /api/news': (_req, _res, url) => ({
    current: runtime.news,
    history: runtime.population.digests(num(url.searchParams.get('limit'), 30)),
    postMortem: runtime.postMortem,
    budget: { spentEur: runtime.store.aiUsageThisMonth().spend, budgetEur: runtime.settings.aiMonthlyBudgetEur },
    settings: { newsEnabled: runtime.settings.ai.newsEnabled, cheapModel: runtime.settings.ai.cheapModel, postMortemEnabled: runtime.settings.ai.postMortemEnabled, newsRiskVeto: runtime.settings.ai.newsRiskVeto },
  }),

  'GET /api/attribution': (_req, _res, url) => ({
    summary: runtime.evolution.store.attributionSummary(),
    rows: runtime.evolution.store.listAttribution(num(url.searchParams.get('limit'), 200)),
    labels: REASON_LABELS,
  }),

  'GET /api/execution': (_req, _res, url) => ({
    demo: runtime.demo.health(),
    parity: runtime.demo.parityReport(),
    orders: runtime.evolution.store.listOrders(num(url.searchParams.get('limit'), 120)),
    policy: runtime.settings.execution,
    diagnosis: runtime.executionDiagnosis(),
    simulator: runtime.simBroker.health(),
    simOrders: runtime.simBroker.recent(num(url.searchParams.get('limit'), 120)),
  }),

  'GET /api/research/edge': () => ({
    regime: runtime.regime,
    volForecast: runtime.volForecast,
    crossAsset: runtime.crossAsset,
    onChain: runtime.onChain,
    orderBook: runtime.orderBook.get(runtime.settings.instId) ?? null,
    anomaly: runtime.anomalyResult,
    explanation: runtime.explanation,
    kelly: runtime.kellyResult,
  }),

  'GET /api/operations': () => ({
    health: runtime.health(),
    qualityEvents: runtime.store.listQualityEvents(60),
    lastBackup: runtime.store.getState('last_backup', null),
    backups: listBackups().slice(0, 12).map((file) => ({ name: file.name, bytes: file.bytes, at: file.at })),
    disk: diskUsage(),
    database: { path: runtime.store.path, bytes: (() => { try { return statSync(runtime.store.path).size } catch { return 0 } })(), restoredFrom: runtime.store.restoredFrom },
    aiUsage: runtime.store.aiUsageThisMonth(),
    demo: runtime.demo.health(),
  }),

  'POST /api/operations/export': async (req) => {
    const body = await readBody(req)
    const destination = join(process.cwd(), 'backups', `candles-${new Date().toISOString().slice(0, 10)}.parquet`)
    return await runtime.store.exportCandlesToParquet(destination, body.instId ? String(body.instId) : undefined, body.timeframe ? String(body.timeframe) : undefined)
  },

  'POST /api/operations/backup': async () => {
    const destination = join(process.cwd(), 'backups', `mycroft-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
    return await runtime.store.backup(destination)
  },

  'GET /api/ai/models': async (_req, _res, url) => {
    if (!runtime.gemini.configured) return { models: [], error: 'GEMINI_API_KEY not configured' }
    const models = await runtime.gemini.listModels(url.searchParams.get('force') === '1')
    return { models, current: runtime.settings.ai.model, stats: runtime.gemini.stats() }
  },

  'GET /api/derivatives': async (_req, _res, url) => {
    const instId = runtime.resolveInstId(url.searchParams.get('instId') ?? runtime.settings.instId)
    if (!instId) throw new Error('unknown instrument')
    const spec = runtime.universe.get(instId)
    return await fetchDerivatives(instId, (spec?.instType as 'SWAP') ?? 'SWAP', runtime.tickers.get(instId)?.changePct24h ?? null)
  },

  'GET /api/logs': (_req, _res, url) =>
    log.recent(num(url.searchParams.get('limit'), 200), (url.searchParams.get('level') as never) ?? undefined),

  'POST /api/telegram/test': async () => {
    const chats = runtime.activeChats()
    if (!runtime.bot.configured) throw new Error('TELEGRAM_BOT_TOKEN not configured')
    if (!chats.length) throw new Error('no chat registered — send /start to the bot')
    const delivered = await runtime.bot.broadcast(chats, runtime.statusHtml())
    return { delivered, chats }
  },

  'GET /api/telegram/status': () => ({
    ...runtime.bot.stats(),
    chats: runtime.chats,
    muted: [...runtime.mutedChats],
    settings: runtime.settings.telegram,
  }),
}

/* -------------------------------------------------------------------------- */
/*  Server                                                                     */
/* -------------------------------------------------------------------------- */

export function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ENV.port}`)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
      })
      res.end()
      return
    }
    const key = `${req.method} ${url.pathname.replace(/\/$/, '') || '/api/health'}`
    const handler = routes[key]
    if (!handler) {
      json(res, 404, { error: `no route for ${key}`, routes: Object.keys(routes) })
      return
    }
    try {
      const body = await handler(req, res, url)
      if (!res.headersSent) json(res, 200, body ?? null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) json(res, 400, { error: message })
      log.error('api', `${key}: ${message}`)
    }
  })
  server.listen(ENV.port, '0.0.0.0', () => {
    log.info('api', `HTTP API listening on 0.0.0.0:${ENV.port}`)
  })
  return server
}

export { statusCard }
