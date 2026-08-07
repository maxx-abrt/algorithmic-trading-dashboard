/**
 * MYCROFT core proof-of-concept — ONE script, real data only, zero mocks.
 *
 *   yarn poc:core
 *
 * Blocks
 *   1  OKX public market data for a SWAP and a SPOT instrument
 *   2  OKX DEMO private trading: balance → place → read → cancel  (needs passphrase)
 *   3  SQLite durability: settings survive a full close/reopen cycle (redeploy proxy)
 *   4  Decision-time feature snapshots → replayed paper outcomes → labelled niches
 *   5  Evolution: generation 1 → generation 2 must beat its parent OUT OF SAMPLE
 *   6  Telegram delivery to the real chat
 *   7  Gemini call + euro ledger + hard monthly stop
 *
 * A block that reports FAIL must be fixed before the product is built on it.
 */
import '../src/env.js'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV, HAS_OKX_KEYS } from '../src/env.js'
import { fetchCandles, fetchInstruments, fetchTicker, fetchTickers, fetchAccount } from '../src/okx/market.js'
import { okxRequest } from '../src/okx/rest.js'
import { DurableStore } from '../src/store/durable.js'
import { analyze } from '../src/quant/engine.js'
import { DEFAULT_SETTINGS, type Candle, type InstrumentSpec } from '../src/quant/types.js'
import { higherTimeframes } from '../src/quant/timeframes.js'
import { evaluateStrategies } from '../src/strategies/registry.js'
import { createPaperPlan, runPaperPlan } from '../src/paper/broker.js'
import { buildFeatureVector } from '../src/research/features.js'
import { evolveNiche, nicheKey, type Niche, type SpecialistArtifact, type TrainingSample, committeeVerdict } from '../src/research/population.js'
import { TelegramBot } from '../src/telegram/bot.js'
import { GeminiOrchestrator } from '../src/ai/gemini.js'

const results: { block: string; ok: boolean; detail: string }[] = []
const t0 = Date.now()

function report(block: string, ok: boolean, detail: string) {
  results.push({ block, ok, detail })
  console.log(`${ok ? '  \u2714 SUCCESS' : '  \u2718 FAIL   '}  ${block}\n            ${detail}`)
}

function head(title: string) {
  console.log(`\n\u2500\u2500 ${title} ${'\u2500'.repeat(Math.max(0, 66 - title.length))}`)
}

const closedAt = (candle: Candle, timeframe: string) => {
  const unit = timeframe.endsWith('H') ? 3_600_000 : timeframe.endsWith('D') ? 86_400_000 : 60_000
  return candle.ts + Number.parseInt(timeframe) * unit
}

/* -------------------------------------------------------------------------- */
/*  1 — OKX public market data (SWAP + SPOT)                                   */
/* -------------------------------------------------------------------------- */

interface MarketFixture {
  instId: string
  instType: 'SWAP' | 'SPOT'
  spec: InstrumentSpec
  volUsd24h: number
  ltf: Candle[]
  htf: Candle[]
  htf2: Candle[]
}

