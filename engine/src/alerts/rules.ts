/**
 * Alert rule evaluation.
 *
 * Rules are pure functions of (previous analysis, current analysis, live ticker).
 * Everything stateful — cooldowns, dedupe, delivery — is handled by the runtime,
 * so this module stays trivially testable.
 */
import type { Analysis } from '../quant/types.js'
import type { AlertRuleRow } from '../convex/client.js'
import { fmtPct, fmtPrice } from '../format.js'

export type Severity = 'info' | 'opportunity' | 'warning' | 'critical'

export interface AlertCandidate {
  ruleId?: string
  ruleName: string
  type: string
  severity: Severity
  instId: string
  timeframe: string
  title: string
  message: string
  decision?: string
  conviction?: number
  price: number
  telegram: boolean
  /** stable identity used for dedupe */
  fingerprint: string
}

export interface RuleContext {
  analysis: Analysis
  previous: Analysis | null
  changePct24h: number | null
  volUsd24h: number | null
  inWatchlist: boolean
}

export const ALERT_TYPES = [
  'signal',
  'conviction',
  'price_cross',
  'pct_move',
  'rsi_level',
  'squeeze_fire',
  'funding_extreme',
  'oi_spike',
  'pattern',
  'regime_change',
  'level_break',
  'vol_spike',
  'divergence',
] as const

export const ALERT_TYPE_LABELS: Record<string, string> = {
  signal: 'Actionable signal (LONG/SHORT with conviction)',
  conviction: 'Conviction crosses a threshold',
  price_cross: 'Price crosses a level',
  pct_move: '24h move exceeds a percentage',
  rsi_level: 'RSI crosses a level',
  squeeze_fire: 'Volatility squeeze fires',
  funding_extreme: 'Funding rate becomes extreme',
  oi_spike: 'Open interest spikes',
  pattern: 'Confirmed candlestick formation',
  regime_change: 'Volatility regime changes',
  level_break: 'Support / resistance breaks',
  vol_spike: 'Volatility or volume climax',
  divergence: 'Fresh oscillator divergence',
}

function hardVetoed(a: Analysis) {
  return a.vetoes.some((v) => v.severity === 'hard')
}

