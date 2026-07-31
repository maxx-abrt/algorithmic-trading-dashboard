/**
 * Telegram card renderer.
 *
 * Design brief: compact, monospaced, scannable in 3 seconds on a phone.
 * Hierarchy comes from block bars and light box drawing (Claude-Code flavour),
 * never from walls of prose. Every card ends with an unambiguous ACTION block:
 * what to do, on which venue, how much, and what it costs if wrong.
 */
import type { Analysis } from '../quant/types.js'
import { escapeHtml, fmtPct, fmtPrice, fmtUsd } from '../format.js'

const W = 30

/** ▰▰▰▰▰▰▱▱▱▱ */
function bar(value: number, max = 100, width = 10) {
  const pct = Math.max(0, Math.min(1, max === 0 ? 0 : value / max))
  const filled = Math.round(pct * width)
  return '\u25B0'.repeat(filled) + '\u25B1'.repeat(width - filled)
}

/** Signed bar centred on zero: ▱▱▰▰│▰▰▱▱ */
function signedBar(value: number, width = 10) {
  const half = Math.floor(width / 2)
  const mag = Math.min(1, Math.abs(value) / 100)
  const cells = Math.round(mag * half)
  const left = value < 0 ? '\u25B1'.repeat(half - cells) + '\u25B0'.repeat(cells) : '\u25B1'.repeat(half)
  const right = value > 0 ? '\u25B0'.repeat(cells) + '\u25B1'.repeat(half - cells) : '\u25B1'.repeat(half)
  return `${left}\u2502${right}`
}

function row(label: string, value: string, labelWidth = 8) {
  return `${label.padEnd(labelWidth)}${value}`
}

function box(title: string, lines: string[]) {
  const head = `\u250C\u2500 ${title} ${'\u2500'.repeat(Math.max(1, W - title.length - 4))}`
  const body = lines.map((l) => `\u2502 ${l}`)
  return [head, ...body, `\u2514${'\u2500'.repeat(W)}`].join('\n')
}

function actionBox(lines: string[]) {
  const head = `\u256D\u2500 DO THIS ${'\u2500'.repeat(Math.max(1, W - 10))}\u256E`
  const body = lines.map((l) => `\u2502 ${l.padEnd(W - 1)}\u2502`)
  return [head, ...body, `\u2570${'\u2500'.repeat(W)}\u256F`].join('\n')
}

/** How the instrument actually trades — it changes what the user must click. */
export function venueOf(a: Analysis): { tag: string; how: string } {
  const equity = a.session.isEquity
  if (a.instType === 'SPOT') {
    return {
      tag: equity ? 'xSTOCK SPOT' : 'SPOT',
      how: equity
        ? 'OKX spot · tokenized share, no leverage'
        : 'OKX spot · no leverage, no liquidation',
    }
  }
  if (a.instType === 'FUTURES') {
    return { tag: 'DATED FUTURES', how: 'OKX futures · expiry contract, isolated margin' }
  }
  return {
    tag: equity ? 'xSTOCK PERP' : 'PERP SWAP',
    how: equity
      ? 'OKX perp on a tokenized US share · isolated margin'
      : 'OKX perpetual swap · isolated margin',
  }
}

const ICON = { LONG: '\u{1F7E9}', SHORT: '\u{1F7E5}', WAIT: '\u{26AA}' } as const

/* -------------------------------------------------------------------------- */
/*  Signal card                                                                */
/* -------------------------------------------------------------------------- */

