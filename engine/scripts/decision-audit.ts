/**
 * Decision audit — calibration check for the gate stack.
 *
 * Runs the full brain over the most liquid slice of the OKX universe on two
 * timeframes and reports the distribution of verdicts, the veto histogram and
 * the conviction spread. Use it after touching weights or gates: a healthy
 * configuration produces roughly 10-30% actionable setups, not 0% and not 90%.
 *
 *   yarn tsx scripts/decision-audit.ts [count] [timeframes...]
 */
import '../src/env.js'
import { fetchCandles, fetchDerivatives, fetchInstruments, fetchTickers } from '../src/okx/market.js'
import { analyze } from '../src/quant/engine.js'
import type { Analysis, InstrumentSpec } from '../src/quant/types.js'
import { higherTimeframes } from '../src/quant/timeframes.js'

const COUNT = Number(process.argv[2] ?? 14)
const BARS = process.argv.slice(3).length ? process.argv.slice(3) : ['15m', '1H']

const specs = new Map<string, InstrumentSpec>()
for (const t of ['SWAP', 'SPOT'] as const) {
  for (const s of await fetchInstruments(t)) specs.set(s.instId, s)
}
const tickers = (await fetchTickers('SWAP'))
  .filter((t) => t.instId.endsWith('-USDT-SWAP'))
  .sort((a, b) => b.volUsd24h - a.volUsd24h)
  .slice(0, COUNT)

const rows: { instId: string; bar: string; a: Analysis }[] = []

for (const t of tickers) {
  for (const bar of BARS) {
    const [h1, h2] = higherTimeframes(bar)
    try {
      const [ltf, htf, htf2, deriv] = await Promise.all([
        fetchCandles(t.instId, bar, 400),
        fetchCandles(t.instId, h1, 260),
        fetchCandles(t.instId, h2, 180),
        fetchDerivatives(t.instId, 'SWAP', t.changePct24h),
      ])
      rows.push({
        instId: t.instId,
        bar,
        a: analyze({
          instId: t.instId,
          spec: specs.get(t.instId) ?? null,
          ltf,
          htf,
          htf2,
          derivatives: deriv,
          livePrice: t.last,
          volUsd24h: t.volUsd24h,
          settings: { timeframe: bar, htfTimeframe: h1, htf2Timeframe: h2 },
        }),
      })
    } catch (err) {
      console.log(`  skip ${t.instId} ${bar}: ${(err as Error).message}`)
    }
  }
}

const counts = { LONG: 0, SHORT: 0, WAIT: 0 } as Record<string, number>
const vetoHist = new Map<string, number>()
const hardHist = new Map<string, number>()
let convSum = 0
let best: { instId: string; bar: string; a: Analysis } | null = null

console.log(`\n${'inst'.padEnd(20)}${'tf'.padEnd(5)}${'verdict'.padEnd(9)}${'conv'.padStart(5)}${'comp'.padStart(6)}${'mtf'.padStart(5)}  regime           playbook              blockers`)
console.log('-'.repeat(140))
for (const r of rows.sort((x, y) => y.a.conviction - x.a.conviction)) {
  counts[r.a.decision]++
  convSum += r.a.conviction
  for (const v of r.a.vetoes) {
    vetoHist.set(v.id, (vetoHist.get(v.id) ?? 0) + 1)
    if (v.severity === 'hard') hardHist.set(v.id, (hardHist.get(v.id) ?? 0) + 1)
  }
  if (r.a.decision !== 'WAIT' && (!best || r.a.conviction > best.a.conviction)) best = r
  console.log(
    r.instId.padEnd(20) +
      r.bar.padEnd(5) +
      r.a.decision.padEnd(9) +
      r.a.conviction.toFixed(0).padStart(5) +
      `${r.a.compositeScore > 0 ? '+' : ''}${r.a.compositeScore.toFixed(0)}`.padStart(6) +
      `${r.a.mtfAlignment.toFixed(0)}%`.padStart(5) +
      '  ' +
      r.a.regime.toLowerCase().padEnd(17) +
      (r.a.playbook ?? '—').padEnd(22) +
      r.a.vetoes.map((v) => (v.severity === 'hard' ? `!${v.id}` : v.id)).join(' '),
  )
}

const actionable = counts.LONG + counts.SHORT
console.log('-'.repeat(140))
console.log(
  `\n${rows.length} evaluations · LONG ${counts.LONG} · SHORT ${counts.SHORT} · WAIT ${counts.WAIT} · actionable ${(
    (actionable / Math.max(1, rows.length)) *
    100
  ).toFixed(0)}% · mean conviction ${(convSum / Math.max(1, rows.length)).toFixed(1)}`,
)
console.log(
  `hard vetoes: ${[...hardHist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
)
console.log(
  `all vetoes:  ${[...vetoHist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
)
if (best) {
  console.log(`\nbest actionable idea → ${best.instId} ${best.bar}`)
  for (const line of best.a.narrative) console.log(`  ${line}`)
}
process.exit(0)
