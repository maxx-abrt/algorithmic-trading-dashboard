/**
 * THE DECISION TAPE — the single most important storage change in this system.
 *
 * The old design stored, for every historical decision, only `features -> label`.
 * That is enough to fit a classifier and nothing else: you can never ask "what if
 * the stop had been wider", "what if we had exited at TP1", "what would the equity
 * curve have looked like if this model had gated the trades". So models were being
 * born generation after generation without a single strategy ever being TESTED.
 *
 * The tape stores, for every historical decision:
 *   • the frozen point-in-time feature vector (schema-stamped)
 *   • the full trade PLAN that was on the table (entry zone, stop, TP ladder, ATR)
 *   • the PRICE PATH that followed, as a compact Float32 blob of relative offsets
 *
 * With the path we can re-simulate ANY execution policy in microseconds, with no
 * candle lookups and no exchange calls: different thresholds, different stops,
 * different TP ladders, trailing variants, time stops, and reinforcement-learning
 * exit agents. That is what turns "34 models born" into "34 models measured".
 *
 * Storage cost: 96 bars x 3 floats x 4 bytes = 1.1 KB per row before base64.
 * 100 000 rows ≈ 150 MB, which is nothing next to the 6.2 M bars already stored.
 */
import type Database from 'better-sqlite3'

export const TAPE_SCHEMA_VERSION = 1
export const TAPE_MAX_BARS = 96

export interface TapePathBar {
  /** (open / entry) - 1 */
  o: number
  /** (high / entry) - 1 */
  h: number
  /** (low / entry) - 1 */
  l: number
  /** (close / entry) - 1 */
  c: number
}

/** floats per stored bar: open, high, low, close */
export const TAPE_PATH_STRIDE = 4

export interface TapeRow {
  id: number
  at: number
  symbol: string
  instType: string
  timeframe: string
  playbook: string
  side: 'LONG' | 'SHORT'
  featureSchema: string
  features: number[]
  entry: number
  entryLow: number
  entryHigh: number
  stop: number
  targets: { price: number; allocation: number }[]
  atr: number
  maxEntryBars: number
  maxHoldBars: number
  trailAtrMult: number
  feeBps: number
  slippageBps: number
  fundingRate8h: number | null
  regimeId: number | null
  path: TapePathBar[]
  /** net R of the ORIGINAL plan, kept for fast baselines */
  baselineNetR: number | null
  baselineLabel: number | null
  horizonEndAt: number
  source: string
}

export type TapeInsert = Omit<TapeRow, 'id'>

/* -------------------------------------------------------------------------- */
/*  Path codec                                                                 */
/* -------------------------------------------------------------------------- */

export function encodePath(path: readonly TapePathBar[]): string {
  const bars = Math.min(TAPE_MAX_BARS, path.length)
  const array = new Float32Array(bars * TAPE_PATH_STRIDE)
  for (let i = 0; i < bars; i++) {
    array[i * TAPE_PATH_STRIDE] = path[i].o
    array[i * TAPE_PATH_STRIDE + 1] = path[i].h
    array[i * TAPE_PATH_STRIDE + 2] = path[i].l
    array[i * TAPE_PATH_STRIDE + 3] = path[i].c
  }
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString('base64')
}

