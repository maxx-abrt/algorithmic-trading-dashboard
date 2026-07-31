/**
 * Confluence scoring engine.
 *
 * Twenty-plus independent factors each produce a signed score (-100..100) and a
 * regime-adapted weight. The blended composite decides direction, the playbook
 * decides *how* to trade it, and the veto list can kill the idea outright.
 * Nothing here is a single-indicator trigger — that is the whole point.
 */
import { clamp, scale, softSign, weightedMean } from './math'
import { patternScore } from './patterns'
import type { EdgeBlock } from './edge'
import type { SessionInfo } from './sessions'
import type {
  Analysis,
  DerivativesBlock,
  EngineSettings,
  Factor,
  Indicators,
  PlaybookId,
  Regime,
  TimeframeContext,
  Veto,
} from './types'

/* -------------------------------------------------------------------------- */
/*  Regime-adaptive group weights                                              */
/* -------------------------------------------------------------------------- */

const BASE_WEIGHTS: Record<Factor['group'], number> = {
  trend: 1,
  momentum: 1,
  volatility: 0.7,
  volume: 0.9,
  structure: 1.1,
  pattern: 0.8,
  derivatives: 0.6,
  mtf: 1.4,
  stats: 0.95,
  edge: 1.15,
}

/**
 * In a trend, trend/momentum factors lead. In a range, structure and
 * mean-reversion factors lead. In chop, everything is discounted.
 */
const REGIME_TILT: Record<Regime, Partial<Record<Factor['group'], number>>> = {
  TRENDING_UP: { trend: 1.45, momentum: 1.2, mtf: 1.3, structure: 0.9, volatility: 0.55, stats: 1.2 },
  TRENDING_DOWN: { trend: 1.45, momentum: 1.2, mtf: 1.3, structure: 0.9, volatility: 0.55, stats: 1.2 },
  RANGING: { trend: 0.6, structure: 1.5, volatility: 1.1, momentum: 0.95, pattern: 1.15, stats: 1.15 },
  SQUEEZE: { volatility: 1.6, structure: 1.3, trend: 0.7, momentum: 0.8, volume: 1.15 },
  EXPANSION: { volatility: 1.3, volume: 1.25, momentum: 1.15, trend: 1.1, pattern: 0.7 },
  CHOPPY: { trend: 0.45, momentum: 0.6, structure: 1.2, pattern: 0.6, mtf: 0.8, stats: 1.1 },
  CAPITULATION: { trend: 0.5, momentum: 0.7, volatility: 1.5, volume: 1.4, pattern: 1.25, structure: 1.2 },
}

function groupWeight(group: Factor['group'], regime: Regime, s: EngineSettings) {
  const tilt = REGIME_TILT[regime]?.[group] ?? 1
  const user = s.weights?.[group] ?? 1
  return BASE_WEIGHTS[group] * tilt * clamp(user, 0, 3)
}

/* -------------------------------------------------------------------------- */
/*  Factor construction                                                        */
/* -------------------------------------------------------------------------- */

export interface ScoreInput {
  indicators: Indicators
  mtf: TimeframeContext[]
  derivatives: DerivativesBlock | null
  settings: EngineSettings
  ltfTrendScore: number
}

