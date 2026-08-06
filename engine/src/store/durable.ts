import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Analysis, Candle } from '../quant/types.js'
import type { PaperTrade } from '../paper/types.js'

export const STORE_SCHEMA_VERSION = 2

export interface ModelRegistryRow {
  id: string
  created_at: number
  state: string
  strategy: string
  version: string
  metrics_json: Record<string, unknown>
  artifact_path: string | null
  rollback_reason: string | null
  settings_json: string | null
  weights_json: string | null
  promoted_at: number | null
  retired_at: number | null
  parent_id: string | null
  canary_status: string | null
  live_mean_r: number | null
  live_win_rate: number | null
  live_trades_count: number | null
  live_max_drawdown_r: number | null
}

export interface TrainingRow {
  id: number
  model_id: string
  observed_at: number
  inst_id: string
  timeframe: string
  features_json: string
  label: number
  net_r: number | null
  trade_id: string | null
  source: string
  features: number[]
}

export interface CandidateRecord {
  id: string
  observedAt: number
  instId: string
  timeframe: string
  playbook: string
  side: string
  eligible: boolean
  reasons: string[]
  policyVersion: string
  featureTime: number
  latestSourceTime: number
  availableAt: number
  payload: unknown
}

export class DurableStore {
  readonly db: Database.Database

