/**
 * Telegram notifications about the SYSTEM, not just about signals.
 *
 * The owner cannot watch a dashboard 24/7, so the bot reports what changed:
 * a new generation was born, a canary took the crown, a champion was rolled
 * back, the engine is alive, and once a day what it actually learned.
 */
import { fmtUsd } from '../format.js'
import type { EvolutionNotice } from '../research/evolution-service.js'
import { REASON_LABELS, type ReasonCode } from '../paper/attribution.js'

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ICONS: Record<EvolutionNotice['type'], string> = {
  born: '\u{1F9EC}',
  promoted: '\u{1F451}',
  canary: '\u{1F423}',
  retired: '\u{1F4E6}',
  rolled_back: '\u{26A0}',
  rejected: '\u{1F6AB}',
}

const TITLES: Record<EvolutionNotice['type'], string> = {
  born: 'New generation born',
  promoted: 'New champion',
  canary: 'Canary started',
  retired: 'Specialist retired',
  rolled_back: 'Champion rolled back',
  rejected: 'Evolution rejected',
}

export function evolutionCard(notice: EvolutionNotice) {
  return [`${ICONS[notice.type]} <b>${TITLES[notice.type]}</b>`, `<code>${esc(notice.nicheKey)}</code>`, '', esc(notice.detail)].join('\n')
}

const r = (value: number | null | undefined, digits = 2) => (value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}R`)
const pct = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(0)}%`)

export interface DigestInput {
  uptimeSec: number
  engineEnabled: boolean
  instruments: number
  samples: number
  specialists: number
  championCount: number
  validationState: string
  paper: { total: number; closed: number; open: number; winRate: number | null; avgR: number | null; sumR: number }
  today: { closed: number; sumR: number; wins: number }
  champions: { displayName: string; nicheKey: string; generation: number; liveTrades: number; liveMeanR: number | null }[]
  attribution: { reasonCode: string; count: number; meanR: number }[]
  demo: { configured: boolean; reason: string; placed: number; filled: number; rejected: number; equityUsd: number | null }
  aiSpendEur: number
  aiBudgetEur: number
  diskFreeGb: number | null
}

export function digestCard(input: DigestInput) {
  const hours = Math.floor(input.uptimeSec / 3600)
  const lines: string[] = []
  lines.push('\u{1F4CA} <b>MYCROFT daily digest</b>')
  lines.push(`<i>${input.engineEnabled ? 'engine online' : 'engine paused'} · uptime ${hours}h · ${input.instruments} instruments</i>`)
  lines.push('')
  lines.push('<b>Learning</b>')
  lines.push(`<pre>samples      ${input.samples}\nspecialists  ${input.specialists} (${input.championCount} champion)\nstate        ${input.validationState}</pre>`)
  if (input.champions.length) {
    lines.push('<b>Champions</b>')
    lines.push(
      `<pre>${input.champions
        .slice(0, 6)
        .map((row) => `${row.displayName.padEnd(18).slice(0, 18)} G${row.generation} ${row.nicheKey.split('|').slice(0, 2).join('/')} ${String(row.liveTrades).padStart(3)}t ${r(row.liveMeanR)}`)
        .join('\n')}</pre>`,
    )
  }
  lines.push('<b>Paper performance</b>')
  lines.push(
    `<pre>closed       ${input.paper.closed}\nopen         ${input.paper.open}\nwin rate     ${pct(input.paper.winRate)}\nmean         ${r(input.paper.avgR)}\ncumulative   ${r(input.paper.sumR)}\nlast 24h     ${input.today.closed} closed, ${r(input.today.sumR)}</pre>`,
  )
  if (input.attribution.length) {
    lines.push('<b>Why trades ended</b>')
    lines.push(
      `<pre>${input.attribution
        .slice(0, 5)
        .map((row) => `${String(row.count).padStart(4)} ${r(row.meanR)}  ${(REASON_LABELS[row.reasonCode as ReasonCode] ?? row.reasonCode).slice(0, 36)}`)
        .join('\n')}</pre>`,
    )
  }
  lines.push('<b>Execution &amp; budget</b>')
  lines.push(
    `<pre>okx demo     ${
      input.demo.configured
        ? `on · ${input.demo.placed} placed / ${input.demo.filled} filled / ${input.demo.rejected} rejected${input.demo.equityUsd != null ? ` · ${fmtUsd(input.demo.equityUsd)}` : ''}`
        : `off (${input.demo.reason})`
    }\nai spend     \u20AC${input.aiSpendEur.toFixed(3)} / \u20AC${input.aiBudgetEur.toFixed(2)}\ndisk free    ${input.diskFreeGb != null ? `${input.diskFreeGb.toFixed(1)} GB` : '—'}</pre>`,
  )
  return lines.join('\n')
}

export function heartbeatCard(input: {
  uptimeSec: number
  samples: number
  championCount: number
  openTrades: number
  closedToday: number
  sumRToday: number
  validationState: string
  wsHealthy: boolean
}) {
  const hours = Math.floor(input.uptimeSec / 3600)
  const minutes = Math.floor((input.uptimeSec % 3600) / 60)
  return [
    `\u{1F49A} <b>MYCROFT alive</b> — ${hours}h ${minutes}m`,
    `<pre>feed        ${input.wsHealthy ? 'healthy' : 'degraded'}\nstate       ${input.validationState}\nchampions   ${input.championCount}\nsamples     ${input.samples}\nopen        ${input.openTrades}\ntoday       ${input.closedToday} closed, ${r(input.sumRToday)}</pre>`,
  ].join('\n')
}

export function orderCard(input: {
  kind: 'placed' | 'filled' | 'closed' | 'rejected'
  instId: string
  side: string
  timeframe: string
  playbook: string
  px?: number | null
  sz?: number | null
  netR?: number | null
  reason?: string
  modelName?: string | null
  probability?: number | null
}) {
  const icon = input.kind === 'placed' ? '\u{1F4E4}' : input.kind === 'filled' ? '\u2705' : input.kind === 'closed' ? '\u{1F3C1}' : '\u{1F6AB}'
  const head = `${icon} <b>OKX demo ${input.kind}</b> — ${esc(input.instId)} ${input.side} ${input.timeframe}`
  const rows = [
    `playbook    ${input.playbook}`,
    input.modelName ? `expert      ${input.modelName}${input.probability != null ? ` (p=${(input.probability * 100).toFixed(0)}%)` : ''}` : '',
    input.px != null ? `price       ${input.px}` : '',
    input.sz != null ? `size        ${input.sz}` : '',
    input.netR != null ? `net         ${r(input.netR)}` : '',
    input.reason ? `reason      ${input.reason.slice(0, 90)}` : '',
  ].filter(Boolean)
  return `${head}\n<pre>${esc(rows.join('\n'))}</pre>`
}
