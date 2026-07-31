import './env.js' // must be first: populates process.env before any other module
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../../convex/_generated/api.js'
import { AiOrchestrator } from './aiOrchestrator.js'
import {
  closePositionMarket,
  fetchBalance,
  fetchCandles,
  fetchInstrument,
  normalizeBar,
  OkxPublicStream,
  placeOrder,
  roundToTick,
  setLeverage,
  type Instrument,
} from './okxEngine.js'
import { QuantEngine, sizePosition } from './quantEngine.js'
import type { Candle, Settings } from './types.js'

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL
const WORKER_KEY = process.env.WORKER_API_KEY

if (!CONVEX_URL) {
  console.error('[apex] NEXT_PUBLIC_CONVEX_URL is missing in .env.local')
  process.exit(1)
}
if (!WORKER_KEY) {
  console.error('[apex] WORKER_API_KEY is missing in .env.local')
  process.exit(1)
}

const convex = new ConvexHttpClient(CONVEX_URL)
const ai = new AiOrchestrator()
const quant = new QuantEngine()

const LIVE = process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE

const COLORS: Record<string, string> = {
  info: '\x1b[90m',
  signal: '\x1b[36m',
  ai: '\x1b[35m',
  trade: '\x1b[32m',
  error: '\x1b[31m',
}

type Level = 'info' | 'signal' | 'ai' | 'trade' | 'error'

async function log(level: Level, message: string, extra: Record<string, unknown> = {}) {
  console.log(`${COLORS[level] ?? ''}[${level}]\x1b[0m ${message}`)
  try {
    await convex.mutation(api.trading.log, {
      key: WORKER_KEY!,
      level,
      message,
      ...extra,
    })
  } catch (err) {
    console.error('[apex] convex log failed:', (err as Error).message)
  }
}

/* -------------------------------------------------------------------------- */
/*  Runtime state                                                              */
/* -------------------------------------------------------------------------- */

let settings: Settings | null = null
let settingsSig = ''
let instrument: Instrument | null = null
let stream: OkxPublicStream | null = null
let livePrice = 0
let lastEvalAt = 0
let lastAiAt = 0
let lastSetupKey = ''
let equityUsd = Number(process.env.PAPER_EQUITY_USD ?? 10_000)
let openPositions = 0
let dayKey = ''
let dayStartEquity = equityUsd
let realizedToday = 0
let evaluations = 0

const AI_COOLDOWN_MS = Number(process.env.AI_COOLDOWN_MS ?? 90_000)
const EVAL_THROTTLE_MS = Number(process.env.EVAL_THROTTLE_MS ?? 3_000)

function signature(s: Settings) {
  return `${s.instId}|${s.timeframe}|${s.htfTimeframe}`
}

async function loadSettings(): Promise<Settings> {
  const row = (await convex.query(api.settings.get, {})) as Settings
  return row
}

/* -------------------------------------------------------------------------- */
/*  Market data wiring                                                         */
/* -------------------------------------------------------------------------- */

async function seedSeries(s: Settings) {
  const [ltf, htf] = await Promise.all([
    fetchCandles(s.instId, s.timeframe, 300),
    fetchCandles(s.instId, s.htfTimeframe, 300),
  ])
  quant.seed(ltf, htf)
  livePrice = ltf[ltf.length - 1]?.close ?? 0
  instrument = await fetchInstrument(s.instId)
  await log(
    'info',
    `Seeded ${ltf.length} × ${s.timeframe} and ${htf.length} × ${s.htfTimeframe} candles for ${s.instId} (ctVal ${instrument.ctVal})`,
    { instId: s.instId, timeframe: s.timeframe },
  )
}

function wireStream(s: Settings) {
  stream?.close()
  stream = new OkxPublicStream({
    onCandle: (instId, bar, candle) => {
      if (instId !== settings?.instId) return
      if (bar === normalizeBar(settings.timeframe)) {
        quant.ltf.upsert(candle)
        livePrice = candle.close
      } else if (bar === normalizeBar(settings.htfTimeframe)) {
        quant.htf.upsert(candle)
      }
    },
    onTicker: (instId, last) => {
      if (instId === settings?.instId) livePrice = last
    },
    onStatus: (status, meta) => {
      void convex
        .mutation(api.trading.heartbeat, { key: WORKER_KEY!, service: 'okx_ws', status, meta })
        .catch(() => {})
    },
  })
  stream.connect()
  // Give the socket a beat to open before subscribing.
  setTimeout(() => {
    stream?.subscribeCandles(s.instId, s.timeframe)
    stream?.subscribeCandles(s.instId, s.htfTimeframe)
    stream?.subscribeTicker(s.instId)
  }, 600)
}