  constructor(readonly path = process.env.MYCROFT_DB_PATH || resolve(process.cwd(), 'data/mycroft.sqlite')) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS alert_events_time ON alert_events(observed_at DESC);
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL, estimated_eur REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candles (
        inst_id TEXT NOT NULL, timeframe TEXT NOT NULL, ts INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        volume REAL NOT NULL, quote_volume REAL, confirmed INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'okx', received_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (inst_id, timeframe, ts)
      );
      CREATE INDEX IF NOT EXISTS candles_lookup ON candles(inst_id, timeframe, ts DESC);
      CREATE TABLE IF NOT EXISTS data_quality_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, inst_id TEXT NOT NULL,
        timeframe TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL, detail TEXT NOT NULL,
        repaired_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, inst_id TEXT NOT NULL, timeframe TEXT NOT NULL,
        decision TEXT NOT NULL, policy_version TEXT NOT NULL, model_version TEXT NOT NULL,
        feature_time INTEGER NOT NULL, latest_source_time INTEGER NOT NULL, available_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, inst_id TEXT NOT NULL, timeframe TEXT NOT NULL,
        playbook TEXT NOT NULL, side TEXT NOT NULL, eligible INTEGER NOT NULL, reasons_json TEXT NOT NULL,
        policy_version TEXT NOT NULL, feature_time INTEGER NOT NULL, latest_source_time INTEGER NOT NULL,
        available_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS candidates_lookup ON candidates(inst_id, timeframe, observed_at DESC);
      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY, inst_id TEXT NOT NULL, timeframe TEXT NOT NULL, status TEXT NOT NULL,
        opened_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL, policy_version TEXT NOT NULL,
        model_version TEXT NOT NULL, playbook TEXT NOT NULL, net_r REAL NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paper_trades_status ON paper_trades(status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS paper_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id TEXT NOT NULL, at INTEGER NOT NULL,
        type TEXT NOT NULL, detail TEXT NOT NULL, payload_json TEXT NOT NULL,
        UNIQUE(trade_id, at, type, detail)
      );
      CREATE TABLE IF NOT EXISTS risk_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_campaigns (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL, hypothesis TEXT NOT NULL,
        budget_json TEXT NOT NULL, manifest_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiment_trials (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL,
        config_hash TEXT NOT NULL, metrics_json TEXT NOT NULL, artifact_hash TEXT,
        FOREIGN KEY(campaign_id) REFERENCES research_campaigns(id)
      );
      CREATE TABLE IF NOT EXISTS model_registry (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, strategy TEXT NOT NULL,
        version TEXT NOT NULL, metrics_json TEXT NOT NULL, artifact_path TEXT, rollback_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_findings (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, campaign_id TEXT, verdict TEXT NOT NULL,
        finding TEXT NOT NULL, evidence_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL, key TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, delivered_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS champion_training_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        inst_id TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        features_json TEXT NOT NULL,
        label INTEGER NOT NULL,
        net_r REAL,
        trade_id TEXT,
        source TEXT NOT NULL DEFAULT 'live',
        FOREIGN KEY (model_id) REFERENCES model_registry(id)
      );
      CREATE INDEX IF NOT EXISTS champion_training_rows_model ON champion_training_rows(model_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS champion_canary_trades (
        trade_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        net_r REAL
      );
    `)
    // Add columns to model_registry for champion lifecycle (v2 migration).
    const addColumn = (col: string, def: string) => {
      try { this.db.exec(`ALTER TABLE model_registry ADD COLUMN ${col} ${def}`) } catch { /* column already exists */ }
    }
    addColumn('settings_json', 'TEXT')
    addColumn('weights_json', 'TEXT')
    addColumn('promoted_at', 'INTEGER')
    addColumn('retired_at', 'INTEGER')
    addColumn('parent_id', 'TEXT')
    addColumn('canary_status', 'TEXT')
    addColumn('live_mean_r', 'REAL')
    addColumn('live_win_rate', 'REAL')
    addColumn('live_trades_count', 'INTEGER')
    addColumn('live_max_drawdown_r', 'REAL')
    this.db.prepare('DELETE FROM paper_events WHERE trade_id LIKE ?').run('campaign:%')
    this.db.prepare('DELETE FROM paper_trades WHERE id LIKE ?').run('campaign:%')
    this.db.prepare('INSERT INTO metadata(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run('schema_version', String(STORE_SCHEMA_VERSION), Date.now())
  }

  upsertCandles(instId: string, timeframe: string, candles: readonly Candle[], receivedAt = Date.now()) {
    const statement = this.db.prepare(`
      INSERT INTO candles(inst_id,timeframe,ts,open,high,low,close,volume,quote_volume,confirmed,received_at)
      VALUES (@instId,@timeframe,@ts,@open,@high,@low,@close,@volume,@quoteVolume,@confirmed,@receivedAt)
      ON CONFLICT(inst_id,timeframe,ts) DO UPDATE SET
        open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close,
        volume=excluded.volume, quote_volume=excluded.quote_volume, confirmed=excluded.confirmed,
        received_at=excluded.received_at, revision=candles.revision+1
    `)
    const tx = this.db.transaction((rows: readonly Candle[]) => {
      for (const candle of rows) statement.run({
        instId, timeframe, ts: candle.ts, open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: candle.volume, quoteVolume: candle.quoteVolume ?? null,
        confirmed: candle.confirmed ? 1 : 0, receivedAt,
      })
    })
    tx(candles)
    return candles.length
  }

  loadCandles(instId: string, timeframe: string, limit = 1000): Candle[] {
    const rows = this.db.prepare(`SELECT ts,open,high,low,close,volume,quote_volume,confirmed FROM candles
      WHERE inst_id=? AND timeframe=? ORDER BY ts DESC LIMIT ?`).all(instId, timeframe, limit) as Record<string, number | null>[]
    return rows.reverse().map((row) => ({
      ts: Number(row.ts), open: Number(row.open), high: Number(row.high), low: Number(row.low),
      close: Number(row.close), volume: Number(row.volume), quoteVolume: row.quote_volume == null ? undefined : Number(row.quote_volume),
      confirmed: Boolean(row.confirmed),
    }))
  }

  recordDecision(id: string, analysis: Analysis, policyVersion: string, modelVersion: string) {
    const latestSourceTime = analysis.generatedAt - Math.max(0, analysis.dataQuality.staleMs)
    this.db.prepare(`INSERT OR IGNORE INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, analysis.generatedAt, analysis.instId, analysis.timeframe, analysis.decision, policyVersion, modelVersion,
      analysis.generatedAt, latestSourceTime, Date.now(), JSON.stringify(analysis),
    )
  }

  recordCandidate(candidate: CandidateRecord) {
    this.db.prepare(`INSERT OR REPLACE INTO candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      candidate.id, candidate.observedAt, candidate.instId, candidate.timeframe, candidate.playbook, candidate.side,
      candidate.eligible ? 1 : 0, JSON.stringify(candidate.reasons), candidate.policyVersion, candidate.featureTime,
      candidate.latestSourceTime, candidate.availableAt, JSON.stringify(candidate.payload),
    )
  }

  saveTrade(trade: PaperTrade) {
    this.db.prepare(`INSERT INTO paper_trades(id,inst_id,timeframe,status,opened_at,closed_at,updated_at,policy_version,model_version,playbook,net_r,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,opened_at=excluded.opened_at,
      closed_at=excluded.closed_at,updated_at=excluded.updated_at,net_r=excluded.net_r,payload_json=excluded.payload_json`).run(
      trade.id, trade.plan.instId, trade.plan.timeframe, trade.status, trade.filledAt ?? null, trade.closedAt ?? null,
      Date.now(), trade.plan.policyVersion, trade.plan.modelVersion, trade.plan.playbook, trade.netRealizedR, JSON.stringify(trade),
    )
    const insertEvent = this.db.prepare('INSERT OR IGNORE INTO paper_events(trade_id,at,type,detail,payload_json) VALUES (?,?,?,?,?)')
    const tx = this.db.transaction(() => {
      for (const event of trade.events) insertEvent.run(trade.id, event.at, event.type, event.detail, JSON.stringify(event))
    })
    tx()
  }

  loadActiveTrades(): PaperTrade[] {
    return (this.db.prepare(`SELECT payload_json FROM paper_trades WHERE status IN ('pending','open') ORDER BY updated_at`).all() as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as PaperTrade)
  }

  summary() {
    const count = (table: string) => Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)
    return {
      candles: count('candles'), qualityEvents: count('data_quality_events'), decisions: count('decisions'),
      candidates: count('candidates'), paperTrades: count('paper_trades'), paperEvents: count('paper_events'),
      campaigns: count('research_campaigns'), trials: count('experiment_trials'), models: count('model_registry'),
    }
  }

  getState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM app_state WHERE key=?').get(key) as { value_json: string } | undefined
    if (!row) return fallback
    try { return JSON.parse(row.value_json) as T } catch { return fallback }
  }

  setState(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO app_state(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), Date.now())
  }

  recordQualityEvent(event: { instId: string; timeframe: string; kind: string; severity: string; detail: string; repairedAt?: number }) {
    this.db.prepare(`INSERT INTO data_quality_events(observed_at,inst_id,timeframe,kind,severity,detail,repaired_at) VALUES (?,?,?,?,?,?,?)`)
      .run(Date.now(), event.instId, event.timeframe, event.kind, event.severity, event.detail, event.repairedAt ?? null)
  }

  listQualityEvents(limit = 100) {
    return this.db.prepare('SELECT * FROM data_quality_events ORDER BY observed_at DESC LIMIT ?').all(limit)
  }

  listCandidates(limit = 200, instId?: string) {
    const rows = instId
      ? this.db.prepare('SELECT * FROM candidates WHERE inst_id=? ORDER BY observed_at DESC LIMIT ?').all(instId, limit)
      : this.db.prepare('SELECT * FROM candidates ORDER BY observed_at DESC LIMIT ?').all(limit)
    return (rows as Record<string, unknown>[]).map((row) => ({
      ...row,
      eligible: Boolean(row.eligible),
      reasons: JSON.parse(String(row.reasons_json ?? '[]')),
      payload: JSON.parse(String(row.payload_json ?? '{}')),
    }))
  }

  listTrades(limit = 200, status = 'all') {
    const rows = status === 'all'
      ? this.db.prepare('SELECT payload_json FROM paper_trades ORDER BY updated_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT payload_json FROM paper_trades WHERE status=? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
    return (rows as { payload_json: string }[]).map((row) => JSON.parse(row.payload_json) as PaperTrade)
  }

  paperStats() {
    const trades = this.listTrades(1000).filter((trade) => trade.status === 'closed')
    const sumR = trades.reduce((sum, trade) => sum + trade.netRealizedR, 0)
    const wins = trades.filter((trade) => trade.netRealizedR > 0)
    return {
      total: this.listTrades(1000).length,
      closed: trades.length,
      open: this.loadActiveTrades().length,
      winRate: trades.length ? wins.length / trades.length : null,
      avgR: trades.length ? sumR / trades.length : null,
      sumR,
      bestR: trades.length ? Math.max(...trades.map((trade) => trade.netRealizedR)) : null,
      worstR: trades.length ? Math.min(...trades.map((trade) => trade.netRealizedR)) : null,
    }
  }

  recordAlert(event: Record<string, unknown>) {
    const id = String(event.id ?? `alert:${Date.now()}:${Math.random().toString(36).slice(2)}`)
    this.db.prepare('INSERT OR REPLACE INTO alert_events(id,observed_at,payload_json) VALUES (?,?,?)')
      .run(id, Number(event.ts ?? Date.now()), JSON.stringify({ ...event, _id: id }))
    return id
  }

  listAlerts(limit = 100) {
    return (this.db.prepare('SELECT payload_json FROM alert_events ORDER BY observed_at DESC LIMIT ?').all(limit) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
  }

  recordAiUsage(model: string, tokensIn: number, tokensOut: number, estimatedEur: number) {
    this.db.prepare('INSERT INTO ai_usage(observed_at,model,tokens_in,tokens_out,estimated_eur) VALUES (?,?,?,?,?)')
      .run(Date.now(), model, tokensIn, tokensOut, estimatedEur)
  }

  aiUsageThisMonth() {
    const start = new Date()
    start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0)
    const row = this.db.prepare(`SELECT COALESCE(sum(estimated_eur),0) AS spend,COALESCE(sum(tokens_in),0) AS tokensIn,
      COALESCE(sum(tokens_out),0) AS tokensOut,count(*) AS calls FROM ai_usage WHERE observed_at>=?`).get(start.getTime()) as Record<string, number>
    return row
  }

  upsertCampaign(campaign: { id: string; status: string; hypothesis: string; budget: unknown; manifest: unknown }) {
    this.db.prepare(`INSERT INTO research_campaigns(id,created_at,status,hypothesis,budget_json,manifest_json) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,manifest_json=excluded.manifest_json`).run(
      campaign.id, Date.now(), campaign.status, campaign.hypothesis, JSON.stringify(campaign.budget), JSON.stringify(campaign.manifest),
    )
  }

  recordTrial(trial: { id: string; campaignId: string; status: string; configHash: string; metrics: unknown; artifactHash?: string }) {
    this.db.prepare(`INSERT OR REPLACE INTO experiment_trials(id,campaign_id,created_at,status,config_hash,metrics_json,artifact_hash) VALUES (?,?,?,?,?,?,?)`).run(
      trial.id, trial.campaignId, Date.now(), trial.status, trial.configHash, JSON.stringify(trial.metrics), trial.artifactHash ?? null,
    )
  }

  registerModel(model: { id: string; state: string; strategy: string; version: string; metrics: unknown; artifactPath?: string; rollbackReason?: string; settingsJson?: string; weightsJson?: string; parentId?: string }) {
    this.db.prepare(`INSERT OR REPLACE INTO model_registry(id,created_at,state,strategy,version,metrics_json,artifact_path,rollback_reason,settings_json,weights_json,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      model.id, Date.now(), model.state, model.strategy, model.version, JSON.stringify(model.metrics), model.artifactPath ?? null, model.rollbackReason ?? null,
      model.settingsJson ?? null, model.weightsJson ?? null, model.parentId ?? null,
    )
  }

  promoteModel(id: string, settingsJson?: string, weightsJson?: string) {
    this.db.prepare(`UPDATE model_registry SET state='paper_champion', promoted_at=?, settings_json=?, weights_json=? WHERE id=?`).run(
      Date.now(), settingsJson ?? null, weightsJson ?? null, id,
    )
  }

  retireModel(id: string, reason: string, state = 'rolled_back') {
    this.db.prepare(`UPDATE model_registry SET state=?, retired_at=?, rollback_reason=? WHERE id=?`).run(
      state, Date.now(), reason, id,
    )
  }

  setCanaryStatus(id: string, status: string) {
    this.db.prepare(`UPDATE model_registry SET canary_status=? WHERE id=?`).run(status, id)
  }

  updateLiveStats(id: string, meanR: number, winRate: number, tradesCount: number, maxDrawdownR: number) {
    this.db.prepare(`UPDATE model_registry SET live_mean_r=?, live_win_rate=?, live_trades_count=?, live_max_drawdown_r=? WHERE id=?`).run(
      meanR, winRate, tradesCount, maxDrawdownR, id,
    )
  }

  getModel(id: string): ModelRegistryRow | null {
    const row = this.db.prepare('SELECT * FROM model_registry WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      created_at: Number(row.created_at),
      state: String(row.state),
      strategy: String(row.strategy),
      version: String(row.version),
      metrics_json: JSON.parse(String(row.metrics_json ?? '{}')),
      artifact_path: row.artifact_path ? String(row.artifact_path) : null,
      rollback_reason: row.rollback_reason ? String(row.rollback_reason) : null,
      settings_json: row.settings_json ? String(row.settings_json) : null,
      weights_json: row.weights_json ? String(row.weights_json) : null,
      promoted_at: row.promoted_at != null ? Number(row.promoted_at) : null,
      retired_at: row.retired_at != null ? Number(row.retired_at) : null,
      parent_id: row.parent_id ? String(row.parent_id) : null,
      canary_status: row.canary_status ? String(row.canary_status) : null,
      live_mean_r: row.live_mean_r != null ? Number(row.live_mean_r) : null,
      live_win_rate: row.live_win_rate != null ? Number(row.live_win_rate) : null,
      live_trades_count: row.live_trades_count != null ? Number(row.live_trades_count) : null,
      live_max_drawdown_r: row.live_max_drawdown_r != null ? Number(row.live_max_drawdown_r) : null,
    }
  }

  listModelsByState(state: string): ModelRegistryRow[] {
    return (this.db.prepare('SELECT * FROM model_registry WHERE state=? ORDER BY created_at DESC').all(state) as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id),
        created_at: Number(row.created_at),
        state: String(row.state),
        strategy: String(row.strategy),
        version: String(row.version),
        metrics_json: JSON.parse(String(row.metrics_json ?? '{}')),
        artifact_path: row.artifact_path ? String(row.artifact_path) : null,
        rollback_reason: row.rollback_reason ? String(row.rollback_reason) : null,
        settings_json: row.settings_json ? String(row.settings_json) : null,
        weights_json: row.weights_json ? String(row.weights_json) : null,
        promoted_at: row.promoted_at != null ? Number(row.promoted_at) : null,
        retired_at: row.retired_at != null ? Number(row.retired_at) : null,
        parent_id: row.parent_id ? String(row.parent_id) : null,
        canary_status: row.canary_status ? String(row.canary_status) : null,
        live_mean_r: row.live_mean_r != null ? Number(row.live_mean_r) : null,
        live_win_rate: row.live_win_rate != null ? Number(row.live_win_rate) : null,
        live_trades_count: row.live_trades_count != null ? Number(row.live_trades_count) : null,
        live_max_drawdown_r: row.live_max_drawdown_r != null ? Number(row.live_max_drawdown_r) : null,
      }))
  }

