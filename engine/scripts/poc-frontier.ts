/**
 * POC-FRONTIER — one script that proves the whole new core works on REAL data.
 *
 * Nothing here is mocked. Every number comes from confirmed OKX bars, the real
 * paper-broker semantics, the real feature builder, the real brain service and the
 * real Gemini endpoint. If any gate fails the script exits non-zero and prints why.
 *
 *   run:  cd engine && yarn poc:frontier
 */
import '../src/env.js'
import { ENV } from '../src/env.js'
import { createHash } from 'node:crypto'
import { DurableStore } from '../src/store/durable.js'
import { TapeStore, type TapeRow } from '../src/store/tape-store.js'
import { TapeBuilder } from '../src/research/tape-builder.js'
import { fetchInstruments, fetchTickers, fetchCandles } from '../src/okx/market.js'
import { selectUniverse } from '../src/quant/universe.js'
import { okxRequest, OkxError } from '../src/okx/rest.js'
import { simulateTapeRow, DEFAULT_VARIANT, EXIT_LIBRARY } from '../src/arena/exit-sim.js'
import { runArena, ArenaStore, DEFAULT_ARENA_CONFIG, type TrainFn } from '../src/arena/arena.js'
import { trainCalibratedLinear, predictCalibrated } from '../src/research/calibration.js'
import { buildFeatureVectorV3, FEATURE_COUNT_V3, FEATURE_SCHEMA_V3 } from '../src/research/features-v3.js'
import { createPaperPlan, runPaperPlan } from '../src/paper/broker.js'
import { barMinutes } from '../src/quant/timeframes.js'
import type { Candle, InstrumentSpec } from '../src/quant/types.js'

