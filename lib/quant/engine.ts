/**
 * The orchestrator: turns raw OKX candles into a full `Analysis`.
 *
 * Pipeline
 *   1. per-timeframe indicator computation (LTF + 2 HTFs)
 *   2. market structure, volume profile, divergences, candlestick patterns
 *   3. weighted factor model -> composite score
 *   4. veto layer (things that must never be traded)
 *   5. playbook selection -> risk plan (SL / TP ladder / sizing)
 *   6. narrative + compact LLM payload
 *
 * Everything is pure: no network, no Convex, no globals. That makes it
 * trivially testable and safe to run both in the worker and in a route handler.
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
import { buildFactors, buildVetoes, composite, decide, mtfAlignment, selectPlaybook } from './scoring'
import { buildRiskPlan } from './risk'
import { barMs, barsPerYear, normalizeBar } from './timeframes'

/* -------------------------------------------------------------------------- */
/*  Per-timeframe indicator computation                                        */
/* -------------------------------------------------------------------------- */

export interface ComputeOptions {
  timeframe: string
  usePatterns?: boolean
  htfSwings?: number[]
  profileLookback?: number
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

function auditCandles(candles: readonly Candle[], timeframe: string, label: string): string[] {
  const w: string[] = []
  if (candles.length < MIN_BARS) {
    w.push(`${label}: only ${candles.length} bars (min ${MIN_BARS}) — indicators unreliable`)
  } else if (candles.length < IDEAL_BARS) {
    w.push(`${label}: ${candles.length} bars (<${IDEAL_BARS}) — EMA200/Ichimoku still warming up`)
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
}): string[] {
  const { indicators: i, mtf, plan, derivatives: dv } = a
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
    `MTF ${Math.round(a.alignment)}% aligned — ` +
      mtf.map((t) => `${t.timeframe} ${t.bias.toLowerCase()} (${t.trendScore > 0 ? '+' : ''}${Math.round(t.trendScore)})`).join(', ') +
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
      `MFI ${fmt(i.volume.mfi, 0)}, volume ${fmt(i.volume.volumeRatio, 2)}x avg, ` +
      `VWAP z ${fmt(i.volume.vwapZ, 2)}, CVD slope ${fmt(i.volume.cvdSlope, 2)}.`,
  )