export function buildFactors(input: ScoreInput): Factor[] {
  const { indicators: i, mtf, derivatives, settings, ltfTrendScore } = input
  const regime = i.volatility.regime
  const price = i.price
  const atr = i.volatility.atr || price * 0.002
  const f: Factor[] = []

  const push = (
    id: string,
    label: string,
    group: Factor['group'],
    score: number,
    weightMult: number,
    detail: string,
  ) => {
    f.push({
      id,
      label,
      group,
      score: clamp(score, -100, 100),
      weight: groupWeight(group, regime, settings) * weightMult,
      detail,
    })
  }

  /* ---- Trend ----------------------------------------------------------- */
  push(
    'ltf_trend',
    'LTF trend composite',
    'trend',
    ltfTrendScore,
    1.4,
    `EMA200 ${i.ma.ema200.toPrecision(6)} · slope ${i.ma.ema50SlopePct.toFixed(2)}% · stacked ${
      i.ma.stackedBull ? 'bull' : i.ma.stackedBear ? 'bear' : 'mixed'
    }`,
  )

  const diSpread = i.trend.plusDI - i.trend.minusDI
  push(
    'adx_di',
    'ADX / DI directional strength',
    'trend',
    softSign(diSpread, 16) * scale(i.trend.adx, 12, 34, 0.25, 1),
    1.1,
    `ADX ${i.trend.adx.toFixed(1)} · +DI ${i.trend.plusDI.toFixed(1)} / -DI ${i.trend.minusDI.toFixed(1)}`,
  )

  push(
    'ichimoku',
    'Ichimoku cloud',
    'trend',
    (i.ichimoku.priceAboveCloud ? 65 : i.ichimoku.priceBelowCloud ? -65 : 0) +
      (i.ichimoku.conversion > i.ichimoku.base ? 20 : -20),
    0.8,
    i.ichimoku.priceAboveCloud
      ? `above cloud (${i.ichimoku.cloudBottom.toPrecision(6)}–${i.ichimoku.cloudTop.toPrecision(6)})`
      : i.ichimoku.priceBelowCloud
        ? 'below cloud'
        : 'inside cloud (no edge)',
  )

  push(
    'trail_systems',
    'Supertrend / PSAR / Chandelier',
    'trend',
    (i.trend.supertrendBull ? 55 : -55) + (i.trend.psarBull ? 25 : -25),
    0.7,
    `Supertrend ${i.trend.supertrend.toPrecision(6)} ${i.trend.supertrendBull ? 'bull' : 'bear'} · PSAR ${
      i.trend.psarBull ? 'bull' : 'bear'
    }`,
  )

  /* ---- Momentum -------------------------------------------------------- */
  push(
    'momentum',
    'Momentum composite',
    'momentum',
    i.momentum.score,
    1.4,
    `RSI ${i.momentum.rsi.toFixed(1)} · MACD hist ${i.momentum.macdHist.toPrecision(3)} · StochRSI ${i.momentum.stochRsiK.toFixed(0)}`,
  )

  const macdCross =
    i.momentum.macdHist > 0 && i.momentum.macdHistPrev <= 0
      ? 80
      : i.momentum.macdHist < 0 && i.momentum.macdHistPrev >= 0
        ? -80
        : softSign(i.momentum.macdHist - i.momentum.macdHistPrev, price * 0.0004)
  push(
    'macd_cross',
    'MACD histogram inflection',
    'momentum',
    macdCross,
    0.9,
    `hist ${i.momentum.macdHist.toPrecision(3)} vs prev ${i.momentum.macdHistPrev.toPrecision(3)}`,
  )

  // RSI extremes are a *fade* signal in ranges and a *strength* signal in trends.
  const trending = regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN'
  const rsiExtreme = trending
    ? softSign(i.momentum.rsi - 50, 30)
    : i.momentum.rsi < 30
      ? scale(30 - i.momentum.rsi, 0, 15, 40, 95)
      : i.momentum.rsi > 70
        ? -scale(i.momentum.rsi - 70, 0, 15, 40, 95)
        : 0
  push(
    'rsi_context',
    trending ? 'RSI trend strength' : 'RSI exhaustion (fade)',
    'momentum',
    rsiExtreme,
    1,
    `RSI ${i.momentum.rsi.toFixed(1)} interpreted for ${regime.toLowerCase()} regime`,
  )

  if (i.divergences.length) {
    const net = i.divergences.reduce(
      (s, d) => s + (d.side === 'LONG' ? 1 : -1) * d.strength * (d.kind === 'regular' ? 1 : 0.6),
      0,
    )
    push(
      'divergence',
      'Oscillator divergence',
      'momentum',
      softSign(net, 90),
      1.2,
      i.divergences
        .map((d) => `${d.kind} ${d.side} ${d.source.toUpperCase()} (${d.barsAgo} bars ago)`)
        .join(', '),
    )
  }

  /* ---- Volatility ------------------------------------------------------ */
  // %B is directional inside a trend, contrarian at the extremes of a range.
  const pb = i.volatility.percentB
  const bbScore = trending
    ? softSign(pb - 0.5, 0.45)
    : pb > 1
      ? -85
      : pb < 0
        ? 85
        : softSign(0.5 - pb, 0.4) * 0.8
  push(
    'bollinger',
    'Bollinger position (%B)',
    'volatility',
    bbScore,
    1,
    `%B ${pb.toFixed(2)} · width ${i.volatility.bbWidthPct.toFixed(2)}% (pct ${i.volatility.bbWidthPercentile.toFixed(0)})`,
  )

  push(
    'squeeze',
    'TTM squeeze / expansion',
    'volatility',
    // A squeeze itself is directionless — it amplifies whatever breaks out.
    i.volatility.squeeze ? softSign(i.momentum.score, 60) * 0.7 : 0,
    i.volatility.squeeze ? 1.2 : 0.3,
    i.volatility.squeeze
      ? `squeeze active (BB inside Keltner, width pct ${i.volatility.bbWidthPercentile.toFixed(0)})`
      : `no squeeze · ATR pct ${i.volatility.atrPercentile.toFixed(0)} · expansion ${i.volatility.volExpansion.toFixed(0)}`,
  )

  const keltPos =
    i.volatility.keltnerUpper > i.volatility.keltnerLower
      ? (price - i.volatility.keltnerMiddle) /
        ((i.volatility.keltnerUpper - i.volatility.keltnerLower) / 2)
      : 0
  push(
    'keltner',
    'Keltner channel position',
    'volatility',
    trending ? softSign(keltPos, 1.1) : -softSign(keltPos, 1) * 0.9,
    0.8,
    `position ${keltPos.toFixed(2)} of channel half-width`,
  )

  /* ---- Volume ---------------------------------------------------------- */
  push(
    'volume_flow',
    'Volume flow (OBV / CVD / MFI)',
    'volume',
    i.volume.score,
    1.3,
    `OBV slope ${i.volume.obvSlope.toFixed(2)}% · CVD slope ${i.volume.cvdSlope.toFixed(2)}% · MFI ${i.volume.mfi.toFixed(1)}`,
  )

  const vwapScore = trending
    ? softSign(i.volume.vwapZ, 2.2) * 0.6
    : -softSign(i.volume.vwapZ, 1.8)
  push(
    'vwap',
    trending ? 'VWAP trend anchor' : 'VWAP deviation (fade)',
    'volume',
    vwapScore,
    1.1,
    `price ${i.volume.vwapDeviationPct >= 0 ? '+' : ''}${i.volume.vwapDeviationPct.toFixed(2)}% vs VWAP (z ${i.volume.vwapZ.toFixed(2)})`,
  )

  push(
    'participation',
    'Participation vs average',
    'volume',
    softSign((i.volume.volumeRatio - 1) * (i.momentum.score >= 0 ? 1 : -1), 0.7),
    0.7,
    `volume ${i.volume.volumeRatio.toFixed(2)}× 20-bar average`,
  )

  /* ---- Structure ------------------------------------------------------- */
  const structScore =
    i.structure.structure === 'UPTREND' ? 70 : i.structure.structure === 'DOWNTREND' ? -70 : 0
  push(
    'market_structure',
    'Market structure (HH/HL)',
    'structure',
    structScore + (i.structure.bos === 'BULL' ? 25 : i.structure.bos === 'BEAR' ? -25 : 0),
    1.3,
    `${i.structure.structure}${i.structure.bos ? ` · BOS ${i.structure.bos}` : ''}${
      i.structure.choch ? ` · CHoCH ${i.structure.choch}` : ''
    }`,
  )

  if (i.structure.choch) {
    push(
      'choch',
      'Change of character',
      'structure',
      i.structure.choch === 'BULL' ? 65 : -65,
      1.1,
      `${i.structure.choch} CHoCH — prior ${i.structure.structure.toLowerCase()} losing control`,
    )
  }

  // Room to the next level decides whether the trade even has space to work.
  const sup = i.structure.nearestSupport
  const res = i.structure.nearestResistance
  const roomUp = res ? Math.abs(res.price - price) / atr : 6
  const roomDown = sup ? Math.abs(price - sup.price) / atr : 6
  push(
    'level_room',
    'Room to next level',
    'structure',
    softSign(roomUp - roomDown, 3),
    1,
    `${roomUp.toFixed(2)} ATR to ${res ? res.price.toPrecision(6) : 'open air'} above · ${roomDown.toFixed(2)} ATR to ${
      sup ? sup.price.toPrecision(6) : 'open air'
    } below`,
  )

  push(
    'range_position',
    'Position inside range',
    'structure',
    trending ? 0 : softSign(0.5 - i.structure.rangePosition, 0.35),
    trending ? 0.4 : 1.1,
    `${(i.structure.rangePosition * 100).toFixed(0)}% of the ${i.structure.rangeLow.toPrecision(6)}–${i.structure.rangeHigh.toPrecision(6)} range`,
  )

  push(
    'value_area',
    'Volume profile value area',
    'structure',
    i.profile.insideValue
      ? softSign(i.profile.poc - price, atr * 1.5) * 0.6
      : price > i.profile.vah
        ? trending
          ? 45
          : -55
        : price < i.profile.val
          ? trending
            ? -45
            : 55
          : 0,
    0.9,
    `POC ${i.profile.poc.toPrecision(6)} · VA ${i.profile.val.toPrecision(6)}–${i.profile.vah.toPrecision(6)} · ${
      i.profile.insideValue ? 'inside value' : 'outside value'
    }`,
  )

  if (i.structure.fvg.length) {
    const net = i.structure.fvg.reduce((s, g) => {
      const mid = (g.top + g.bottom) / 2
      const near = Math.abs(price - mid) / atr < 2 ? 1 : 0.4
      return s + (g.side === 'LONG' ? 1 : -1) * near
    }, 0)
    push(
      'fvg',
      'Unmitigated fair-value gaps',
      'structure',
      softSign(net, 2),
      0.6,
      i.structure.fvg
        .map((g) => `${g.side} ${g.bottom.toPrecision(6)}–${g.top.toPrecision(6)}`)
        .join(', '),
    )
  }

  /* ---- Patterns -------------------------------------------------------- */
  if (settings.usePatterns && i.patterns.length) {
    const ps = patternScore(i.patterns)
    push(
      'candlestick',
      'Candlestick confluence',
      'pattern',
      ps.score,
      1.3,
      i.patterns
        .slice(0, 4)
        .map((p) => `${p.label} ${p.side} ${(p.confirmed * 100).toFixed(0)}%`)
        .join(' · '),
    )
    if (ps.top && ps.top.confirmed > 0.6) {
      push(
        'candlestick_lead',
        `Lead formation: ${ps.top.label}`,
        'pattern',
        ps.top.side === 'LONG' ? ps.top.confirmed * 100 : -ps.top.confirmed * 100,
        1,
        ps.top.notes.slice(0, 3).join(' · '),
      )
    }
  }

  /* ---- Statistical regime ---------------------------------------------- */
  push(
    'stat_drift',
    'Statistical drift quality',
    'stats',
    i.stats.score,
    1.2,
    `Hurst ${i.stats.hurst.toFixed(2)} · regression R² ${i.stats.regR2.toFixed(2)} · t ${i.stats.regTstat.toFixed(1)} · slope ${i.stats.regSlopePct.toFixed(3)}%/bar`,
  )

  push(
    'stat_stretch',
    i.stats.meanReversion > 20 ? 'Reversion stretch (fade)' : 'Trend stretch',
    'stats',
    i.stats.meanReversion > 20
      ? -softSign(i.stats.zScore20, 2)
      : softSign(i.stats.regPos - 0.5, 0.9) * 0.6,
    0.9,
    `z-score ${i.stats.zScore20.toFixed(2)} · channel position ${(i.stats.regPos * 100).toFixed(0)}% · reversion ${i.stats.meanReversion.toFixed(0)}`,
  )

  /* ---- Extra trend overlays -------------------------------------------- */
  push(
    'overlays',
    'Donchian / VWMA / Vortex / Heikin',
    'trend',
    i.xtrend.score,
    1,
    `Donchian ${(i.xtrend.donchianPos * 100).toFixed(0)}% · VWMA ${i.xtrend.vwmaSpreadPct >= 0 ? '+' : ''}${i.xtrend.vwmaSpreadPct.toFixed(2)}% · VI ${i.xtrend.vortexPlus.toFixed(2)}/${i.xtrend.vortexMinus.toFixed(2)} · HA ${i.xtrend.heikinTrend} ×${i.xtrend.heikinRun}`,
  )

  /* ---- Volatility forecast (directionless, but sizes the conviction) ---- */
  push(
    'vol_forecast',
    'Volatility forecast',
    'volatility',
    i.xvol.volTrend === 'rising' ? softSign(i.momentum.score, 90) * 0.4 : 0,
    0.6,
    `1-bar σ ${i.xvol.forecastBarSigmaPct.toFixed(2)}% · expected ${i.xvol.horizonBars}-bar move ±${i.xvol.expectedMovePct.toFixed(2)}% · Parkinson ${i.xvol.parkinsonVolPct.toFixed(0)}% · GK ${i.xvol.garmanKlassVolPct.toFixed(0)}% · vol ${i.xvol.volTrend}`,
  )

  /* ---- Multi-timeframe ------------------------------------------------- */
  for (const tf of mtf) {
    const isLtf = tf.timeframe === settings.timeframe
    push(
      `mtf_${tf.timeframe}`,
      `${tf.timeframe} context`,
      'mtf',
      tf.trendScore,
      isLtf ? 0.6 : tf.timeframe === settings.htf2Timeframe ? 1.1 : 1.4,
      `${tf.bias} · ${tf.regime} · ADX ${tf.adx.toFixed(1)} · ${tf.structure}${tf.choch ? ` · CHoCH ${tf.choch}` : ''}`,
    )
  }

  /* ---- Derivatives ----------------------------------------------------- */
  if (settings.useDerivatives && derivatives) {
    const d = derivatives
    push(
      'positioning',
      'Derivatives positioning',
      'derivatives',
      d.score,
      1.2,
      [
        d.fundingRate !== null
          ? `funding ${(d.fundingRate * 100).toFixed(4)}% (${d.fundingApr?.toFixed(1)}% APR)`
          : null,
        d.openInterestChangePct !== null ? `OI ${d.openInterestChangePct.toFixed(2)}%` : null,
        d.takerRatio !== null ? `taker buy/sell ${d.takerRatio.toFixed(2)}` : null,
        d.longShortRatio !== null ? `L/S ${d.longShortRatio.toFixed(2)}` : null,
        d.basisBps !== null ? `basis ${d.basisBps.toFixed(1)}bps` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'no derivatives data',
    )
    if (d.bookImbalance !== null) {
      push(
        'book_imbalance',
        'Order-book imbalance',
        'derivatives',
        softSign(d.bookImbalance, 0.35),
        0.7,
        `imbalance ${(d.bookImbalance * 100).toFixed(1)}% · spread ${d.spreadBps?.toFixed(2)}bps`,
      )
    }
  }

  return f
}

/* -------------------------------------------------------------------------- */
/*  Composite + vetoes                                                         */
/* -------------------------------------------------------------------------- */

export function composite(factors: Factor[]) {
  return clamp(weightedMean(factors), -100, 100)
}

/**
 * The empirical-edge factor is built in a second pass, because it needs to know
 * which side the confluence picked before it can back-test that exact idea.
 */
export function edgeFactor(
  edge: EdgeBlock,
  side: 'LONG' | 'SHORT',
  regime: Regime,
  settings: EngineSettings,
): Factor {
  const dir = side === 'LONG' ? 1 : -1
  // 42% is the structural base rate of a 1:2 setup; above that we have an edge.
  const delta = edge.adjustedWinRate - 42
  const raw = clamp((delta / 18) * 100, -100, 100) * edge.confidence
  return {
    id: 'empirical_edge',
    label: 'Empirical edge (historical analogues)',
    group: 'edge',
    score: clamp(raw * dir, -100, 100),
    weight: groupWeight('edge', regime, settings) * (edge.sample >= 12 ? 1.2 : 0.6),
    detail: edge.sample
      ? `${edge.sample} analogues · ${edge.winRate.toFixed(0)}% raw / ${edge.adjustedWinRate.toFixed(0)}% shrunk hit rate · avg ${edge.avgR.toFixed(2)}R · MFE ${edge.avgMfeR.toFixed(2)}R / MAE ${edge.avgMaeR.toFixed(2)}R`
      : edge.note,
  }
}

/** How much the timeframes agree, 0..100. */
export function mtfAlignment(mtf: TimeframeContext[]) {
  if (!mtf.length) return 0
  const signs = mtf.map((t) => Math.sign(t.trendScore))
  const magnitude = mtf.map((t) => Math.abs(t.trendScore))
  const agree = Math.abs(signs.reduce((s, v) => s + v, 0)) / mtf.length
  const strength = magnitude.reduce((s, v) => s + v, 0) / mtf.length
  return clamp(agree * 60 + (strength / 100) * 40, 0, 100)
}

export function buildVetoes(input: {
  indicators: Indicators
  mtf: TimeframeContext[]
  derivatives: DerivativesBlock | null
  settings: EngineSettings
  side: 'LONG' | 'SHORT'
  composite: number
  alignment: number
  dataWarnings: string[]
  session: SessionInfo
  edge: EdgeBlock | null
  volUsd24h: number | null
  playbook: PlaybookId | null
}): Veto[] {
  const { indicators: i, mtf, derivatives, settings, side, alignment, dataWarnings, session, edge, volUsd24h, playbook } = input
  const v: Veto[] = []
  const long = side === 'LONG'

  if (i.volatility.regime === 'CHOPPY') {
    v.push({
      id: 'chop',
      reason: `Choppiness ${i.volatility.choppiness.toFixed(1)} with ADX ${i.trend.adx.toFixed(1)} — no exploitable structure.`,
      severity: 'hard',
    })
  }

  if (i.volatility.atrPct > settings.maxAtrPct) {
    v.push({
      id: 'vol_too_high',
      reason: `ATR ${i.volatility.atrPct.toFixed(2)}% exceeds the ${settings.maxAtrPct}% ceiling — stops become lottery tickets.`,
      severity: 'hard',
    })
  }

  if (i.trend.adx < settings.minAdx && i.volatility.regime !== 'RANGING' && i.volatility.regime !== 'SQUEEZE') {
    v.push({
      id: 'adx_low',
      reason: `ADX ${i.trend.adx.toFixed(1)} below the ${settings.minAdx} floor.`,
      severity: 'soft',
    })
  }

  // Higher timeframes must not point the other way — but only when we are trying
  // to trade WITH a trend. A range fade or a divergence reversal is *supposed* to
  // lean against the higher timeframe, so blocking it there is simply wrong.
  const htf = mtf.filter((t) => t.timeframe !== settings.timeframe)
  const opposed = htf.filter((t) => (long ? t.trendScore < -25 : t.trendScore > 25))
  if (opposed.length) {
    const counterTrend =
      playbook === 'mean_reversion' ||
      playbook === 'range_fade' ||
      playbook === 'divergence_reversal' ||
      playbook === 'pattern_reversal'
    // Only a *committed* higher-timeframe trend can veto: -30 inside a chop
    // regime is noise, -60 inside a trending regime is a wall.
    const wall = opposed.some(
      (t) => Math.abs(t.trendScore) > 55 && (t.regime === 'TRENDING_UP' || t.regime === 'TRENDING_DOWN'),
    )
    v.push({
      id: 'htf_conflict',
      reason: `${opposed.map((t) => `${t.timeframe} ${t.bias} (${t.trendScore.toFixed(0)})`).join(', ')} opposes a ${side}${
        counterTrend ? ' — expected for a counter-trend playbook' : ''
      }.`,
      severity: settings.requireMtfAlignment && wall && !counterTrend ? 'hard' : 'soft',
    })
  }

  if (settings.requireMtfAlignment && alignment < 35) {
    v.push({
      id: 'alignment',
      reason: `Timeframe alignment only ${alignment.toFixed(0)}%.`,
      severity: 'soft',
    })
  }

  // No room = no trade — but "room" must be judged against the strength of the
  // barrier, not a flat distance: a round number 0.7 ATR away is not a wall.
  const atr = i.volatility.atr || i.price * 0.002
  const barrier = long ? i.structure.nearestResistance : i.structure.nearestSupport
  if (barrier) {
    const room = Math.abs(barrier.price - i.price) / atr
    const rrRoom = room / Math.max(1, settings.rrRatio)
    if (room < 0.9 && barrier.strength > 45) {
      v.push({
        id: 'no_room',
        reason: `Strong ${barrier.kind} at ${barrier.price.toPrecision(6)} only ${room.toFixed(2)} ATR away (${barrier.source}, strength ${barrier.strength.toFixed(0)}) — the first target has nowhere to go.`,
        severity: room < 0.45 && barrier.strength > 70 ? 'hard' : 'soft',
      })
    } else if (rrRoom < 0.5 && barrier.strength > 70) {
      v.push({
        id: 'room_vs_target',
        reason: `Only ${room.toFixed(2)} ATR of clear air before ${barrier.price.toPrecision(6)} — not enough for a ${settings.rrRatio.toFixed(1)}R target.`,
        severity: 'soft',
      })
    }
  }

  // Momentum already spent: entering after the move is how accounts die.
  if (long && i.momentum.rsi > 78 && i.volume.vwapZ > 2.4) {
    v.push({
      id: 'exhausted_long',
      reason: `RSI ${i.momentum.rsi.toFixed(1)} with price ${i.volume.vwapZ.toFixed(2)}σ above VWAP — chasing.`,
      severity: 'soft',
    })
  }
  if (!long && i.momentum.rsi < 22 && i.volume.vwapZ < -2.4) {
    v.push({
      id: 'exhausted_short',
      reason: `RSI ${i.momentum.rsi.toFixed(1)} with price ${i.volume.vwapZ.toFixed(2)}σ below VWAP — chasing.`,
      severity: 'soft',
    })
  }

  if (derivatives?.spreadBps !== null && derivatives?.spreadBps !== undefined && derivatives.spreadBps > 12) {
    v.push({
      id: 'spread',
      reason: `Spread ${derivatives.spreadBps.toFixed(1)}bps — illiquid book, slippage will eat the edge.`,
      severity: 'soft',
    })
  }

  // Funding that pays against the position is a real, compounding cost.
  if (derivatives?.fundingApr != null) {
    const apr = derivatives.fundingApr
    if ((long && apr > 45) || (!long && apr < -45)) {
      v.push({
        id: 'funding_cost',
        reason: `Funding ${apr.toFixed(1)}% APR works against a ${side}.`,
        severity: 'soft',
      })
    }
  }

  const opposingDiv = i.divergences.filter((d) => d.side !== side && d.kind === 'regular')
  if (opposingDiv.length >= 2) {
    v.push({
      id: 'divergence_conflict',
      reason: `${opposingDiv.length} regular divergences point the other way.`,
      severity: 'soft',
    })
  }

  /* ---- liquidity, session, statistics, empirical history ---------------- */

  if (volUsd24h != null && volUsd24h < 2_000_000) {
    v.push({
      id: 'illiquid',
      reason: `24h turnover only $${(volUsd24h / 1_000_000).toFixed(2)}M — slippage and stop hunts dominate at this size.`,
      severity: volUsd24h < 400_000 ? 'hard' : 'soft',
    })
  }

  if (session.isEquity && !session.marketOpen) {
    v.push({
      id: 'equity_session',
      reason: `${session.session} — ${session.note}. Underlying reopens in ${Math.floor(session.minutesToOpen / 60)}h${session.minutesToOpen % 60}m.`,
      severity: session.session === 'WEEKEND' ? 'hard' : 'soft',
    })
  }

  if (i.volatility.regime === 'CAPITULATION') {
    v.push({
      id: 'capitulation',
      reason: `Capitulation tape: ATR ${i.volatility.atrPct.toFixed(2)}% at the ${i.volatility.atrPercentile.toFixed(0)}th percentile with a volume climax — wait for the reversal bar to close.`,
      severity: 'soft',
    })
  }

  if (i.xvol.climax) {
    const against = side === 'LONG' ? i.momentum.score < -20 : i.momentum.score > 20
    if (against) {
      v.push({
        id: 'climax_against',
        reason: 'Volume + range climax bar printed against the intended direction.',
        severity: 'soft',
      })
    }
  }

  // A trend playbook inside a statistically mean-reverting tape is a trap.
  if (i.stats.meanReversion > 55 && Math.abs(i.stats.regTstat) < 1.4) {
    v.push({
      id: 'reverting_tape',
      reason: `Hurst ${i.stats.hurst.toFixed(2)} with a statistically flat drift (t ${i.stats.regTstat.toFixed(1)}) — momentum entries mean-revert here.`,
      severity: 'soft',
    })
  }

  if (edge && edge.sample >= 15 && edge.adjustedWinRate < 33) {
    v.push({
      id: 'edge_negative',
      reason: `History disagrees: ${edge.sample} analogues of this exact context resolved ${edge.winRate.toFixed(0)}% in favour (avg ${edge.avgR.toFixed(2)}R).`,
      severity: 'soft',
    })
  }

  // Funding settlement inside the next few minutes distorts perp entries.
  if (derivatives?.nextFundingTime && derivatives.fundingApr != null) {
    const mins = (derivatives.nextFundingTime - Date.now()) / 60_000
    if (mins > 0 && mins < 12 && Math.abs(derivatives.fundingApr) > 25) {
      v.push({
        id: 'funding_imminent',
        reason: `Funding settles in ${mins.toFixed(0)}min at ${derivatives.fundingApr.toFixed(1)}% APR — expect a wick.`,
        severity: 'soft',
      })
    }
  }

  for (const w of dataWarnings) {
    // "[info]" warnings are diagnostics, not reasons to stand aside.
    if (w.startsWith('[info]')) continue
    v.push({ id: 'data', reason: w, severity: w.includes('stale') || w.includes('malformed') ? 'hard' : 'soft' })
  }

  return v
}

/* -------------------------------------------------------------------------- */
/*  Playbook selection                                                         */
/* -------------------------------------------------------------------------- */

export function selectPlaybook(
  i: Indicators,
  side: 'LONG' | 'SHORT',
  settings: EngineSettings,
): PlaybookId | null {
  const long = side === 'LONG'
  const regime = i.volatility.regime
  const trending = regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN'
  const aligned = long ? regime === 'TRENDING_UP' : regime === 'TRENDING_DOWN'
  const strongPattern = i.patterns.find((p) => p.side === side && p.confirmed > 0.62)
  const divergence = i.divergences.find((d) => d.side === side && d.kind === 'regular')

  const allowed = (p: PlaybookId) => {
    switch (settings.strategy) {
      case 'trend_momentum':
        return p === 'trend_pullback' || p === 'trend_continuation' || p === 'structure_break_retest'
      case 'mean_reversion':
        return p === 'mean_reversion' || p === 'range_fade' || p === 'divergence_reversal'
      case 'breakout':
        return p === 'squeeze_breakout' || p === 'structure_break_retest'
      case 'pattern_confirm':
        return p === 'pattern_reversal' || p === 'trend_pullback'
      default:
        return true
    }
  }

  const candidates: PlaybookId[] = []

  if (regime === 'SQUEEZE') candidates.push('squeeze_breakout')
  if (aligned && (long ? i.volatility.percentB < 0.45 : i.volatility.percentB > 0.55))
    candidates.push('trend_pullback')
  if (aligned && i.structure.bos === (long ? 'BULL' : 'BEAR'))
    candidates.push('structure_break_retest')
  if (aligned) candidates.push('trend_continuation')
  if (!trending && Math.abs(i.volume.vwapZ) > 1.5) candidates.push('mean_reversion')
  if (!trending && (long ? i.structure.rangePosition < 0.3 : i.structure.rangePosition > 0.7))
    candidates.push('range_fade')
  if (divergence) candidates.push('divergence_reversal')
  if (strongPattern) candidates.push('pattern_reversal')

  return candidates.find(allowed) ?? null
}

/* -------------------------------------------------------------------------- */
/*  Final decision                                                             */
/* -------------------------------------------------------------------------- */

export function decide(input: {
  composite: number
  alignment: number
  factors: Factor[]
  vetoes: Veto[]
  settings: EngineSettings
  /** confluence bonuses: empirical edge + confirmed candlestick lead, 0..12 */
  bonus?: number
}): { decision: Analysis['decision']; conviction: number } {
  const { composite: comp, alignment, factors, vetoes, settings } = input
  const side = comp > 0 ? 'LONG' : 'SHORT'
  const hardVetoes = vetoes.filter((v) => v.severity === 'hard')
  const softVetoes = vetoes.filter((v) => v.severity === 'soft')

  // Agreement: how many weighted factors point the same way as the composite.
  const totalWeight = factors.reduce((s, x) => s + x.weight, 0) || 1
  const agreeWeight = factors
    .filter((x) => Math.sign(x.score) === Math.sign(comp) && Math.abs(x.score) > 8)
    .reduce((s, x) => s + x.weight, 0)
  const agreement = (agreeWeight / totalWeight) * 100

  let conviction =
    Math.abs(comp) * 0.55 + agreement * 0.25 + alignment * 0.2 - softVetoes.length * 4 + (input.bonus ?? 0)
  conviction = clamp(conviction, 0, 100)

  if (hardVetoes.length) return { decision: 'WAIT', conviction: Math.min(conviction, 35) }
  if (Math.abs(comp) < settings.minCompositeScore) return { decision: 'WAIT', conviction }
  if (conviction < settings.minConfidence) return { decision: 'WAIT', conviction }

  return { decision: side, conviction }
}
