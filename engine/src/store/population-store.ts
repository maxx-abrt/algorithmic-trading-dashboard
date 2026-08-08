/**
 * Population store V3 — specialists that are judged on results, not on proxies.
 *
 * The V2 table recorded a specialist's Brier score and then waited for live trades
 * that never came, so every model sat in `canary` forever and the system reported
 * NO_VALIDATED_MODEL for as long as it ran. V3 records, for every specialist:
 *
 *   • the genome (feature mask + regularisation + exit variant + threshold)
 *   • the ARENA evidence: purged walk-forward net R, lift over the take-everything
 *     baseline, how many folds were positive, held-out-symbol result, p value
 *   • the FORWARD evidence: real closed paper/simulated trades attributed to it
 *   • its lineage: parent hash and generation
 *
 * Promotion needs both kinds of evidence, and either one can demote it again.
 */
import type Database from 'better-sqlite3'

export const POPULATION_SCHEMA_VERSION = 1

export type Lifecycle = 'shadow' | 'canary' | 'champion' | 'retired' | 'rejected'

export interface SpecialistV3Row {
  artifact_hash: string
  niche_key: string
  playbook: string
  inst_type: string
  timeframe: string
  feature_schema: string
  backend: string
  brain_model_id: string | null
  generation: number
  parent_hash: string | null
  display_name: string
  lifecycle: Lifecycle
  artifact_path: string | null
  genome_json: string
  metrics_json: string
  arena_json: string | null
  arena_run_id: number | null
  arena_verdict: string | null
  arena_mean_r: number | null
  arena_mean_r_lift: number | null
  arena_oos_trades: number | null
  arena_folds_positive: number | null
  arena_folds_total: number | null
  arena_sharpe: number | null
  arena_max_dd_r: number | null
  arena_p_value: number | null
  arena_at: number | null
  skills_json: string | null
  created_at: number
  promoted_at: number | null
  retired_at: number | null
  live_trades: number
  live_mean_r: number | null
  live_win_rate: number | null
  live_max_dd_r: number | null
  live_sum_r: number | null
  rejection_reason: string | null
  trials: number
  placebo_score: number | null
}