export function decodePath(blob: string | null): TapePathBar[] {
  if (!blob) return []
  const buffer = Buffer.from(blob, 'base64')
  const bytes = TAPE_PATH_STRIDE * 4
  const usable = buffer.byteLength - (buffer.byteLength % bytes)
  if (usable <= 0) return []
  const copy = new Uint8Array(usable)
  copy.set(buffer.subarray(0, usable))
  const array = new Float32Array(copy.buffer)
  const out: TapePathBar[] = []
  for (let i = 0; i + TAPE_PATH_STRIDE - 1 < array.length; i += TAPE_PATH_STRIDE) {
    out.push({ o: array[i], h: array[i + 1], l: array[i + 2], c: array[i + 3] })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*  Schema                                                                     */
/* -------------------------------------------------------------------------- */

export function migrateTapeSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_tape (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      inst_type TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      playbook TEXT NOT NULL,
      side TEXT NOT NULL,
      feature_schema TEXT NOT NULL,
      features_json TEXT NOT NULL,
      entry REAL NOT NULL,
      entry_low REAL NOT NULL,
      entry_high REAL NOT NULL,
      stop REAL NOT NULL,
      targets_json TEXT NOT NULL,
      atr REAL NOT NULL,
      max_entry_bars INTEGER NOT NULL,
      max_hold_bars INTEGER NOT NULL,
      trail_atr_mult REAL NOT NULL,
      fee_bps REAL NOT NULL,
      slippage_bps REAL NOT NULL,
      funding_rate_8h REAL,
      regime_id INTEGER,
      path_blob TEXT NOT NULL,
      path_bars INTEGER NOT NULL,
      baseline_net_r REAL,
      baseline_label INTEGER,
      horizon_end_at INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'replay',
      UNIQUE(symbol, timeframe, playbook, side, at)
    );
    CREATE INDEX IF NOT EXISTS decision_tape_niche ON decision_tape(playbook, inst_type, timeframe, at);
    CREATE INDEX IF NOT EXISTS decision_tape_time ON decision_tape(at);
    CREATE INDEX IF NOT EXISTS decision_tape_symbol ON decision_tape(symbol, timeframe, at);

    CREATE TABLE IF NOT EXISTS tape_cursor (
      key TEXT PRIMARY KEY,
      last_ts INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                      */
/* -------------------------------------------------------------------------- */

export interface TapeQuery {
  playbook?: string
  instType?: string
  timeframe?: string
  symbol?: string
  excludeSymbols?: string[]
  featureSchema?: string
  fromAt?: number
  toAt?: number
  limit?: number
  /** newest first when true (default false = chronological) */
  desc?: boolean
}

export class TapeStore {
  constructor(readonly db: Database.Database) {
    migrateTapeSchema(db)
  }

  insert(rows: readonly TapeInsert[]): number {
    if (!rows.length) return 0
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO decision_tape
        (at,symbol,inst_type,timeframe,playbook,side,feature_schema,features_json,entry,entry_low,entry_high,stop,
         targets_json,atr,max_entry_bars,max_hold_bars,trail_atr_mult,fee_bps,slippage_bps,funding_rate_8h,regime_id,
         path_blob,path_bars,baseline_net_r,baseline_label,horizon_end_at,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    let inserted = 0
    const tx = this.db.transaction((batch: readonly TapeInsert[]) => {
      for (const row of batch) {
        const blob = encodePath(row.path)
        const result = statement.run(
          row.at,
          row.symbol,
          row.instType,
          row.timeframe,
          row.playbook,
          row.side,
          row.featureSchema,
          JSON.stringify(row.features.map((value) => Number(value.toFixed(6)))),
          row.entry,
          row.entryLow,
          row.entryHigh,
          row.stop,
          JSON.stringify(row.targets),
          row.atr,
          row.maxEntryBars,
          row.maxHoldBars,
          row.trailAtrMult,
          row.feeBps,
          row.slippageBps,
          row.fundingRate8h,
          row.regimeId,
          blob,
          Math.min(TAPE_MAX_BARS, row.path.length),
          row.baselineNetR,
          row.baselineLabel,
          row.horizonEndAt,
          row.source,
        )
        inserted += result.changes
      }
    })
    tx(rows)
    return inserted
  }

  private hydrate(raw: Record<string, unknown>): TapeRow {
    return {
      id: Number(raw.id),
      at: Number(raw.at),
      symbol: String(raw.symbol),
      instType: String(raw.inst_type),
      timeframe: String(raw.timeframe),
      playbook: String(raw.playbook),
      side: String(raw.side) === 'SHORT' ? 'SHORT' : 'LONG',
      featureSchema: String(raw.feature_schema),
      features: JSON.parse(String(raw.features_json)) as number[],
      entry: Number(raw.entry),
      entryLow: Number(raw.entry_low),
      entryHigh: Number(raw.entry_high),
      stop: Number(raw.stop),
      targets: JSON.parse(String(raw.targets_json)) as { price: number; allocation: number }[],
      atr: Number(raw.atr),
      maxEntryBars: Number(raw.max_entry_bars),
      maxHoldBars: Number(raw.max_hold_bars),
      trailAtrMult: Number(raw.trail_atr_mult),
      feeBps: Number(raw.fee_bps),
      slippageBps: Number(raw.slippage_bps),
      fundingRate8h: raw.funding_rate_8h == null ? null : Number(raw.funding_rate_8h),
      regimeId: raw.regime_id == null ? null : Number(raw.regime_id),
      path: decodePath(raw.path_blob == null ? null : String(raw.path_blob)),
      baselineNetR: raw.baseline_net_r == null ? null : Number(raw.baseline_net_r),
      baselineLabel: raw.baseline_label == null ? null : Number(raw.baseline_label),
      horizonEndAt: Number(raw.horizon_end_at),
      source: String(raw.source),
    }
  }

  private where(query: TapeQuery): { sql: string; params: unknown[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (query.playbook) {
      clauses.push('playbook=?')
      params.push(query.playbook)
    }
    if (query.instType) {
      clauses.push('inst_type=?')
      params.push(query.instType)
    }
    if (query.timeframe) {
      clauses.push('timeframe=?')
      params.push(query.timeframe)
    }
    if (query.symbol) {
      clauses.push('symbol=?')
      params.push(query.symbol)
    }
    if (query.excludeSymbols?.length) {
      clauses.push(`symbol NOT IN (${query.excludeSymbols.map(() => '?').join(',')})`)
      params.push(...query.excludeSymbols)
    }
    if (query.featureSchema) {
      clauses.push('feature_schema=?')
      params.push(query.featureSchema)
    }
    if (query.fromAt != null) {
      clauses.push('at>=?')
      params.push(query.fromAt)
    }
    if (query.toAt != null) {
      clauses.push('at<=?')
      params.push(query.toAt)
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  list(query: TapeQuery = {}): TapeRow[] {
    const { sql, params } = this.where(query)
    const limit = Math.min(200_000, query.limit ?? 20_000)
    const rows = this.db
      .prepare(`SELECT * FROM decision_tape ${sql} ORDER BY at ${query.desc ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[]
    return rows.map((row) => this.hydrate(row))
  }

  /** Feature rows only — much cheaper than hydrating paths when training a classifier. */
  listLight(query: TapeQuery = {}): { at: number; symbol: string; features: number[]; netR: number; label: 0 | 1; horizonEndAt: number; regimeId: number | null }[] {
    const { sql, params } = this.where(query)
    const limit = Math.min(200_000, query.limit ?? 20_000)
    const rows = this.db
      .prepare(
        `SELECT at,symbol,features_json,baseline_net_r,baseline_label,horizon_end_at,regime_id FROM decision_tape ${sql} ORDER BY at ${query.desc ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[]
    return rows.map((row) => ({
      at: Number(row.at),
      symbol: String(row.symbol),
      features: JSON.parse(String(row.features_json)) as number[],
      netR: row.baseline_net_r == null ? 0 : Number(row.baseline_net_r),
      label: Number(row.baseline_label) === 1 ? (1 as const) : (0 as const),
      horizonEndAt: Number(row.horizon_end_at),
      regimeId: row.regime_id == null ? null : Number(row.regime_id),
    }))
  }

  count(query: TapeQuery = {}): number {
    const { sql, params } = this.where(query)
    return Number((this.db.prepare(`SELECT count(*) AS n FROM decision_tape ${sql}`).get(...params) as { n: number }).n)
  }

  /** Coverage matrix used by the exploration scheduler and the UI. */
  coverage(): {
    nicheKey: string
    playbook: string
    instType: string
    timeframe: string
    rows: number
    wins: number
    sumR: number
    symbols: number
    firstAt: number
    lastAt: number
  }[] {
    return (
      this.db
        .prepare(
          `SELECT playbook, inst_type, timeframe, count(*) AS rows, sum(baseline_label) AS wins,
                  COALESCE(sum(baseline_net_r),0) AS sum_r, count(DISTINCT symbol) AS symbols,
                  min(at) AS first_at, max(at) AS last_at
           FROM decision_tape GROUP BY playbook, inst_type, timeframe ORDER BY rows DESC`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      nicheKey: `${row.playbook}|${row.inst_type}|${row.timeframe}`,
      playbook: String(row.playbook),
      instType: String(row.inst_type),
      timeframe: String(row.timeframe),
      rows: Number(row.rows),
      wins: Number(row.wins ?? 0),
      sumR: Number(row.sum_r ?? 0),
      symbols: Number(row.symbols ?? 0),
      firstAt: Number(row.first_at ?? 0),
      lastAt: Number(row.last_at ?? 0),
    }))
  }

  symbols(query: TapeQuery = {}): string[] {
    const { sql, params } = this.where(query)
    return (this.db.prepare(`SELECT DISTINCT symbol FROM decision_tape ${sql} ORDER BY symbol`).all(...params) as { symbol: string }[]).map((row) => row.symbol)
  }

  cursor(key: string): number {
    const row = this.db.prepare('SELECT last_ts FROM tape_cursor WHERE key=?').get(key) as { last_ts: number } | undefined
    return row ? Number(row.last_ts) : 0
  }

  setCursor(key: string, lastTs: number) {
    this.db
      .prepare('INSERT INTO tape_cursor(key,last_ts,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET last_ts=excluded.last_ts, updated_at=excluded.updated_at')
      .run(key, lastTs, Date.now())
  }

  prune(beforeAt: number) {
    return this.db.prepare('DELETE FROM decision_tape WHERE at<?').run(beforeAt).changes
  }
}
