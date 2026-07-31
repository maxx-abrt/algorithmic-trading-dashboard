/** Shared presentation helpers (Telegram cards, logs, API payloads). */

export function fmtNum(n: number | null | undefined, dp?: number): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const digits = dp ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8)
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 1 })
  if (abs >= 1) return n.toFixed(3)
  if (abs >= 0.01) return n.toFixed(5)
  return n.toPrecision(4)
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(n / 1e6).toFixed(2)}M`
  if (abs >= 10_000) return `$${(n / 1000).toFixed(1)}k`
  if (abs >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

export function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function pad(label: string, width: number) {
  return label.length >= width ? label : label + ' '.repeat(width - label.length)
}

export function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
