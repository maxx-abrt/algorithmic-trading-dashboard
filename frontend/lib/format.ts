/** Formatting helpers — every number on screen goes through here. */

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (abs >= 100) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (abs >= 1) return n.toFixed(3)
  if (abs >= 0.01) return n.toFixed(5)
  if (abs > 0) return n.toPrecision(4)
  return '0'
}

export function fmtNum(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export function fmtSigned(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}`
}

export function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}k`
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`
  return `${sign}$${abs.toFixed(2)}`
}

export function fmtR(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}R`
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function clockUtc(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toISOString().slice(11, 19)
}

export function dateUtc(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toISOString().slice(5, 16).replace('T', ' ')
}

export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function toneOf(n: number | null | undefined, deadband = 0): 'bull' | 'bear' | 'neutral' {
  if (n == null || !Number.isFinite(n)) return 'neutral'
  if (n > deadband) return 'bull'
  if (n < -deadband) return 'bear'
  return 'neutral'
}

export const TONE_TEXT = {
  bull: 'text-bull',
  bear: 'text-bear',
  neutral: 'text-muted-foreground',
} as const

export function compactDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`
}
