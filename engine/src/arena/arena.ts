/**
 * THE STRATEGY ARENA — where a model stops being a number and becomes a result.
 *
 * A specialist used to be judged on Brier score and AUC over a holdout of rows.
 * Those are proxies. They cannot answer the only question that matters: if this
 * model had been in charge, what would the equity curve have looked like, after
 * fees, after slippage, after funding, out of sample, on symbols it never saw?
 *
 * The arena answers exactly that, and it does it honestly:
 *
 *   • PURGED WALK-FORWARD. The tape is cut into chronological folds. For fold k the
 *     model trains only on rows whose LABEL was already knowable before the fold
 *     opens (overlapping financial labels are the classic leak), then it is scored
 *     on fold k and never sees it again.
 *   • NESTED SELECTION. The probability threshold and the exit variant are chosen on
 *     the training slice only. Choosing them on the test slice is how backtests lie.
 *   • BASELINE COMPARISON. Every run is reported against "take every candidate",
 *     because a model that cannot beat that adds nothing.
 *   • HELD-OUT SYMBOLS. A separate score on instruments excluded from every fold.
 *   • DEFLATED SHARPE. Corrected for how many variants were tried.
 *
 * Cost: the whole thing runs off the decision tape, so a full campaign over
 * 20 000 stored decisions with 8 exit variants takes well under a second.
 */
import type Database from 'better-sqlite3'
import type { TapeRow } from '../store/tape-store.js'
import { DEFAULT_VARIANT, EXIT_LIBRARY, simulateTapeRow, type ExitVariant } from './exit-sim.js'
import { computeMetrics, groupMetrics, EMPTY_METRICS, type PerformanceMetrics, type TradeSample } from './metrics.js'

export type Scorer = (features: readonly number[]) => number | null

export interface TrainedScorer {
  scorer: Scorer
  info: Record<string, unknown>
}

/** Given the training slice, produce a scorer. Return null to fall back to baseline. */
export type TrainFn = (rows: readonly TapeRow[]) => TrainedScorer | null

export interface ArenaConfig {
  label: string
  nicheKey: string
  folds: number
  /** minimum fraction of candidates the policy must still take (anti-overfit) */
  minCoverage: number
  /** candidate thresholds are searched on this quantile grid of train scores */
  thresholdGrid: number[]
  variants: ExitVariant[]
  holdoutSymbols: string[]
  /** extra time buffer added on top of the label-horizon purge, in ms */
  embargoMs: number
}

export const DEFAULT_ARENA_CONFIG: Omit<ArenaConfig, 'label' | 'nicheKey'> = {
  folds: 4,
  minCoverage: 0.12,
  thresholdGrid: [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85],
  variants: EXIT_LIBRARY,
  holdoutSymbols: [],
  embargoMs: 0,
}

export interface FoldReport {
  fold: number
  trainRows: number
  purgedRows: number
  testRows: number
  fromAt: number
  toAt: number
  threshold: number
  variantId: string
  coverage: number
  policy: PerformanceMetrics
  baseline: PerformanceMetrics
  trained: boolean
}

export interface ArenaReport {
  label: string
  nicheKey: string
  at: number
  rows: number
  symbols: number
  folds: FoldReport[]
  /** pooled out-of-sample result of the policy */
  policy: PerformanceMetrics
  /** pooled out-of-sample result of taking everything */
  baseline: PerformanceMetrics
  /** policy.meanR - baseline.meanR, the only number that proves selection adds value */
  meanRLift: number
  sumRLift: number
  holdout: PerformanceMetrics | null
  byRegime: { key: number; metrics: PerformanceMetrics }[]
  bySymbol: { key: string; metrics: PerformanceMetrics }[]
  byVariant: { id: string; label: string; metrics: PerformanceMetrics }[]
  byExitReason: { key: string; metrics: PerformanceMetrics }[]
  /** how many (threshold x variant) combinations were evaluated */
  trials: number
  /** every fold positive => the edge is not one lucky window */
  foldsPositive: number
  verdict: 'edge' | 'no_edge' | 'insufficient_data'
  reasons: string[]
  trades: (TradeSample & { exitReason: string; side: string })[]
  info: Record<string, unknown>
}

