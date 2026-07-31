/**
 * Risk engine — stop placement, take-profit ladder, leverage, position size,
 * liquidation distance and expectancy. Volatility-aware and structure-aware:
 * the stop goes where the idea is wrong, not at an arbitrary percentage.
 */
import { clamp, floorToLot, roundToTick } from './math'
import type {
  EngineSettings,
  Indicators,
  InstrumentSpec,
  PlaybookId,
  RiskPlan,
  Side,
} from './types'

/** ATR stop multiplier per regime — wider stops when volatility expands. */
function stopAtrMultiplier(indicators: Indicators, playbook: PlaybookId | null) {
  const v = indicators.volatility
  let m = 1.5
  switch (v.regime) {
    case 'EXPANSION':
      m = 2.2
      break
    case 'TRENDING_UP':
    case 'TRENDING_DOWN':
      m = 1.8
      break
    case 'SQUEEZE':
      m = 1.2
      break
    case 'CHOPPY':
      m = 2.0
      break
    default:
      m = 1.6
  }
  if (playbook === 'mean_reversion' || playbook === 'range_fade') m *= 0.85
  if (playbook === 'squeeze_breakout') m *= 1.1
  // Very high ATR percentile means the market is already stretched: give room.
  if (v.atrPercentile > 85) m *= 1.15
  if (v.atrPercentile < 15) m *= 0.9
  return clamp(m, 0.9, 3)
}

/** Bars after which an idea that has not worked is stale. */
function timeStop(playbook: PlaybookId | null) {
  switch (playbook) {
    case 'mean_reversion':
    case 'range_fade':
      return 8
    case 'squeeze_breakout':
      return 6
    case 'divergence_reversal':
    case 'pattern_reversal':
      return 10
    default:
      return 18
  }
}

export interface BuildPlanInput {
  side: Side
  entry: number
  indicators: Indicators
  settings: EngineSettings
  spec: InstrumentSpec | null
  conviction: number
  playbook: PlaybookId | null
  equityUsd: number
}