export function signalCard(a: Analysis): string {
  const i = a.indicators
  const p = a.plan
  const venue = venueOf(a)
  const hardVeto = a.vetoes.some((v) => v.severity === 'hard')

  /* ---- header ---------------------------------------------------------- */
  const head =
    `${ICON[a.decision] ?? ICON.WAIT} <b>${a.decision}</b> · <code>${escapeHtml(a.instId)}</code> · ${a.timeframe}\n` +
    `<b>${fmtPrice(a.price)}</b>  ${a.liquidity.volUsd24h ? `· ${fmtUsd(a.liquidity.volUsd24h)} 24h` : ''} · ${venue.tag}`

  /* ---- scores ---------------------------------------------------------- */
  const scores = [
    row('conv', `${bar(a.conviction)} ${a.conviction.toFixed(0).padStart(3)}`),
    row('score', `${signedBar(a.compositeScore)} ${(a.compositeScore >= 0 ? '+' : '') + a.compositeScore.toFixed(0)}`),
    row('mtf', `${bar(a.mtfAlignment)} ${a.mtfAlignment.toFixed(0)}%`),
    row('regime', a.regime.replace(/_/g, ' ').toLowerCase() + (a.playbook ? ` · ${a.playbook.replace(/_/g, ' ')}` : '')),
  ].join('\n')

  /* ---- plan ------------------------------------------------------------ */
  const blocks: string[] = [scores]

  if (p) {
    const slPct = ((p.stopLoss - p.entry) / p.entry) * 100
    const planLines = [
      row('entry', `${fmtPrice(p.entryZone[0])} → ${fmtPrice(p.entryZone[1])}`, 6),
      row('stop', `${fmtPrice(p.stopLoss)}  ${slPct.toFixed(2)}% · ${p.riskDistanceAtr.toFixed(1)}atr`, 6),
      ...p.takeProfits.map((t, idx) =>
        row(`tp${idx + 1}`, `${fmtPrice(t.price)}  ${t.rr.toFixed(2)}R · ${t.allocationPct}%`, 6),
      ),
      row('r:r', `${p.expectedRr.toFixed(2)}R · net ${p.netExpectancyR >= 0 ? '+' : ''}${p.netExpectancyR.toFixed(2)}R`, 6),
      row('hold', `~${p.expectedBarsToTarget} bars · cut at ${p.timeStopBars}`, 6),
    ]
    blocks.push(box('PLAN', planLines))

    const sizeLines = [
      row('size', `${p.contracts} ct ≈ ${fmtUsd(p.notionalUsd)} @ ${p.leverage}x`, 7),
      row('margin', `${fmtUsd(p.marginUsd)} · ${p.marginPctOfEquity.toFixed(1)}% of book`, 7),
      row('risk', `${fmtUsd(p.riskUsd)} if stopped`, 7),
      ...(p.liquidationEstimate ? [row('liq', fmtPrice(p.liquidationEstimate), 7)] : []),
      row('costs', `${fmtUsd(p.feesUsd)} fees · ${p.slippageBps.toFixed(1)}bps slip`, 7),
    ]
    blocks.push(box('SIZE', sizeLines))
  }

  /* ---- evidence (4 tight lines) --------------------------------------- */
  const drivers = a.factors
    .slice()
    .sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))
    .slice(0, 3)
    .map((f) => `${f.label.toLowerCase()} ${f.score >= 0 ? '+' : ''}${f.score.toFixed(0)}`)
    .join(' · ')

  const evidence: string[] = []
  evidence.push(`<b>why</b> ${escapeHtml(drivers)}`)
  evidence.push(
    `<b>tape</b> ${a.mtf.map((t) => `${t.timeframe} ${t.trendScore >= 0 ? '+' : ''}${t.trendScore.toFixed(0)}`).join(' ')} · rsi ${i.momentum.rsi.toFixed(0)} · adx ${i.trend.adx.toFixed(0)} · vwap z ${i.volume.vwapZ.toFixed(1)}`,
  )
  evidence.push(
    `<b>vol</b> atr ${i.volatility.atrPct.toFixed(2)}% (${i.volatility.atrPercentile.toFixed(0)}th) · ±${i.xvol.expectedMovePct.toFixed(2)}% / ${i.xvol.horizonBars}b · ${i.xvol.volTrend}${i.volatility.squeeze ? ' · squeeze' : ''}`,
  )
  if (i.patterns.length) {
    evidence.push(
      `<b>candles</b> ${i.patterns
        .slice(0, 2)
        .map((x) => `${escapeHtml(x.label.toLowerCase())} ${(x.confirmed * 100).toFixed(0)}%`)
        .join(' · ')}`,
    )
  }
  const dv = a.derivatives
  if (dv && dv.fundingApr != null) {
    evidence.push(
      `<b>flow</b> funding ${dv.fundingApr.toFixed(1)}%apr${dv.openInterestChangePct != null ? ` · oi ${fmtPct(dv.openInterestChangePct, 1)}` : ''}${dv.longShortRatio != null ? ` · l/s ${dv.longShortRatio.toFixed(2)}` : ''}${dv.spreadBps != null ? ` · spread ${dv.spreadBps.toFixed(1)}bps` : ''}`,
    )
  }
  if (a.edge && a.edge.sample > 0) {
    evidence.push(
      `<b>edge</b> ${a.edge.sample} analogues → ${a.edge.winRate.toFixed(0)}% hit · avg ${a.edge.avgR >= 0 ? '+' : ''}${a.edge.avgR.toFixed(2)}R`,
    )
  }
  if (a.session.isEquity) {
    evidence.push(`<b>session</b> ${a.session.session.toLowerCase()} · ${escapeHtml(a.session.note.split('—')[0].trim())}`)
  }

  /* ---- blockers -------------------------------------------------------- */
  const blockers = a.vetoes.length
    ? a.vetoes
        .slice(0, 3)
        .map((v) => `${v.severity === 'hard' ? '\u{1F6D1}' : '\u{26A0}'} ${escapeHtml(v.reason)}`)
        .join('\n')
    : ''

  /* ---- AI -------------------------------------------------------------- */
  const ai = a.ai
    ? `\u{1F9E0} <b>${escapeHtml(a.ai.model)}</b> ${a.ai.decision} ${a.ai.confidence.toFixed(0)}% ${a.ai.agreesWithQuant ? '· agrees' : '· <b>disagrees</b>'}\n<i>${escapeHtml(a.ai.reasoning.slice(0, 420))}</i>`
    : ''

  /* ---- action ---------------------------------------------------------- */
  let action: string
  if (a.decision === 'WAIT' || !p) {
    const need = a.vetoes.length ? a.vetoes[0].reason : 'confluence below threshold'
    action = actionBox([
      '\u25CF STAND ASIDE — no entry',
      `waiting on:`,
      ...wrap(need, W - 3),
      ...(a.shadowPlan
        ? [
            '',
            `if it confirms: ${a.compositeScore >= 0 ? 'LONG' : 'SHORT'}`,
            `entry ${fmtPrice(a.shadowPlan.entryZone[0])}-${fmtPrice(a.shadowPlan.entryZone[1])}`,
            `SL ${fmtPrice(a.shadowPlan.stopLoss)} · TP ${fmtPrice(a.shadowPlan.takeProfits[0]?.price)}`,
            `would risk ${fmtUsd(a.shadowPlan.riskUsd)} for ${a.shadowPlan.expectedRr.toFixed(1)}R`,
          ]
        : []),
      `re-check every ${a.timeframe} close`,
    ])
  } else if (hardVeto) {
    action = actionBox([
      `\u25CF DO NOT ENTER (${a.decision} blocked)`,
      ...wrap(a.vetoes.find((v) => v.severity === 'hard')?.reason ?? '', W - 3),
    ])
  } else {
    const arrow = a.decision === 'LONG' ? '\u25B2' : '\u25BC'
    const verb = a.decision === 'LONG' ? 'BUY / LONG' : 'SELL / SHORT'
    action = actionBox([
      `${arrow} ${verb} · ${venue.tag}`,
      ...wrap(venue.how, W - 3),
      '',
      `limit ${fmtPrice(p.entryZone[0])}-${fmtPrice(p.entryZone[1])}`,
      a.instType === 'SPOT'
        ? `size ${fmtUsd(p.notionalUsd)}`
        : `${p.contracts} ct · ${p.leverage}x · ${fmtUsd(p.marginUsd)} margin`,
      `SL ${fmtPrice(p.stopLoss)}   (hard)`,
      `TP ${p.takeProfits.map((t) => fmtPrice(t.price)).join(' ')}`,
      `risk ${fmtUsd(p.riskUsd)} · ${p.expectedRr.toFixed(1)}R target`,
      `move SL to BE at ${fmtPrice(p.takeProfits[0].price)}`,
    ])
  }

  const footer = `<i>${new Date(a.generatedAt).toISOString().slice(11, 16)}Z · ${a.dataQuality.ltfBars} bars · ${a.factors.length} factors · you execute, the bot never trades</i>`

  return [
    head,
    `<pre>${escapeHtml(blocks.join('\n\n'))}</pre>`,
    evidence.join('\n'),
    blockers,
    ai,
    `<pre>${escapeHtml(action)}</pre>`,
    footer,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/)
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      if (line) out.push(line.trim())
      line = w
    } else {
      line += ` ${w}`
    }
  }
  if (line.trim()) out.push(line.trim())
  return out.slice(0, 3)
}