/* -------------------------------------------------------------------------- */
/*  Trading                                                                    */
/* -------------------------------------------------------------------------- */

async function refreshEquity(s: Settings) {
  if (s.paperMode || !LIVE) return
  try {
    const eq = await fetchBalance('USDT')
    if (eq > 0) equityUsd = eq
    await convex.mutation(api.trading.heartbeat, {
      key: WORKER_KEY!,
      service: 'okx_rest',
      status: 'online',
      meta: `equity ${eq.toFixed(2)} USDT`,
    })
  } catch (err) {
    await convex.mutation(api.trading.heartbeat, {
      key: WORKER_KEY!,
      service: 'okx_rest',
      status: 'degraded',
      meta: (err as Error).message.slice(0, 140),
    })
  }
}

function rollDay() {
  const today = new Date().toISOString().slice(0, 10)
  if (dayKey !== today) {
    dayKey = today
    dayStartEquity = equityUsd
    realizedToday = 0
  }
}

async function execute(
  s: Settings,
  plan: { side: 'LONG' | 'SHORT'; entry: number; stopLoss: number; takeProfit: number },
  leverage: number,
  confidence: number,
  reasoning: string,
) {
  if (!instrument) return

  const sizing = sizePosition({
    equityUsd,
    riskPct: s.riskPerTradePct,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    ctVal: instrument.ctVal,
    lotSz: instrument.lotSz,
    minSz: instrument.minSz,
    leverage,
  })

  if (sizing.contracts <= 0) {
    await log(
      'error',
      `Sizing produced 0 contracts (equity ${equityUsd.toFixed(2)} USDT, risk ${s.riskPerTradePct}%, minSz ${instrument.minSz}). Trade skipped.`,
      { instId: s.instId, timeframe: s.timeframe },
    )
    return
  }

  const tp = roundToTick(plan.takeProfit, instrument.tickSz)
  const sl = roundToTick(plan.stopLoss, instrument.tickSz)
  const paper = s.paperMode || !LIVE
  let ordId: string | undefined

  if (!paper) {
    try {
      await setLeverage(s.instId, leverage)
      const res = await placeOrder({
        instId: s.instId,
        side: plan.side === 'LONG' ? 'buy' : 'sell',
        size: sizing.contracts,
        tpTriggerPx: tp,
        slTriggerPx: sl,
        ordType: 'market',
        clOrdId: `apex${Date.now().toString(36)}`,
      })
      ordId = res?.ordId
    } catch (err) {
      await log('error', `OKX order failed: ${(err as Error).message}`, {
        instId: s.instId,
        timeframe: s.timeframe,
      })
      return
    }
  }

  await convex.mutation(api.trading.openPosition, {
    key: WORKER_KEY!,
    instId: s.instId,
    side: plan.side,
    entryPrice: plan.entry,
    takeProfit: tp,
    stopLoss: sl,
    leverage,
    sizeContracts: sizing.contracts,
    notionalUsd: sizing.notionalUsd,
    riskUsd: sizing.riskUsd,
    paper,
    ordId,
    reason: reasoning.slice(0, 300),
  })
  openPositions++

  await log(
    'trade',
    `${paper ? 'PAPER' : 'LIVE'} ${plan.side} ${s.instId} @ ${plan.entry.toFixed(4)} | ${sizing.contracts} ct (${sizing.notionalUsd.toFixed(0)} USD, ${leverage}x) | SL ${sl.toFixed(4)} TP ${tp.toFixed(4)} | risk ${sizing.riskUsd.toFixed(2)} USD`,
    {
      instId: s.instId,
      timeframe: s.timeframe,
      decision: plan.side,
      confidence,
    },
  )
}