function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))
  return sorted[index]
}

function toTrade(row: TapeRow, variant: ExitVariant) {
  const result = simulateTapeRow(row, variant)
  return { row, result }
}

/**
 * Pick the exit variant that performed best on the TRAIN slice.
 * Selection uses every train candidate, not just the ones the model liked, so the
 * variant choice cannot borrow information from the model's own test behaviour.
 */
function bestVariantOnTrain(rows: readonly TapeRow[], variants: readonly ExitVariant[]): { variant: ExitVariant; metrics: PerformanceMetrics } {
  let best = { variant: variants[0] ?? DEFAULT_VARIANT, metrics: { ...EMPTY_METRICS } }
  let bestScore = -Infinity
  for (const variant of variants) {
    const samples: TradeSample[] = []
    for (const row of rows) {
      const { result } = toTrade(row, variant)
      if (!result.filled) continue
      samples.push({ at: row.at, netR: result.netR, barsHeld: result.barsHeld, symbol: row.symbol, regimeId: row.regimeId })
    }
    if (samples.length < 20) continue
    const metrics = computeMetrics(samples, variants.length)
    // Robust objective: reward expectancy, punish drawdown and low sample count.
    const score = metrics.meanR * Math.sqrt(metrics.trades) - metrics.maxDrawdownR * 0.02
    if (score > bestScore) {
      bestScore = score
      best = { variant, metrics }
    }
  }
  return best
}

function bestThresholdOnTrain(
  rows: readonly TapeRow[],
  scorer: Scorer,
  variant: ExitVariant,
  grid: readonly number[],
  minCoverage: number,
): { threshold: number; coverage: number } {
  const scored: { score: number; netR: number; at: number; barsHeld: number }[] = []
  for (const row of rows) {
    const score = scorer(row.features)
    if (score == null) continue
    const { result } = toTrade(row, variant)
    if (!result.filled) continue
    scored.push({ score, netR: result.netR, at: row.at, barsHeld: result.barsHeld })
  }
  if (scored.length < 30) return { threshold: 0, coverage: 1 }
  const scores = scored.map((row) => row.score)
  let best = { threshold: 0, coverage: 1, objective: -Infinity }
  for (const q of grid) {
    const threshold = quantile(scores, q)
    const taken = scored.filter((row) => row.score >= threshold)
    const coverage = taken.length / scored.length
    if (coverage < minCoverage || taken.length < 15) continue
    const metrics = computeMetrics(taken.map((row) => ({ at: row.at, netR: row.netR, barsHeld: row.barsHeld })), grid.length)
    const objective = metrics.meanR * Math.sqrt(metrics.trades)
    if (objective > best.objective) best = { threshold, coverage, objective }
  }
  return { threshold: best.threshold, coverage: best.coverage }
}

/**
 * Run a purged walk-forward campaign for one policy over one slice of the tape.
 */