/* -------------------------------------------------------------------------- */
/*  Alert card                                                                 */
/* -------------------------------------------------------------------------- */

export function alertCard(input: {
  title: string
  message: string
  instId: string
  timeframe: string
  price: number
  severity: string
  ruleName: string
  analysis?: Analysis | null
}): string {
  const icon =
    input.severity === 'critical'
      ? '\u{1F6A8}'
      : input.severity === 'opportunity'
        ? '\u{1F3AF}'
        : input.severity === 'warning'
          ? '\u{26A0}'
          : '\u{1F514}'
  const a = input.analysis
  const out = [
    `${icon} <b>${escapeHtml(input.title)}</b>`,
    `<code>${escapeHtml(input.instId)}</code> · ${input.timeframe} · <b>${fmtPrice(input.price)}</b>`,
    escapeHtml(input.message),
  ]

  if (a) {
    const lines = [
      row('conv', `${bar(a.conviction)} ${a.conviction.toFixed(0)} · ${a.decision}`),
      row('regime', `${a.regime.replace(/_/g, ' ').toLowerCase()} · mtf ${a.mtfAlignment.toFixed(0)}%`),
    ]
    if (a.plan) {
      lines.push(row('stop', fmtPrice(a.plan.stopLoss), 8))
      lines.push(row('tp1', `${fmtPrice(a.plan.takeProfits[0]?.price)} · ${a.plan.takeProfits[0]?.rr.toFixed(2)}R`, 8))
    }
    out.push(`<pre>${escapeHtml(lines.join('\n'))}</pre>`)
    if (a.decision !== 'WAIT' && a.plan) {
      const venue = venueOf(a)
      out.push(
        `<pre>${escapeHtml(
          actionBox([
            `${a.decision === 'LONG' ? '\u25B2' : '\u25BC'} ${a.decision} · ${venue.tag}`,
            `${fmtPrice(a.plan.entryZone[0])}-${fmtPrice(a.plan.entryZone[1])} · ${a.plan.leverage}x`,
            `SL ${fmtPrice(a.plan.stopLoss)} · risk ${fmtUsd(a.plan.riskUsd)}`,
          ]),
        )}</pre>`,
      )
    }
  }
  out.push(`<i>${escapeHtml(input.ruleName)}</i>`)
  return out.join('\n')
}