export function migratePopulationSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS specialists_v3 (
      artifact_hash TEXT PRIMARY KEY,
      niche_key TEXT NOT NULL,
      playbook TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      feature_schema TEXT NOT NULL,
      backend TEXT NOT NULL DEFAULT 'linear',
      brain_model_id TEXT,
      generation INTEGER NOT NULL,
      parent_hash TEXT,
      display_name TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      artifact_path TEXT,
      genome_json TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      arena_json TEXT,
      arena_run_id INTEGER,
      arena_verdict TEXT,
      arena_mean_r REAL,
      arena_mean_r_lift REAL,
      arena_oos_trades INTEGER,
      arena_folds_positive INTEGER,
      arena_folds_total INTEGER,
      arena_sharpe REAL,
      arena_max_dd_r REAL,
      arena_p_value REAL,
      arena_at INTEGER,
      skills_json TEXT,
      created_at INTEGER NOT NULL,
      promoted_at INTEGER,
      retired_at INTEGER,
      live_trades INTEGER NOT NULL DEFAULT 0,
      live_mean_r REAL,
      live_win_rate REAL,
      live_max_dd_r REAL,
      live_sum_r REAL,
      rejection_reason TEXT,
      trials INTEGER NOT NULL DEFAULT 0,
      placebo_score REAL
    );
    CREATE INDEX IF NOT EXISTS specialists_v3_niche ON specialists_v3(niche_key, lifecycle, generation DESC);
    CREATE INDEX IF NOT EXISTS specialists_v3_life ON specialists_v3(lifecycle, arena_mean_r_lift DESC);

    CREATE TABLE IF NOT EXISTS population_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      niche_key TEXT,
      artifact_hash TEXT,
      detail TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS population_events_time ON population_events(at DESC);

    CREATE TABLE IF NOT EXISTS bandit_arms (
      key TEXT PRIMARY KEY,
      pulls INTEGER NOT NULL DEFAULT 0,
      wins REAL NOT NULL DEFAULT 0,
      losses REAL NOT NULL DEFAULT 0,
      sum_r REAL NOT NULL DEFAULT 0,
      last_pull_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orchestrator_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      target TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      duration_ms INTEGER,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS orchestrator_jobs_time ON orchestrator_jobs(at DESC);

    CREATE TABLE IF NOT EXISTS news_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,
      risk_score REAL NOT NULL,
      direction REAL NOT NULL,
      event_proximity REAL NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_eur REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS news_digests_time ON news_digests(at DESC);

    CREATE TABLE IF NOT EXISTS sim_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      trade_id TEXT NOT NULL,
      inst_id TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      side TEXT NOT NULL,
      intended_px REAL NOT NULL,
      filled_px REAL,
      requested_sz REAL NOT NULL,
      filled_sz REAL NOT NULL DEFAULT 0,
      spread_bps REAL,
      slippage_bps REAL,
      latency_ms REAL,
      state TEXT NOT NULL,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS sim_orders_time ON sim_orders(at DESC);
    CREATE INDEX IF NOT EXISTS sim_orders_trade ON sim_orders(trade_id);
  `)
}

export class PopulationStore {
  constructor(readonly db: Database.Database) {
    migratePopulationSchema(db)
  }

  upsert(row: Omit<SpecialistV3Row, 'promoted_at' | 'retired_at' | 'live_trades' | 'live_mean_r' | 'live_win_rate' | 'live_max_dd_r' | 'live_sum_r'>) {
    this.db
      .prepare(
        `INSERT INTO specialists_v3(artifact_hash,niche_key,playbook,inst_type,timeframe,feature_schema,backend,brain_model_id,
            generation,parent_hash,display_name,lifecycle,artifact_path,genome_json,metrics_json,arena_json,arena_run_id,
            arena_verdict,arena_mean_r,arena_mean_r_lift,arena_oos_trades,arena_folds_positive,arena_folds_total,arena_sharpe,
            arena_max_dd_r,arena_p_value,arena_at,skills_json,created_at,rejection_reason,trials,placebo_score)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(artifact_hash) DO UPDATE SET lifecycle=excluded.lifecycle, metrics_json=excluded.metrics_json,
           arena_json=excluded.arena_json, arena_run_id=excluded.arena_run_id, arena_verdict=excluded.arena_verdict,
           arena_mean_r=excluded.arena_mean_r, arena_mean_r_lift=excluded.arena_mean_r_lift, arena_oos_trades=excluded.arena_oos_trades,
           arena_folds_positive=excluded.arena_folds_positive, arena_folds_total=excluded.arena_folds_total,
           arena_sharpe=excluded.arena_sharpe, arena_max_dd_r=excluded.arena_max_dd_r, arena_p_value=excluded.arena_p_value,
           arena_at=excluded.arena_at, skills_json=excluded.skills_json, rejection_reason=excluded.rejection_reason,
           trials=excluded.trials, placebo_score=excluded.placebo_score, brain_model_id=excluded.brain_model_id`,
      )
      .run(
        row.artifact_hash,
        row.niche_key,
        row.playbook,
        row.inst_type,
        row.timeframe,
        row.feature_schema,
        row.backend,
        row.brain_model_id,
        row.generation,
        row.parent_hash,
        row.display_name,
        row.lifecycle,
        row.artifact_path,
        row.genome_json,
        row.metrics_json,
        row.arena_json,
        row.arena_run_id,
        row.arena_verdict,
        row.arena_mean_r,
        row.arena_mean_r_lift,
        row.arena_oos_trades,
        row.arena_folds_positive,
        row.arena_folds_total,
        row.arena_sharpe,
        row.arena_max_dd_r,
        row.arena_p_value,
        row.arena_at,
        row.skills_json,
        row.created_at,
        row.rejection_reason,
        row.trials,
        row.placebo_score,
      )
  }

  setLifecycle(artifactHash: string, lifecycle: Lifecycle, reason?: string) {
    const now = Date.now()
    if (lifecycle === 'champion' || lifecycle === 'canary') {
      this.db.prepare('UPDATE specialists_v3 SET lifecycle=?, promoted_at=?, rejection_reason=NULL WHERE artifact_hash=?').run(lifecycle, now, artifactHash)
    } else {
      this.db.prepare('UPDATE specialists_v3 SET lifecycle=?, retired_at=?, rejection_reason=? WHERE artifact_hash=?').run(lifecycle, now, reason ?? null, artifactHash)
    }
  }

  updateLive(artifactHash: string, stats: { trades: number; meanR: number; winRate: number; maxDrawdownR: number; sumR: number }) {
    this.db
      .prepare('UPDATE specialists_v3 SET live_trades=?, live_mean_r=?, live_win_rate=?, live_max_dd_r=?, live_sum_r=? WHERE artifact_hash=?')
      .run(stats.trades, stats.meanR, stats.winRate, stats.maxDrawdownR, stats.sumR, artifactHash)
  }

  updateSkills(artifactHash: string, skills: unknown) {
    this.db.prepare('UPDATE specialists_v3 SET skills_json=? WHERE artifact_hash=?').run(JSON.stringify(skills), artifactHash)
  }

  get(artifactHash: string): SpecialistV3Row | null {
    return (this.db.prepare('SELECT * FROM specialists_v3 WHERE artifact_hash=?').get(artifactHash) as SpecialistV3Row | undefined) ?? null
  }

  list(limit = 400): SpecialistV3Row[] {
    return this.db.prepare('SELECT * FROM specialists_v3 ORDER BY created_at DESC LIMIT ?').all(limit) as SpecialistV3Row[]
  }

  active(): SpecialistV3Row[] {
    return this.db.prepare("SELECT * FROM specialists_v3 WHERE lifecycle IN ('champion','canary') ORDER BY generation DESC").all() as SpecialistV3Row[]
  }

  byLifecycle(lifecycle: Lifecycle): SpecialistV3Row[] {
    return this.db.prepare('SELECT * FROM specialists_v3 WHERE lifecycle=? ORDER BY generation DESC, created_at DESC').all(lifecycle) as SpecialistV3Row[]
  }

  championFor(nicheKey: string): SpecialistV3Row | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM specialists_v3 WHERE niche_key=? AND lifecycle IN ('champion','canary') ORDER BY CASE lifecycle WHEN 'champion' THEN 0 ELSE 1 END, generation DESC LIMIT 1",
        )
        .get(nicheKey) as SpecialistV3Row | undefined) ?? null
    )
  }

  bestFor(nicheKey: string): SpecialistV3Row | null {
    return (
      (this.db.prepare('SELECT * FROM specialists_v3 WHERE niche_key=? ORDER BY arena_mean_r_lift DESC LIMIT 1').get(nicheKey) as SpecialistV3Row | undefined) ?? null
    )
  }

  lineage(nicheKey: string): SpecialistV3Row[] {
    return this.db.prepare('SELECT * FROM specialists_v3 WHERE niche_key=? ORDER BY generation ASC, created_at ASC').all(nicheKey) as SpecialistV3Row[]
  }

  generationStats(): { nicheKey: string; generation: number; born: number; bestLift: number; meanLift: number; bestSharpe: number }[] {
    return (
      this.db
        .prepare(
          `SELECT niche_key, generation, count(*) AS born, max(arena_mean_r_lift) AS best_lift,
                  avg(arena_mean_r_lift) AS mean_lift, max(arena_sharpe) AS best_sharpe
           FROM specialists_v3 GROUP BY niche_key, generation ORDER BY niche_key, generation`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      nicheKey: String(row.niche_key),
      generation: Number(row.generation),
      born: Number(row.born),
      bestLift: Number(row.best_lift ?? 0),
      meanLift: Number(row.mean_lift ?? 0),
      bestSharpe: Number(row.best_sharpe ?? 0),
    }))
  }

  event(event: { type: string; nicheKey?: string | null; artifactHash?: string | null; detail: string; payload?: unknown }) {
    this.db
      .prepare('INSERT INTO population_events(at,type,niche_key,artifact_hash,detail,payload_json) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), event.type, event.nicheKey ?? null, event.artifactHash ?? null, event.detail, event.payload ? JSON.stringify(event.payload) : null)
  }

  events(limit = 120) {
    return (this.db.prepare('SELECT * FROM population_events ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      type: String(row.type),
      nicheKey: row.niche_key == null ? null : String(row.niche_key),
      artifactHash: row.artifact_hash == null ? null : String(row.artifact_hash),
      detail: String(row.detail),
      payload: row.payload_json ? (JSON.parse(String(row.payload_json)) as unknown) : null,
    }))
  }

  summary() {
    const scalar = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      specialists: scalar('SELECT count(*) AS n FROM specialists_v3'),
      champions: scalar("SELECT count(*) AS n FROM specialists_v3 WHERE lifecycle='champion'"),
      canaries: scalar("SELECT count(*) AS n FROM specialists_v3 WHERE lifecycle='canary'"),
      shadows: scalar("SELECT count(*) AS n FROM specialists_v3 WHERE lifecycle='shadow'"),
      retired: scalar("SELECT count(*) AS n FROM specialists_v3 WHERE lifecycle='retired'"),
      topGeneration: scalar('SELECT COALESCE(max(generation),0) AS n FROM specialists_v3'),
      withArenaEdge: scalar("SELECT count(*) AS n FROM specialists_v3 WHERE arena_verdict='edge'"),
    }
  }

  /* ---- orchestrator job log --------------------------------------------- */

  logJob(job: { kind: string; target?: string | null; status: string; detail?: string; durationMs?: number; payload?: unknown }) {
    this.db
      .prepare('INSERT INTO orchestrator_jobs(at,kind,target,status,detail,duration_ms,payload_json) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), job.kind, job.target ?? null, job.status, job.detail ?? null, job.durationMs ?? null, job.payload ? JSON.stringify(job.payload) : null)
    this.db.prepare('DELETE FROM orchestrator_jobs WHERE id NOT IN (SELECT id FROM orchestrator_jobs ORDER BY at DESC LIMIT 600)').run()
  }

  jobs(limit = 60) {
    return (this.db.prepare('SELECT * FROM orchestrator_jobs ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      kind: String(row.kind),
      target: row.target == null ? null : String(row.target),
      status: String(row.status),
      detail: row.detail == null ? null : String(row.detail),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      payload: row.payload_json ? (JSON.parse(String(row.payload_json)) as unknown) : null,
    }))
  }

  /* ---- bandit ----------------------------------------------------------- */

  arm(key: string) {
    const row = this.db.prepare('SELECT * FROM bandit_arms WHERE key=?').get(key) as Record<string, unknown> | undefined
    return {
      key,
      pulls: Number(row?.pulls ?? 0),
      wins: Number(row?.wins ?? 0),
      losses: Number(row?.losses ?? 0),
      sumR: Number(row?.sum_r ?? 0),
      lastPullAt: Number(row?.last_pull_at ?? 0),
    }
  }

  arms() {
    return (this.db.prepare('SELECT * FROM bandit_arms ORDER BY pulls DESC').all() as Record<string, unknown>[]).map((row) => ({
      key: String(row.key),
      pulls: Number(row.pulls),
      wins: Number(row.wins),
      losses: Number(row.losses),
      sumR: Number(row.sum_r),
      lastPullAt: Number(row.last_pull_at),
    }))
  }

  pullArm(key: string) {
    this.db
      .prepare(
        `INSERT INTO bandit_arms(key,pulls,last_pull_at,updated_at) VALUES (?,1,?,?)
         ON CONFLICT(key) DO UPDATE SET pulls=bandit_arms.pulls+1, last_pull_at=excluded.last_pull_at, updated_at=excluded.updated_at`,
      )
      .run(key, Date.now(), Date.now())
  }

  rewardArm(key: string, netR: number) {
    const win = netR > 0 ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO bandit_arms(key,pulls,wins,losses,sum_r,updated_at) VALUES (?,0,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET wins=bandit_arms.wins+?, losses=bandit_arms.losses+?, sum_r=bandit_arms.sum_r+?, updated_at=?`,
      )
      .run(key, win, 1 - win, netR, Date.now(), win, 1 - win, netR, Date.now())
  }

  /* ---- news ------------------------------------------------------------- */

  saveDigest(row: {
    contentHash: string
    model: string
    riskScore: number
    direction: number
    eventProximity: number
    summary: string
    payload: unknown
    tokensIn: number
    tokensOut: number
    costEur: number
  }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO news_digests(at,content_hash,model,risk_score,direction,event_proximity,summary,payload_json,tokens_in,tokens_out,cost_eur)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(Date.now(), row.contentHash, row.model, row.riskScore, row.direction, row.eventProximity, row.summary, JSON.stringify(row.payload), row.tokensIn, row.tokensOut, row.costEur)
    this.db.prepare('DELETE FROM news_digests WHERE id NOT IN (SELECT id FROM news_digests ORDER BY at DESC LIMIT 400)').run()
  }

  digestByHash(contentHash: string) {
    const row = this.db.prepare('SELECT * FROM news_digests WHERE content_hash=?').get(contentHash) as Record<string, unknown> | undefined
    return row ? this.hydrateDigest(row) : null
  }

  latestDigest() {
    const row = this.db.prepare('SELECT * FROM news_digests ORDER BY at DESC LIMIT 1').get() as Record<string, unknown> | undefined
    return row ? this.hydrateDigest(row) : null
  }

  digests(limit = 40) {
    return (this.db.prepare('SELECT * FROM news_digests ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((row) => this.hydrateDigest(row))
  }

  private hydrateDigest(row: Record<string, unknown>) {
    return {
      id: Number(row.id),
      at: Number(row.at),
      contentHash: String(row.content_hash),
      model: String(row.model),
      riskScore: Number(row.risk_score),
      direction: Number(row.direction),
      eventProximity: Number(row.event_proximity),
      summary: String(row.summary),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      costEur: Number(row.cost_eur),
    }
  }

  /* ---- simulated execution --------------------------------------------- */

  recordSimOrder(order: {
    tradeId: string
    instId: string
    instType: string
    side: string
    intendedPx: number
    filledPx: number | null
    requestedSz: number
    filledSz: number
    spreadBps: number | null
    slippageBps: number | null
    latencyMs: number | null
    state: string
    reason?: string
  }) {
    this.db
      .prepare(
        `INSERT INTO sim_orders(at,trade_id,inst_id,inst_type,side,intended_px,filled_px,requested_sz,filled_sz,spread_bps,slippage_bps,latency_ms,state,reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        Date.now(),
        order.tradeId,
        order.instId,
        order.instType,
        order.side,
        order.intendedPx,
        order.filledPx,
        order.requestedSz,
        order.filledSz,
        order.spreadBps,
        order.slippageBps,
        order.latencyMs,
        order.state,
        order.reason ?? null,
      )
    this.db.prepare('DELETE FROM sim_orders WHERE id NOT IN (SELECT id FROM sim_orders ORDER BY at DESC LIMIT 4000)').run()
  }

  simOrders(limit = 120) {
    return (this.db.prepare('SELECT * FROM sim_orders ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      tradeId: String(row.trade_id),
      instId: String(row.inst_id),
      instType: String(row.inst_type),
      side: String(row.side),
      intendedPx: Number(row.intended_px),
      filledPx: row.filled_px == null ? null : Number(row.filled_px),
      requestedSz: Number(row.requested_sz),
      filledSz: Number(row.filled_sz),
      spreadBps: row.spread_bps == null ? null : Number(row.spread_bps),
      slippageBps: row.slippage_bps == null ? null : Number(row.slippage_bps),
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
      state: String(row.state),
      reason: row.reason == null ? null : String(row.reason),
    }))
  }

  simFillQuality() {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n,
                sum(CASE WHEN state='filled' THEN 1 ELSE 0 END) AS filled,
                sum(CASE WHEN state='rejected' THEN 1 ELSE 0 END) AS rejected,
                avg(CASE WHEN state='filled' THEN slippage_bps END) AS mean_slip,
                max(CASE WHEN state='filled' THEN slippage_bps END) AS worst_slip,
                avg(spread_bps) AS mean_spread,
                avg(latency_ms) AS mean_latency
         FROM sim_orders`,
      )
      .get() as Record<string, unknown>
    const total = Number(row.n ?? 0)
    return {
      orders: total,
      filled: Number(row.filled ?? 0),
      rejected: Number(row.rejected ?? 0),
      fillRate: total ? Number(row.filled ?? 0) / total : null,
      meanSlippageBps: row.mean_slip == null ? null : Number(row.mean_slip),
      worstSlippageBps: row.worst_slip == null ? null : Number(row.worst_slip),
      meanSpreadBps: row.mean_spread == null ? null : Number(row.mean_spread),
      meanLatencyMs: row.mean_latency == null ? null : Number(row.mean_latency),
    }
  }
}
