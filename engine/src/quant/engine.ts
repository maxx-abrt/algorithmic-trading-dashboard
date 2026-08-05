/**
 * The orchestrator: turns raw OKX candles into a complete `Analysis`.
 *
 * Pipeline
 *   1. per-timeframe indicator computation (LTF + 2 HTFs)
 *   2. market structure, volume profile, divergences, candlestick patterns
 *   3. statistical layer (Hurst, regression channel) + advanced volatility
 *   4. weighted factor model -> preliminary composite -> side
 *   5. empirical edge back-scan of that exact side, folded back into the score
 *   6. veto layer (things that must never be traded)
 *   7. playbook selection -> risk plan (SL / TP ladder / sizing / costs)
 *   8. narrative + compact LLM payload
 *
 * Everything is pure: no network, no database, no globals. That makes it
 * trivially testable and safe to run in the engine loop and on demand.
 */

import type {
  Analysis,
  Candle,
  DerivativesBlock,
  EngineSettings,
  Indicators,
  InstrumentSpec,
  TimeframeContext,
} from './types'
import { DEFAULT_SETTINGS } from './types'
import { clamp, last, roundTo, safe } from './math'
import {
  atrSeries,
  biasFromScore,
  computeIchimoku,
  computeMomentum,
  computeMovingAverages,
  computeTrendFollow,
  computeVolatility,
  computeVolume,
  toOhlcv,
  trendScore,
} from './indicators'
import { computeStructure, computeVolumeProfile, findDivergences, findSwings } from './structure'
import { averageVolume, detectPatterns, patternScore } from './patterns'
import { buildFactors, buildVetoes, composite, decide, edgeFactor, mtfAlignment, selectPlaybook } from './scoring'
import { buildRiskPlan, stopAtrMultiplier, timeStop } from './risk'
import { barMinutes, barMs, barsPerYear, higherTimeframes, normalizeBar } from './timeframes'
import { computeStats } from './stats'
import { computeAdvancedVol, computeExtraTrend } from './extras'
import { computeEdge, type EdgeBlock } from './edge'
import { sessionInfo, type SessionInfo } from './sessions'

/* -------------------------------------------------------------------------- */
/*  Per-timeframe indicator computation                                        */
/* -------------------------------------------------------------------------- */

export interface ComputeOptions {
  timeframe: string
  usePatterns?: boolean
  htfSwings?: number[]
  profileLookback?: number
  horizonBars?: number
}

/** Full indicator set for one timeframe. */
export function computeIndicators(candles: readonly Candle[], opts: ComputeOptions): Indicators {
  const tf = normalizeBar(opts.timeframe)
  const d = toOhlcv(candles)
  const price = last(d.close, 0)

  const atr = last(atrSeries(d, 14), Math.max(price * 0.005, 1e-9))
  const ma = computeMovingAverages(d, atr)
  const momentum = computeMomentum(d)
  const trend = computeTrendFollow(d)
  const ichimoku = computeIchimoku(d)
  const volatility = computeVolatility(d, barsPerYear(tf), trend.adx, ma.ema50SlopePct)
  const volume = computeVolume(candles, d, tf)
  const profile = computeVolumeProfile(candles, opts.profileLookback ?? 180)
  const structure = computeStructure(candles, profile, volatility.atr, opts.htfSwings ?? [])
  const divergences = findDivergences(candles, d)
  const stats = computeStats(d)
  const xvol = computeAdvancedVol(candles, d, barsPerYear(tf), opts.horizonBars ?? 12)
  const xtrend = computeExtraTrend(d, volatility.atr)

  // Regime refinement that needs volume + volatility together: a >2.5σ volume
  // climax on a top-decile ATR bar is capitulation, not a trend.
  if (xvol.climax && volatility.atrPercentile > 82) volatility.regime = 'CAPITULATION'

  const ltfTrend = trendScore(price, ma, trend, ichimoku, volatility.atr)

  const patterns =
    opts.usePatterns === false
      ? []
      : detectPatterns(candles, {
          atr: volatility.atr,
          volatility,
          structure,
          trendScore: ltfTrend,
          avgVolume: averageVolume(candles, 20),
        })

  return {
    price,
    ma,
    momentum,
    volatility,
    volume,
    ichimoku,
    trend,
    profile,
    structure,
    divergences,
    patterns,
    stats,
    xvol,
    xtrend,
  }
}

