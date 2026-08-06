/**
 * Risk engine — stop placement, take-profit ladder, leverage, position size,
 * liquidation distance, cost-adjusted expectancy and balance-aware sizing.
 *
 * Design rule: the stop goes where the idea is *wrong*, never at an arbitrary
 * percentage, and every number the user sees is net of the costs they will
 * actually pay (taker fees, funding, spread slippage).
 */
import { clamp, floorToLot, roundToTick } from './math'
import type { EdgeBlock } from './edge'
import type { SessionInfo } from './sessions'
import type { CalibratedLinearModel } from '../research/calibration'
import { predictCalibrated } from '../research/calibration'
import { buildFeatureVector } from '../research/features'
import type { CrossAssetData } from './cross-asset'
import type { OnChainData } from './onchain'
import type { OrderBookSnapshot } from './orderbook'
import type { VolForecast } from './vol-forecast'
import type { RegimeInfo } from './regime'
import type {
  DerivativesBlock,
  EngineSettings,
  Indicators,
  InstrumentSpec,
  PlaybookId,
  RiskPlan,
  Side,
} from './types'

/** ATR stop multiplier per regime — wider stops when volatility expands. */
export function stopAtrMultiplier(indicators: Indicators, playbook: PlaybookId | null) {
  const v = indicators.volatility
  let m = 1.5
  switch (v.regime) {
    case 'EXPANSION':
      m = 2.2
      break
    case 'CAPITULATION':
      m = 2.6
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
  if (v.atrPercentile > 85) m *= 1.15
  if (v.atrPercentile < 15) m *= 0.9
  // A rising volatility forecast means the stop must breathe more.
  if (indicators.xvol?.volTrend === 'rising') m *= 1.08
  return clamp(m, 0.9, 3)
}

/** Bars after which an idea that has not worked is stale. */
export function timeStop(playbook: PlaybookId | null) {
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
  derivatives?: DerivativesBlock | null
  edge?: EdgeBlock | null
  session?: SessionInfo | null
  /** free collateral from the real OKX balance, when read-only keys exist */
  availableUsd?: number | null
  barMinutes?: number
  /** calibrated champion model for win-probability blending */
  championModel?: CalibratedLinearModel | null
  /** playbook score from evaluateStrategies, used as a champion feature */
  playbookScore?: number
  /** composite score from the analysis, used as a champion feature */
  compositeScore?: number
  /** mtf alignment from the analysis, used as a champion feature */
  mtfAlignment?: number
  /** market context for champion feature vector */
  marketContext?: { fearGreedIndex: number | null; sentimentScore: number | null; btcDominance: number | null; marketCapChange24h: number | null } | null
  /** cross-asset signals for expanded feature vector */
  crossAsset?: CrossAssetData | null
  /** on-chain metrics for expanded feature vector */
  onChain?: OnChainData | null
  /** order book snapshot for microstructure features */
  orderBook?: OrderBookSnapshot | null
  /** volatility forecast from GARCH/EWMA */
  volForecast?: VolForecast | null
  /** market regime classification */
  regimeInfo?: RegimeInfo | null
}

function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return '$0'
  const abs = Math.abs(n)
  if (abs >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `$${n.toFixed(2)}`
}

export function buildRiskPlan(input: BuildPlanInput): RiskPlan {
  const {
    side,
    entry,
    indicators,
    settings,
    spec,
    conviction,
    playbook,
    equityUsd,
    derivatives,
    edge,
    session,
  } = input
  const warnings: string[] = []
  const i = indicators
  const atr = i.volatility.atr > 0 ? i.volatility.atr : Math.max(entry * 0.003, 1e-9)
  const long = side === 'LONG'
  const dir = long ? 1 : -1
  const barMinutes = input.barMinutes ?? 15

  /* ---- 1. Stop loss ---------------------------------------------------- */
  const mult = stopAtrMultiplier(i, playbook)
  const atrStop = entry - dir * mult * atr

  const buffer = 0.35 * atr
  const structuralRef = long ? i.structure.swingLow : i.structure.swingHigh
  const structuralStop = long ? structuralRef - buffer : structuralRef + buffer

  const systemStop = long
    ? Math.min(i.trend.supertrend, i.trend.chandelierLong)
    : Math.max(i.trend.supertrend, i.trend.chandelierShort)

  const candidates = [atrStop, structuralStop, systemStop].filter(
    (p) => Number.isFinite(p) && (long ? p < entry : p > entry),
  )
  let stopLoss = candidates.length ? (long ? Math.min(...candidates) : Math.max(...candidates)) : atrStop

  let stopBasis =
    stopLoss === structuralStop
      ? 'structure swing + 0.35 ATR buffer'
      : stopLoss === systemStop
        ? 'trailing system (Supertrend/Chandelier)'
        : `${mult.toFixed(2)} × ATR`

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
  const profileTarget = long ? Math.max(i.profile.vah, i.profile.poc) : Math.min(i.profile.val, i.profile.poc)
  const meanTarget = i.volume.vwap
  const rangeTarget = long ? i.structure.rangeHigh : i.structure.rangeLow
  const measured = entry + dir * Math.abs(i.structure.rangeHigh - i.structure.rangeLow) * 0.618
  const channelTarget = long ? i.stats.regUpper : i.stats.regLower
  const donchianTarget = long ? i.xtrend.donchianUpper : i.xtrend.donchianLower

  const rrOf = (price: number) => (dist > 0 ? ((price - entry) * dir) / dist : 0)

  type Target = { price: number; basis: string }
  const pool: Target[] = []

  if (playbook === 'mean_reversion' || playbook === 'range_fade') {
    pool.push({ price: meanTarget, basis: 'VWAP reversion' })
    pool.push({ price: i.profile.poc, basis: 'volume POC' })
    pool.push({ price: i.stats.regMid, basis: 'regression mean' })
    pool.push({ price: rangeTarget, basis: 'range extreme' })
  } else {
    if (opposing) pool.push({ price: opposing.price, basis: `${opposing.source} level` })
    pool.push({ price: profileTarget, basis: 'value-area edge' })
    pool.push({ price: donchianTarget, basis: '20-bar Donchian edge' })
    pool.push({ price: measured, basis: '0.618 measured move' })
    pool.push({ price: channelTarget, basis: 'regression 2σ channel' })
    pool.push({ price: rangeTarget, basis: 'range extreme' })
  }
  pool.push({ price: entry + dir * dist * minRr, basis: `${minRr.toFixed(1)}R` })
  pool.push({ price: entry + dir * dist * (minRr + 1.5), basis: `${(minRr + 1.5).toFixed(1)}R` })
  pool.push({ price: entry + dir * dist * (minRr + 3), basis: `${(minRr + 3).toFixed(1)}R` })

  const ladder = pool
    .filter((t) => Number.isFinite(t.price) && rrOf(t.price) >= 0.8)
    .sort((a, b) => rrOf(a.price) - rrOf(b.price))

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

  /* ---- 3. Time to target, sanity-checked against the vol forecast ------ */
  const tp1DistPct = Math.abs(takeProfits[0].price - entry) / entry * 100
  const sigmaPct = i.xvol.forecastBarSigmaPct > 0 ? i.xvol.forecastBarSigmaPct : i.volatility.atrPct * 0.7
  // Random-walk scaling: bars ≈ (distance / σ)²
  const expectedBarsToTarget = clamp(Math.round((tp1DistPct / Math.max(sigmaPct, 1e-6)) ** 2), 1, 400)
  const bars = timeStop(playbook)
  if (expectedBarsToTarget > bars * 2.5) {
    warnings.push(
      `At the current ${sigmaPct.toFixed(2)}%/bar volatility, TP1 needs ~${expectedBarsToTarget} bars but the time stop is ${bars} — expect to be cut early.`,
    )
  }

  /* ---- 4. Leverage ----------------------------------------------------- */
  const maxLever = spec?.maxLever ?? settings.leverage
  const stopPct = (dist / entry) * 100
  const volCap = stopPct > 0 ? clamp(35 / stopPct, 1, 50) : settings.leverage
  const convictionCap = clamp((conviction / 100) * settings.leverage * 1.25, 1, settings.leverage)
  const sessionCap = session && session.isEquity && !session.marketOpen ? Math.max(1, settings.leverage * 0.5) : settings.leverage
  const leverage = Math.max(
    1,
    Math.floor(Math.min(settings.leverage, maxLever, volCap, convictionCap, sessionCap)),
  )
  if (leverage < settings.leverage) {
    warnings.push(
      `Leverage capped at ${leverage}× (stop ${stopPct.toFixed(2)}% away, conviction ${conviction.toFixed(0)}%${
        sessionCap < settings.leverage ? ', underlying market closed' : ''
      }).`,
    )
  }

  /* ---- 5. Position size ------------------------------------------------ */
  const riskPct = clamp(settings.riskPerTradePct, 0.05, 10)
  const convictionScale = clamp(0.5 + (conviction - settings.minConfidence) / 80, 0.3, 1)
  const edgeScale = edge && edge.sample >= 12 ? clamp(0.7 + (edge.adjustedWinRate - 42) / 60, 0.5, 1.25) : 1
  const sessionScale = session ? clamp(session.liquidityFactor, 0.35, 1) : 1
  const riskUsdTarget = equityUsd * (riskPct / 100) * convictionScale * edgeScale * sessionScale

  const ctVal = spec?.ctVal ?? 1
  const lotSz = spec?.lotSz ?? 0.01
  const minSz = spec?.minSz ?? 0.01
  const tickSz = spec?.tickSz ?? 0.0001

  const lossPerContract = dist * ctVal
  let contracts = lossPerContract > 0 ? riskUsdTarget / lossPerContract : 0
  const collateral = input.availableUsd && input.availableUsd > 0 ? Math.min(equityUsd, input.availableUsd) : equityUsd
  const maxNotional = collateral * leverage * 0.9
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

  /* ---- 6. Real trading costs ------------------------------------------ */
  const feeBps = clamp(settings.takerFeeBps ?? 5, 0, 50)
  const feesUsd = (notionalUsd * feeBps) / 10_000 * 2
  const spreadBps = derivatives?.spreadBps ?? null
  const slippageBps = spreadBps != null ? clamp(spreadBps, 0, 200) : 2
  const slippageUsd = (notionalUsd * slippageBps) / 10_000
  const holdHours = (expectedBarsToTarget * barMinutes) / 60
  const fundingPeriods = Math.max(0, Math.ceil(holdHours / 8) - 1)
  const fundingRate = derivatives?.fundingRate ?? 0
  const fundingCostUsd = notionalUsd * fundingRate * fundingPeriods * (long ? 1 : -1)
  const costUsd = feesUsd + slippageUsd + Math.max(0, fundingCostUsd)
  const costR = riskUsd > 0 ? costUsd / riskUsd : 0
  if (costR > 0.25) {
    warnings.push(
      `Frictions (fees ${fmtUsd(feesUsd)}, slippage ${fmtUsd(slippageUsd)}, funding ${fmtUsd(fundingCostUsd)}) eat ${(costR * 100).toFixed(0)}% of the risk budget — the R:R on screen is optimistic.`,
    )
  }

  /* ---- 7. Liquidation estimate (isolated margin) ----------------------- */
  const maintenanceRate = 0.005
  const liquidationEstimate = leverage > 1 ? entry * (1 - dir * (1 / leverage - maintenanceRate)) : null
  if (
    liquidationEstimate &&
    ((long && liquidationEstimate > stopLoss) || (!long && liquidationEstimate < stopLoss))
  ) {
    warnings.push(
      `Liquidation (${liquidationEstimate.toPrecision(6)}) sits before the stop — lower leverage or widen margin.`,
    )
  }

  /* ---- 8. Expectancy, calibrated by real history ---------------------- */
  const convictionProb = clamp(0.34 + (conviction / 100) * 0.36, 0.3, 0.72)
  const empirical = edge && edge.sample >= 8 ? edge.adjustedWinRate / 100 : null
  let modelProb: number | null = null
  if (input.championModel) {
    const features = buildFeatureVector({
      compositeScore: input.compositeScore ?? 0,
      mtfAlignment: input.mtfAlignment ?? 0,
      indicators: i,
      playbookScore: input.playbookScore ?? 0,
      marketContext: input.marketContext,
      derivatives: input.derivatives,
      crossAsset: input.crossAsset,
      onChain: input.onChain,
      orderBook: input.orderBook,
      volForecast: input.volForecast,
      regime: input.regimeInfo,
    })
    try { modelProb = predictCalibrated(input.championModel, features) } catch { modelProb = null }
  }
  const blend = empirical != null ? clamp(edge!.confidence, 0, 0.7) : 0
  const modelBlend = modelProb != null && input.championModel ? clamp(input.championModel.featureCount / 32, 0, 0.35) : 0
  const totalBlend = clamp(blend + modelBlend, 0, 0.85)
  const winProbability = clamp(
    convictionProb * (1 - totalBlend) +
      (empirical ?? 0) * blend +
      (modelProb ?? 0) * modelBlend,
    0.25,
    0.75,
  )
  const expectancyR = winProbability * expectedRr - (1 - winProbability)
  const netExpectancyR = winProbability * (expectedRr - costR) - (1 - winProbability) * (1 + costR)
  const kellyFraction = clamp(
    expectedRr > 0 ? winProbability - (1 - winProbability) / expectedRr : 0,
    0,
    0.25,
  )
  if (netExpectancyR <= 0) {
    warnings.push(
      `Net expectancy after costs is ${netExpectancyR.toFixed(2)}R — mathematically this idea does not pay. Wait for a better location.`,
    )
  }

  const marginPctOfEquity = equityUsd > 0 ? (marginUsd / equityUsd) * 100 : 0
  const sizingAdvice =
    contracts > 0
      ? `Commit ${fmtUsd(marginUsd)} of margin (${marginPctOfEquity.toFixed(1)}% of ${fmtUsd(equityUsd)}) at ${leverage}× — ${contracts} contract${contracts === 1 ? '' : 's'} ≈ ${fmtUsd(notionalUsd)} notional, risking ${fmtUsd(riskUsd)} (${((riskUsd / Math.max(equityUsd, 1)) * 100).toFixed(2)}% of equity) if the stop fills.` +
        (input.availableUsd != null
          ? ` Free collateral seen on the account: ${fmtUsd(input.availableUsd)}.`
          : '')
      : 'Position size resolves to zero at this risk budget — do not force it.'

  const breakevenTrigger = entry + dir * dist * 1
  const trailAtrMult = i.volatility.regime === 'EXPANSION' || i.volatility.regime === 'CAPITULATION' ? 2.5 : 1.8
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
    timeStopBars: bars,
    winProbability,
    probabilityBasis: modelProb != null ? 'champion_calibrated_blend' : empirical != null ? 'empirical_shrunk_with_heuristic_prior' : 'heuristic_scenario_not_calibrated',
    validationState: edge && edge.sample >= 30 ? 'RESEARCH_CANDIDATE' : 'INSUFFICIENT_EVIDENCE',
    expectancyR,
    kellyFraction,
    feesUsd,
    fundingCostUsd,
    slippageBps,
    netExpectancyR,
    expectedBarsToTarget,
    marginPctOfEquity,
    sizingAdvice,
    edgeWinRate: empirical != null ? empirical * 100 : null,
    edgeSample: edge?.sample ?? 0,
    warnings,
  }
}