  recordTrainingRow(row: { modelId: string; observedAt: number; instId: string; timeframe: string; features: number[]; label: number; netR?: number; tradeId?: string; source?: string }) {
    this.db.prepare(`INSERT INTO champion_training_rows(model_id,observed_at,inst_id,timeframe,features_json,label,net_r,trade_id,source) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      row.modelId, row.observedAt, row.instId, row.timeframe, JSON.stringify(row.features), row.label, row.netR ?? null, row.tradeId ?? null, row.source ?? 'live',
    )
  }

  listTrainingRows(modelId: string, beforeTs?: number, limit = 5000): TrainingRow[] {
    const rows = beforeTs != null
      ? this.db.prepare('SELECT * FROM champion_training_rows WHERE model_id=? AND observed_at<? ORDER BY observed_at DESC LIMIT ?').all(modelId, beforeTs, limit) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM champion_training_rows WHERE model_id=? ORDER BY observed_at DESC LIMIT ?').all(modelId, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: Number(row.id),
      model_id: String(row.model_id),
      observed_at: Number(row.observed_at),
      inst_id: String(row.inst_id),
      timeframe: String(row.timeframe),
      features_json: String(row.features_json ?? '[]'),
      label: Number(row.label),
      net_r: row.net_r == null ? null : Number(row.net_r),
      trade_id: row.trade_id ? String(row.trade_id) : null,
      source: String(row.source ?? 'live'),
      features: JSON.parse(String(row.features_json ?? '[]')) as number[],
    }))
  }

  recordCanaryTrade(tradeId: string, modelId: string, openedAt: number) {
    this.db.prepare(`INSERT OR REPLACE INTO champion_canary_trades(trade_id,model_id,opened_at) VALUES (?,?,?)`).run(
      tradeId, modelId, openedAt,
    )
  }

  closeCanaryTrade(tradeId: string, closedAt: number, netR: number) {
    this.db.prepare(`UPDATE champion_canary_trades SET closed_at=?, net_r=? WHERE trade_id=?`).run(
      closedAt, netR, tradeId,
    )
  }

  listCanaryTrades(modelId: string) {
    return (this.db.prepare('SELECT * FROM champion_canary_trades WHERE model_id=? ORDER BY opened_at').all(modelId) as Record<string, unknown>[])
      .map((row) => ({
        trade_id: String(row.trade_id),
        model_id: String(row.model_id),
        opened_at: Number(row.opened_at),
        closed_at: row.closed_at == null ? null : Number(row.closed_at),
        net_r: row.net_r == null ? null : Number(row.net_r),
      }))
  }

  researchState() {
    const parse = (rows: { [key: string]: unknown }[], field: string) => rows.map((row) => ({ ...row, [field]: JSON.parse(String(row[field] ?? '{}')) }))
    const campaigns = parse(this.db.prepare('SELECT * FROM research_campaigns ORDER BY created_at DESC LIMIT 100').all() as Record<string, unknown>[], 'manifest_json')
    const trials = parse(this.db.prepare('SELECT * FROM experiment_trials ORDER BY created_at DESC LIMIT 300').all() as Record<string, unknown>[], 'metrics_json')
    const models = parse(this.db.prepare('SELECT * FROM model_registry ORDER BY created_at DESC LIMIT 100').all() as Record<string, unknown>[], 'metrics_json')
    return { campaigns, trials, models, champion: models.find((row) => row.state === 'paper_champion') ?? null, canary: models.find((row) => row.state === 'paper_canary') ?? null, validationState: models.some((row) => row.state === 'paper_champion') ? 'VALIDATED' : 'NO_VALIDATED_MODEL' }
  }

  pruneCandles(beforeTs: number) {
    return this.db.prepare('DELETE FROM candles WHERE ts<?').run(beforeTs).changes
  }

  async exportCandlesToParquet(destination: string, instId?: string, timeframe?: string) {
    const parquetModule = await import('parquetjs-lite')
    const parquet = ((parquetModule as unknown as { default?: typeof parquetModule }).default ?? parquetModule)
    const { ParquetSchema, ParquetWriter } = parquet
    mkdirSync(dirname(destination), { recursive: true })
    const schema = new ParquetSchema({
      inst_id: { type: 'UTF8' }, timeframe: { type: 'UTF8' }, ts: { type: 'INT64' },
      open: { type: 'DOUBLE' }, high: { type: 'DOUBLE' }, low: { type: 'DOUBLE' }, close: { type: 'DOUBLE' },
      volume: { type: 'DOUBLE' }, quote_volume: { type: 'DOUBLE', optional: true }, confirmed: { type: 'BOOLEAN' },
      received_at: { type: 'INT64' }, revision: { type: 'INT32' },
    })
    const clauses: string[] = []
    const params: unknown[] = []
    if (instId) { clauses.push('inst_id=?'); params.push(instId) }
    if (timeframe) { clauses.push('timeframe=?'); params.push(timeframe) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM candles ${where} ORDER BY inst_id,timeframe,ts`).all(...params) as Record<string, unknown>[]
    const writer = await ParquetWriter.openFile(schema, destination)
    for (const row of rows) await writer.appendRow({
      inst_id: row.inst_id, timeframe: row.timeframe, ts: Number(row.ts), open: row.open, high: row.high,
      low: row.low, close: row.close, volume: row.volume, quote_volume: row.quote_volume ?? undefined,
      confirmed: Boolean(row.confirmed), received_at: Number(row.received_at), revision: Number(row.revision),
    })
    await writer.close()
    this.setState('last_parquet_export', { destination, at: Date.now(), rows: rows.length, instId, timeframe })
    return { destination, at: Date.now(), rows: rows.length }
  }

  async backup(destination: string) {
    mkdirSync(dirname(destination), { recursive: true })
    const result = await this.db.backup(destination)
    this.setState('last_backup', { destination, at: Date.now(), pages: result.totalPages })
    return { destination, at: Date.now(), pages: result.totalPages }
  }

  checkpoint() {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
  }

  close() {
    this.checkpoint()
    this.db.close()
  }
}
