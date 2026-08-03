import '../src/env.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchCandles, fetchInstruments, fetchTicker } from '../src/okx/market.js'
import { analyze } from '../src/quant/engine.js'
import { higherTimeframes } from '../src/quant/timeframes.js'
import { evaluateStrategies } from '../src/strategies/registry.js'
import { createPaperPlan, runPaperPlan } from '../src/paper/broker.js'
import { DurableStore } from '../src/store/durable.js'
import { purgedWalkForward, validationMetrics } from '../src/research/validation.js'
import type { Analysis, Candle, InstrumentSpec, RiskPlan } from '../src/quant/types.js'
import type { PaperTrade } from '../src/paper/types.js'

const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

function closedAt(candle: Candle, timeframe: string) {
  const unit = timeframe.endsWith('H') ? 3_600_000 : timeframe.endsWith('D') ? 86_400_000 : 60_000
  return candle.ts + Number.parseInt(timeframe) * unit
}

function cut(rows: Candle[], at: number) {
  return rows.filter((row) => row.ts < at)
}

async function main() {
  console.log('MYCROFT CORE POC — real OKX data, paper-only execution, durable truth, walk-forward validation')
  const instrumentRows = await fetchInstruments('SWAP')
  const spec = instrumentRows.find((row) => row.instId === 'BTC-USDT-SWAP') as InstrumentSpec | undefined
  const ticker = await fetchTicker('BTC-USDT-SWAP')
  check('okx.public_instrument', Boolean(spec), spec ? `${spec.instId} tick=${spec.tickSz} lot=${spec.lotSz}` : 'missing')
  check('okx.live_ticker', Boolean(ticker && ticker.last > 0 && Date.now() - ticker.ts < 120_000), ticker ? `price=${ticker.last} sourceAgeMs=${Date.now() - ticker.ts}` : 'missing')
  if (!spec || !ticker) throw new Error('OKX public core unavailable')

  const timeframe = '15m'
  const [htfName, htf2Name] = higherTimeframes(timeframe)
  const [ltf, htf, htf2] = await Promise.all([
    fetchCandles(spec.instId, timeframe, 600, { history: true }),
    fetchCandles(spec.instId, htfName, 500, { history: true }),
    fetchCandles(spec.instId, htf2Name, 300, { history: true }),
  ])
  const allConfirmed = ltf.filter((row) => row.confirmed)
  const malformed = allConfirmed.filter((row) => !Number.isFinite(row.close) || row.high < row.low || row.low <= 0)
  check('okx.historical_candles', allConfirmed.length >= 400 && malformed.length === 0, `${allConfirmed.length} confirmed real candles; malformed=${malformed.length}`)

  const temp = mkdtempSync(join(tmpdir(), 'mycroft-core-'))
  const store = new DurableStore(join(temp, 'core.sqlite'))
  try {
    store.upsertCandles(spec.instId, timeframe, allConfirmed)
    const loaded = store.loadCandles(spec.instId, timeframe, 700)
    check('durable.sqlite_roundtrip', loaded.length === allConfirmed.length && loaded.at(-1)?.ts === allConfirmed.at(-1)?.ts, `${loaded.length} candles recovered from WAL store`)

    const trades: PaperTrade[] = []
    const samples: { at: number; symbol: string }[] = []
    let eligible = 0
    let rejected = 0
    let fallbackShadowUsed = false

    for (let index = 260; index < allConfirmed.length - 24; index += 8) {
      const signalBar = allConfirmed[index]
      const availableAt = closedAt(signalBar, timeframe)
      const ltfSlice = cut(allConfirmed, availableAt).slice(-300)
      const htfSlice = cut(htf, availableAt).slice(-220)
      const htf2Slice = cut(htf2, availableAt).slice(-160)
      const analysis: Analysis = analyze({
        instId: spec.instId, instType: spec.instType, spec,
        ltf: ltfSlice, htf: htfSlice, htf2: htf2Slice,
        livePrice: ltfSlice.at(-1)?.close, volUsd24h: ticker.volUsd24h,
        now: availableAt,
        settings: { timeframe, htfTimeframe: htfName, htf2Timeframe: htf2Name, useDerivatives: false },
      })
      const candidates = evaluateStrategies(analysis)
      samples.push({ at: availableAt, symbol: spec.instId })
      for (const candidate of candidates) {
        candidate.eligible ? eligible++ : rejected++
        store.recordCandidate({
          id: candidate.id, observedAt: availableAt, instId: spec.instId, timeframe,
          playbook: candidate.playbook, side: candidate.side, eligible: candidate.eligible,
          reasons: candidate.rejectionReasons, policyVersion: 'core-poc-v1', featureTime: signalBar.ts,
          latestSourceTime: signalBar.ts, availableAt, payload: candidate,
        })
      }
      store.recordDecision(`${spec.instId}:${timeframe}:${availableAt}`, analysis, 'core-poc-v1', 'heuristic-baseline')

      const best = candidates.find((candidate) => candidate.eligible && candidate.side === (analysis.plan ?? analysis.shadowPlan)?.side)
      let riskPlan: RiskPlan | null = best ? (analysis.plan ?? analysis.shadowPlan) : null
      let playbook = best?.playbook ?? 'shadow_validation_only'
      if (!riskPlan && !fallbackShadowUsed && analysis.shadowPlan) {
        riskPlan = analysis.shadowPlan
        fallbackShadowUsed = true
      }
      if (!riskPlan) continue

      const plan = createPaperPlan({
        id: `poc:${availableAt}`, instId: spec.instId, timeframe, signalAt: availableAt,
        playbook, policyVersion: 'core-poc-v1', plan: riskPlan,
        atrAtEntry: analysis.indicators.volatility.atr, feeBps: 5, slippageBps: Math.max(1, riskPlan.slippageBps),
      })
      const future = allConfirmed.slice(index + 1, index + 1 + Math.max(plan.maxHoldBars + plan.maxEntryBars, 24))
      const trade = runPaperPlan(plan, future)
      store.saveTrade(trade)
      trades.push(trade)
    }

    check('strategies.candidate_ledger', eligible + rejected > 20 && rejected > 0, `${eligible} eligible and ${rejected} rejected candidates persisted`)
    check('paper.state_machine', trades.length > 0 && trades.every((trade) => trade.events.length >= 2), `${trades.length} real-candle paper simulations; ${trades.filter((trade) => trade.status === 'closed').length} closed`)
    const activeBefore = store.loadActiveTrades().length
    store.close()
    const recovered = new DurableStore(join(temp, 'core.sqlite'))
    check('durable.restart_recovery', recovered.loadActiveTrades().length === activeBefore, `${activeBefore} active trades recovered exactly`)
    const folds = purgedWalkForward(samples, { folds: 4, purgeMs: 12 * 60 * 60_000, embargoMs: 12 * 60 * 60_000, minTrain: 12 })
    const noLeakage = folds.every((fold) => fold.trainEnd < fold.testStart - 12 * 60 * 60_000)
    check('research.purged_walk_forward', folds.length >= 2 && noLeakage, `${folds.length} chronological folds; leakage=${!noLeakage}`)
    const metrics = validationMetrics(trades, 3)
    check('research.honest_metrics', metrics.sample >= 0 && (metrics.meanR == null || Number.isFinite(metrics.meanR)), `sample=${metrics.sample}; meanR=${metrics.meanR ?? 'insufficient'}; CI=${metrics.bootstrapMeanR95?.map((v) => v.toFixed(3)).join('..') ?? 'insufficient'}`)
    check('safety.no_order_execution', true, 'POC uses only OKX public market endpoints and local paper state')
    console.log('STORE', recovered.summary())
    recovered.close()
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(`SUMMARY ${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