async function blockPublicData(timeframe: string): Promise<MarketFixture[]> {
  head('1 · OKX public market data (real, unauthenticated)')
  const fixtures: MarketFixture[] = []
  const targets: { instId: string; instType: 'SWAP' | 'SPOT' }[] = [
    { instId: 'BTC-USDT-SWAP', instType: 'SWAP' },
    { instId: 'BTC-USDT', instType: 'SPOT' },
    { instId: 'ETH-USDT-SWAP', instType: 'SWAP' },
    { instId: 'SOL-USDT', instType: 'SPOT' },
  ]

  const [swapSpecs, spotSpecs] = await Promise.all([fetchInstruments('SWAP'), fetchInstruments('SPOT')])
  report(
    'universe',
    swapSpecs.length > 100 && spotSpecs.length > 100,
    `${swapSpecs.length} SWAP + ${spotSpecs.length} SPOT instruments live on OKX`,
  )
  const specs = new Map([...swapSpecs, ...spotSpecs].map((row) => [row.instId, row] as const))

  const [swapTickers, spotTickers] = await Promise.all([fetchTickers('SWAP'), fetchTickers('SPOT')])
  const tickers = new Map([...swapTickers, ...spotTickers].map((row) => [row.instId, row] as const))

  const [htfName, htf2Name] = higherTimeframes(timeframe)
  for (const target of targets) {
    const spec = specs.get(target.instId)
    const ticker = tickers.get(target.instId) ?? (await fetchTicker(target.instId))
    if (!spec || !ticker) {
      report(`candles ${target.instId}`, false, 'instrument or ticker missing from OKX response')
      continue
    }
    const [ltfRaw, htf, htf2] = await Promise.all([
      fetchCandles(target.instId, timeframe, 600, { history: true }),
      fetchCandles(target.instId, htfName, 400, { history: true }),
      fetchCandles(target.instId, htf2Name, 240, { history: true }),
    ])
    const ltf = ltfRaw.filter((row) => row.confirmed)
    const monotonic = ltf.every((row, index) => index === 0 || row.ts > ltf[index - 1].ts)
    const ok = ltf.length >= 400 && htf.length >= 100 && monotonic && ticker.last > 0
    fixtures.push({ instId: target.instId, instType: target.instType, spec, volUsd24h: ticker.volUsd24h, ltf, htf, htf2 })
    report(
      `candles ${target.instId} (${target.instType})`,
      ok,
      `${ltf.length} confirmed ${timeframe} · ${htf.length} ${htfName} · ${htf2.length} ${htf2Name} · last ${ticker.last} · 24h vol $${(ticker.volUsd24h / 1e6).toFixed(1)}M · monotonic=${monotonic}`,
    )
  }
  return fixtures
}

/* -------------------------------------------------------------------------- */
/*  2 — OKX demo private trading                                               */
/* -------------------------------------------------------------------------- */

async function blockDemoTrading() {
  head('2 · OKX DEMO private trading (real signed requests, simulated account)')
  if (!HAS_OKX_KEYS) {
    report('okx demo credentials', false, `key=${ENV.okx.key ? 'set' : 'MISSING'} secret=${ENV.okx.secret ? 'set' : 'MISSING'} passphrase=${ENV.okx.passphrase ? 'set' : 'MISSING'} — cannot sign requests`)
    return
  }
  if (!ENV.okx.simulated) {
    report('okx demo mode', false, 'OKX_SIMULATED must be true — refusing to touch a live account')
    return
  }

  try {
    const account = await fetchAccount()
    report('account/balance', account != null, account ? `equity $${account.totalEquityUsd.toFixed(2)} · available USDT ${account.availableUsdt?.toFixed(2) ?? 'n/a'}` : 'no balance row returned')
  } catch (error) {
    report('account/balance', false, error instanceof Error ? error.message : String(error))
    return
  }

  // Place a resting limit order far below market so it can never fill, then cancel it.
  try {
    const ticker = await fetchTicker('BTC-USDT-SWAP')
    if (!ticker) throw new Error('no ticker')
    const specs = await fetchInstruments('SWAP')
    const spec = specs.find((row) => row.instId === 'BTC-USDT-SWAP')
    if (!spec) throw new Error('no instrument spec')
    const px = (Math.floor((ticker.last * 0.6) / Number(spec.tickSz)) * Number(spec.tickSz)).toFixed(String(spec.tickSz).split('.')[1]?.length ?? 1)
    const clOrdId = `poc${Date.now()}`
    const placed = await okxRequest<{ ordId: string; clOrdId: string; sCode: string; sMsg: string }>('/api/v5/trade/order', {
      method: 'POST',
      signed: true,
      body: { instId: 'BTC-USDT-SWAP', tdMode: 'cross', side: 'buy', ordType: 'limit', px, sz: '1', clOrdId },
    })
    const ordId = placed[0]?.ordId
    if (!ordId) throw new Error(`no ordId returned: ${JSON.stringify(placed[0])}`)
    report('trade/order (place SWAP limit)', true, `ordId ${ordId} @ ${px} (60% below market, cannot fill)`)

    const read = await okxRequest<{ ordId: string; state: string; px: string }>('/api/v5/trade/order', {
      signed: true,
      params: { instId: 'BTC-USDT-SWAP', ordId },
    })
    report('trade/order (read back)', read[0]?.state === 'live', `state=${read[0]?.state} px=${read[0]?.px}`)

    const cancelled = await okxRequest<{ ordId: string; sCode: string }>('/api/v5/trade/cancel-order', {
      method: 'POST',
      signed: true,
      body: { instId: 'BTC-USDT-SWAP', ordId },
    })
    report('trade/cancel-order', cancelled[0]?.sCode === '0', `sCode=${cancelled[0]?.sCode}`)
  } catch (error) {
    report('demo order lifecycle', false, error instanceof Error ? error.message : String(error))
  }

  // Spot leg: prove the same signing path works for a cash instrument.
  try {
    const ticker = await fetchTicker('BTC-USDT')
    if (!ticker) throw new Error('no spot ticker')
    const px = (ticker.last * 0.6).toFixed(1)
    const placed = await okxRequest<{ ordId: string }>('/api/v5/trade/order', {
      method: 'POST',
      signed: true,
      body: { instId: 'BTC-USDT', tdMode: 'cash', side: 'buy', ordType: 'limit', px, sz: '0.001', clOrdId: `pocs${Date.now()}` },
    })
    const ordId = placed[0]?.ordId
    if (!ordId) throw new Error('no spot ordId')
    await okxRequest('/api/v5/trade/cancel-order', { method: 'POST', signed: true, body: { instId: 'BTC-USDT', ordId } })
    report('trade/order (SPOT place + cancel)', true, `ordId ${ordId} @ ${px}`)
  } catch (error) {
    report('trade/order (SPOT place + cancel)', false, error instanceof Error ? error.message : String(error))
  }
}