/** Paper-mode bracket resolution + live PnL sync. */
async function reconcilePositions(s: Settings) {
  if (livePrice <= 0) return
  const open = await convex.query(api.positions.listOpen, {})
  openPositions = open.length
  if (!open.length) return

  await convex.mutation(api.trading.markPositions, {
    key: WORKER_KEY!,
    instId: s.instId,
    markPrice: livePrice,
  })

  for (const p of open) {
    if (p.instId !== s.instId) continue
    const hitTp = p.side === 'LONG' ? livePrice >= p.takeProfit : livePrice <= p.takeProfit
    const hitSl = p.side === 'LONG' ? livePrice <= p.stopLoss : livePrice >= p.stopLoss
    if (!hitTp && !hitSl) continue

    const exit = hitTp ? p.takeProfit : p.stopLoss
    if (!p.paper) {
      try {
        await closePositionMarket(s.instId)
      } catch {
        /* OKX bracket already handled it */
      }
    }
    await convex.mutation(api.trading.closePosition, {
      key: WORKER_KEY!,
      positionId: p._id,
      exitPrice: exit,
      reason: hitTp ? 'take_profit' : 'stop_loss',
    })

    const dir = p.side === 'LONG' ? 1 : -1
    const pnl = p.notionalUsd * ((exit - p.entryPrice) / p.entryPrice) * dir
    realizedToday += pnl
    if (s.paperMode || !LIVE) equityUsd += pnl
    openPositions = Math.max(0, openPositions - 1)

    await log(
      'trade',
      `Closed ${p.side} ${p.instId} @ ${exit.toFixed(4)} via ${hitTp ? 'TP' : 'SL'} | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`,
      { instId: p.instId, decision: p.side },
    )
  }
}

/* -------------------------------------------------------------------------- */
/*  Main tick                                                                  */
/* -------------------------------------------------------------------------- */

