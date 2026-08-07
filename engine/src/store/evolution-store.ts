/**
 * Durable storage for the self-improving population.
 *
 * Lives inside the same SQLite WAL database as everything else so a single file
 * backup restores the entire brain: samples, specialists, lineage, events,
 * failure attribution and real exchange orders.
 */
import type Database from 'better-sqlite3'
import type { SpecialistArtifact, TrainingSample } from '../research/population.js'

export const EVOLUTION_SCHEMA_VERSION = 3

export interface SpecialistRow {
  artifact_hash: string
  niche_key: string
  playbook: string
  inst_type: string
  timeframe: string
  generation: number
  parent_hash: string | null
  display_name: string
  lifecycle: 'shadow' | 'canary' | 'champion' | 'retired' | 'rejected'
  artifact_path: string | null
  metrics_json: string
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
  placebo_skill: number | null
}

export interface EvolutionEventRow {
  id: number
  at: number
  type: string
  niche_key: string | null
  artifact_hash: string | null
  detail: string
  payload_json: string | null
}

export interface AttributionRow {
  trade_id: string
  at: number
  inst_id: string
  playbook: string
  reason_code: string
  detail: string
  expected_r: number | null
  realised_r: number
  mfe_r: number
  mae_r: number
}

export function migrateEvolutionSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      playbook TEXT NOT NULL,
      features_json TEXT NOT NULL,
      label INTEGER NOT NULL,
      net_r REAL,
      horizon_end_at INTEGER NOT NULL,
      trade_id TEXT,
      source TEXT NOT NULL DEFAULT 'live_paper',
      UNIQUE(trade_id, playbook)
    );
    CREATE INDEX IF NOT EXISTS training_samples_niche ON training_samples(playbook, inst_type, timeframe, at);

    CREATE TABLE IF NOT EXISTS specialists (
      artifact_hash TEXT PRIMARY KEY,
      niche_key TEXT NOT NULL,
      playbook TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      generation INTEGER NOT NULL,
      parent_hash TEXT,
      display_name TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      artifact_path TEXT,
      metrics_json TEXT NOT NULL,
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
      placebo_skill REAL
    );
    CREATE INDEX IF NOT EXISTS specialists_niche ON specialists(niche_key, lifecycle, generation DESC);

    CREATE TABLE IF NOT EXISTS evolution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      type TEXT NOT NULL,
      niche_key TEXT,
      artifact_hash TEXT,
      detail TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS evolution_events_time ON evolution_events(at DESC);

    CREATE TABLE IF NOT EXISTS trade_attribution (
      trade_id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      inst_id TEXT NOT NULL,
      playbook TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      detail TEXT NOT NULL,
      expected_r REAL,
      realised_r REAL NOT NULL,
      mfe_r REAL NOT NULL,
      mae_r REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trade_attribution_reason ON trade_attribution(reason_code, at DESC);

    CREATE TABLE IF NOT EXISTS okx_orders (
      cl_ord_id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      ord_id TEXT,
      inst_id TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      side TEXT NOT NULL,
      ord_type TEXT NOT NULL,
      px REAL,
      sz REAL NOT NULL,
      state TEXT NOT NULL,
      filled_sz REAL NOT NULL DEFAULT 0,
      avg_px REAL,
      fee REAL,
      purpose TEXT NOT NULL DEFAULT 'entry',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS okx_orders_trade ON okx_orders(trade_id, created_at);
  `)
}

export class EvolutionStore {
  constructor(private readonly db: Database.Database) {
    migrateEvolutionSchema(db)
  }

  /* ---- samples ---------------------------------------------------------- */

  recordSample(sample: TrainingSample & { instType: string; timeframe: string; playbook: string; tradeId?: string; source?: string }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO training_samples(at,symbol,inst_type,timeframe,playbook,features_json,label,net_r,horizon_end_at,trade_id,source)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        sample.at,
        sample.symbol,
        sample.instType,
        sample.timeframe,
        sample.playbook,
        JSON.stringify(sample.features),
        sample.label,
        sample.netR ?? null,
        sample.horizonEndAt ?? sample.at,
        sample.tradeId ?? null,
        sample.source ?? 'live_paper',
      )
  }

  listSamples(filter: { playbook?: string; instType?: string; timeframe?: string; limit?: number } = {}): TrainingSample[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.playbook) {
      clauses.push('playbook=?')
      params.push(filter.playbook)
    }
    if (filter.instType) {
      clauses.push('inst_type=?')
      params.push(filter.instType)
    }
    if (filter.timeframe) {
      clauses.push('timeframe=?')
      params.push(filter.timeframe)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    params.push(Math.min(20_000, filter.limit ?? 5_000))
    const rows = this.db.prepare(`SELECT * FROM training_samples ${where} ORDER BY at DESC LIMIT ?`).all(...params) as Record<string, unknown>[]
    return rows
      .map((row) => ({
        at: Number(row.at),
        symbol: String(row.symbol),
        features: JSON.parse(String(row.features_json)) as number[],
        label: Number(row.label) === 1 ? (1 as const) : (0 as const),
        netR: row.net_r == null ? undefined : Number(row.net_r),
        horizonEndAt: Number(row.horizon_end_at),
      }))
      .reverse()
  }

  /** Sample counts grouped by niche — drives which niches are worth a campaign. */
  nicheCounts(): { nicheKey: string; playbook: string; instType: string; timeframe: string; samples: number; wins: number; sumR: number; lastAt: number }[] {
    return (
      this.db
        .prepare(
          `SELECT playbook, inst_type, timeframe, count(*) AS samples, sum(label) AS wins,
                  COALESCE(sum(net_r),0) AS sum_r, max(at) AS last_at
           FROM training_samples GROUP BY playbook, inst_type, timeframe ORDER BY samples DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      nicheKey: `${row.playbook}|${row.inst_type}|${row.timeframe}`,
      playbook: String(row.playbook),
      instType: String(row.inst_type),
      timeframe: String(row.timeframe),
      samples: Number(row.samples),
      wins: Number(row.wins ?? 0),
      sumR: Number(row.sum_r ?? 0),
      lastAt: Number(row.last_at ?? 0),
    }))
  }

  sampleTotal() {
    return Number((this.db.prepare('SELECT count(*) AS n FROM training_samples').get() as { n: number }).n)
  }

  /* ---- specialists ------------------------------------------------------ */

  upsertSpecialist(input: {
    artifactHash: string
    artifact: SpecialistArtifact
    displayName: string
    lifecycle: SpecialistRow['lifecycle']
    artifactPath: string | null
    rejectionReason?: string | null
    trials?: number
    placeboSkill?: number | null
  }) {
    const { artifact } = input
    const nicheKey = `${artifact.niche.playbook}|${artifact.niche.instType}|${artifact.niche.timeframe}`
    this.db
      .prepare(
        `INSERT INTO specialists(artifact_hash,niche_key,playbook,inst_type,timeframe,generation,parent_hash,display_name,lifecycle,artifact_path,metrics_json,created_at,rejection_reason,trials,placebo_skill)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(artifact_hash) DO UPDATE SET lifecycle=excluded.lifecycle, artifact_path=excluded.artifact_path,
           metrics_json=excluded.metrics_json, rejection_reason=excluded.rejection_reason, trials=excluded.trials, placebo_skill=excluded.placebo_skill`,
      )
      .run(
        input.artifactHash,
        nicheKey,
        artifact.niche.playbook,
        artifact.niche.instType,
        artifact.niche.timeframe,
        artifact.generation,
        artifact.parentHash,
        input.displayName,
        input.lifecycle,
        input.artifactPath,
        JSON.stringify(artifact.metrics),
        artifact.trainedAt,
        input.rejectionReason ?? null,
        input.trials ?? 0,
        input.placeboSkill ?? null,
      )
  }

  setLifecycle(artifactHash: string, lifecycle: SpecialistRow['lifecycle'], reason?: string) {
    const now = Date.now()
    if (lifecycle === 'champion' || lifecycle === 'canary') {
      this.db.prepare('UPDATE specialists SET lifecycle=?, promoted_at=?, rejection_reason=NULL WHERE artifact_hash=?').run(lifecycle, now, artifactHash)
    } else {
      this.db.prepare('UPDATE specialists SET lifecycle=?, retired_at=?, rejection_reason=? WHERE artifact_hash=?').run(lifecycle, now, reason ?? null, artifactHash)
    }
  }

  listSpecialists(limit = 400): SpecialistRow[] {
    return this.db.prepare('SELECT * FROM specialists ORDER BY created_at DESC LIMIT ?').all(limit) as SpecialistRow[]
  }

  listByLifecycle(lifecycle: SpecialistRow['lifecycle']): SpecialistRow[] {
    return this.db.prepare('SELECT * FROM specialists WHERE lifecycle=? ORDER BY generation DESC, created_at DESC').all(lifecycle) as SpecialistRow[]
  }

  getSpecialist(artifactHash: string): SpecialistRow | null {
    return (this.db.prepare('SELECT * FROM specialists WHERE artifact_hash=?').get(artifactHash) as SpecialistRow | undefined) ?? null
  }

  championFor(nicheKey: string): SpecialistRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM specialists WHERE niche_key=? AND lifecycle IN ('champion','canary') ORDER BY CASE lifecycle WHEN 'champion' THEN 0 ELSE 1 END, generation DESC LIMIT 1")
        .get(nicheKey) as SpecialistRow | undefined) ?? null
    )
  }

  updateLiveStats(artifactHash: string, stats: { trades: number; meanR: number; winRate: number; maxDrawdownR: number; sumR: number }) {
    this.db
      .prepare('UPDATE specialists SET live_trades=?, live_mean_r=?, live_win_rate=?, live_max_dd_r=?, live_sum_r=? WHERE artifact_hash=?')
      .run(stats.trades, stats.meanR, stats.winRate, stats.maxDrawdownR, stats.sumR, artifactHash)
  }

  /* ---- events ----------------------------------------------------------- */

  recordEvent(event: { type: string; nicheKey?: string | null; artifactHash?: string | null; detail: string; payload?: unknown }) {
    this.db
      .prepare('INSERT INTO evolution_events(at,type,niche_key,artifact_hash,detail,payload_json) VALUES (?,?,?,?,?,?)')
      .run(Date.now(), event.type, event.nicheKey ?? null, event.artifactHash ?? null, event.detail, event.payload ? JSON.stringify(event.payload) : null)
  }

  listEvents(limit = 120): EvolutionEventRow[] {
    return this.db.prepare('SELECT * FROM evolution_events ORDER BY at DESC LIMIT ?').all(limit) as EvolutionEventRow[]
  }

  /* ---- attribution ------------------------------------------------------ */

  recordAttribution(row: Omit<AttributionRow, 'at'> & { at?: number }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trade_attribution(trade_id,at,inst_id,playbook,reason_code,detail,expected_r,realised_r,mfe_r,mae_r)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.trade_id, row.at ?? Date.now(), row.inst_id, row.playbook, row.reason_code, row.detail, row.expected_r ?? null, row.realised_r, row.mfe_r, row.mae_r)
  }

  attributionSummary(sinceMs = 30 * 24 * 60 * 60_000) {
    const since = Date.now() - sinceMs
    return (
      this.db
        .prepare(
          `SELECT reason_code, count(*) AS n, COALESCE(avg(realised_r),0) AS mean_r, COALESCE(sum(realised_r),0) AS sum_r
           FROM trade_attribution WHERE at>=? GROUP BY reason_code ORDER BY n DESC`,
        )
        .all(since) as Record<string, unknown>[]
    ).map((row) => ({
      reasonCode: String(row.reason_code),
      count: Number(row.n),
      meanR: Number(row.mean_r),
      sumR: Number(row.sum_r),
    }))
  }

  listAttribution(limit = 200) {
    return this.db.prepare('SELECT * FROM trade_attribution ORDER BY at DESC LIMIT ?').all(limit) as AttributionRow[]
  }

  /* ---- exchange orders -------------------------------------------------- */

  recordOrder(order: {
    clOrdId: string
    tradeId: string
    ordId?: string | null
    instId: string
    instType: string
    side: string
    ordType: string
    px?: number | null
    sz: number
    state: string
    filledSz?: number
    avgPx?: number | null
    fee?: number | null
    purpose?: string
    raw?: unknown
  }) {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO okx_orders(cl_ord_id,trade_id,ord_id,inst_id,inst_type,side,ord_type,px,sz,state,filled_sz,avg_px,fee,purpose,created_at,updated_at,raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(cl_ord_id) DO UPDATE SET ord_id=COALESCE(excluded.ord_id,okx_orders.ord_id), state=excluded.state,
           filled_sz=excluded.filled_sz, avg_px=COALESCE(excluded.avg_px,okx_orders.avg_px), fee=COALESCE(excluded.fee,okx_orders.fee),
           updated_at=excluded.updated_at, raw_json=excluded.raw_json`,
      )
      .run(
        order.clOrdId,
        order.tradeId,
        order.ordId ?? null,
        order.instId,
        order.instType,
        order.side,
        order.ordType,
        order.px ?? null,
        order.sz,
        order.state,
        order.filledSz ?? 0,
        order.avgPx ?? null,
        order.fee ?? null,
        order.purpose ?? 'entry',
        now,
        now,
        order.raw ? JSON.stringify(order.raw) : null,
      )
  }

  listOrders(limit = 200) {
    return this.db.prepare('SELECT * FROM okx_orders ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
  }

  openOrders() {
    return this.db.prepare("SELECT * FROM okx_orders WHERE state IN ('live','partially_filled','pending') ORDER BY created_at").all() as Record<string, unknown>[]
  }

  ordersForTrade(tradeId: string) {
    return this.db.prepare('SELECT * FROM okx_orders WHERE trade_id=? ORDER BY created_at').all(tradeId) as Record<string, unknown>[]
  }

  summary() {
    const count = (table: string) => Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)
    return {
      samples: count('training_samples'),
      specialists: count('specialists'),
      champions: Number((this.db.prepare("SELECT count(*) AS n FROM specialists WHERE lifecycle='champion'").get() as { n: number }).n),
      events: count('evolution_events'),
      attributions: count('trade_attribution'),
      exchangeOrders: count('okx_orders'),
    }
  }
}