/* -------------------------------------------------------------------------- */
/*  Status card                                                                */
/* -------------------------------------------------------------------------- */

export function statusCard(state: {
  engineEnabled: boolean
  instId: string
  timeframe: string
  universe: number
  watchlist: number
  series: number
  bars: number
  ws: { public: boolean; business: boolean; subs: number }
  rest: { calls: number; errors: number; avgLatencyMs: number }
  ai: { configured: boolean; calls: number; cacheHits: number; tokensIn: number; tokensOut: number; model: string }
  convex: string
  scanner: { lastRunAt: number; scanned: number; top: string[] }
  equityUsd: number
  uptimeSec: number
  alerts24h: number
}): string {
  const up = (ok: boolean) => (ok ? '\u25CF online ' : '\u25CB down   ')
  const mins = Math.floor(state.uptimeSec / 60)
  const uptime = mins > 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`
  const lines = [
    row('engine', `${state.engineEnabled ? '\u25CF running' : '\u25CB paused '} · up ${uptime}`),
    row('focus', `${state.instId} ${state.timeframe}`),
    row('okx ws', `${up(state.ws.public && state.ws.business)}· ${state.ws.subs} subs`),
    row('okx rest', `${state.rest.calls} calls · ${state.rest.avgLatencyMs.toFixed(0)}ms · ${state.rest.errors} err`),
    row('memory', `${state.series} series · ${state.bars} bars`),
    row('scanner', `${state.scanner.scanned} scored`),
    row('ai', state.ai.configured ? `${state.ai.calls} calls · ${state.ai.cacheHits} cached · ${(state.ai.tokensIn + state.ai.tokensOut).toLocaleString('en-US')} tok` : 'disabled'),
    row('convex', state.convex),
    row('alerts', `${state.alerts24h} fired`),
    row('book', `${fmtUsd(state.equityUsd)} sizing base`),
  ]
  const top = state.scanner.top.length
    ? `\n<b>best setups</b>\n<pre>${escapeHtml(state.scanner.top.join('\n'))}</pre>`
    : ''
  return `\u{1F5A5} <b>MYCROFT</b> · ${state.universe} instruments · ${state.watchlist} watched\n<pre>${escapeHtml(lines.join('\n'))}</pre>${top}`
}

export const HELP = `\u{1F916} <b>MYCROFT</b> — OKX decision companion

I watch OKX (crypto perps, dated futures, spot and tokenized US shares), run the full quant stack locally and only ping you when a real setup appears. I never place an order: every card ends with exactly what <i>you</i> should do.

<pre>/status            engine, feeds, cost
/analyze BTC 15m   full decision card
/watch NVDA 1H     add to surveillance
/unwatch NVDA      stop watching
/list              watchlist + verdicts
/scan              best setups now
/settings          risk + AI config
/mute  /unmute     pause notifications
/help              this message</pre>

Symbols accept short form (<code>BTC</code>, <code>NVDA</code>) or full OKX ids (<code>BTC-USDT-SWAP</code>).`
