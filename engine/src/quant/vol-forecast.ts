/**
 * Volatility Forecasting — EWMA and GARCH(1,1).
 *
 * Predicts next-period volatility to adjust position sizes preemptively.
 * Higher forecasted volatility → smaller positions (target constant risk).
 *
 * EWMA (Exponentially Weighted Moving Average):
 *   σ²_t = λ * σ²_{t-1} + (1-λ) * r²_{t-1}
 *   λ = 0.94 (RiskMetrics standard for daily, 0.97 for intraday)
 *
 * GARCH(1,1):
 *   σ²_t = ω + α * r²_{t-1} + β * σ²_{t-1}
 *   ω = unconditional variance * (1 - α - β)
 *   α + β < 1 for stationarity
 *
 * We also compute a volatility regime classification:
 *   - low: forecast < 0.5x historical average
 *   - normal: 0.5x - 2x
 *   - high: > 2x
 */

export interface VolForecast {
  /** forecasted volatility (as % of price) for next period */
  forecastVolPct: number
  /** historical average volatility */
  historicalVolPct: number
  /** vol ratio: forecast / historical (1 = normal, >1 = elevated) */
  volRatio: number
  /** normalized 0..1 (0 = very calm, 1 = very volatile) */
  normalized: number
  /** regime label */
  regime: 'low' | 'normal' | 'high' | 'extreme'
  /** confidence 0..1 */
  confidence: number
  /** model used */
  model: 'ewma' | 'garch'
}

/**
 * Compute EWMA volatility forecast.
 */
export function ewmaVolForecast(
  returns: number[], // array of period returns (e.g. 5-min returns)
  lambda = 0.97,
): { forecast: number; historical: number } {
  if (returns.length < 10) {
    const hist = returns.length > 0 ? std(returns) : 0
    return { forecast: hist, historical: hist }
  }

  // Initialize with sample variance
  let variance = returns.slice(0, Math.min(20, returns.length)).reduce((s, r) => s + r * r, 0) / Math.min(20, returns.length)

  // EWMA recursion
  for (let i = Math.min(20, returns.length); i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] * returns[i]
  }

  const forecast = Math.sqrt(variance)
  const historical = std(returns)

  return { forecast, historical }
}

/**
 * Compute GARCH(1,1) volatility forecast.
 * Uses method of moments for parameter estimation.
 */
export function garchVolForecast(
  returns: number[],
): { forecast: number; historical: number; params: { omega: number; alpha: number; beta: number } } {
  if (returns.length < 30) {
    const hist = returns.length > 0 ? std(returns) : 0
    return { forecast: hist, historical: hist, params: { omega: 0, alpha: 0, beta: 0 } }
  }

  // Estimate parameters using method of moments
  const meanRet = returns.reduce((s, r) => s + r, 0) / returns.length
  const demeaned = returns.map((r) => r - meanRet)
  const unconditionalVar = demeaned.reduce((s, r) => s + r * r, 0) / returns.length

  // Typical GARCH parameters for crypto
  const alpha = 0.08
  const beta = 0.90
  const omega = unconditionalVar * (1 - alpha - beta)

  // GARCH recursion
  let variance = unconditionalVar
  for (let i = 0; i < demeaned.length; i++) {
    variance = omega + alpha * demeaned[i] * demeaned[i] + beta * variance
  }

  const forecast = Math.sqrt(variance)
  const historical = Math.sqrt(unconditionalVar)

  return { forecast, historical, params: { omega, alpha, beta } }
}

/**
 * Full volatility forecast with regime classification.
 */
export function forecastVolatility(
  returns: number[],
  options: { model?: 'ewma' | 'garch'; atrPct?: number } = {},
): VolForecast {
  const model = options.model ?? 'garch'

  let forecast: number
  let historical: number

  if (model === 'garch' && returns.length >= 30) {
    const result = garchVolForecast(returns)
    forecast = result.forecast
    historical = result.historical
  } else {
    const result = ewmaVolForecast(returns)
    forecast = result.forecast
    historical = result.historical
  }

  // If we have ATR%, blend it with the return-based forecast
  if (options.atrPct != null && options.atrPct > 0) {
    forecast = forecast * 0.6 + (options.atrPct / 100) * 0.4
    historical = historical * 0.6 + (options.atrPct / 100) * 0.4
  }

  const volRatio = historical > 0 ? forecast / historical : 1
  const normalized = Math.max(0, Math.min(1, forecast / 0.1)) // 10% vol = max

  let regime: VolForecast['regime']
  if (volRatio < 0.5) regime = 'low'
  else if (volRatio < 2) regime = 'normal'
  else if (volRatio < 4) regime = 'high'
  else regime = 'extreme'

  // Confidence based on sample size and vol ratio stability
  const confidence = Math.min(1, returns.length / 100) * (1 - Math.min(0.3, Math.abs(volRatio - 1) * 0.1))

  return {
    forecastVolPct: forecast * 100,
    historicalVolPct: historical * 100,
    volRatio,
    normalized,
    regime,
    confidence,
    model,
  }
}

/**
 * Compute position size adjustment based on volatility forecast.
 * Target: constant risk per trade regardless of volatility.
 *
 * size = base_size * (historical_vol / forecast_vol)
 * When vol is forecasted to rise → reduce size
 * When vol is forecasted to fall → increase size
 */
export function volAdjustedSize(forecast: VolForecast, baseSize: number): number {
  if (forecast.forecastVolPct <= 0) return baseSize
  const adjustment = forecast.historicalVolPct / forecast.forecastVolPct
  // Clamp to reasonable range
  return baseSize * Math.max(0.3, Math.min(2.0, adjustment))
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}