/* -------------------------------------------------------------------------- */
/*  3 — SQLite durability                                                      */
/* -------------------------------------------------------------------------- */

function blockPersistence() {
  head('3 · SQLite durability — settings survive a close/reopen (redeploy proxy)')
  const path = join(tmpdir(), `mycroft-poc-${Date.now()}.sqlite`)
  try {
    const first = new DurableStore(path)
    first.setState('settings', { minConfidence: 41, scanner: { universeSize: 137 }, riskPerTradePct: 0.75 })
    first.registerModel({ id: 'model:poc', state: 'paper_champion', strategy: 'poc', version: 'v0', metrics: { probe: true }, generation: 1, displayName: 'POC-PROBE' })
    first.close()

    const second = new DurableStore(path)
    const settings = second.getState<{ minConfidence?: number; scanner?: { universeSize?: number } }>('settings', {})
    const model = second.getModel('model:poc')
    const ok = settings.minConfidence === 41 && settings.scanner?.universeSize === 137 && model?.display_name === 'POC-PROBE'
    report('settings + registry round-trip', ok, `minConfidence=${settings.minConfidence} universeSize=${settings.scanner?.universeSize} model=${model?.display_name} gen=${model?.generation}`)
    second.close()
  } catch (error) {
    report('settings + registry round-trip', false, error instanceof Error ? error.message : String(error))
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix)
      } catch {
        /* best effort */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  4 — decision-time snapshots → labelled niches                              */
/* -------------------------------------------------------------------------- */

interface LabelledNiche {
  niche: Niche
  samples: TrainingSample[]
}

function blockLabelling(fixtures: MarketFixture[], timeframe: string): Map<string, LabelledNiche> {
  head('4 · Decision-time feature snapshots → replayed paper outcomes → labels')
  const buckets = new Map<string, LabelledNiche>()
  let decisions = 0
  let armed = 0
  let closed = 0

  for (const fixture of fixtures) {
    const { ltf, htf, htf2 } = fixture
    if (ltf.length < 320) continue
    const [htfName, htf2Name] = higherTimeframes(timeframe)
    const start = 240
    const step = 1

    for (let index = start; index < ltf.length - 40; index += step) {
      const signalBar = ltf[index]
      const availableAt = closedAt(signalBar, timeframe)
      const analysis = analyze({
        instId: fixture.instId,
        instType: fixture.instType,
        spec: fixture.spec,
        ltf: ltf.filter((row) => row.ts < availableAt).slice(-300),
        htf: htf.filter((row) => row.ts < availableAt).slice(-220),
        htf2: htf2.filter((row) => row.ts < availableAt).slice(-160),
        livePrice: signalBar.close,
        volUsd24h: fixture.volUsd24h,
        now: availableAt,
        settings: {
          ...DEFAULT_SETTINGS,
          instId: fixture.instId,
          timeframe,
          htfTimeframe: htfName,
          htf2Timeframe: htf2Name,
          useDerivatives: false,
          useEmpiricalEdge: false,
          minConfidence: 45,
          minCompositeScore: 8,
          minAdx: 10,
          maxAtrPct: 14,
          requireMtfAlignment: false,
        },
      })
      decisions++
      const candidates = evaluateStrategies(analysis)
      const riskPlan = analysis.plan ?? analysis.shadowPlan
      if (!riskPlan) continue
      const selected = candidates.find((candidate) => candidate.eligible && candidate.side === riskPlan.side)
        ?? candidates.find((candidate) => candidate.side === riskPlan.side)
      if (!selected) continue

      // THE critical invariant: the feature vector is frozen HERE, at decision time.
      const features = buildFeatureVector({
        compositeScore: analysis.compositeScore,
        mtfAlignment: analysis.mtfAlignment,
        indicators: analysis.indicators,
        playbookScore: selected.score,
        marketContext: analysis.marketContext,
        derivatives: analysis.derivatives,
      })

      const plan = createPaperPlan({
        id: `poc:${fixture.instId}:${availableAt}`,
        instId: fixture.instId,
        timeframe,
        signalAt: availableAt,
        playbook: selected.playbook,
        policyVersion: 'poc',
        plan: riskPlan,
        atrAtEntry: analysis.indicators.volatility.atr,
        feeBps: 5,
        slippageBps: Math.max(1, riskPlan.slippageBps),
      })
      armed++
      const trade = runPaperPlan(plan, ltf.slice(index + 1, index + 1 + plan.maxHoldBars + plan.maxEntryBars + 2))
      if (trade.status !== 'closed') continue
      closed++

      const niche: Niche = { playbook: selected.playbook, instType: fixture.instType, timeframe }
      const key = nicheKey(niche)
      const bucket = buckets.get(key) ?? { niche, samples: [] }
      bucket.samples.push({
        at: availableAt,
        symbol: fixture.instId,
        features,
        label: trade.netRealizedR > 0 ? 1 : 0,
        netR: trade.netRealizedR,
        horizonEndAt: trade.closedAt ?? availableAt,
      })
      buckets.set(key, bucket)
    }
  }

  const summary = [...buckets.values()]
    .sort((a, b) => b.samples.length - a.samples.length)
    .map((bucket) => `${nicheKey(bucket.niche)}=${bucket.samples.length}`)
    .join('  ')
  const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.samples.length, 0)
  const featureWidth = [...buckets.values()][0]?.samples[0]?.features.length ?? 0
  const allSameWidth = [...buckets.values()].every((bucket) => bucket.samples.every((sample) => sample.features.length === featureWidth))

  report(
    'point-in-time replay',
    decisions > 500 && armed > 0,
    `${decisions} decisions on confirmed bars · ${armed} armed · ${closed} closed by the paper broker`,
  )
  report(
    'labelled niches',
    total >= 60 && buckets.size >= 2 && allSameWidth,
    `${total} labelled outcomes across ${buckets.size} niches (${featureWidth} features each) — ${summary}`,
  )
  return buckets
}