/** Lightweight higher-timeframe context (no patterns, no deep profile). */
export function computeTimeframeContext(
  candles: readonly Candle[],
  timeframe: string,
): TimeframeContext {
  const tf = normalizeBar(timeframe)
  const i = computeIndicators(candles, {
    timeframe: tf,
    usePatterns: false,
    profileLookback: 120,
  })
  const score = trendScore(i.price, i.ma, i.trend, i.ichimoku, i.volatility.atr)
  return {
    timeframe: tf,
    bars: candles.length,
    price: i.price,
    bias: biasFromScore(score),
    trendScore: roundTo(score, 1),
    regime: i.volatility.regime,
    adx: roundTo(i.trend.adx, 1),
    rsi: roundTo(i.momentum.rsi, 1),
    atrPct: roundTo(i.volatility.atrPct, 3),
    ema50: i.ma.ema50,
    ema200: i.ma.ema200,
    structure: i.structure.structure,
    bos: i.structure.bos,
    choch: i.structure.choch,
  }
}

/* -------------------------------------------------------------------------- */
/*  Data quality                                                              */
/* -------------------------------------------------------------------------- */

const MIN_BARS = 60
const IDEAL_BARS = 200

function auditCandles(candles: readonly Candle[], timeframe: string, label: string, minBars = MIN_BARS): string[] {
  const w: string[] = []
  if (candles.length < minBars) {
    w.push(`${label}: only ${candles.length} bars (min ${minBars}) — indicators unreliable`)
  } else if (candles.length < IDEAL_BARS) {
    // Informational only: a context timeframe with 120 bars is perfectly usable.
    w.push(`[info] ${label}: ${candles.length} bars (<${IDEAL_BARS}) — EMA200/Ichimoku still warming up`)
  }

  const step = barMs(timeframe)
  let gaps = 0
  let bad = 0
  for (let k = 1; k < candles.length; k++) {
    const dt = candles[k].ts - candles[k - 1].ts
    if (dt > step * 1.6) gaps++
    if (dt <= 0) bad++
  }
  if (gaps > 0) w.push(`${label}: ${gaps} missing bar${gaps > 1 ? 's' : ''} in the series`)
  if (bad > 0) w.push(`${label}: ${bad} out-of-order timestamps`)

  const broken = candles.filter(
    (c) =>
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.high) ||
      !Number.isFinite(c.low) ||
      !Number.isFinite(c.close) ||
      c.high < c.low ||
      c.close <= 0,
  ).length
  if (broken > 0) w.push(`${label}: ${broken} malformed candle${broken > 1 ? 's' : ''}`)

  const flat = candles.slice(-20).filter((c) => c.high === c.low).length
  if (flat >= 10) w.push(`${label}: ${flat}/20 recent bars have zero range — illiquid instrument`)

  return w
}

/** Drop the still-forming last candle so signals never repaint. */
export function dropUnclosed(candles: Candle[], timeframe: string, now = Date.now()): Candle[] {
  if (candles.length < 2) return candles
  const step = barMs(timeframe)
  const lastBar = candles[candles.length - 1]
  const closesAt = lastBar.ts + step
  if (lastBar.confirmed === false || closesAt > now) return candles.slice(0, -1)
  return candles
}

/* -------------------------------------------------------------------------- */
/*  Narrative                                                                 */
/* -------------------------------------------------------------------------- */

function fmt(n: number, dp = 2) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = abs >= 1000 ? 2 : abs >= 1 ? dp : 6
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