export function runArena(allRows: readonly TapeRow[], train: TrainFn, config: ArenaConfig): ArenaReport {
  const at = Date.now()
  const holdoutSet = new Set(config.holdoutSymbols)
  const rows = allRows.filter((row) => !holdoutSet.has(row.symbol)).sort((a, b) => a.at - b.at)
  const holdoutRows = allRows.filter((row) => holdoutSet.has(row.symbol)).sort((a, b) => a.at - b.at)
  const symbols = new Set(rows.map((row) => row.symbol)).size

  const base: ArenaReport = {
    label: config.label,
    nicheKey: config.nicheKey,
    at,
    rows: rows.length,
    symbols,
    folds: [],
    policy: { ...EMPTY_METRICS },
    baseline: { ...EMPTY_METRICS },
    meanRLift: 0,
    sumRLift: 0,
    holdout: null,
    byRegime: [],
    bySymbol: [],
    byVariant: [],
    byExitReason: [],
    trials: config.thresholdGrid.length * config.variants.length,
    foldsPositive: 0,
    verdict: 'insufficient_data',
    reasons: [],
    trades: [],
    info: {},
  }

  const minPerFold = 40
  if (rows.length < minPerFold * 2) {
    base.reasons.push(`insufficient_rows(${rows.length})`)
    return base
  }

  const folds = Math.max(2, Math.min(config.folds, Math.floor(rows.length / minPerFold)))
  const foldSize = Math.floor(rows.length / (folds + 1))
  const policyTrades: (TradeSample & { exitReason: string; side: string })[] = []
  const baselineTrades: TradeSample[] = []
  const foldReports: FoldReport[] = []
  let lastScorer: Scorer | null = null
  let lastInfo: Record<string, unknown> = {}
  let lastVariant: ExitVariant = DEFAULT_VARIANT
  let lastThreshold = 0

  for (let fold = 0; fold < folds; fold++) {
    const trainEnd = foldSize * (fold + 1)
    const testStart = trainEnd
    const testEnd = fold === folds - 1 ? rows.length : foldSize * (fold + 2)
    const testSlice = rows.slice(testStart, testEnd)
    if (testSlice.length < 15) continue
    const testOpensAt = testSlice[0].at
    const trainPool = rows.slice(0, trainEnd)
    // PURGE: only rows whose label was resolved before the test window opens.
    const trainSlice = trainPool.filter((row) => row.horizonEndAt + config.embargoMs < testOpensAt)
    const purgedRows = trainPool.length - trainSlice.length
    if (trainSlice.length < 40) continue

    const { variant } = bestVariantOnTrain(trainSlice, config.variants)
    const trained = train(trainSlice)
    const scorer: Scorer = trained?.scorer ?? (() => 1)
    const { threshold, coverage } = trained
      ? bestThresholdOnTrain(trainSlice, scorer, variant, config.thresholdGrid, config.minCoverage)
      : { threshold: 0, coverage: 1 }

    lastScorer = trained?.scorer ?? null
    lastInfo = trained?.info ?? {}
    lastVariant = variant
    lastThreshold = threshold

    const foldPolicy: TradeSample[] = []
    const foldBaseline: TradeSample[] = []
    let taken = 0
    let evaluated = 0
    for (const row of testSlice) {
      const { result } = toTrade(row, variant)
      if (!result.filled) continue
      evaluated++
      const sample: TradeSample = { at: row.at, netR: result.netR, barsHeld: result.barsHeld, symbol: row.symbol, regimeId: row.regimeId, playbook: row.playbook }
      foldBaseline.push(sample)
      const score = scorer(row.features)
      if (score == null || score < threshold) continue
      taken++
      foldPolicy.push(sample)
      policyTrades.push({ ...sample, exitReason: result.exitReason, side: row.side })
    }
    baselineTrades.push(...foldBaseline)

    foldReports.push({
      fold,
      trainRows: trainSlice.length,
      purgedRows,
      testRows: testSlice.length,
      fromAt: testSlice[0].at,
      toAt: testSlice[testSlice.length - 1].at,
      threshold,
      variantId: variant.id,
      coverage: evaluated ? taken / evaluated : 0,
      policy: computeMetrics(foldPolicy, base.trials),
      baseline: computeMetrics(foldBaseline, 1),
      trained: Boolean(trained),
    })
  }

  if (!foldReports.length) {
    base.reasons.push('no_usable_folds')
    return base
  }

  const policy = computeMetrics(policyTrades, base.trials)
  const baseline = computeMetrics(baselineTrades, 1)

  /* held-out symbols, scored with the LAST trained model (the one that would ship) */
  let holdout: PerformanceMetrics | null = null
  if (holdoutRows.length >= 20) {
    const samples: TradeSample[] = []
    for (const row of holdoutRows) {
      const { result } = toTrade(row, lastVariant)
      if (!result.filled) continue
      const score = lastScorer ? lastScorer(row.features) : 1
      if (score == null || score < lastThreshold) continue
      samples.push({ at: row.at, netR: result.netR, barsHeld: result.barsHeld, symbol: row.symbol, regimeId: row.regimeId })
    }
    holdout = computeMetrics(samples, base.trials)
  }

  /* variant leaderboard over the whole tape — diagnostic only, clearly in-sample */
  const byVariant = config.variants
    .map((variant) => {
      const samples: TradeSample[] = []
      for (const row of rows) {
        const { result } = toTrade(row, variant)
        if (!result.filled) continue
        samples.push({ at: row.at, netR: result.netR, barsHeld: result.barsHeld, symbol: row.symbol, regimeId: row.regimeId })
      }
      return { id: variant.id, label: variant.label, metrics: computeMetrics(samples, config.variants.length) }
    })
    .sort((a, b) => b.metrics.meanR - a.metrics.meanR)

  const reasons: string[] = []
  const foldsPositive = foldReports.filter((fold) => fold.policy.sumR > 0).length
  if (policy.trades < 30) reasons.push(`too_few_oos_trades(${policy.trades})`)
  if (policy.meanR <= 0) reasons.push(`mean_r_${policy.meanR.toFixed(3)}_not_positive`)
  if (policy.meanR <= baseline.meanR) reasons.push(`no_lift_over_baseline(${policy.meanR.toFixed(3)}<=${baseline.meanR.toFixed(3)})`)
  if (foldsPositive < Math.ceil(foldReports.length / 2)) reasons.push(`only_${foldsPositive}/${foldReports.length}_folds_positive`)
  if (policy.pValue > 0.1) reasons.push(`p_value_${policy.pValue.toFixed(3)}_too_weak`)
  if (holdout && holdout.trades >= 20 && holdout.meanR <= 0) reasons.push(`holdout_mean_r_${holdout.meanR.toFixed(3)}`)

  return {
    ...base,
    folds: foldReports,
    policy,
    baseline,
    meanRLift: policy.meanR - baseline.meanR,
    sumRLift: policy.sumR - baseline.sumR,
    holdout,
    byRegime: groupMetrics(policyTrades, (trade) => trade.regimeId ?? null),
    bySymbol: groupMetrics(policyTrades, (trade) => trade.symbol ?? null).slice(0, 40),
    byVariant,
    byExitReason: groupMetrics(policyTrades, (trade) => (trade as { exitReason?: string }).exitReason ?? null),
    foldsPositive,
    verdict: reasons.length ? 'no_edge' : 'edge',
    reasons,
    trades: policyTrades.slice(-800),
    info: { ...lastInfo, variant: lastVariant.id, threshold: lastThreshold },
  }
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

export function migrateArenaSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      niche_key TEXT NOT NULL,
      label TEXT NOT NULL,
      artifact_hash TEXT,
      kind TEXT NOT NULL DEFAULT 'walkforward',
      verdict TEXT NOT NULL,
      rows INTEGER NOT NULL,
      oos_trades INTEGER NOT NULL,
      mean_r REAL NOT NULL,
      sum_r REAL NOT NULL,
      baseline_mean_r REAL NOT NULL,
      mean_r_lift REAL NOT NULL,
      sharpe REAL NOT NULL,
      deflated_sharpe REAL NOT NULL,
      max_dd_r REAL NOT NULL,
      win_rate REAL NOT NULL,
      p_value REAL NOT NULL,
      folds_positive INTEGER NOT NULL,
      folds_total INTEGER NOT NULL,
      report_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS arena_runs_niche ON arena_runs(niche_key, at DESC);
    CREATE INDEX IF NOT EXISTS arena_runs_artifact ON arena_runs(artifact_hash, at DESC);
  `)
}

export class ArenaStore {
  constructor(readonly db: Database.Database) {
    migrateArenaSchema(db)
  }

  save(report: ArenaReport, artifactHash: string | null, kind = 'walkforward'): number {
    const result = this.db
      .prepare(
        `INSERT INTO arena_runs(at,niche_key,label,artifact_hash,kind,verdict,rows,oos_trades,mean_r,sum_r,baseline_mean_r,mean_r_lift,
           sharpe,deflated_sharpe,max_dd_r,win_rate,p_value,folds_positive,folds_total,report_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        report.at,
        report.nicheKey,
        report.label,
        artifactHash,
        kind,
        report.verdict,
        report.rows,
        report.policy.trades,
        report.policy.meanR,
        report.policy.sumR,
        report.baseline.meanR,
        report.meanRLift,
        report.policy.sharpe,
        report.policy.deflatedSharpe,
        report.policy.maxDrawdownR,
        report.policy.winRate,
        report.policy.pValue,
        report.foldsPositive,
        report.folds.length,
        JSON.stringify(compactReport(report)),
      )
    return Number(result.lastInsertRowid)
  }

  list(limit = 60, nicheKey?: string) {
    const rows = nicheKey
      ? (this.db.prepare('SELECT * FROM arena_runs WHERE niche_key=? ORDER BY at DESC LIMIT ?').all(nicheKey, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM arena_runs ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[])
    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      nicheKey: String(row.niche_key),
      label: String(row.label),
      artifactHash: row.artifact_hash == null ? null : String(row.artifact_hash),
      kind: String(row.kind),
      verdict: String(row.verdict),
      rows: Number(row.rows),
      oosTrades: Number(row.oos_trades),
      meanR: Number(row.mean_r),
      sumR: Number(row.sum_r),
      baselineMeanR: Number(row.baseline_mean_r),
      meanRLift: Number(row.mean_r_lift),
      sharpe: Number(row.sharpe),
      deflatedSharpe: Number(row.deflated_sharpe),
      maxDrawdownR: Number(row.max_dd_r),
      winRate: Number(row.win_rate),
      pValue: Number(row.p_value),
      foldsPositive: Number(row.folds_positive),
      foldsTotal: Number(row.folds_total),
    }))
  }

  get(id: number) {
    const row = this.db.prepare('SELECT * FROM arena_runs WHERE id=?').get(id) as Record<string, unknown> | undefined
    if (!row) return null
    return { id: Number(row.id), at: Number(row.at), nicheKey: String(row.niche_key), report: JSON.parse(String(row.report_json)) as ReturnType<typeof compactReport> }
  }

  latestFor(artifactHash: string) {
    const row = this.db.prepare('SELECT * FROM arena_runs WHERE artifact_hash=? ORDER BY at DESC LIMIT 1').get(artifactHash) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: Number(row.id),
      at: Number(row.at),
      verdict: String(row.verdict),
      oosTrades: Number(row.oos_trades),
      meanR: Number(row.mean_r),
      sumR: Number(row.sum_r),
      meanRLift: Number(row.mean_r_lift),
      sharpe: Number(row.sharpe),
      deflatedSharpe: Number(row.deflated_sharpe),
      maxDrawdownR: Number(row.max_dd_r),
      winRate: Number(row.win_rate),
      pValue: Number(row.p_value),
      foldsPositive: Number(row.folds_positive),
      foldsTotal: Number(row.folds_total),
    }
  }

  prune(keep = 500) {
    return this.db.prepare('DELETE FROM arena_runs WHERE id NOT IN (SELECT id FROM arena_runs ORDER BY at DESC LIMIT ?)').run(keep).changes
  }
}

/** Trim the report so a run row stays a few kilobytes, not a megabyte. */
function compactReport(report: ArenaReport) {
  const slim = (metrics: PerformanceMetrics, points = 240) => ({
    ...metrics,
    equity: metrics.equity.length > points ? metrics.equity.filter((_, index) => index % Math.ceil(metrics.equity.length / points) === 0) : metrics.equity,
  })
  return {
    ...report,
    policy: slim(report.policy),
    baseline: slim(report.baseline),
    holdout: report.holdout ? slim(report.holdout, 120) : null,
    folds: report.folds.map((fold) => ({ ...fold, policy: slim(fold.policy, 60), baseline: slim(fold.baseline, 60) })),
    byRegime: report.byRegime.map((row) => ({ ...row, metrics: slim(row.metrics, 40) })),
    bySymbol: report.bySymbol.map((row) => ({ ...row, metrics: slim(row.metrics, 0) })),
    byVariant: report.byVariant.map((row) => ({ ...row, metrics: slim(row.metrics, 40) })),
    byExitReason: report.byExitReason.map((row) => ({ ...row, metrics: slim(row.metrics, 0) })),
    trades: report.trades.slice(-400),
  }
}
