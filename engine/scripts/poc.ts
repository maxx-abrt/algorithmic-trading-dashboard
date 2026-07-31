/**
 * APEX-02 — single core proof-of-concept.
 *
 * Runs the entire critical path against LIVE data, in order, and fails loudly:
 *   1. Convex prod round-trip (write + read back through the worker key)
 *   2. OKX universe (spot + swaps + futures + tokenized equities)
 *   3. Candle memory: crypto swap, tokenized equity swap, spot pair, gap audit,
 *      unclosed-bar handling, 480-bar pagination
 *   4. Public WebSocket: live candle + ticker ticks on both socket families
 *   5. Derivatives context: funding, OI, basis, book imbalance, taker flow
 *   6. Quant brain: full Analysis (all blocks, patterns, structure, stats,
 *      advanced volatility, empirical edge, vetoes, risk plan) with no NaN
 *   7. Gemini: model catalogue + strict-JSON arbitration within token budget
 *   8. Telegram: real signal card delivered to the registered chat
 *   9. Journal grading maths on real candles
 *
 *   yarn poc
 */
import '../src/env.js'
import { ENV, HAS_OKX_KEYS } from '../src/env.js'
import { convex } from '../src/convex/client.js'
import {
  fetchCandles,
  fetchDerivatives,
  fetchInstruments,
  fetchTicker,
  fetchTickers,
} from '../src/okx/market.js'
import { OkxStream } from '../src/okx/ws.js'
import { analyze, dropUnclosed, quickScore } from '../src/quant/engine.js'
import { barMs } from '../src/quant/timeframes.js'
import type { Analysis, Candle, InstrumentSpec } from '../src/quant/types.js'
import { GeminiOrchestrator } from '../src/ai/gemini.js'
import { TelegramBot } from '../src/telegram/bot.js'
import { signalCard } from '../src/telegram/cards.js'
import { gradeSignal } from '../src/journal.js'

const results: { step: string; ok: boolean; detail: string }[] = []
let failures = 0

function record(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m'} ${step} — ${detail}`)
}

function header(t: string) {
  console.log(`\n\x1b[36m── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}\x1b[0m`)
}

/** Deep NaN / Infinity hunt — a single bad number can poison a decision. */
function findNonFinite(value: unknown, path = '', out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 12) return out
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path || 'root')
    return out
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findNonFinite(v, `${path}[${i}]`, out, depth + 1))
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findNonFinite(v, path ? `${path}.${k}` : k, out, depth + 1)
  }
  return out
}