export function evaluateRule(rule: AlertRuleRow, ctx: RuleContext): AlertCandidate | null {
  const a = ctx.analysis
  const prev = ctx.previous
  const p = rule.params ?? {}
  const base = {
    ruleId: rule._id,
    ruleName: rule.name,
    type: rule.type,
    instId: a.instId,
    timeframe: a.timeframe,
    price: a.price,
    telegram: rule.telegram,
    decision: a.decision,
    conviction: a.conviction,
  }
  const dirWanted = (p.direction ?? 'any').toUpperCase()

  switch (rule.type) {
    case 'signal': {
      const threshold = p.threshold ?? 60
      if (a.decision === 'WAIT' || a.conviction < threshold || hardVetoed(a)) return null
      if (dirWanted !== 'ANY' && dirWanted !== a.decision) return null
      const tp = a.plan?.takeProfits[0]
      return {
        ...base,
        severity: 'opportunity',
        title: `${a.decision} setup · ${a.instId}`,
        message: `${a.playbook?.replace(/_/g, ' ') ?? 'confluence'} at ${fmtPrice(a.price)} · conviction ${a.conviction.toFixed(0)}/100 · ${
          a.plan ? `stop ${fmtPrice(a.plan.stopLoss)}, TP1 ${fmtPrice(tp?.price)} (${tp?.rr.toFixed(2)}R), net ${a.plan.netExpectancyR.toFixed(2)}R` : 'no plan'
        }`,
        fingerprint: `signal|${a.instId}|${a.timeframe}|${a.decision}|${a.playbook}`,
      }
    }
    case 'conviction': {
      const threshold = p.threshold ?? 70
      const crossedUp = a.conviction >= threshold && (prev?.conviction ?? 0) < threshold
      if (!crossedUp) return null
      return {
        ...base,
        severity: 'opportunity',
        title: `Conviction ${a.conviction.toFixed(0)} · ${a.instId}`,
        message: `Confluence crossed ${threshold} (${a.decision}, composite ${a.compositeScore.toFixed(0)}, MTF ${a.mtfAlignment.toFixed(0)}%).`,
        fingerprint: `conviction|${a.instId}|${a.timeframe}|${threshold}`,
      }
    }
    case 'price_cross': {
      const level = p.value
      if (level == null || !prev) return null
      const up = prev.price < level && a.price >= level
      const down = prev.price > level && a.price <= level
      if (!(up || down)) return null
      if (dirWanted === 'ABOVE' && !up) return null
      if (dirWanted === 'BELOW' && !down) return null
      return {
        ...base,
        severity: 'info',
        title: `${a.instId} crossed ${fmtPrice(level)}`,
        message: `Price ${up ? 'broke above' : 'broke below'} ${fmtPrice(level)} (now ${fmtPrice(a.price)}). Regime ${a.regime.toLowerCase()}, decision ${a.decision}.`,
        fingerprint: `price|${a.instId}|${level}|${up ? 'up' : 'down'}`,
      }
    }
    case 'pct_move': {
      const threshold = p.threshold ?? 5
      if (ctx.changePct24h == null || Math.abs(ctx.changePct24h) < threshold) return null
      return {
        ...base,
        severity: 'warning',
        title: `${a.instId} ${fmtPct(ctx.changePct24h, 1)} in 24h`,
        message: `Move of ${fmtPct(ctx.changePct24h, 2)} with ATR at the ${a.indicators.volatility.atrPercentile.toFixed(0)}th percentile. Decision ${a.decision}.`,
        fingerprint: `pct|${a.instId}|${Math.round(ctx.changePct24h)}`,
      }
    }
    case 'rsi_level': {
      const level = p.value ?? 70
      const rsi = a.indicators.momentum.rsi
      const prevRsi = prev?.indicators.momentum.rsi ?? rsi
      const up = prevRsi < level && rsi >= level
      const down = prevRsi > level && rsi <= level
      if (!(up || down)) return null
      if (dirWanted === 'ABOVE' && !up) return null
      if (dirWanted === 'BELOW' && !down) return null
      return {
        ...base,
        severity: 'info',
        title: `RSI ${rsi.toFixed(1)} · ${a.instId}`,
        message: `RSI crossed ${up ? 'above' : 'below'} ${level} on ${a.timeframe} at ${fmtPrice(a.price)}.`,
        fingerprint: `rsi|${a.instId}|${level}|${up ? 'up' : 'down'}`,
      }
    }
    case 'squeeze_fire': {
      if (!prev) return null
      if (!(prev.indicators.volatility.squeeze && !a.indicators.volatility.squeeze)) return null
      return {
        ...base,
        severity: 'opportunity',
        title: `Squeeze fired · ${a.instId}`,
        message: `Bollinger bands expanded out of the Keltner squeeze. Momentum ${a.indicators.momentum.score.toFixed(0)}, direction bias ${a.bias}, expected move ±${a.indicators.xvol.expectedMovePct.toFixed(2)}%.`,
        fingerprint: `squeeze|${a.instId}|${a.timeframe}`,
      }
    }
    case 'funding_extreme': {
      const threshold = p.threshold ?? 40
      const apr = a.derivatives?.fundingApr
      if (apr == null || Math.abs(apr) < threshold) return null
      return {
        ...base,
        severity: 'warning',
        title: `Funding ${apr.toFixed(1)}% APR · ${a.instId}`,
        message: `${apr > 0 ? 'Longs' : 'Shorts'} are paying ${Math.abs(apr).toFixed(1)}% annualised — crowded positioning, squeeze risk against the crowd.`,
        fingerprint: `funding|${a.instId}|${Math.round(apr / 10)}`,
      }
    }
    case 'oi_spike': {
      const threshold = p.threshold ?? 5
      const oi = a.derivatives?.openInterestChangePct
      if (oi == null || Math.abs(oi) < threshold) return null
      return {
        ...base,
        severity: 'info',
        title: `Open interest ${fmtPct(oi, 1)} · ${a.instId}`,
        message: `OI moved ${fmtPct(oi, 2)} while price is ${a.bias.toLowerCase()} — ${
          oi > 0 ? 'new positions entering' : 'positions closing / liquidations'
        }.`,
        fingerprint: `oi|${a.instId}|${Math.round(oi)}`,
      }
    }
    case 'pattern': {
      const threshold = (p.threshold ?? 65) / 100
      const fresh = a.indicators.patterns.find((x) => x.barsAgo <= 1 && x.confirmed >= threshold)
      if (!fresh) return null
      if (dirWanted !== 'ANY' && dirWanted !== fresh.side) return null
      return {
        ...base,
        severity: 'opportunity',
        title: `${fresh.label} · ${a.instId}`,
        message: `${fresh.side} formation confirmed at ${(fresh.confirmed * 100).toFixed(0)}% — ${fresh.notes.slice(0, 3).join('; ')}.`,
        fingerprint: `pattern|${a.instId}|${fresh.name}|${fresh.ts}`,
      }
    }
    case 'regime_change': {
      if (!prev || prev.regime === a.regime) return null
      return {
        ...base,
        severity: 'info',
        title: `Regime → ${a.regime.replace(/_/g, ' ')} · ${a.instId}`,
        message: `Switched from ${prev.regime.replace(/_/g, ' ').toLowerCase()} to ${a.regime
          .replace(/_/g, ' ')
          .toLowerCase()} (ADX ${a.indicators.trend.adx.toFixed(1)}, ATR pct ${a.indicators.volatility.atrPercentile.toFixed(0)}, chop ${a.indicators.volatility.choppiness.toFixed(0)}).`,
        fingerprint: `regime|${a.instId}|${a.regime}`,
      }
    }
    case 'level_break': {
      if (!prev) return null
      const res = prev.indicators.structure.nearestResistance
      const sup = prev.indicators.structure.nearestSupport
      const brokeUp = res && prev.price < res.price && a.price > res.price
      const brokeDown = sup && prev.price > sup.price && a.price < sup.price
      if (!brokeUp && !brokeDown) return null
      const lvl = brokeUp ? res! : sup!
      return {
        ...base,
        severity: 'opportunity',
        title: `${brokeUp ? 'Resistance' : 'Support'} broken · ${a.instId}`,
        message: `${fmtPrice(lvl.price)} (${lvl.source}, strength ${lvl.strength.toFixed(0)}) gave way. Structure ${a.indicators.structure.structure}${
          a.indicators.structure.bos ? `, ${a.indicators.structure.bos} BOS` : ''
        }.`,
        fingerprint: `level|${a.instId}|${lvl.price.toPrecision(6)}`,
      }
    }
    case 'vol_spike': {
      const threshold = p.threshold ?? 90
      const climax = a.indicators.xvol.climax
      if (!climax && a.indicators.volatility.atrPercentile < threshold) return null
      return {
        ...base,
        severity: 'warning',
        title: `Volatility spike · ${a.instId}`,
        message: `ATR at the ${a.indicators.volatility.atrPercentile.toFixed(0)}th percentile${
          climax ? ' with a volume climax bar' : ''
        } — widen stops or stand aside (expected move ±${a.indicators.xvol.expectedMovePct.toFixed(2)}%).`,
        fingerprint: `vol|${a.instId}|${Math.round(a.indicators.volatility.atrPercentile)}`,
      }
    }
    case 'divergence': {
      const d = a.indicators.divergences.find((x) => x.barsAgo <= 2 && x.kind === 'regular')
      if (!d) return null
      if (dirWanted !== 'ANY' && dirWanted !== d.side) return null
      return {
        ...base,
        severity: 'opportunity',
        title: `${d.side} ${d.source.toUpperCase()} divergence · ${a.instId}`,
        message: `Regular ${d.side === 'LONG' ? 'bullish' : 'bearish'} divergence on ${d.source.toUpperCase()} (strength ${d.strength.toFixed(0)}) ${d.barsAgo} bars ago at ${fmtPrice(a.price)}.`,
        fingerprint: `div|${a.instId}|${d.source}|${d.side}`,
      }
    }
    default:
      return null
  }
}

export function scopeMatches(rule: AlertRuleRow, instId: string, inWatchlist: boolean) {
  if (rule.scope === '*') return inWatchlist
  if (rule.scope === 'ANY') return true
  return rule.scope === instId
}