export function buildRiskPlan(input: BuildPlanInput): RiskPlan {
  const { side, entry, indicators, settings, spec, conviction, playbook, equityUsd } = input
  const warnings: string[] = []
  const i = indicators
  const atr = i.volatility.atr > 0 ? i.volatility.atr : Math.max(entry * 0.003, 1e-9)
  const long = side === 'LONG'
  const dir = long ? 1 : -1

  /* ---- 1. Stop loss ---------------------------------------------------- */
  const mult = stopAtrMultiplier(i, playbook)
  const atrStop = entry - dir * mult * atr

  // Structural stop: just beyond the protective swing / level.
  const buffer = 0.35 * atr
  const structuralRef = long ? i.structure.swingLow : i.structure.swingHigh
  const structuralStop = long ? structuralRef - buffer : structuralRef + buffer

  // Trailing-system stop (Supertrend / Chandelier) as a third candidate.
  const systemStop = long
    ? Math.min(i.trend.supertrend, i.trend.chandelierLong)
    : Math.max(i.trend.supertrend, i.trend.chandelierShort)

  const candidates = [atrStop, structuralStop, systemStop].filter(
    (p) => Number.isFinite(p) && (long ? p < entry : p > entry),
  )
  // Take the *widest* sane candidate so noise cannot knock us out, then cap it.
  let stopLoss = candidates.length
    ? long
      ? Math.min(...candidates)
      : Math.max(...candidates)
    : atrStop

  let stopBasis =
    stopLoss === structuralStop
      ? 'structure swing + 0.35 ATR buffer'
      : stopLoss === systemStop
        ? 'trailing system (Supertrend/Chandelier)'
        : `${mult.toFixed(2)} × ATR`

  // Hard caps: never wider than 3.2 ATR, never tighter than 0.6 ATR / 0.12%.
  const maxDist = 3.2 * atr
  const minDist = Math.max(0.6 * atr, entry * 0.0012)
  let dist = Math.abs(entry - stopLoss)
  if (dist > maxDist) {
    stopLoss = entry - dir * maxDist
    dist = maxDist
    stopBasis = 'capped at 3.2 × ATR'
    warnings.push('Structural stop was too far; capped at 3.2 ATR.')
  }
  if (dist < minDist) {
    stopLoss = entry - dir * minDist
    dist = minDist
    stopBasis = 'widened to volatility floor (0.6 ATR)'
  }

  /* ---- 2. Take-profit ladder ------------------------------------------ */
  const minRr = clamp(settings.rrRatio, 1.2, 10)
  const opposing = long ? i.structure.nearestResistance : i.structure.nearestSupport
  const profileTarget = long
    ? Math.max(i.profile.vah, i.profile.poc)
    : Math.min(i.profile.val, i.profile.poc)
  const meanTarget = i.volume.vwap
  const rangeTarget = long ? i.structure.rangeHigh : i.structure.rangeLow
  const measured = entry + dir * Math.abs(i.structure.rangeHigh - i.structure.rangeLow) * 0.618

  const rrOf = (price: number) => (dist > 0 ? ((price - entry) * dir) / dist : 0)

  type Target = { price: number; basis: string }
  const pool: Target[] = []

  if (playbook === 'mean_reversion' || playbook === 'range_fade') {
    pool.push({ price: meanTarget, basis: 'VWAP reversion' })
    pool.push({ price: i.profile.poc, basis: 'volume POC' })
    pool.push({ price: rangeTarget, basis: 'range extreme' })
  } else {
    if (opposing) pool.push({ price: opposing.price, basis: `${opposing.source} level` })
    pool.push({ price: profileTarget, basis: 'value-area edge' })
    pool.push({ price: measured, basis: '0.618 measured move' })
    pool.push({ price: rangeTarget, basis: 'range extreme' })
  }
  // Pure R multiples always available as fallbacks.
  pool.push({ price: entry + dir * dist * minRr, basis: `${minRr.toFixed(1)}R` })
  pool.push({ price: entry + dir * dist * (minRr + 1.5), basis: `${(minRr + 1.5).toFixed(1)}R` })
  pool.push({ price: entry + dir * dist * (minRr + 3), basis: `${(minRr + 3).toFixed(1)}R` })

  const ladder = pool
    .filter((t) => Number.isFinite(t.price) && rrOf(t.price) >= 0.8)
    .sort((a, b) => rrOf(a.price) - rrOf(b.price))

  // Deduplicate targets that sit within 0.25R of each other.
  const chosen: Target[] = []
  for (const t of ladder) {
    if (chosen.some((c) => Math.abs(rrOf(c.price) - rrOf(t.price)) < 0.3)) continue
    chosen.push(t)
    if (chosen.length === 3) break
  }
  while (chosen.length < 3) {
    const r = minRr + chosen.length * 1.2
    chosen.push({ price: entry + dir * dist * r, basis: `${r.toFixed(1)}R` })
  }

  const allocations = [40, 35, 25]
  const takeProfits = chosen.map((t, idx) => ({
    price: t.price,
    rr: rrOf(t.price),
    allocationPct: allocations[idx],
    basis: t.basis,
  }))

  const expectedRr = takeProfits.reduce((s, t) => s + t.rr * (t.allocationPct / 100), 0)
  if (expectedRr < minRr * 0.6) {
    warnings.push(
      `Blended R:R ${expectedRr.toFixed(2)} is below the ${minRr.toFixed(1)} target — structure is capping upside.`,
    )
  }

  /* ---- 3. Leverage ----------------------------------------------------- */
  const maxLever = spec?.maxLever ?? settings.leverage
  // Volatility-targeted leverage: keep a stop-out to ~<40% of margin.
  const stopPct = (dist / entry) * 100
  const volCap = stopPct > 0 ? clamp(35 / stopPct, 1, 50) : settings.leverage
  const convictionCap = clamp((conviction / 100) * settings.leverage * 1.25, 1, settings.leverage)
  const leverage = Math.max(
    1,
    Math.floor(Math.min(settings.leverage, maxLever, volCap, convictionCap)),
  )
  if (leverage < settings.leverage) {
    warnings.push(
      `Leverage reduced to ${leverage}x (stop is ${stopPct.toFixed(2)}% away, conviction ${conviction.toFixed(0)}%).`,
    )
  }

  /* ---- 4. Position size ------------------------------------------------ */
  const riskPct = clamp(settings.riskPerTradePct, 0.05, 10)
  // Scale risk with conviction (half size at threshold, full at 90+).
  const convictionScale = clamp(0.5 + (conviction - settings.minConfidence) / 80, 0.3, 1)
  const riskUsdTarget = equityUsd * (riskPct / 100) * convictionScale

  const ctVal = spec?.ctVal ?? 1
  const lotSz = spec?.lotSz ?? 0.01
  const minSz = spec?.minSz ?? 0.01
  const tickSz = spec?.tickSz ?? 0.0001

  const lossPerContract = dist * ctVal
  let contracts = lossPerContract > 0 ? riskUsdTarget / lossPerContract : 0
  const maxNotional = equityUsd * leverage * 0.9
  const maxContracts = entry * ctVal > 0 ? maxNotional / (entry * ctVal) : 0
  if (contracts > maxContracts) {
    contracts = maxContracts
    warnings.push('Size capped by available margin, not by risk.')
  }
  contracts = floorToLot(contracts, lotSz)
  if (contracts < minSz) {
    contracts = 0
    warnings.push(
      `Risk budget is below one minimum lot (${minSz}). Increase equity or risk %, or pick a cheaper instrument.`,
    )
  }

  const notionalUsd = contracts * ctVal * entry
  const marginUsd = leverage > 0 ? notionalUsd / leverage : 0
  const riskUsd = contracts * lossPerContract

  /* ---- 5. Liquidation estimate (isolated margin) ----------------------- */
  const maintenanceRate = 0.005
  const liquidationEstimate =
    leverage > 1 ? entry * (1 - dir * (1 / leverage - maintenanceRate)) : null
  if (
    liquidationEstimate &&
    ((long && liquidationEstimate > stopLoss) || (!long && liquidationEstimate < stopLoss))
  ) {
    warnings.push(
      `Liquidation (${liquidationEstimate.toPrecision(6)}) sits before the stop — lower leverage.`,
    )
  }

  /* ---- 6. Expectancy --------------------------------------------------- */
  // Map conviction to a calibrated win probability (never above 72%).
  const winProbability = clamp(0.34 + (conviction / 100) * 0.36, 0.3, 0.72)
  const expectancyR = winProbability * expectedRr - (1 - winProbability)
  const kellyFraction = clamp(
    expectedRr > 0 ? winProbability - (1 - winProbability) / expectedRr : 0,
    0,
    0.25,
  )

  const breakevenTrigger = entry + dir * dist * 1
  const trailAtrMult = i.volatility.regime === 'EXPANSION' ? 2.5 : 1.8
  const entryPad = 0.25 * atr

  return {
    side,
    entry: roundToTick(entry, tickSz),
    entryZone: [
      roundToTick(long ? entry - entryPad : entry, tickSz),
      roundToTick(long ? entry : entry + entryPad, tickSz),
    ],
    stopLoss: roundToTick(stopLoss, tickSz),
    stopBasis,
    takeProfits: takeProfits.map((t) => ({ ...t, price: roundToTick(t.price, tickSz) })),
    expectedRr,
    riskDistance: dist,
    riskDistanceAtr: dist / atr,
    leverage,
    contracts,
    notionalUsd,
    marginUsd,
    riskUsd,
    liquidationEstimate: liquidationEstimate ? roundToTick(liquidationEstimate, tickSz) : null,
    breakevenTrigger: roundToTick(breakevenTrigger, tickSz),
    trailAtrMult,
    invalidation: roundToTick(
      long ? Math.min(stopLoss, i.structure.swingLow) : Math.max(stopLoss, i.structure.swingHigh),
      tickSz,
    ),
    timeStopBars: timeStop(playbook),
    winProbability,
    expectancyR,
    kellyFraction,
    warnings,
  }
}
