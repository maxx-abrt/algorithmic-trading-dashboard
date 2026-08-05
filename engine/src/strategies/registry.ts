import type { Analysis, Side } from '../quant/types.js'

export type PlaybookId = 'trend_pullback' | 'volatility_breakout' | 'range_fade'

export interface StrategyCandidate {
  id: string
  playbook: PlaybookId
  side: Side
  eligible: boolean
  prerequisites: string[]
  triggers: string[]
  rejectionReasons: string[]
  invalidation: string
  score: number
}

function candidateId(a: Analysis, playbook: PlaybookId, side: Side) {
  return `${a.instId}:${a.timeframe}:${a.generatedAt}:${playbook}:${side}`
}

function trendPullback(a: Analysis): StrategyCandidate {
  const i = a.indicators
  const side: Side = i.ma.stackedBear ? 'SHORT' : 'LONG'
  const sign = side === 'LONG' ? 1 : -1
  const prerequisites = [
    i.trend.adx >= 18 ? 'adx_trending' : '',
    side === 'LONG' ? (i.ma.stackedBull ? 'bullish_ema_stack' : '') : (i.ma.stackedBear ? 'bearish_ema_stack' : ''),
    a.mtfAlignment >= 55 ? 'mtf_alignment' : '',
  ].filter(Boolean)
  const distanceAtr = Math.abs(a.price - i.ma.ema21) / Math.max(i.volatility.atr, 1e-9)
  const triggers = [distanceAtr <= 1.1 ? 'ema21_pullback' : '', sign * i.momentum.score >= -10 ? 'momentum_not_broken' : ''].filter(Boolean)
  const rejectionReasons = [
    ...(i.trend.adx < 18 ? ['adx_below_18'] : []),
    ...(!(side === 'LONG' ? i.ma.stackedBull : i.ma.stackedBear) ? ['ema_stack_absent'] : []),
    ...(a.mtfAlignment < 55 ? ['mtf_alignment_below_55'] : []),
    ...(distanceAtr > 1.1 ? ['price_too_far_from_pullback_zone'] : []),
  ]
  return {
    id: candidateId(a, 'trend_pullback', side), playbook: 'trend_pullback', side,
    eligible: rejectionReasons.length === 0, prerequisites, triggers, rejectionReasons,
    invalidation: 'EMA structure breaks and the structural stop is crossed',
    score: Math.max(0, 100 - rejectionReasons.length * 22 + prerequisites.length * 3),
  }
}

function volatilityBreakout(a: Analysis): StrategyCandidate {
  const i = a.indicators
  const side: Side = a.compositeScore >= 0 ? 'LONG' : 'SHORT'
  const directionBreak = side === 'LONG' ? i.structure.bos === 'BULL' : i.structure.bos === 'BEAR'
  const compressed = i.volatility.squeeze || i.volatility.bbWidthPercentile <= 25
  const volume = i.volume.volumeRatio >= 1.15
  const rejectionReasons = [
    ...(!compressed ? ['no_prior_compression'] : []),
    ...(!directionBreak ? ['no_confirmed_structure_break'] : []),
    ...(!volume ? ['volume_below_breakout_threshold'] : []),
    ...(i.volatility.regime === 'CHOPPY' ? ['choppy_regime'] : []),
  ]
  return {
    id: candidateId(a, 'volatility_breakout', side), playbook: 'volatility_breakout', side,
    eligible: rejectionReasons.length === 0,
    prerequisites: [compressed ? 'volatility_compression' : '', i.volatility.atrPercentile < 80 ? 'non_climax_volatility' : ''].filter(Boolean),
    triggers: [directionBreak ? 'structure_break' : '', volume ? 'volume_expansion' : ''].filter(Boolean),
    rejectionReasons, invalidation: 'Price closes back inside the pre-breakout value area',
    score: Math.max(0, 100 - rejectionReasons.length * 24),
  }
}

function rangeFade(a: Analysis): StrategyCandidate {
  const i = a.indicators
  const atLow = i.structure.rangePosition <= 0.2
  const atHigh = i.structure.rangePosition >= 0.8
  const side: Side = atLow ? 'LONG' : 'SHORT'
  const regimeOk = i.volatility.regime === 'RANGING' || i.volatility.regime === 'CHOPPY'
  const momentumOk = side === 'LONG' ? i.momentum.rsi <= 42 : i.momentum.rsi >= 58
  const rejectionReasons = [
    ...(!regimeOk ? ['market_not_range_bound'] : []),
    ...(!atLow && !atHigh ? ['price_not_at_range_extreme'] : []),
    ...(!momentumOk ? ['momentum_not_stretched'] : []),
    ...(i.trend.adx > 28 ? ['trend_strength_too_high'] : []),
  ]
  return {
    id: candidateId(a, 'range_fade', side), playbook: 'range_fade', side,
    eligible: rejectionReasons.length === 0,
    prerequisites: [regimeOk ? 'range_regime' : '', i.trend.adx <= 28 ? 'low_trend_strength' : ''].filter(Boolean),
    triggers: [atLow || atHigh ? 'range_extreme' : '', momentumOk ? 'momentum_stretch' : ''].filter(Boolean),
    rejectionReasons, invalidation: 'Range boundary breaks with expanding volume',
    score: Math.max(0, 100 - rejectionReasons.length * 24),
  }
}

export const STRATEGY_REGISTRY = [trendPullback, volatilityBreakout, rangeFade] as const

export function evaluateStrategies(analysis: Analysis): StrategyCandidate[] {
  return STRATEGY_REGISTRY.map((strategy) => strategy(analysis)).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score)
}