async function tick() {
  const s = await loadSettings()
  settings = s
  rollDay()

  const sig = signature(s)
  if (sig !== settingsSig) {
    settingsSig = sig
    lastSetupKey = ''
    await seedSeries(s)
    wireStream(s)
  }

  await convex.mutation(api.trading.heartbeat, {
    key: WORKER_KEY!,
    service: 'worker',
    status: s.engineEnabled ? 'online' : 'degraded',
    meta: s.engineEnabled
      ? `${s.instId} ${s.timeframe}/${s.htfTimeframe} · ${s.paperMode || !LIVE ? 'paper' : 'LIVE'} · equity ${equityUsd.toFixed(2)}`
      : 'engine paused',
    evaluations,
  })

  if (!s.engineEnabled) return
  if (!quant.ready) {
    await log('info', `Warming up: ${quant.ltf.length}/60 LTF bars`, { instId: s.instId })
    return
  }

  await reconcilePositions(s)

  const now = Date.now()
  if (now - lastEvalAt < EVAL_THROTTLE_MS) return
  lastEvalAt = now
  evaluations++

  /* ---- 1. Local compute (free) --------------------------------------- */
  const evaluation = quant.evaluate(s, livePrice)
  const i = evaluation.indicators

  await convex.mutation(api.trading.syncMarketState, {
    key: WORKER_KEY!,
    instId: s.instId,
    timeframe: s.timeframe,
    price: i.price,
    ema200: i.ema200,
    ema200Htf: i.ema200Htf,
    rsi: i.rsi,
    atr: i.atr,
    atrPct: i.atrPct,
    vwap: i.vwap,
    vwapDeviationPct: i.vwapDeviationPct,
    poc: i.poc,
    keltnerUpper: i.keltnerUpper,
    keltnerMiddle: i.keltnerMiddle,
    keltnerLower: i.keltnerLower,
    htfBias: i.htfBias,
    setup: evaluation.setup,
  })

  /* ---- 2. Gates before spending a single token ------------------------ */
  if (evaluation.setup === 'NONE' || !evaluation.plan) return

  const setupKey = `${evaluation.setup}:${Math.round(now / 60_000)}`
  if (setupKey === lastSetupKey) return

  if (openPositions >= s.maxOpenPositions) {
    await log('signal', `${evaluation.setup} detected but max open positions reached.`, {
      instId: s.instId,
      timeframe: s.timeframe,
    })
    lastSetupKey = setupKey
    return
  }

  const ddPct = dayStartEquity > 0 ? (-realizedToday / dayStartEquity) * 100 : 0
  if (ddPct >= s.maxDailyLossPct) {
    await log('error', `Daily loss limit hit (${ddPct.toFixed(2)}%). Trading halted for today.`, {
      instId: s.instId,
    })
    return
  }

  await log('signal', `${evaluation.setup} — ${evaluation.triggers.join(' · ')}`, {
    instId: s.instId,
    timeframe: s.timeframe,
    snapshot: JSON.stringify(evaluation.compact),
  })
  lastSetupKey = setupKey

  /* ---- 3. AI validation (rate-limited + cached) ----------------------- */
  if (now - lastAiAt < AI_COOLDOWN_MS) {
    await log('info', 'AI cooldown active — signal logged without LLM call.', {
      instId: s.instId,
    })
    return
  }

  let decision = {
    decision: evaluation.plan.side as 'LONG' | 'SHORT' | 'WAIT',
    confidence: 100,
    leverage: s.leverage,
    tp_price: evaluation.plan.takeProfit,
    sl_price: evaluation.plan.stopLoss,
    reasoning: `Deterministic quant plan (no AI key): ${evaluation.triggers.join('; ')}`,
  }

  if (ai.configured) {
    try {
      lastAiAt = now
      const result = await ai.decide(evaluation, s)
      if (result) {
        decision = result.decision
        await convex.mutation(api.trading.heartbeat, {
          key: WORKER_KEY!,
          service: 'ai',
          status: 'online',
          meta: `${s.aiModel} · ${ai.calls} calls · ${ai.cacheHits} cached · ${ai.tokensIn}/${ai.tokensOut} tok`,
          aiCalls: ai.calls,
        })
        await log(
          'ai',
          `${decision.decision} @ ${decision.confidence}% conf, ${decision.leverage}x — ${decision.reasoning}`,
          {
            instId: s.instId,
            timeframe: s.timeframe,
            decision: decision.decision,
            confidence: decision.confidence,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            snapshot: result.cached ? 'cache-hit' : undefined,
          },
        )
      }
    } catch (err) {
      await convex.mutation(api.trading.heartbeat, {
        key: WORKER_KEY!,
        service: 'ai',
        status: 'degraded',
        meta: (err as Error).message.slice(0, 140),
      })
      await log('error', `AI call failed: ${(err as Error).message}`, { instId: s.instId })
      return
    }
  }

  /* ---- 4. Execution -------------------------------------------------- */
  if (decision.decision === 'WAIT') return
  if (decision.confidence < s.minConfidence) {
    await log(
      'info',
      `Confidence ${decision.confidence}% below threshold ${s.minConfidence}% — no trade.`,
      { instId: s.instId, timeframe: s.timeframe },
    )
    return
  }
  if (!s.autoTrade) {
    await log('info', 'Auto-trade disabled — signal only.', {
      instId: s.instId,
      timeframe: s.timeframe,
      decision: decision.decision,
      confidence: decision.confidence,
    })
    return
  }

  await execute(
    s,
    {
      side: decision.decision,
      entry: evaluation.plan.entry,
      stopLoss: decision.sl_price,
      takeProfit: decision.tp_price,
    },
    decision.leverage,
    decision.confidence,
    decision.reasoning,
  )
}

/* -------------------------------------------------------------------------- */
/*  Supervisor loop                                                            */
/* -------------------------------------------------------------------------- */

async function main() {
  const s = await loadSettings()
  await log(
    'info',
    `APEX-01 worker online · ${LIVE ? 'OKX keys detected' : 'no OKX keys (public data only)'} · ${ai.configured ? `AI ${s.aiModel}` : 'AI disabled (deterministic mode)'}`,
  )

  await refreshEquity(s)
  setInterval(() => void refreshEquity(settings ?? s).catch(() => {}), 30_000).unref()

  const loop = async () => {
    try {
      await tick()
    } catch (err) {
      console.error('[apex] tick error:', err)
      await log('error', `Tick failed: ${(err as Error).message}`).catch(() => {})
    }
  }
  await loop()
  setInterval(loop, 2_000)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stream?.close()
    await convex
      .mutation(api.trading.heartbeat, {
        key: WORKER_KEY!,
        service: 'worker',
        status: 'offline',
        meta: 'shutdown',
      })
      .catch(() => {})
    process.exit(0)
  })
}

void main()