function buildNarrative(a: {
  settings: EngineSettings
  indicators: Indicators
  mtf: TimeframeContext[]
  alignment: number
  comp: number
  decision: Analysis['decision']
  conviction: number
  playbook: Analysis['playbook']
  plan: Analysis['plan']
  derivatives: DerivativesBlock | null
  factors: Analysis['factors']
  vetoes: Analysis['vetoes']
  edge: EdgeBlock | null
  session: SessionInfo
}): string[] {
  const { indicators: i, mtf, plan, derivatives: dv, edge, session } = a
  const out: string[] = []

  out.push(
    `${a.settings.instId} @ ${fmt(i.price)} — ${a.decision}` +
      (a.playbook ? ` via ${a.playbook.replace(/_/g, ' ')}` : '') +
      ` (conviction ${Math.round(a.conviction)}/100, composite ${a.comp > 0 ? '+' : ''}${Math.round(a.comp)}).`,
  )

  out.push(
    `Regime ${i.volatility.regime.replace(/_/g, ' ').toLowerCase()}: ADX ${fmt(i.trend.adx, 1)}, ` +
      `ATR ${fmt(i.volatility.atrPct, 2)}% (${Math.round(i.volatility.atrPercentile)}th pct), ` +
      `choppiness ${fmt(i.volatility.choppiness, 0)}, efficiency ${fmt(i.volatility.efficiencyRatio, 2)}` +
      (i.volatility.squeeze ? ', TTM squeeze ON' : '') +
      `, realised vol ${fmt(i.volatility.realizedVolPct, 0)}% annualised.`,
  )

  out.push(
    `Volatility model: 1-bar σ ${fmt(i.xvol.forecastBarSigmaPct, 2)}%, expected ${i.xvol.horizonBars}-bar move ±${fmt(i.xvol.expectedMovePct, 2)}%, ` +
      `Parkinson ${fmt(i.xvol.parkinsonVolPct, 0)}% / Garman-Klass ${fmt(i.xvol.garmanKlassVolPct, 0)}% / EWMA ${fmt(i.xvol.ewmaVolPct, 0)}% annualised, ` +
      `ATR expansion ${fmt(i.xvol.atrExpansion, 2)}×, vol ${i.xvol.volTrend}${i.xvol.climax ? ', CLIMAX bar detected' : ''}.`,
  )

  out.push(
    `Statistics: Hurst ${fmt(i.stats.hurst, 2)} (${i.stats.hurst > 0.55 ? 'persistent' : i.stats.hurst < 0.45 ? 'mean-reverting' : 'random walk'}), ` +
      `regression slope ${fmt(i.stats.regSlopePct, 3)}%/bar with R² ${fmt(i.stats.regR2, 2)} and t ${fmt(i.stats.regTstat, 1)}, ` +
      `z-score ${fmt(i.stats.zScore20, 2)}, channel position ${Math.round(i.stats.regPos * 100)}%, lag-1 autocorrelation ${fmt(i.stats.autocorr1, 2)}.`,
  )

  out.push(
    `MTF ${Math.round(a.alignment)}% aligned — ` +
      mtf
        .map((t) => `${t.timeframe} ${t.bias.toLowerCase()} (${t.trendScore > 0 ? '+' : ''}${Math.round(t.trendScore)})`)
        .join(', ') +
      '.',
  )

  out.push(
    `Structure ${i.structure.structure.toLowerCase()}` +
      (i.structure.bos ? `, ${i.structure.bos} BOS` : '') +
      (i.structure.choch ? `, ${i.structure.choch} CHoCH` : '') +
      `; range position ${Math.round(i.structure.rangePosition * 100)}%` +
      (i.structure.nearestSupport
        ? `, support ${fmt(i.structure.nearestSupport.price)} (${fmt(i.structure.nearestSupport.distancePct, 2)}%)`
        : '') +
      (i.structure.nearestResistance
        ? `, resistance ${fmt(i.structure.nearestResistance.price)} (${fmt(i.structure.nearestResistance.distancePct, 2)}%)`
        : '') +
      `. POC ${fmt(i.profile.poc)}, VA ${fmt(i.profile.val)}–${fmt(i.profile.vah)}${i.profile.insideValue ? ' (inside value)' : ' (outside value)'}.`,
  )

  out.push(
    `Momentum: RSI ${fmt(i.momentum.rsi, 1)}, StochRSI ${fmt(i.momentum.stochRsiK, 0)}, ` +
      `MACD hist ${fmt(i.momentum.macdHist, 4)} (${i.momentum.macdHist > i.momentum.macdHistPrev ? 'rising' : 'falling'}), ` +
      `UO ${fmt(i.xtrend.ultimateOsc, 0)}, MFI ${fmt(i.volume.mfi, 0)}, volume ${fmt(i.volume.volumeRatio, 2)}x avg, ` +
      `VWAP z ${fmt(i.volume.vwapZ, 2)}, CVD slope ${fmt(i.volume.cvdSlope, 2)}.`,
  )

  out.push(
    `Overlays: Donchian ${Math.round(i.xtrend.donchianPos * 100)}% of the 20-bar channel, VWMA spread ${fmt(i.xtrend.vwmaSpreadPct, 2)}%, ` +
      `Vortex +${fmt(i.xtrend.vortexPlus, 2)}/-${fmt(i.xtrend.vortexMinus, 2)}, Heikin-Ashi ${i.xtrend.heikinTrend} run of ${i.xtrend.heikinRun}, ` +
      `Elder bull ${fmt(i.xtrend.elderBull, 2)} / bear ${fmt(i.xtrend.elderBear, 2)} ATR.`,
  )

  if (i.patterns.length) {
    out.push(
      `Candles: ` +
        i.patterns
          .slice(0, 4)
          .map(
            (p) =>
              `${p.label} (${p.side === 'LONG' ? 'bull' : 'bear'}, ${Math.round(p.confirmed * 100)}% confirmed, ${p.barsAgo}b ago${
                p.notes.length ? ` — ${p.notes.slice(0, 2).join('; ')}` : ''
              })`,
          )
          .join(', ') +
        '.',
    )
  }
  if (i.divergences.length) {
    out.push(
      `Divergences: ` +
        i.divergences
          .slice(0, 3)
          .map((d) => `${d.source.toUpperCase()} ${d.kind} ${d.side === 'LONG' ? 'bullish' : 'bearish'} (${d.barsAgo}b ago)`)
          .join(', ') +
        '.',
    )
  }

  if (dv) {
    const bits: string[] = []
    if (dv.fundingApr != null) bits.push(`funding ${fmt(dv.fundingApr, 1)}% APR`)
    if (dv.openInterestChangePct != null) bits.push(`OI ${fmt(dv.openInterestChangePct, 2)}%`)
    if (dv.openInterestUsd != null) bits.push(`OI $${fmt(dv.openInterestUsd / 1e6, 1)}M`)
    if (dv.longShortRatio != null) bits.push(`L/S ${fmt(dv.longShortRatio, 2)}`)
    if (dv.takerRatio != null) bits.push(`taker ${fmt(dv.takerRatio, 2)}`)
    if (dv.bookImbalance != null) bits.push(`book ${fmt(dv.bookImbalance * 100, 0)}%`)
    if (dv.basisBps != null) bits.push(`basis ${fmt(dv.basisBps, 1)}bps`)
    if (dv.spreadBps != null) bits.push(`spread ${fmt(dv.spreadBps, 1)}bps`)
    if (bits.length) out.push(`Derivatives: ${bits.join(', ')}.`)
  }

  if (edge && edge.sample > 0) {
    out.push(
      `Empirical edge: ${edge.sample} historical analogues of this exact context resolved ${fmt(edge.winRate, 0)}% in favour ` +
        `(shrunk ${fmt(edge.adjustedWinRate, 0)}%), average ${fmt(edge.avgR, 2)}R, MFE ${fmt(edge.avgMfeR, 2)}R vs MAE ${fmt(edge.avgMaeR, 2)}R over ${edge.horizonBars} bars.`,
    )
  }

  if (session.isEquity) {
    out.push(`Session: ${session.session} — ${session.note}.`)
  }

  const top = [...a.factors].sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight)).slice(0, 3)
  if (top.length) {
    out.push(`Top drivers: ${top.map((f) => `${f.label} ${f.score > 0 ? '+' : ''}${Math.round(f.score)}`).join(', ')}.`)
  }

  if (a.vetoes.length) {
    out.push(`Blockers: ` + a.vetoes.map((v) => `${v.severity === 'hard' ? '[HARD] ' : ''}${v.reason}`).join(' | '))
  }

  if (plan) {
    out.push(
      `Plan: ${plan.side} entry ${fmt(plan.entry)} (zone ${fmt(plan.entryZone[0])}–${fmt(plan.entryZone[1])}), ` +
        `SL ${fmt(plan.stopLoss)} (${plan.stopBasis}, ${fmt(plan.riskDistanceAtr, 2)} ATR), ` +
        `TPs ${plan.takeProfits.map((t) => `${fmt(t.price)}@${t.allocationPct}% (${fmt(t.rr, 2)}R, ${t.basis})`).join(' / ')}, ` +
        `blended ${fmt(plan.expectedRr, 2)}R, ${plan.leverage}×, risk $${fmt(plan.riskUsd)}, ` +
        `net expectancy ${fmt(plan.netExpectancyR, 2)}R after ${fmt(plan.slippageBps, 1)}bps slippage and $${fmt(plan.feesUsd, 2)} fees, ` +
        `~${plan.expectedBarsToTarget} bars to TP1, time stop ${plan.timeStopBars} bars.`,
    )
    out.push(plan.sizingAdvice)
  } else {
    out.push('No executable plan: waiting for a cleaner setup.')
  }

  return out
}

