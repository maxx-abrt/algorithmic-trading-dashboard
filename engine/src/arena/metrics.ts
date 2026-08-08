/**
 * Performance statistics for a set of simulated or real trades.
 *
 * Everything here is expressed in R (risk units) so results are comparable across
 * instruments, timeframes and account sizes. Nothing is annualised with a magic
 * constant: the Sharpe is a per-trade Sharpe scaled by the observed trade rate,
 * which is the only honest way to compare a 15m scalper with a 4H swing model.
 */

export interface TradeSample {
  at: number
  netR: number
  barsHeld: number
  symbol?: string
  regimeId?: number | null
  playbook?: string
}

export interface PerformanceMetrics {
  trades: number
  wins: number
  winRate: number
  meanR: number
  medianR: number
  sumR: number
  stdevR: number
  /** per-trade Sharpe (meanR / stdevR) */
  sharpe: number
  /** downside-only variant */
  sortino: number
  /** Sharpe corrected for the number of strategies tried (Bailey & Lopez de Prado) */
  deflatedSharpe: number
  maxDrawdownR: number
  /** sumR / maxDrawdownR */
  calmar: number
  profitFactor: number
  expectancyR: number
  avgWinR: number
  avgLossR: number
  payoff: number
  /** Newey-West-free t statistic of meanR */
  tStat: number
  /** two-sided p value from the t statistic */
  pValue: number
  avgBarsHeld: number
  bestR: number
  worstR: number
  /** longest streak of losing trades */
  maxLossStreak: number
  equity: { at: number; equityR: number }[]
}

export const EMPTY_METRICS: PerformanceMetrics = {
  trades: 0,
  wins: 0,
  winRate: 0,
  meanR: 0,
  medianR: 0,
  sumR: 0,
  stdevR: 0,
  sharpe: 0,
  sortino: 0,
  deflatedSharpe: 0,
  maxDrawdownR: 0,
  calmar: 0,
  profitFactor: 0,
  expectancyR: 0,
  avgWinR: 0,
  avgLossR: 0,
  payoff: 0,
  tStat: 0,
  pValue: 1,
  avgBarsHeld: 0,
  bestR: 0,
  worstR: 0,
  maxLossStreak: 0,
  equity: [],
}

/** Abramowitz & Stegun 7.1.26 error function — enough precision for a p value. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return sign * y
}

const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

export function computeMetrics(trades: readonly TradeSample[], trialsTried = 1): PerformanceMetrics {
  const n = trades.length
  if (!n) return { ...EMPTY_METRICS }
  const ordered = [...trades].sort((a, b) => a.at - b.at)
  const returns = ordered.map((trade) => trade.netR)
  const sumR = returns.reduce((sum, value) => sum + value, 0)
  const meanR = sumR / n
  const sorted = [...returns].sort((a, b) => a - b)
  const medianR = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  const variance = n > 1 ? returns.reduce((sum, value) => sum + (value - meanR) ** 2, 0) / (n - 1) : 0
  const stdevR = Math.sqrt(variance)
  const downside = returns.filter((value) => value < 0)
  const downsideDeviation = downside.length ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length) : 0

  const wins = returns.filter((value) => value > 0)
  const losses = returns.filter((value) => value <= 0)
  const grossWin = wins.reduce((sum, value) => sum + value, 0)
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0))

  let equityR = 0
  let peak = 0
  let maxDrawdownR = 0
  const equity: { at: number; equityR: number }[] = []
  let lossStreak = 0
  let maxLossStreak = 0
  for (const trade of ordered) {
    equityR += trade.netR
    peak = Math.max(peak, equityR)
    maxDrawdownR = Math.max(maxDrawdownR, peak - equityR)
    equity.push({ at: trade.at, equityR: Number(equityR.toFixed(4)) })
    if (trade.netR <= 0) {
      lossStreak++
      maxLossStreak = Math.max(maxLossStreak, lossStreak)
    } else lossStreak = 0
  }

  const sharpe = stdevR > 1e-9 ? meanR / stdevR : 0
  const sortino = downsideDeviation > 1e-9 ? meanR / downsideDeviation : sharpe
  const tStat = stdevR > 1e-9 ? (meanR / stdevR) * Math.sqrt(n) : 0
  const pValue = Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(tStat)))))

  // Deflated Sharpe: the expected maximum Sharpe of `trials` independent random
  // strategies is subtracted, so a search that tried 200 masks cannot brag about
  // the luckiest one.
  const trials = Math.max(1, trialsTried)
  const euler = 0.5772156649
  const expectedMax =
    trials > 1
      ? (1 - euler) * inverseNormal(1 - 1 / trials) + euler * inverseNormal(1 - 1 / (trials * Math.E))
      : 0
  const deflatedSharpe = stdevR > 1e-9 && n > 2 ? Math.max(0, normalCdf(((sharpe - expectedMax / Math.sqrt(n)) * Math.sqrt(n - 1)) / Math.sqrt(1 - 0 * sharpe))) : 0

  return {
    trades: n,
    wins: wins.length,
    winRate: wins.length / n,
    meanR,
    medianR,
    sumR,
    stdevR,
    sharpe,
    sortino,
    deflatedSharpe,
    maxDrawdownR,
    calmar: maxDrawdownR > 1e-9 ? sumR / maxDrawdownR : sumR > 0 ? Infinity : 0,
    profitFactor: grossLoss > 1e-9 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancyR: meanR,
    avgWinR: wins.length ? grossWin / wins.length : 0,
    avgLossR: losses.length ? -grossLoss / losses.length : 0,
    payoff: losses.length && grossLoss > 0 ? grossWin / wins.length / (grossLoss / losses.length) : 0,
    tStat,
    pValue,
    avgBarsHeld: ordered.reduce((sum, trade) => sum + trade.barsHeld, 0) / n,
    bestR: sorted[n - 1],
    worstR: sorted[0],
    maxLossStreak,
    equity,
  }
}

/** Acklam's inverse normal CDF approximation. */
function inverseNormal(p: number): number {
  if (p <= 0) return -6
  if (p >= 1) return 6
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const plow = 0.02425
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Group metrics by an arbitrary key (regime, symbol, playbook, hour of day…). */
export function groupMetrics<T extends string | number>(trades: readonly TradeSample[], keyOf: (trade: TradeSample) => T | null): { key: T; metrics: PerformanceMetrics }[] {
  const buckets = new Map<T, TradeSample[]>()
  for (const trade of trades) {
    const key = keyOf(trade)
    if (key == null) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.push(trade)
    else buckets.set(key, [trade])
  }
  return [...buckets.entries()].map(([key, rows]) => ({ key, metrics: computeMetrics(rows) })).sort((a, b) => b.metrics.sumR - a.metrics.sumR)
}