  if (i.patterns.length) {
    out.push(
      `Candles: ` +
        i.patterns
          .slice(0, 4)
          .map(
            (p) =>
              `${p.label} (${p.side === 'LONG' ? 'bull' : 'bear'}, ${Math.round(p.confirmed * 100)}% conf, ${p.barsAgo}b ago)`,
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
          .map((d) => `${d.source.toUpperCase()} ${d.kind} ${d.side === 'LONG' ? 'bullish' : 'bearish'}`)
          .join(', ') +
        '.',
    )
  }

  if (dv) {
    const bits: string[] = []
    if (dv.fundingApr != null) bits.push(`funding ${fmt(dv.fundingApr, 1)}% APR`)
    if (dv.openInterestChangePct != null) bits.push(`OI ${fmt(dv.openInterestChangePct, 2)}%`)
    if (dv.longShortRatio != null) bits.push(`L/S ${fmt(dv.longShortRatio, 2)}`)
    if (dv.takerRatio != null) bits.push(`taker ${fmt(dv.takerRatio, 2)}`)
    if (dv.bookImbalance != null) bits.push(`book ${fmt(dv.bookImbalance * 100, 0)}%`)
    if (dv.basisBps != null) bits.push(`basis ${fmt(dv.basisBps, 1)}bps`)
    if (dv.spreadBps != null) bits.push(`spread ${fmt(dv.spreadBps, 1)}bps`)
    if (bits.length) out.push(`Derivatives: ${bits.join(', ')}.`)
  }

  const top = [...a.factors].sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight)).slice(0, 3)
  if (top.length) out.push(`Top drivers: ${top.map((f) => `${f.label} ${f.score > 0 ? '+' : ''}${Math.round(f.score)}`).join(', ')}.`)

  if (a.vetoes.length) {
    out.push(
      `Blockers: ` + a.vetoes.map((v) => `${v.severity === 'hard' ? '[HARD] ' : ''}${v.reason}`).join(' | '),
    )
  }

  if (plan) {
    out.push(
      `Plan: ${plan.side} entry ${fmt(plan.entry)} (zone ${fmt(plan.entryZone[0])}–${fmt(plan.entryZone[1])}), ` +
        `SL ${fmt(plan.stopLoss)} (${plan.stopBasis}, ${fmt(plan.riskDistanceAtr, 2)} ATR), ` +
        `TPs ${plan.takeProfits.map((t) => `${fmt(t.price)}@${t.allocationPct}% (${fmt(t.rr, 2)}R)`).join(' / ')}, ` +
        `blended ${fmt(plan.expectedRr, 2)}R, ${plan.leverage}x, risk $${fmt(plan.riskUsd)}, ` +
        `expectancy ${fmt(plan.expectancyR, 2)}R, time stop ${plan.timeStopBars} bars.`,
    )
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
    },
    mom: {
      rsi: roundTo(i.momentum.rsi, 1),
      srsi: Math.round(i.momentum.stochRsiK),
      mh: roundTo(i.momentum.macdHist, 5),
      score: Math.round(i.momentum.score),
    },
    vol: {
      atrPct: roundTo(i.volatility.atrPct, 2),
      atrPctl: Math.round(i.volatility.atrPercentile),
      bbw: roundTo(i.volatility.bbWidthPct, 2),
      sq: i.volatility.squeeze ? 1 : 0,
      chop: Math.round(i.volatility.choppiness),
      er: roundTo(i.volatility.efficiencyRatio, 2),
      rv: Math.round(i.volatility.realizedVolPct),
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
    pats: i.patterns.slice(0, 5).map((p) => `${p.name}:${p.side === 'LONG' ? '+' : '-'}${Math.round(p.confirmed * 100)}@${p.barsAgo}`),
    divs: i.divergences.slice(0, 3).map((d) => `${d.source}${d.kind === 'hidden' ? 'H' : ''}:${d.side === 'LONG' ? '+' : '-'}${Math.round(d.strength)}`),
    deriv: a.indicators ? undefined : undefined,
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
          exp: roundTo(a.plan.expectancyR, 2),
        }
      : null,
    dq: {
      bars: a.dataQuality.ltfBars,
      warn: a.dataQuality.warnings.length,
    },
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
  const ltf = dropUnclosed([...input.ltf].sort((a, b) => a.ts - b.ts), tf, now)
  const htfRaw = [...(input.htf ?? [])].sort((a, b) => a.ts - b.ts)
  const htf2Raw = [...(input.htf2 ?? [])].sort((a, b) => a.ts - b.ts)
  const htf = dropUnclosed(htfRaw, settings.htfTimeframe, now)
  const htf2 = dropUnclosed(htf2Raw, settings.htf2Timeframe, now)

  const warnings = [
    ...auditCandles(ltf, tf, tf),
    ...auditCandles(htf, settings.htfTimeframe, settings.htfTimeframe),
    ...auditCandles(htf2, settings.htf2Timeframe, settings.htf2Timeframe),
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
  const pScore = patternScore(indicators.patterns)

  const factors = buildFactors({
    indicators,
    mtf,
    derivatives,
    settings,
    ltfTrendScore: ltfTrend,
  })
  const comp = composite(factors)
  const alignment = mtfAlignment(allTf)
  const side: 'LONG' | 'SHORT' = comp >= 0 ? 'LONG' : 'SHORT'

  const vetoes = buildVetoes({
    indicators,
    mtf,
    derivatives,
    settings,
    side,
    composite: comp,
    alignment,
    dataWarnings: warnings,
  })

  const { decision, conviction } = decide({
    composite: comp,
    alignment,
    factors,
    vetoes,
    settings,
  })

  const playbook = decision === 'WAIT' ? selectPlaybook(indicators, side, settings) : selectPlaybook(indicators, decision, settings)

  const plan =
    decision === 'WAIT'
      ? null
      : buildRiskPlan({
          side: decision,
          entry: price,
          indicators: { ...indicators, price },
          settings,
          spec: input.spec ?? null,
          conviction,
          playbook,
          equityUsd: settings.equityUsd,
        })

  const analysis: Analysis = {
    generatedAt: now,
    instId: input.instId,
    instType: input.instType ?? input.spec?.instType ?? (input.instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT'),
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
          score: Math.round(derivatives.score),
        }
      : null,
    patScore: Math.round(pScore.score),
  }

  return analysis
}

/** Cheap screener score, used by the market scanner (no risk plan). */
export function quickScore(candles: readonly Candle[], timeframe: string) {
  const i = computeIndicators(candles, { timeframe, usePatterns: true, profileLookback: 120 })
  const score = trendScore(i.price, i.ma, i.trend, i.ichimoku, i.volatility.atr)
  const pat = patternScore(i.patterns)
  const blended = clamp(
    score * 0.55 + i.momentum.score * 0.2 + i.volume.score * 0.12 + pat.score * 0.13,
    -100,
    100,
  )
  return {
    price: i.price,
    score: roundTo(blended, 1),
    trendScore: roundTo(score, 1),
    momentum: roundTo(i.momentum.score, 1),
    regime: i.volatility.regime,
    adx: roundTo(i.trend.adx, 1),
    rsi: roundTo(i.momentum.rsi, 1),
    atrPct: roundTo(i.volatility.atrPct, 3),
    atrPercentile: Math.round(safe(i.volatility.atrPercentile)),
    squeeze: i.volatility.squeeze,
    volumeRatio: roundTo(i.volume.volumeRatio, 2),
    structure: i.structure.structure,
    bos: i.structure.bos,
    choch: i.structure.choch,
    rangePosition: roundTo(i.structure.rangePosition, 3),
    topPattern: pat.top ? { label: pat.top.label, side: pat.top.side, confirmed: roundTo(pat.top.confirmed, 2) } : null,
    patternScore: roundTo(pat.score, 1),
    divergence: i.divergences[0]
      ? { source: i.divergences[0].source, side: i.divergences[0].side, kind: i.divergences[0].kind }
      : null,
    bias: biasFromScore(blended, 15),
  }
}

export type QuickScore = ReturnType<typeof quickScore>