/* -------------------------------------------------------------------------- */
/*  Compact LLM payload                                                       */
/* -------------------------------------------------------------------------- */

function buildCompact(a: Analysis): Record<string, unknown> {
  const i = a.indicators
  return {
    sym: a.instId,
    tf: a.timeframe,
    px: roundTo(a.price, 6),
    dec: a.decision,
    pb: a.playbook,
    conv: Math.round(a.conviction),
    comp: Math.round(a.compositeScore),
    reg: a.regime,
    align: Math.round(a.mtfAlignment),
    mtf: a.mtf.map((t) => `${t.timeframe}:${Math.round(t.trendScore)}`).join('|'),
    trend: {
      adx: roundTo(i.trend.adx, 1),
      st: i.trend.supertrendBull ? 1 : -1,
      ema: `${i.price > i.ma.ema50 ? '>' : '<'}50 ${i.price > i.ma.ema200 ? '>' : '<'}200`,
      ich: i.ichimoku.priceAboveCloud ? 'above' : i.ichimoku.priceBelowCloud ? 'below' : 'in',
      vi: `${roundTo(i.xtrend.vortexPlus, 2)}/${roundTo(i.xtrend.vortexMinus, 2)}`,
      ha: `${i.xtrend.heikinTrend}${i.xtrend.heikinRun}`,
      dc: roundTo(i.xtrend.donchianPos, 2),
    },
    mom: {
      rsi: roundTo(i.momentum.rsi, 1),
      srsi: Math.round(i.momentum.stochRsiK),
      mh: roundTo(i.momentum.macdHist, 5),
      uo: Math.round(i.xtrend.ultimateOsc),
      score: Math.round(i.momentum.score),
    },
    vol: {
      atrPct: roundTo(i.volatility.atrPct, 2),
      atrPctl: Math.round(i.volatility.atrPercentile),
      bbw: roundTo(i.volatility.bbWidthPct, 2),
      sq: i.volatility.squeeze ? 1 : 0,
      chop: Math.round(i.volatility.choppiness),
      er: roundTo(i.volatility.efficiencyRatio, 2),
      sigma1: roundTo(i.xvol.forecastBarSigmaPct, 2),
      em: roundTo(i.xvol.expectedMovePct, 2),
      vtrend: i.xvol.volTrend,
      climax: i.xvol.climax ? 1 : 0,
    },
    stat: {
      h: roundTo(i.stats.hurst, 2),
      r2: roundTo(i.stats.regR2, 2),
      t: roundTo(i.stats.regTstat, 1),
      z: roundTo(i.stats.zScore20, 2),
      mr: Math.round(i.stats.meanReversion),
    },
    flow: {
      vr: roundTo(i.volume.volumeRatio, 2),
      mfi: Math.round(i.volume.mfi),
      vwapZ: roundTo(i.volume.vwapZ, 2),
      cvd: roundTo(i.volume.cvdSlope, 2),
      obv: roundTo(i.volume.obvSlope, 2),
    },
    struct: {
      s: i.structure.structure,
      bos: i.structure.bos,
      choch: i.structure.choch,
      pos: roundTo(i.structure.rangePosition, 2),
      sup: roundTo(i.structure.nearestSupport?.price ?? 0, 6),
      res: roundTo(i.structure.nearestResistance?.price ?? 0, 6),
      poc: roundTo(i.profile.poc, 6),
      fvg: i.structure.fvg.length,
    },
    pats: i.patterns
      .slice(0, 5)
      .map((p) => `${p.name}:${p.side === 'LONG' ? '+' : '-'}${Math.round(p.confirmed * 100)}@${p.barsAgo}`),
    divs: i.divergences
      .slice(0, 3)
      .map((d) => `${d.source}${d.kind === 'hidden' ? 'H' : ''}:${d.side === 'LONG' ? '+' : '-'}${Math.round(d.strength)}`),
    edge: a.edge && a.edge.sample
      ? { n: a.edge.sample, wr: Math.round(a.edge.adjustedWinRate), r: roundTo(a.edge.avgR, 2) }
      : null,
    ses: a.session.isEquity ? a.session.session : null,
    top: a.factors
      .slice()
      .sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))
      .slice(0, 6)
      .map((f) => `${f.id}:${Math.round(f.score)}`),
    vetoes: a.vetoes.map((v) => `${v.severity === 'hard' ? '!' : ''}${v.id}`),
    plan: a.plan
      ? {
          side: a.plan.side,
          e: roundTo(a.plan.entry, 6),
          sl: roundTo(a.plan.stopLoss, 6),
          tp: a.plan.takeProfits.map((t) => roundTo(t.price, 6)),
          rr: roundTo(a.plan.expectedRr, 2),
          lev: a.plan.leverage,
          risk: Math.round(a.plan.riskUsd),
          exp: roundTo(a.plan.netExpectancyR, 2),
        }
      : null,
    dq: { bars: a.dataQuality.ltfBars, warn: a.dataQuality.warnings.length },
  }
}