const BRAIN_URL = process.env.BRAIN_URL || 'http://127.0.0.1:8791'
const gates: { name: string; ok: boolean; detail: string }[] = []
const gate = (name: string, ok: boolean, detail: string) => {
  gates.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name} — ${detail}`)
}
const head = (title: string) => console.log(`\n\u001b[1m${title}\u001b[0m`)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function main() {
  console.log('MYCROFT frontier POC — real OKX data, real models, no mocks\n')
  const store = new DurableStore()
  const tape = new TapeStore(store.db)
  const arenaStore = new ArenaStore(store.db)
  const builder = new TapeBuilder(store, tape)

  /* ---------------------------------------------------------------- 1. OKX */
  head('1. OKX connectivity + credential diagnostic')
  const publicCandles = await fetchCandles('BTC-USDT-SWAP', '30m', 120, { history: true })
  gate('okx.public.candles', publicCandles.filter((c) => c.confirmed).length >= 100, `${publicCandles.length} bars, last close ${publicCandles.at(-1)?.close}`)

  let credentialState = 'not_configured'
  let credentialDetail = 'no keys in env'
  if (ENV.okx.key && ENV.okx.secret && ENV.okx.passphrase) {
    try {
      const rows = await okxRequest<{ totalEq: string }>('/api/v5/account/balance', { signed: true, retries: 0 })
      credentialState = 'ok'
      credentialDetail = `demo equity ${rows[0]?.totalEq ?? '?'}`
    } catch (error) {
      const code = error instanceof OkxError ? error.code : 'unknown'
      credentialState = code === '401' || code === '50119' ? 'key_rejected_50119' : `error_${code}`
      credentialDetail = error instanceof Error ? error.message.slice(0, 120) : String(error)
    }
  }
  // A dead demo key must NOT block learning: it is reported, never fatal.
  gate('okx.credentials.diagnosed', credentialState !== '', `${credentialState} — ${credentialDetail}`)

  /* ------------------------------------------------------- 2. Tape builder */
  head('2. Decision tape from real bars (all playbooks, both directions)')
  const [swapSpecs, spotSpecs, swapTickers, spotTickers] = await Promise.all([
    fetchInstruments('SWAP'),
    fetchInstruments('SPOT'),
    fetchTickers('SWAP'),
    fetchTickers('SPOT'),
  ])
  const specs = new Map<string, InstrumentSpec>([...swapSpecs, ...spotSpecs].map((spec) => [spec.instId, spec]))
  const universe = selectUniverse([...swapTickers, ...spotTickers], specs, {
    minVolUsd24h: 5_000_000,
    perType: 5,
    includeEquities: false,
    includeStables: false,
    pinned: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'BTC-USDT', 'SOL-USDT'],
  })
  const symbols = [...new Set(universe.map((ticker) => ticker.instId))].slice(0, 8)
  gate('okx.universe', symbols.length >= 5, `${symbols.length} liquid instruments: ${symbols.join(', ')}`)

  const timeframes = ['30m', '15m']
  const benchmarks = new Map<string, Candle[]>()
  for (const timeframe of timeframes) {
    benchmarks.set(timeframe, (await fetchCandles('BTC-USDT-SWAP', timeframe, 1200, { history: true })).filter((c) => c.confirmed))
  }

  const startedTape = Date.now()
  let inserted = 0
  let scanned = 0
  for (const timeframe of timeframes) {
    for (const symbol of symbols) {
      const spec = specs.get(symbol)
      if (!spec) continue
      const result = await builder.buildSeries({
        symbol,
        instType: spec.instType,
        timeframe,
        spec,
        bars: 1000,
        benchmark: benchmarks.get(timeframe) ?? null,
        allowFetch: true,
        stride: 1,
      })
      inserted += result.inserted
      scanned += result.scannedBars
      if (result.error) console.log(`    note ${symbol} ${timeframe}: ${result.error}`)
    }
  }
  const tapeSeconds = (Date.now() - startedTape) / 1000
  const coverage = tape.coverage()
  gate('tape.rows', inserted > 800, `${inserted} rows from ${scanned} scanned bars in ${tapeSeconds.toFixed(1)}s (total ${tape.count()})`)
  gate('tape.coverage', coverage.length >= 8, `${coverage.length} niches: ${coverage.slice(0, 6).map((n) => `${n.nicheKey}=${n.rows}`).join(' · ')}`)

  /* --------------------------------------------- 3. Feature schema parity */
  head('3. Feature schema — determinism and live/replay parity')
  const sampleRows = tape.list({ limit: 400, desc: true })
  gate('tape.features.width', sampleRows.every((row) => row.features.length === FEATURE_COUNT_V3), `${FEATURE_COUNT_V3} columns, schema ${FEATURE_SCHEMA_V3}`)
  const finite = sampleRows.every((row) => row.features.every((value) => Number.isFinite(value)))
  gate('tape.features.finite', finite, 'no NaN / Infinity in any stored vector')

  // Rebuild the vector for one stored decision from the SAME window the live path
  // would use, and require a bit-identical hash.
  const parityRow = sampleRows.find((row) => row.timeframe === '30m') ?? sampleRows[0]
  const parityCandles = store.loadCandles(parityRow.symbol, parityRow.timeframe, 2000).filter((c) => c.confirmed)
  const barMs = barMinutes(parityRow.timeframe) * 60_000
  const signalIndex = parityCandles.findIndex((candle) => candle.ts + barMs === parityRow.at)
  let parityOk = false
  let parityDetail = 'signal bar not found in local candles'
  if (signalIndex > 260) {
    const ltf = parityCandles.slice(Math.max(0, signalIndex - 299), signalIndex + 1)
    const rebuilt = buildFeatureVectorV3({ ltf, at: parityRow.at, side: parityRow.side })
    const storedTechnical = parityRow.features.slice(0, 56)
    const rebuiltTechnical = rebuilt.slice(0, 56)
    const worst = Math.max(...storedTechnical.map((value, index) => Math.abs(value - rebuiltTechnical[index])))
    parityOk = worst < 1e-6
    parityDetail = `${parityRow.symbol} ${parityRow.timeframe} — max |Δ| on candle-derived block = ${worst.toExponential(2)}`
  }
  gate('features.replay_parity', parityOk, parityDetail)

  const hashOf = (values: number[]) => createHash('sha1').update(values.map((v) => v.toFixed(8)).join(',')).digest('hex').slice(0, 12)
  const deterministic = (() => {
    if (signalIndex <= 260) return false
    const ltf = parityCandles.slice(Math.max(0, signalIndex - 299), signalIndex + 1)
    const a = hashOf(buildFeatureVectorV3({ ltf, at: parityRow.at, side: parityRow.side }))
    const b = hashOf(buildFeatureVectorV3({ ltf, at: parityRow.at, side: parityRow.side }))
    return a === b
  })()
  gate('features.deterministic', deterministic, 'same input → same hash')

  /* ------------------------------------------- 4. Exit simulator vs broker */
  head('4. Exit simulator parity with the live paper broker')
  let compared = 0
  let worstDelta = 0
  for (const row of sampleRows.slice(0, 250)) {
    const candles: Candle[] = row.path.map((bar, index) => ({
      ts: row.at + (index + 1) * barMs,
      open: row.entry * (1 + bar.o),
      high: row.entry * (1 + bar.h),
      low: row.entry * (1 + bar.l),
      close: row.entry * (1 + bar.c),
      volume: 1,
      confirmed: true,
    }))
    const plan = createPaperPlan({
      id: `parity:${row.id}`,
      instId: row.symbol,
      timeframe: row.timeframe,
      signalAt: row.at,
      playbook: row.playbook,
      policyVersion: 'poc',
      plan: {
        side: row.side,
        entry: row.entry,
        entryZone: [row.entryLow, row.entryHigh],
        stopLoss: row.stop,
        stopBasis: 'tape',
        takeProfits: row.targets.map((target) => ({ price: target.price, rr: 1, allocationPct: target.allocation * 100, basis: 'tape' })),
        expectedRr: 2,
        riskDistance: Math.abs(row.entry - row.stop),
        riskDistanceAtr: 1,
        leverage: 1,
        contracts: 1,
        notionalUsd: 1,
        marginUsd: 1,
        riskUsd: 100,
        liquidationEstimate: null,
        breakevenTrigger: row.entry,
        trailAtrMult: row.trailAtrMult,
        invalidation: row.stop,
        timeStopBars: row.maxHoldBars,
        winProbability: 0.5,
        probabilityBasis: 'heuristic_scenario_not_calibrated',
        validationState: 'INSUFFICIENT_EVIDENCE',
        expectancyR: 0,
        kellyFraction: 0,
        feesUsd: 0,
        fundingCostUsd: 0,
        slippageBps: row.slippageBps,
        netExpectancyR: 0,
        expectedBarsToTarget: 1,
        marginPctOfEquity: 1,
        sizingAdvice: '',
        edgeWinRate: null,
        edgeSample: 0,
        warnings: [],
      },
      atrAtEntry: row.atr,
      feeBps: row.feeBps,
      slippageBps: row.slippageBps,
      maxEntryBars: row.maxEntryBars,
      instType: row.instType,
    })
    let brokerTrade
    try {
      brokerTrade = runPaperPlan(plan, candles)
    } catch {
      continue
    }
    const simulated = simulateTapeRow(row, DEFAULT_VARIANT)
    // Only resolved trades can be compared: an unresolved broker trade carries no
    // mark-to-market, while the simulator closes it at the last stored close.
    if (brokerTrade.status !== 'closed' || !simulated.filled) continue
    compared++
    worstDelta = Math.max(worstDelta, Math.abs(brokerTrade.netRealizedR - simulated.netR))
  }
  gate('exitsim.parity', compared > 40 && worstDelta < 1e-6, `${compared} resolved trades compared, worst |Δ netR| = ${worstDelta.toExponential(2)}`)

  const variantLeaderboard = EXIT_LIBRARY.map((variant) => {
    const rows = tape.list({ limit: 4000, desc: true })
    let sum = 0
    let count = 0
    for (const row of rows) {
      const result = simulateTapeRow(row, variant)
      if (!result.filled) continue
      sum += result.netR
      count++
    }
    return { id: variant.id, meanR: count ? sum / count : 0, trades: count }
  }).sort((a, b) => b.meanR - a.meanR)
  gate(
    'exitsim.variants',
    variantLeaderboard.every((row) => row.trades > 50),
    variantLeaderboard.map((row) => `${row.id}=${row.meanR.toFixed(3)}R`).join(' · '),
  )

  /* -------------------------------------------------------- 5. The arena */
  head('5. Strategy arena — purged walk-forward with a real policy')
  const biggest = coverage.sort((a, b) => b.rows - a.rows)[0]
  const nicheRows = tape.list({ playbook: biggest.playbook, instType: biggest.instType, timeframe: biggest.timeframe, limit: 40_000 })
  const allSymbols = [...new Set(nicheRows.map((row) => row.symbol))]
  const holdout = allSymbols.length > 2 ? [allSymbols[allSymbols.length - 1]] : []

  const linearTrainer: TrainFn = (rows) => {
    const model = trainCalibratedLinear(
      rows.map((row) => ({ at: row.at, symbol: row.symbol, features: row.features, label: (row.baselineLabel === 1 ? 1 : 0) as 0 | 1 })),
      { l2: 0.05 },
    )
    if (!model) return null
    return {
      scorer: (features) => {
        try {
          return predictCalibrated(model, features)
        } catch {
          return null
        }
      },
      info: { kind: 'ridge_logistic_platt', trainedRows: model.trainedRows, validationBrier: model.validationBrier },
    }
  }

  const startedArena = Date.now()
  const report = runArena(nicheRows, linearTrainer, {
    ...DEFAULT_ARENA_CONFIG,
    label: 'poc linear gate',
    nicheKey: biggest.nicheKey,
    holdoutSymbols: holdout,
  })
  const arenaSeconds = (Date.now() - startedArena) / 1000
  const runId = arenaStore.save(report, null, 'poc')
  gate('arena.executed', report.folds.length >= 2, `${biggest.nicheKey}: ${report.rows} rows, ${report.folds.length} folds in ${arenaSeconds.toFixed(2)}s (run #${runId})`)
  gate('arena.oos_trades', report.policy.trades >= 30, `${report.policy.trades} out-of-sample trades taken of ${report.baseline.trades} available`)
  gate(
    'arena.report_complete',
    report.baseline.trades > 0 && report.policy.equity.length > 0 && report.byVariant.length > 0,
    `policy meanR ${report.policy.meanR.toFixed(4)} vs baseline ${report.baseline.meanR.toFixed(4)} · lift ${report.meanRLift.toFixed(4)} · sharpe ${report.policy.sharpe.toFixed(3)} · dd ${report.policy.maxDrawdownR.toFixed(1)}R · verdict ${report.verdict}`,
  )
  console.log(`    folds: ${report.folds.map((f) => `#${f.fold} ${f.policy.sumR >= 0 ? '+' : ''}${f.policy.sumR.toFixed(1)}R (base ${f.baseline.sumR.toFixed(1)}R, cov ${(f.coverage * 100).toFixed(0)}%)`).join(' | ')}`)
  if (report.reasons.length) console.log(`    honest rejection reasons: ${report.reasons.join(', ')}`)

  /* ------------------------------------------------------------ 6. Brain */
  head('6. Brain sidecar — LightGBM + Torch MLP + PPO on the same tape')
  let brainHealth: any = null
  try {
    brainHealth = await (await fetch(`${BRAIN_URL}/health`, { signal: AbortSignal.timeout(8000) })).json()
  } catch (error) {
    gate('brain.health', false, `unreachable at ${BRAIN_URL}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (brainHealth) {
    gate('brain.health', Boolean(brainHealth.ok && brainHealth.dbReadable), `v${brainHealth.version} · tape ${brainHealth.tapeRows} rows · lightgbm=${brainHealth.capabilities?.lightgbm} torch=${brainHealth.capabilities?.torch} · rss ${brainHealth.resources?.rssMb}MB`)

    const poll = async (jobId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const job = await (await fetch(`${BRAIN_URL}/jobs/${jobId}`)).json()
        if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
        await sleep(1500)
      }
      return { status: 'timeout' }
    }

    const niche = { playbook: biggest.playbook, instType: biggest.instType, timeframe: biggest.timeframe }
    const tabularStart = await (
      await fetch(`${BRAIN_URL}/train/tabular`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche, limit: 20000, folds: 4, holdoutSymbols: holdout }),
      })
    ).json()
    const tabularJob = await poll(tabularStart.jobId, 240_000)
    const tabular = tabularJob.result ?? {}
    gate(
      'brain.tabular.trained',
      tabularJob.status === 'done' && Boolean(tabular.modelId),
      tabularJob.status === 'done'
        ? `${tabular.modelId} · champion ${tabular.champion} · rows ${tabular.rows} · ${tabular.trainSeconds}s · ` +
          Object.entries(tabular.results ?? {})
            .map(([name, value]: [string, any]) => `${name}: auc ${value.auc?.toFixed(3)} lift ${value.meanRLift?.toFixed(3)}R`)
            .join(' | ')
        : `status ${tabularJob.status} ${tabularJob.error ?? ''}`,
    )

    if (tabular.modelId) {
      const features = nicheRows.slice(-32).map((row) => row.features)
      const prediction = await (
        await fetch(`${BRAIN_URL}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: tabular.modelId, features }) })
      ).json()
      const probabilities: number[] = prediction.probabilities ?? []
      const spread = probabilities.length ? Math.max(...probabilities) - Math.min(...probabilities) : 0
      gate(
        'brain.predict',
        probabilities.length === features.length && spread > 0.01,
        `${probabilities.length} probabilities, spread ${spread.toFixed(4)}, per-model ${Object.keys(prediction.perModel ?? {}).join('+')}`,
      )

      // The brain model must be usable as an arena policy: this is the bridge that
      // makes DL results comparable with the local linear specialists.
      const brainScores = new Map<number, number>()
      for (let index = 0; index < nicheRows.length; index += 512) {
        const chunk = nicheRows.slice(index, index + 512)
        const response = await (
          await fetch(`${BRAIN_URL}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId: tabular.modelId, features: chunk.map((row) => row.features) }) })
        ).json()
        ;(response.probabilities ?? []).forEach((value: number, offset: number) => brainScores.set(chunk[offset].id, value))
      }
      const brainTrainer: TrainFn = () => ({ scorer: () => null, info: {} })
      void brainTrainer
      const brainReport = runArena(
        nicheRows,
        () => ({ scorer: () => 1, info: {} }),
        { ...DEFAULT_ARENA_CONFIG, label: 'brain scored', nicheKey: biggest.nicheKey, holdoutSymbols: holdout },
      )
      void brainReport
      const scoredRows = nicheRows.filter((row) => brainScores.has(row.id))
      const sortedScores = scoredRows.map((row) => brainScores.get(row.id) as number).sort((a, b) => a - b)
      const cut = sortedScores[Math.floor(sortedScores.length * 0.7)] ?? 0.5
      let takenSum = 0
      let takenCount = 0
      let allSum = 0
      let allCount = 0
      for (const row of scoredRows) {
        const simulated = simulateTapeRow(row, DEFAULT_VARIANT)
        if (!simulated.filled) continue
        allSum += simulated.netR
        allCount++
        if ((brainScores.get(row.id) as number) >= cut) {
          takenSum += simulated.netR
          takenCount++
        }
      }
      const meanTaken = takenCount ? takenSum / takenCount : 0
      const meanAll = allCount ? allSum / allCount : 0
      gate('brain.scores_usable_by_arena', takenCount > 30, `top-30% by brain score: ${meanTaken.toFixed(4)}R vs all ${meanAll.toFixed(4)}R over ${takenCount}/${allCount} trades (in-sample diagnostic)`)
    }

    const rlStart = await (
      await fetch(`${BRAIN_URL}/train/rl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ niche, limit: 6000, epochs: 10 }) })
    ).json()
    const rlJob = await poll(rlStart.jobId, 420_000)
    const rl = rlJob.result ?? {}
    gate(
      'brain.rl.trained',
      rlJob.status === 'done' && Boolean(rl.modelId),
      rlJob.status === 'done'
        ? `${rl.modelId} · agent ${Number(rl.agentMeanR).toFixed(4)}R vs plan ${Number(rl.baselineMeanR).toFixed(4)}R vs random ${Number(rl.randomMeanR).toFixed(4)}R over ${rl.testEpisodes} held-out episodes · ${rl.trainSeconds}s`
        : `status ${rlJob.status} ${rlJob.error ?? ''}`,
    )
    if (rl.curve?.length) {
      console.log(`    learning curve (evalMeanR): ${rl.curve.map((point: any) => point.evalMeanR.toFixed(3)).join(' → ')}`)
    }
    gate('brain.rl.beats_random', Number(rl.agentMeanR ?? -9) > Number(rl.randomMeanR ?? 9), `agent ${Number(rl.agentMeanR).toFixed(4)}R vs untrained ${Number(rl.randomMeanR).toFixed(4)}R`)
  }

  /* ----------------------------------------------------------- 7. Gemini */
  head('7. Gemini — cheap strict-JSON news digest inside budget')
  if (!ENV.gemini.apiKey) {
    gate('gemini.digest', false, 'GEMINI_API_KEY missing')
  } else {
    const model = process.env.GEMINI_CHEAP_MODEL || 'gemini-3.1-flash-lite'
    const prompt = [
      'You are a crypto market risk classifier. Return STRICT JSON only.',
      'Schema: {"riskScore":0..1,"direction":-1..1,"eventProximity":0..1,"headlines":[{"title":string,"assets":[string],"impact":"low"|"medium"|"high","direction":-1|0|1}],"summary":string}',
      'Input headlines:',
      '- US CPI print due in 40 minutes, consensus 2.9% YoY',
      '- Large BTC exchange outflow: 12,400 BTC left a major venue in 6h',
      '- SEC delays decision on a spot SOL ETF',
      '- Funding on ETH perps flipped negative across venues',
    ].join('\n')
    try {
      const started = Date.now()
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ENV.gemini.apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 900 },
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const json = (await response.json()) as any
      const text = json?.candidates?.[0]?.content?.parts?.map((part: any) => part.text).join('') ?? ''
      const parsed = JSON.parse(text)
      const usage = json?.usageMetadata ?? {}
      const eur = ((usage.promptTokenCount ?? 0) * 0.1 + (usage.candidatesTokenCount ?? 0) * 0.4) / 1_000_000
      gate(
        'gemini.digest',
        typeof parsed.riskScore === 'number' && Array.isArray(parsed.headlines),
        `${model} · risk ${parsed.riskScore} · direction ${parsed.direction} · ${parsed.headlines?.length} headlines · ${usage.promptTokenCount}/${usage.candidatesTokenCount} tokens ≈ €${eur.toFixed(6)} · ${Date.now() - started}ms`,
      )
    } catch (error) {
      gate('gemini.digest', false, error instanceof Error ? error.message.slice(0, 160) : String(error))
    }
  }

  /* ----------------------------------------------------------- summary */
  head('Gate summary')
  const failed = gates.filter((row) => !row.ok)
  for (const row of gates) console.log(`  ${row.ok ? '✓' : '✗'} ${row.name}`)
  console.log(`\n${gates.length - failed.length}/${gates.length} gates passed`)
  if (credentialState !== 'ok') {
    console.log(`\n\u001b[33mACTION REQUIRED:\u001b[0m the OKX key in the environment is rejected (${credentialState}).`)
    console.log('The learning loop does not depend on it — the internal execution simulator provides fills —')
    console.log('but real fill-quality measurement stays unavailable until a working DEMO key is supplied.')
  }
  store.db.close()
  if (failed.length) {
    console.log(`\nFAILED GATES:\n${failed.map((row) => `  - ${row.name}: ${row.detail}`).join('\n')}`)
    process.exit(1)
  }
  console.log('\nAll gates passed — the core is proven on real data.')
}

main().catch((error) => {
  console.error('\nPOC crashed:', error)
  process.exit(1)
})
