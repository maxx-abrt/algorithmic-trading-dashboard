/**
 * OKX bar/timeframe helpers.
 * OKX uses "1m,3m,5m,15m,30m,1H,2H,4H,6H,12H,1D,2D,3D,1W,1M" and the UTC
 * variants ("6Hutc", "1Dutc", …). We normalise everything to the plain form.
 */

export const OKX_BARS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '2H',
  '4H',
  '6H',
  '12H',
  '1D',
  '2D',
  '3D',
  '1W',
  '1M',
] as const

export type OkxBar = (typeof OKX_BARS)[number]

const MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1H': 60,
  '2H': 120,
  '4H': 240,
  '6H': 360,
  '12H': 720,
  '1D': 1440,
  '2D': 2880,
  '3D': 4320,
  '1W': 10080,
  '1M': 43200,
}

/** Accepts "1h", "4H", "1d", "1Dutc" … and returns a canonical OKX bar. */
export function normalizeBar(bar: string): OkxBar {
  if (!bar) return '15m'
  const raw = bar.replace(/utc$/i, '').trim()
  const direct = OKX_BARS.find((b) => b.toLowerCase() === raw.toLowerCase())
  if (direct) return direct
  const m = /^(\d+)\s*([mhdwM])$/.exec(raw)
  if (m) {
    const n = m[1]
    const u = m[2]
    const candidate = u === 'm' ? `${n}m` : `${n}${u.toUpperCase()}`
    const found = OKX_BARS.find((b) => b === candidate)
    if (found) return found
  }
  return '15m'
}

export function barMinutes(bar: string): number {
  return MINUTES[normalizeBar(bar)] ?? 15
}

export function barMs(bar: string): number {
  return barMinutes(bar) * 60_000
}

/** Crypto trades 24/7, so a year is simply 365d of bars. */
export function barsPerYear(bar: string): number {
  return (365 * 24 * 60) / barMinutes(bar)
}

export function barLabel(bar: string): string {
  const b = normalizeBar(bar)
  return b.endsWith('m') ? b : b.toUpperCase()
}

/**
 * Suggest the two higher timeframes for a given LTF.
 * Roughly a 4x–6x step, which is the classic MTF ladder.
 */
export function higherTimeframes(bar: string): [OkxBar, OkxBar] {
  switch (normalizeBar(bar)) {
    case '1m':
      return ['5m', '30m']
    case '3m':
      return ['15m', '1H']
    case '5m':
      return ['30m', '4H']
    case '15m':
      return ['1H', '4H']
    case '30m':
      return ['2H', '12H']
    case '1H':
      return ['4H', '1D']
    case '2H':
      return ['6H', '1D']
    case '4H':
      return ['1D', '1W']
    case '6H':
      return ['1D', '1W']
    case '12H':
      return ['1D', '1W']
    case '1D':
      return ['1W', '1M']
    default:
      return ['1W', '1M']
  }
}

/** Is this an intraday bar (used for session-anchored VWAP)? */
export function isIntraday(bar: string): boolean {
  return barMinutes(bar) < 1440
}

/** Bars needed to cover roughly `days` of history. */
export function barsForDays(bar: string, days: number): number {
  return Math.ceil((days * 1440) / barMinutes(bar))
}