/* -------------------------------------------------------------------------- */
/*  Main entry point                                                          */
/* -------------------------------------------------------------------------- */

export interface AnalyzeInput {
  instId: string
  instType?: string
  spec?: InstrumentSpec | null
  ltf: Candle[]
  htf?: Candle[]
  htf2?: Candle[]
  derivatives?: DerivativesBlock | null
  settings?: Partial<EngineSettings>
  /** last trade/ticker price — used to detect stale candles */
  livePrice?: number | null
  /** 24h turnover in USD, used by the liquidity veto */
  volUsd24h?: number | null
  /** free collateral from a read-only OKX balance */
  availableUsd?: number | null
  now?: number
}

export function analyze(input: AnalyzeInput): Analysis {
  const now = input.now ?? Date.now()
  const settings: EngineSettings = {
    ...DEFAULT_SETTINGS,
    ...input.settings,
    instId: input.instId,
    timeframe: normalizeBar(input.settings?.timeframe ?? DEFAULT_SETTINGS.timeframe),
    htfTimeframe: normalizeBar(input.settings?.htfTimeframe ?? DEFAULT_SETTINGS.htfTimeframe),
    htf2Timeframe: normalizeBar(input.settings?.htf2Timeframe ?? DEFAULT_SETTINGS.htf2Timeframe),
    weights: { ...DEFAULT_SETTINGS.weights, ...input.settings?.weights },
  }

  const tf = settings.timeframe
  // Guard: a "higher" timeframe must actually be higher, whatever the caller sent.
  {
    const [a1, a2] = higherTimeframes(tf)
    if (barMinutes(settings.htfTimeframe) <= barMinutes(tf)) settings.htfTimeframe = a1
    if (barMinutes(settings.htf2Timeframe) <= barMinutes(settings.htfTimeframe)) settings.htf2Timeframe = a2
  }
  const ltf = dropUnclosed([...input.ltf].sort((a, b) => a.ts - b.ts), tf, now)
  const htfRaw = [...(input.htf ?? [])].sort((a, b) => a.ts - b.ts)
  const htf2Raw = [...(input.htf2 ?? [])].sort((a, b) => a.ts - b.ts)
  const htf = dropUnclosed(htfRaw, settings.htfTimeframe, now)
  const htf2 = dropUnclosed(htf2Raw, settings.htf2Timeframe, now)

  const warnings = [
    ...auditCandles(ltf, tf, tf),
    ...auditCandles(htf, settings.htfTimeframe, settings.htfTimeframe, 40),
    ...auditCandles(htf2, settings.htf2Timeframe, settings.htf2Timeframe, 40),
  ]

  const lastBar = ltf[ltf.length - 1]
  const staleMs = lastBar ? now - (lastBar.ts + barMs(tf)) : Number.POSITIVE_INFINITY
  if (staleMs > barMs(tf) * 3) {
    warnings.push(`Feed stale: last closed ${tf} bar is ${Math.round(staleMs / 60_000)} min old`)
  }

  /* ---- higher timeframes first (their swings feed LTF structure) -------- */
  const mtf: TimeframeContext[] = []
  const htfSwings: number[] = []
  if (htf.length >= 40) {
    mtf.push(computeTimeframeContext(htf, settings.htfTimeframe))
    htfSwings.push(...findSwings(htf, 3).slice(-10).map((s) => s.price))
  }
  if (htf2.length >= 40) {
    mtf.push(computeTimeframeContext(htf2, settings.htf2Timeframe))
    htfSwings.push(...findSwings(htf2, 3).slice(-6).map((s) => s.price))
  }

  const indicators = computeIndicators(ltf, {
    timeframe: tf,
    usePatterns: settings.usePatterns,
    htfSwings,
    horizonBars: 12,
  })

  // Prefer the live ticker price when it is sane (within 3 ATR of last close).
  const closePx = indicators.price
  const live = input.livePrice ?? null
  const price =
    live && Number.isFinite(live) && live > 0 && Math.abs(live - closePx) < 3 * indicators.volatility.atr
      ? live
      : closePx
  if (live && price !== live) {
    warnings.push('Ticker price diverges from last close by >3 ATR — using candle close')
  }

  const instType = input.instType ?? input.spec?.instType ?? (input.instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT')
  const session = sessionInfo(input.spec?.isEquity ?? false, new Date(now))

  const ltfTrend = trendScore(
    price,
    indicators.ma,
    indicators.trend,
    indicators.ichimoku,
    indicators.volatility.atr,
  )
  const ltfCtx: TimeframeContext = {
    timeframe: tf,
    bars: ltf.length,
    price,
    bias: biasFromScore(ltfTrend),
    trendScore: roundTo(ltfTrend, 1),
    regime: indicators.volatility.regime,
    adx: roundTo(indicators.trend.adx, 1),
    rsi: roundTo(indicators.momentum.rsi, 1),
    atrPct: roundTo(indicators.volatility.atrPct, 3),
    ema50: indicators.ma.ema50,
    ema200: indicators.ma.ema200,
    structure: indicators.structure.structure,
    bos: indicators.structure.bos,
    choch: indicators.structure.choch,
  }
  const allTf = [ltfCtx, ...mtf]

  const derivatives = settings.useDerivatives ? (input.derivatives ?? null) : null

  /* ---- pass 1: confluence without the empirical layer ------------------ */
  const baseFactors = buildFactors({
    indicators,
    mtf,
    derivatives,
    settings,
    ltfTrendScore: ltfTrend,
  })
  const comp1 = composite(baseFactors)
  const side: 'LONG' | 'SHORT' = comp1 >= 0 ? 'LONG' : 'SHORT'

  /* ---- pass 2: back-scan the exact idea, then re-score ----------------- */
  let edgePlaybook = selectPlaybook(indicators, side, settings)
  let edge: EdgeBlock | null =
    settings.useEmpiricalEdge && ltf.length >= 140
      ? computeEdge({
          candles: ltf,
          side,
          stopAtr: stopAtrMultiplier(indicators, edgePlaybook),
          targetR: clamp(settings.rrRatio, 1.2, 6),
          horizonBars: timeStop(edgePlaybook),
        })
      : null

  let factors = edge
    ? [...baseFactors, edgeFactor(edge, side, indicators.volatility.regime, settings)]
    : baseFactors
  let comp = composite(factors)
  const alignment = mtfAlignment(allTf)
  let finalSide: 'LONG' | 'SHORT' = comp >= 0 ? 'LONG' : 'SHORT'

  // Edge statistics are side-specific. If they flip the initial side, recompute
  // against that new side. If the result oscillates, discard the empirical
  // factor rather than attaching LONG evidence to a SHORT decision (or inverse).
  if (edge && finalSide !== side) {
    const recomputedPlaybook = selectPlaybook(indicators, finalSide, settings)
    const recomputedEdge = computeEdge({
      candles: ltf,
      side: finalSide,
      stopAtr: stopAtrMultiplier(indicators, recomputedPlaybook),
      targetR: clamp(settings.rrRatio, 1.2, 6),
      horizonBars: timeStop(recomputedPlaybook),
    })
    const recomputedFactors = [...baseFactors, edgeFactor(recomputedEdge, finalSide, indicators.volatility.regime, settings)]
    const recomputedComposite = composite(recomputedFactors)
    const stableSide: 'LONG' | 'SHORT' = recomputedComposite >= 0 ? 'LONG' : 'SHORT'
    if (stableSide === finalSide) {
      edge = recomputedEdge
      edgePlaybook = recomputedPlaybook
      factors = recomputedFactors
      comp = recomputedComposite
    } else {
      edge = null
      factors = baseFactors
      comp = comp1
      finalSide = side
      edgePlaybook = selectPlaybook(indicators, side, settings)
    }
  }

  const vetoes = buildVetoes({
    indicators,
    mtf,
    derivatives,
    settings,
    side: finalSide,
    composite: comp,
    alignment,
    dataWarnings: warnings,
    session,
    edge,
    volUsd24h: input.volUsd24h ?? null,
    playbook: edgePlaybook,
  })

  // Confluence bonuses: a proven historical edge and a freshly confirmed
  // formation on the right side are worth real conviction points.
  const leadPattern = indicators.patterns.find((p) => p.side === finalSide && p.confirmed > 0.66 && p.barsAgo <= 3)
  const bonus =
    (edge && edge.sample >= 12 && edge.adjustedWinRate > 50 ? clamp((edge.adjustedWinRate - 50) / 3, 0, 7) : 0) +
    (leadPattern ? 4 : 0) +
    (indicators.divergences.some((d) => d.side === finalSide && d.kind === 'regular' && d.barsAgo <= 4) ? 3 : 0)

  const decisionResult = decide({
    composite: comp,
    alignment,
    factors,
    vetoes,
    settings,
    bonus,
  })
  let decision = decisionResult.decision
  const rawConviction = decisionResult.conviction
  // Illiquid sessions can never produce a high-conviction print.
  const conviction = clamp(rawConviction * (session.isEquity ? session.liquidityFactor * 0.35 + 0.65 : 1), 0, 100)

  const playbook = decision === 'WAIT' ? selectPlaybook(indicators, finalSide, settings) : selectPlaybook(indicators, decision, settings)

  const candidatePlan = buildRiskPlan({
    side: decision === 'WAIT' ? finalSide : decision,
    entry: price,
    indicators: { ...indicators, price },
    settings,
    spec: input.spec ?? null,
    conviction,
    playbook,
    equityUsd: settings.equityUsd,
    derivatives,
    edge,
    session,
    availableUsd: input.availableUsd ?? null,
    barMinutes: barMinutes(tf),
  })
  if (decision !== 'WAIT' && candidatePlan.netExpectancyR <= 0) {
    vetoes.push({ id: 'non_positive_net_expectancy', reason: `Plan expectancy is ${candidatePlan.netExpectancyR.toFixed(2)}R after estimated costs`, severity: 'hard' })
    decision = 'WAIT'
  }
  // On WAIT the plan is deliberately not actionable, but the operator still wants
  // to know *where* the trade would live if the tape confirmed.
  const plan = decision === 'WAIT' ? null : candidatePlan
  const shadowPlan = decision === 'WAIT' ? candidatePlan : null

  const analysis: Analysis = {
    generatedAt: now,
    instId: input.instId,
    instType,
    timeframe: tf,
    htfTimeframe: settings.htfTimeframe,
    htf2Timeframe: settings.htf2Timeframe,
    price,
    decision,
    playbook: decision === 'WAIT' ? null : playbook,
    conviction: roundTo(conviction, 1),
    compositeScore: roundTo(comp, 1),
    regime: indicators.volatility.regime,
    bias: biasFromScore(comp, 12),
    indicators: { ...indicators, price },
    mtf: allTf,
    mtfAlignment: roundTo(alignment, 1),
    factors,
    vetoes,
    plan,
    shadowPlan,
    derivatives,
    edge,
    session,
    ai: null,
    liquidity: {
      volUsd24h: input.volUsd24h ?? null,
      spreadBps: derivatives?.spreadBps ?? null,
    },
    narrative: [],
    compact: {},
    dataQuality: {
      ltfBars: ltf.length,
      htfBars: htf.length,
      htf2Bars: htf2.length,
      staleMs: Number.isFinite(staleMs) ? Math.max(0, Math.round(staleMs)) : -1,
      warnings,
    },
  }

  analysis.narrative = buildNarrative({
    settings,
    indicators: analysis.indicators,
    mtf: allTf,
    alignment,
    comp,
    decision,
    conviction,
    playbook: analysis.playbook,
    plan,
    derivatives,
    factors,
    vetoes,
    edge,
    session,
  })
  analysis.compact = {
    ...buildCompact(analysis),
    deriv: derivatives
      ? {
          fund: derivatives.fundingApr != null ? roundTo(derivatives.fundingApr, 2) : null,
          oi: derivatives.openInterestChangePct != null ? roundTo(derivatives.openInterestChangePct, 2) : null,
          ls: derivatives.longShortRatio != null ? roundTo(derivatives.longShortRatio, 2) : null,
          taker: derivatives.takerRatio != null ? roundTo(derivatives.takerRatio, 2) : null,
          book: derivatives.bookImbalance != null ? roundTo(derivatives.bookImbalance, 2) : null,
          spread: derivatives.spreadBps != null ? roundTo(derivatives.spreadBps, 1) : null,
          score: Math.round(derivatives.score),
        }
      : null,
    patScore: Math.round(patternScore(indicators.patterns).score),
  }

  return analysis
}

/** Cheap screener score, used by the market scanner (no risk plan). */
export function quickScore(candles: readonly Candle[], timeframe: string) {
  const i = computeIndicators(candles, { timeframe, usePatterns: true, profileLookback: 120 })
  const score = trendScore(i.price, i.ma, i.trend, i.ichimoku, i.volatility.atr)
  const pat = patternScore(i.patterns)
  const blended = clamp(
    score * 0.44 + i.momentum.score * 0.16 + i.volume.score * 0.1 + pat.score * 0.12 + i.stats.score * 0.1 + i.xtrend.score * 0.08,
    -100,
    100,
  )
  return {
    price: i.price,
    score: roundTo(blended, 1),
    trendScore: roundTo(score, 1),
    momentum: roundTo(i.momentum.score, 1),
    statScore: roundTo(i.stats.score, 1),
    regime: i.volatility.regime,
    adx: roundTo(i.trend.adx, 1),
    rsi: roundTo(i.momentum.rsi, 1),
    atrPct: roundTo(i.volatility.atrPct, 3),
    atrPercentile: Math.round(safe(i.volatility.atrPercentile)),
    squeeze: i.volatility.squeeze,
    volumeRatio: roundTo(i.volume.volumeRatio, 2),
    hurst: roundTo(i.stats.hurst, 2),
    expectedMovePct: roundTo(i.xvol.expectedMovePct, 2),
    climax: i.xvol.climax,
    structure: i.structure.structure,
    bos: i.structure.bos,
    choch: i.structure.choch,
    rangePosition: roundTo(i.structure.rangePosition, 3),
    topPattern: pat.top
      ? { label: pat.top.label, side: pat.top.side, confirmed: roundTo(pat.top.confirmed, 2) }
      : null,
    patternScore: roundTo(pat.score, 1),
    divergence: i.divergences[0]
      ? { source: i.divergences[0].source, side: i.divergences[0].side, kind: i.divergences[0].kind }
      : null,
    bias: biasFromScore(blended, 15),
  }
}

export type QuickScore = ReturnType<typeof quickScore>