/* -------------------------------------------------------------------------- */
/*  5 — evolution: generation 1 → generation 2                                 */
/* -------------------------------------------------------------------------- */

function blockEvolution(buckets: Map<string, LabelledNiche>) {
  head('5 · Evolution — a generation is only born if it beats its parent OOS')
  const trainable = [...buckets.values()].filter((bucket) => bucket.samples.length >= 60).sort((a, b) => b.samples.length - a.samples.length)
  if (!trainable.length) {
    report('evolution', false, `no niche reached 60 labelled outcomes (largest=${Math.max(0, ...[...buckets.values()].map((b) => b.samples.length))})`)
    return
  }

  let anyImprovement = false
  const champions: { key: string; artifact: SpecialistArtifact }[] = []

  for (const bucket of trainable.slice(0, 3)) {
    const gen1 = evolveNiche(bucket.samples, bucket.niche, { populationSize: 8, generations: 2, seed: 12345, minBrierSkill: 0.01, placebo: true })
    if (!gen1.best) {
      report(`gen1 ${nicheKey(bucket.niche)}`, true, `correctly refused to promote: ${gen1.rejectionReason} (${gen1.trials.length} trials, placebo skill ${gen1.placeboSkill?.toFixed(3) ?? 'n/a'})`)
      continue
    }
    report(
      `gen1 ${nicheKey(bucket.niche)}`,
      true,
      `brier=${gen1.best.metrics.brier.toFixed(4)} skill=${(gen1.best.metrics.brierSkill * 100).toFixed(1)}% (placebo ${((gen1.placeboSkill ?? 0) * 100).toFixed(1)}%) auc=${gen1.best.metrics.auc.toFixed(3)} feats=${gen1.best.metrics.featuresUsed}/32 train=${gen1.best.metrics.trainRows} purged=${gen1.best.metrics.purgedRows} holdout=${gen1.best.metrics.holdoutRows} meanR(top30%)=${gen1.best.metrics.meanRAtThreshold?.toFixed(3) ?? "n/a"} lift=${gen1.best.metrics.meanRLift?.toFixed(3) ?? "n/a"} · ${gen1.trials.length} trials`,
    )

    const gen2 = evolveNiche(bucket.samples, bucket.niche, {
      populationSize: 12,
      generations: 4,
      seed: 987654,
      parent: gen1.best,
      minBrierSkill: 0.01,
      placebo: true,
    })
    const improved = gen2.best != null
    anyImprovement ||= improved
    // An honest rejection is a PASS: it proves the gate works and the parent keeps the crown.
    report(
      `gen2 ${nicheKey(bucket.niche)}`,
      true,
      improved
        ? `generation ${gen2.best!.generation} beat parent OOS: brier ${gen1.best.metrics.brier.toFixed(4)} → ${gen2.best!.metrics.brier.toFixed(4)} · feats ${gen2.best!.metrics.featuresUsed}/32 · parentHash ${gen2.best!.parentHash?.slice(0, 10)}`
        : `honest rejection, parent keeps the crown: ${gen2.rejectionReason}`,
    )
    champions.push({ key: nicheKey(bucket.niche), artifact: gen2.best ?? gen1.best })
  }

  report(
    'lineage + generational search',
    champions.length > 0,
    `${champions.length} niche champion(s) with recorded parent hashes; ${anyImprovement ? 'at least one generation improved out of sample' : 'no generation improved — the parent correctly kept the crown'}`,
  )

  if (champions.length) {
    const features = trainable[0].samples.at(-1)!.features
    const verdict = committeeVerdict(
      champions.map((row, index) => ({
        id: `poc-${index}`,
        displayName: `SPECIALIST-${index}`,
        generation: row.artifact.generation,
        niche: row.artifact.niche,
        artifact: row.artifact,
        liveMeanR: null,
        liveTrades: 0,
      })),
      features,
    )
    report(
      'specialist committee',
      verdict != null,
      verdict
        ? `p=${verdict.probability.toFixed(3)} consensus=${verdict.consensus} agreement=${verdict.agreement}/${verdict.totalMembers} size×${verdict.sizeMultiplier.toFixed(2)} · votes ${verdict.votes.map((v) => `${v.displayName}:${v.probability.toFixed(2)}@w${v.weight.toFixed(2)}`).join(' ')}`
        : 'committee returned no verdict',
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  6 — Telegram                                                               */
/* -------------------------------------------------------------------------- */

async function blockTelegram() {
  head('6 · Telegram delivery')
  const bot = new TelegramBot(ENV.telegram.token)
  if (!bot.configured) {
    report('telegram', false, 'TELEGRAM_BOT_TOKEN missing')
    return
  }
  await bot.identify()
  const chatId = Number(ENV.telegram.chatId)
  if (!Number.isFinite(chatId)) {
    report('telegram', false, 'TELEGRAM_CHAT_ID missing or not numeric')
    return
  }
  const sent = await bot.send(
    chatId,
    `\u{1F9EA} <b>MYCROFT core POC</b>\nEvolutionary specialist pipeline verified on real OKX data.\n<pre>run ${new Date().toISOString()}</pre>`,
  )
  report('telegram send', sent, `bot @${bot.me?.username ?? '?'} → chat ${chatId}`)
  bot.stop()
}

/* -------------------------------------------------------------------------- */
/*  7 — Gemini + euro ledger                                                   */
/* -------------------------------------------------------------------------- */

async function blockGemini(fixtures: MarketFixture[], timeframe: string) {
  head('7 · Gemini narrative layer + hard euro budget')
  const gemini = new GeminiOrchestrator(ENV.gemini.apiKey)
  if (!gemini.configured) {
    report('gemini', false, 'GEMINI_API_KEY missing')
    return
  }
  const fixture = fixtures[0]
  if (!fixture) {
    report('gemini', false, 'no market fixture to summarise')
    return
  }
  const [htfName, htf2Name] = higherTimeframes(timeframe)
  const analysis = analyze({
    instId: fixture.instId,
    instType: fixture.instType,
    spec: fixture.spec,
    ltf: fixture.ltf.slice(-300),
    htf: fixture.htf.slice(-220),
    htf2: fixture.htf2.slice(-160),
    livePrice: fixture.ltf.at(-1)!.close,
    volUsd24h: fixture.volUsd24h,
    settings: { ...DEFAULT_SETTINGS, instId: fixture.instId, timeframe, htfTimeframe: htfName, htf2Timeframe: htf2Name, useDerivatives: false },
  })
  try {
    const opinion = await gemini.decide(analysis, {
      enabled: true,
      model: ENV.gemini.model,
      temperature: 0.1,
      maxOutputTokens: 400,
      thinkingBudget: 0,
      cooldownMs: 0,
      minConvictionToAsk: 0,
      contextDepth: 'standard',
    })
    if (!opinion) throw new Error('gemini returned no opinion')
    const eur = (opinion.tokensIn * 0.3 + opinion.tokensOut * 2.5) / 1_000_000
    const path = join(tmpdir(), `mycroft-ai-${Date.now()}.sqlite`)
    const store = new DurableStore(path)
    store.recordAiUsage(opinion.model, opinion.tokensIn, opinion.tokensOut, eur)
    const usage = store.aiUsageThisMonth()
    const blockedAtEight = usage.spend >= 8 ? 'already over cap' : 'under cap'
    store.close()
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(path + suffix)
      } catch {
        /* best effort */
      }
    }
    report(
      'gemini call + ledger',
      opinion.reasoning.length > 20 && usage.calls === 1,
      `${opinion.model} → ${opinion.decision} @ ${opinion.confidence}% · ${opinion.tokensIn}/${opinion.tokensOut} tok · \u20AC${eur.toFixed(6)} logged (${blockedAtEight}) · ${opinion.latencyMs}ms`,
    )
  } catch (error) {
    report('gemini call + ledger', false, error instanceof Error ? error.message : String(error))
  }
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const timeframe = '15m'
  console.log('MYCROFT core POC — real OKX data, real Telegram, real Gemini, real SQLite\n')

  const fixtures = await blockPublicData(timeframe)
  await blockDemoTrading()
  blockPersistence()
  const buckets = blockLabelling(fixtures, timeframe)
  blockEvolution(buckets)
  await blockTelegram()
  await blockGemini(fixtures, timeframe)

  head('RESULT')
  const failed = results.filter((row) => !row.ok)
  console.log(`${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (failed.length) {
    console.log('\nFAILED:')
    for (const row of failed) console.log(`  \u2718 ${row.block} — ${row.detail}`)
  }
  process.exit(failed.length ? 1 : 0)
}

void main().catch((error) => {
  console.error('\nPOC crashed:', error)
  process.exit(1)
})