async function main() {
  console.log('\x1b[1m\nAPEX-02 CORE POC — live OKX / Convex / Gemini / Telegram\x1b[0m')

  /* ===== 1. Convex ====================================================== */
  header('1. Convex production round-trip')
  if (!convex.configured) {
    record('convex.configured', false, 'CONVEX_URL or WORKER_API_KEY missing from engine/.env')
  } else {
    const test = await convex.selfTest()
    record('convex.roundtrip', test.ok, test.ok ? `write+read OK on ${ENV.convexUrl}` : test.error)
    const settings = await convex.getSettings()
    record(
      'convex.settings',
      Boolean(settings),
      settings ? `defaults resolved (instId ${String((settings as Record<string, unknown>).instId)})` : convex.health.lastError,
    )
    const logged = await convex.appendLogs([
      { ts: Date.now(), level: 'info', scope: 'poc', message: 'core proof-of-concept run' },
    ])
    record('convex.logs', logged !== null, logged !== null ? 'log persisted' : convex.health.lastError)
  }

  /* ===== 2. Universe ==================================================== */
  header('2. OKX tradable universe')
  const specs = new Map<string, InstrumentSpec>()
  let swapCount = 0
  let spotCount = 0
  let futuresCount = 0
  try {
    const [swap, spot, futures] = await Promise.all([
      fetchInstruments('SWAP'),
      fetchInstruments('SPOT'),
      fetchInstruments('FUTURES'),
    ])
    swapCount = swap.length
    spotCount = spot.length
    futuresCount = futures.length
    for (const s of [...swap, ...spot, ...futures]) specs.set(s.instId, s)
    record(
      'okx.instruments',
      swapCount > 100 && spotCount > 100,
      `${swapCount} swaps · ${spotCount} spot · ${futuresCount} futures = ${specs.size} instruments`,
    )
    const equities = [...specs.values()].filter((s) => s.isEquity && s.instType === 'SWAP')
    record(
      'okx.tokenized_equities',
      equities.length > 3,
      `${equities.length} tokenized equity swaps (${equities.slice(0, 6).map((e) => e.instId).join(', ')})`,
    )
    const btc = specs.get('BTC-USDT-SWAP')
    record(
      'okx.specs',
      Boolean(btc && btc.ctVal > 0 && btc.tickSz > 0),
      btc ? `BTC-USDT-SWAP ctVal ${btc.ctVal} ${btc.ctValCcy}, tick ${btc.tickSz}, lot ${btc.lotSz}, maxLev ${btc.maxLever}x` : 'BTC-USDT-SWAP missing',
    )
  } catch (err) {
    record('okx.instruments', false, err instanceof Error ? err.message : String(err))
  }

  let tickers = new Map<string, number>()
  try {
    const rows = await fetchTickers('SWAP')
    tickers = new Map(rows.map((r) => [r.instId, r.volUsd24h]))
    const top = rows.sort((a, b) => b.volUsd24h - a.volUsd24h).slice(0, 3)
    record(
      'okx.tickers',
      rows.length > 100,
      `${rows.length} swap tickers · deepest: ${top.map((t) => `${t.instId} $${(t.volUsd24h / 1e6).toFixed(0)}M`).join(', ')}`,
    )
  } catch (err) {
    record('okx.tickers', false, err instanceof Error ? err.message : String(err))
  }

  /* ===== 3. Candles ===================================================== */
  header('3. Candle memory + data quality')
  const series = new Map<string, Candle[]>()
  for (const [instId, bar, minBars] of [
    ['BTC-USDT-SWAP', '15m', 400],
    ['BTC-USDT-SWAP', '1H', 300],
    ['BTC-USDT-SWAP', '4H', 200],
    ['NVDA-USDT-SWAP', '15m', 300],
    ['NVDA-USDT-SWAP', '1H', 200],
    ['NVDA-USDT-SWAP', '4H', 150],
    ['ETH-USDT', '15m', 300],
    ['ETH-USDT', '1H', 200],
    ['ETH-USDT', '4H', 150],
  ] as [string, string, number][]) {
    try {
      const candles = await fetchCandles(instId, bar, minBars)
      series.set(`${instId}|${bar}`, candles)
      const bad = candles.filter(
        (c) => !Number.isFinite(c.close) || c.high < c.low || c.close <= 0 || !Number.isFinite(c.volume),
      ).length
      let gaps = 0
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].ts - candles[i - 1].ts > barMs(bar) * 1.6) gaps++
      }
      const closed = dropUnclosed([...candles], bar)
      record(
        `candles.${instId}.${bar}`,
        candles.length >= Math.min(minBars, 200) && bad === 0,
        `${candles.length} bars, ${gaps} gap(s), ${bad} malformed, last ${new Date(candles[candles.length - 1]!.ts).toISOString().slice(5, 16)}, dropUnclosed removed ${candles.length - closed.length}`,
      )
    } catch (err) {
      record(`candles.${instId}.${bar}`, false, err instanceof Error ? err.message : String(err))
    }
  }

  /* ===== 4. WebSocket =================================================== */
  header('4. Public WebSocket (live ticks + both socket families)')
  await new Promise<void>((resolve) => {
    let candleTicks = 0
    let tickerTicks = 0
    let lastCandle = ''
    let lastTicker = 0
    const stream = new OkxStream({
      onCandle: (instId, bar, candle) => {
        candleTicks++
        lastCandle = `${instId} ${bar} close ${candle.close} confirmed=${candle.confirmed}`
      },
      onTicker: (_instId, last) => {
        tickerTicks++
        lastTicker = last
      },
      onStatus: (kind, status, meta) => {
        if (status !== 'online') console.log(`      ws ${kind}: ${status} — ${meta}`)
      },
    })
    stream.connect()
    setTimeout(() => {
      stream.watchCandles('BTC-USDT-SWAP', ['1m', '15m'])
      stream.watchTickers(['BTC-USDT-SWAP', 'NVDA-USDT-SWAP'])
    }, 900)
    const deadline = Date.now() + 30_000
    const check = setInterval(() => {
      if ((candleTicks > 0 && tickerTicks > 0) || Date.now() > deadline) {
        clearInterval(check)
        record('ws.candles', candleTicks > 0, `${candleTicks} candle frames · ${lastCandle || 'none'}`)
        record('ws.tickers', tickerTicks > 0, `${tickerTicks} ticker frames · last ${lastTicker}`)
        const h = stream.health()
        record(
          'ws.health',
          h.public.healthy && h.business.healthy,
          `public ${h.public.healthy ? 'OK' : 'DOWN'} (${h.public.subs} subs) · business ${h.business.healthy ? 'OK' : 'DOWN'} (${h.business.subs} subs)`,
        )
        stream.close()
        resolve()
      }
    }, 500)
  })

  /* ===== 5. Derivatives ================================================= */
  header('5. Derivatives context')
  const derivs = new Map<string, Awaited<ReturnType<typeof fetchDerivatives>>>()
  for (const instId of ['BTC-USDT-SWAP', 'NVDA-USDT-SWAP']) {
    try {
      const d = await fetchDerivatives(instId, 'SWAP', 0)
      derivs.set(instId, d)
      const populated = [
        d.fundingRate != null && 'funding',
        d.openInterest != null && 'OI',
        d.bookImbalance != null && 'book',
        d.markPrice != null && 'mark',
        d.indexPrice != null && 'index',
        d.basisBps != null && 'basis',
        d.takerRatio != null && 'taker',
        d.longShortRatio != null && 'L/S',
        d.openInterestChangePct != null && 'OIΔ',
      ].filter(Boolean) as string[]
      record(
        `derivatives.${instId}`,
        d.fundingRate != null && d.bookImbalance != null,
        `${populated.length}/9 fields [${populated.join(', ')}] · funding ${d.fundingApr?.toFixed(2) ?? '—'}% APR · spread ${d.spreadBps?.toFixed(2) ?? '—'}bps · score ${d.score.toFixed(0)}`,
      )
    } catch (err) {
      record(`derivatives.${instId}`, false, err instanceof Error ? err.message : String(err))
    }
  }

  /* ===== 6. Quant brain ================================================= */
  header('6. Quantitative brain')
  const analyses: Analysis[] = []
  for (const instId of ['BTC-USDT-SWAP', 'NVDA-USDT-SWAP', 'ETH-USDT']) {
    try {
      const ltf = series.get(`${instId}|15m`) ?? []
      const htf = series.get(`${instId}|1H`) ?? []
      const htf2 = series.get(`${instId}|4H`) ?? []
      const ticker = await fetchTicker(instId)
      const a = analyze({
        instId,
        spec: specs.get(instId) ?? null,
        ltf,
        htf,
        htf2,
        derivatives: derivs.get(instId) ?? null,
        livePrice: ticker?.last ?? null,
        volUsd24h: tickers.get(instId) ?? ticker?.volUsd24h ?? null,
        settings: { timeframe: '15m', htfTimeframe: '1H', htf2Timeframe: '4H', equityUsd: 10_000, riskPerTradePct: 1 },
      })
      analyses.push(a)

      const nonFinite = findNonFinite({
        price: a.price,
        conviction: a.conviction,
        composite: a.compositeScore,
        indicators: a.indicators,
        plan: a.plan,
        edge: a.edge,
      })
      record(
        `quant.${instId}.numbers`,
        nonFinite.length === 0,
        nonFinite.length === 0 ? 'no NaN/Infinity anywhere in the analysis' : `non-finite at ${nonFinite.join(', ')}`,
      )
      record(
        `quant.${instId}.decision`,
        ['LONG', 'SHORT', 'WAIT'].includes(a.decision) && a.factors.length >= 12,
        `${a.decision} @ ${a.conviction.toFixed(0)}/100 · composite ${a.compositeScore.toFixed(0)} · ${a.factors.length} factors · ${a.vetoes.length} veto(es) · regime ${a.regime} · MTF ${a.mtfAlignment.toFixed(0)}%`,
      )
      record(
        `quant.${instId}.blocks`,
        Boolean(a.indicators.stats && a.indicators.xvol && a.indicators.xtrend && a.indicators.profile.poc > 0),
        `Hurst ${a.indicators.stats.hurst.toFixed(2)} · R² ${a.indicators.stats.regR2.toFixed(2)} · σ1 ${a.indicators.xvol.forecastBarSigmaPct.toFixed(2)}% · Parkinson ${a.indicators.xvol.parkinsonVolPct.toFixed(0)}% · POC ${a.indicators.profile.poc.toFixed(2)} · ${a.indicators.structure.levels.length} levels · ${a.indicators.structure.fvg.length} FVG`,
      )
      record(
        `quant.${instId}.patterns`,
        Array.isArray(a.indicators.patterns),
        a.indicators.patterns.length
          ? a.indicators.patterns.slice(0, 3).map((p) => `${p.label} ${p.side} ${(p.confirmed * 100).toFixed(0)}%`).join(' | ')
          : 'no formation in the last 12 bars (valid)',
      )
      record(
        `quant.${instId}.edge`,
        a.edge !== null,
        a.edge ? `${a.edge.sample} analogues · ${a.edge.winRate.toFixed(0)}% raw / ${a.edge.adjustedWinRate.toFixed(0)}% shrunk · avg ${a.edge.avgR.toFixed(2)}R · ${a.edge.note}` : 'edge layer disabled',
      )
      if (a.plan) {
        const p = a.plan
        const sane =
          p.stopLoss > 0 &&
          p.takeProfits.length === 3 &&
          p.takeProfits.every((t) => t.price > 0 && t.rr > 0) &&
          (a.decision === 'LONG' ? p.stopLoss < p.entry : p.stopLoss > p.entry) &&
          p.riskDistance > 0
        record(
          `quant.${instId}.plan`,
          sane,
          `entry ${p.entry} · SL ${p.stopLoss} (${p.stopBasis}) · TP ${p.takeProfits.map((t) => `${t.price}@${t.rr.toFixed(2)}R`).join('/')} · ${p.leverage}x · ${p.contracts} ct · risk $${p.riskUsd.toFixed(2)} · net ${p.netExpectancyR.toFixed(2)}R · fees $${p.feesUsd.toFixed(2)}`,
        )
        console.log(`      sizing: ${p.sizingAdvice}`)
      } else {
        record(`quant.${instId}.plan`, true, `WAIT — no plan by design (${a.vetoes.map((v) => v.id).join(', ') || 'below thresholds'})`)
      }
      record(
        `quant.${instId}.narrative`,
        a.narrative.length >= 6 && JSON.stringify(a.compact).length < 4000,
        `${a.narrative.length} narrative lines · compact payload ${JSON.stringify(a.compact).length} chars (~${Math.round(JSON.stringify(a.compact).length / 4)} tokens)`,
      )
      console.log(`      → ${a.narrative[0]}`)
      if (a.session.isEquity) console.log(`      → ${a.narrative.find((n) => n.startsWith('Session')) ?? ''}`)
    } catch (err) {
      record(`quant.${instId}`, false, err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 400)}` : String(err))
    }
  }

  try {
    const q = quickScore(series.get('BTC-USDT-SWAP|15m') ?? [], '15m')
    record('quant.quickScore', Number.isFinite(q.score), `score ${q.score} · bias ${q.bias} · regime ${q.regime} · hurst ${q.hurst}`)
  } catch (err) {
    record('quant.quickScore', false, err instanceof Error ? err.message : String(err))
  }

  /* ===== 7. Gemini ====================================================== */
  header('7. Gemini arbitration')
  const gemini = new GeminiOrchestrator(ENV.gemini.apiKey)
  if (!gemini.configured) {
    record('gemini.configured', false, 'GEMINI_API_KEY missing')
  } else {
    try {
      const models = await gemini.listModels(true)
      record(
        'gemini.models',
        models.length > 0,
        `${models.length} generateContent models · e.g. ${models.slice(0, 5).map((m) => m.name).join(', ')}`,
      )
      const target = analyses[0]
      if (target) {
        const opinion = await gemini.decide(target, {
          enabled: true,
          model: ENV.gemini.model,
          temperature: 0.15,
          maxOutputTokens: 1200,
          thinkingBudget: 0,
          cooldownMs: 0,
          minConvictionToAsk: 0,
          contextDepth: 'standard',
        })
        record(
          'gemini.decide',
          Boolean(opinion && ['LONG', 'SHORT', 'WAIT'].includes(opinion.decision)),
          opinion
            ? `${opinion.decision} @ ${opinion.confidence}% · ${opinion.tokensIn} in / ${opinion.tokensOut} out tokens · ${opinion.latencyMs}ms · agrees=${opinion.agreesWithQuant}`
            : 'no opinion returned',
        )
        if (opinion) {
          target.ai = opinion
          console.log(`      reasoning: ${opinion.reasoning.slice(0, 300)}`)
          if (opinion.risks.length) console.log(`      risks: ${opinion.risks.join(' | ')}`)
          record(
            'gemini.budget',
            opinion.tokensIn < 4000,
            `prompt stayed at ${opinion.tokensIn} tokens (budget 4000 for standard depth)`,
          )
          const cached = await gemini.decide(target, {
            enabled: true,
            model: ENV.gemini.model,
            temperature: 0.15,
            maxOutputTokens: 1200,
            thinkingBudget: 0,
            cooldownMs: 90_000,
            minConvictionToAsk: 0,
            contextDepth: 'standard',
          })
          record('gemini.cache', Boolean(cached?.cached), cached?.cached ? 'second identical request served from cache (0 tokens)' : 'cache miss')
        }
      }
    } catch (err) {
      record('gemini.decide', false, err instanceof Error ? err.message : String(err))
    }
  }

  /* ===== 8. Telegram ==================================================== */
  header('8. Telegram delivery')
  const bot = new TelegramBot(ENV.telegram.token)
  if (!bot.configured) {
    record('telegram.configured', false, 'TELEGRAM_BOT_TOKEN missing')
  } else {
    const me = await bot.identify()
    record('telegram.getMe', Boolean(me), me ? `@${me.username} (id ${me.id})` : bot.lastError)
    const chatIds = new Set<number>()
    if (ENV.telegram.chatId) chatIds.add(Number(ENV.telegram.chatId))
    for (const c of (await convex.listChats()) ?? []) chatIds.add(c.chatId)
    if (!chatIds.size) {
      record('telegram.send', false, 'no chat id — send /start to the bot first')
    } else {
      const target = analyses[0]
      const html = target
        ? signalCard(target)
        : '<b>APEX-02</b> core POC — no analysis available'
      const delivered = await bot.broadcast([...chatIds], html)
      record('telegram.send', delivered > 0, `signal card delivered to ${delivered}/${chatIds.size} chat(s)`)
    }
  }

  /* ===== 9. Journal grading ============================================ */
  header('9. Journal outcome grading')
  try {
    const candles = series.get('BTC-USDT-SWAP|15m') ?? []
    const anchor = candles[Math.max(0, candles.length - 40)]
    const risk = Math.max(anchor.close * 0.004, 1)
    const fake = {
      _id: 'poc',
      instId: 'BTC-USDT-SWAP',
      timeframe: '15m',
      decision: 'LONG',
      status: 'live',
      entry: anchor.close,
      stopLoss: anchor.close - risk,
      takeProfits: [anchor.close + risk * 1.5, anchor.close + risk * 3, anchor.close + risk * 5],
      tpAllocations: [40, 35, 25],
      riskDistance: risk,
      mfeR: 0,
      maeR: 0,
      barsHeld: 0,
      lastPrice: anchor.close,
      timeStopBars: 18,
      createdAt: anchor.ts,
      conviction: 70,
    }
    const graded = gradeSignal(fake as never, candles, candles[candles.length - 1]!.close)
    record(
      'journal.grade',
      Boolean(graded && Number.isFinite(graded.patch.mfeR as number)),
      graded ? graded.headline : 'no change detected (unexpected on a 40-bar replay)',
    )
  } catch (err) {
    record('journal.grade', false, err instanceof Error ? err.message : String(err))
  }

  /* ===== summary ======================================================== */
  header('SUMMARY')
  console.log(
    `  ${results.length - failures}/${results.length} checks passed · OKX keys ${HAS_OKX_KEYS ? 'present' : 'absent (public data only)'}`,
  )
  if (failures) {
    console.log('\x1b[31m  Failing checks:\x1b[0m')
    for (const r of results.filter((x) => !x.ok)) console.log(`   · ${r.step}: ${r.detail}`)
  }
  console.log('')
  process.exit(failures ? 1 : 0)
}

void main().catch((err) => {
  console.error('\x1b[31mPOC crashed:\x1b[0m', err)
  process.exit(1)
})
