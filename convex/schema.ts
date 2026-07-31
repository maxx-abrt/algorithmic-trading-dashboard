import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * APEX-01 — Convex data model.
 * Single source of truth shared by the Next.js dashboard (reads, realtime)
 * and the Node.js worker (writes, guarded by a shared secret).
 */
export default defineSchema({
  /** Singleton runtime configuration (docKey === "global"). */
  settings: defineTable({
    docKey: v.literal('global'),
    instId: v.string(), // OKX instrument, e.g. BTC-USDT-SWAP / NVDA-USDT-SWAP
    timeframe: v.string(), // LTF: 1m 3m 5m 15m 30m 1H 4H 1D
    htfTimeframe: v.string(), // HTF trend filter: 1H 4H 1D
    strategy: v.union(
      v.literal('trend_momentum'),
      v.literal('mean_reversion'),
      v.literal('hybrid'),
    ),
    riskPerTradePct: v.number(), // % of equity risked per trade
    leverage: v.number(),
    rrRatio: v.number(), // min reward:risk (>= 2)
    minConfidence: v.number(), // 0-100 AI gate
    aiModel: v.string(), // gemini-2.5-flash | gemini-2.5-pro | ...
    autoTrade: v.boolean(), // false => signals only (dry run)
    paperMode: v.boolean(), // true => never hits OKX private endpoints
    engineEnabled: v.boolean(), // kill switch
    maxOpenPositions: v.number(),
    maxDailyLossPct: v.number(),
    updatedAt: v.number(),
  }).index('by_key', ['docKey']),

  /** Live + historical positions mirrored from OKX (or paper engine). */
  positions: defineTable({
    instId: v.string(),
    side: v.union(v.literal('LONG'), v.literal('SHORT')),
    status: v.union(v.literal('open'), v.literal('closed')),
    entryPrice: v.number(),
    markPrice: v.number(),
    takeProfit: v.number(),
    stopLoss: v.number(),
    leverage: v.number(),
    sizeContracts: v.number(),
    notionalUsd: v.number(),
    pnlUsd: v.number(),
    pnlPct: v.number(),
    riskUsd: v.number(),
    paper: v.boolean(),
    ordId: v.optional(v.string()),
    reason: v.optional(v.string()),
    openedAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index('by_status', ['status'])
    .index('by_inst_status', ['instId', 'status'])
    .index('by_openedAt', ['openedAt']),

  /** Terminal stream: quant evaluations, AI reasoning, executions, errors. */
  logs: defineTable({
    ts: v.number(),
    level: v.union(
      v.literal('info'),
      v.literal('signal'),
      v.literal('ai'),
      v.literal('trade'),
      v.literal('error'),
    ),
    instId: v.optional(v.string()),
    timeframe: v.optional(v.string()),
    message: v.string(),
    decision: v.optional(v.string()), // LONG | SHORT | WAIT
    confidence: v.optional(v.number()),
    /** Compact JSON string of the indicator snapshot sent to the LLM. */
    snapshot: v.optional(v.string()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
  }).index('by_ts', ['ts']),

  /** Live market/indicator telemetry for the dashboard (one row per instId+tf). */
  marketState: defineTable({
    instId: v.string(),
    timeframe: v.string(),
    price: v.number(),
    ema200: v.number(),
    ema200Htf: v.number(),
    rsi: v.number(),
    atr: v.number(),
    atrPct: v.number(),
    vwap: v.number(),
    vwapDeviationPct: v.number(),
    poc: v.number(),
    keltnerUpper: v.number(),
    keltnerMiddle: v.number(),
    keltnerLower: v.number(),
    htfBias: v.string(), // BULLISH | BEARISH | NEUTRAL
    setup: v.string(), // NONE | LONG_SETUP | SHORT_SETUP
    updatedAt: v.number(),
  }).index('by_inst_tf', ['instId', 'timeframe']),

  /** Worker / OKX / AI heartbeats + cost counters. */
  telemetry: defineTable({
    service: v.union(
      v.literal('worker'),
      v.literal('okx_ws'),
      v.literal('okx_rest'),
      v.literal('ai'),
    ),
    status: v.union(
      v.literal('online'),
      v.literal('degraded'),
      v.literal('offline'),
    ),
    lastPing: v.number(),
    meta: v.optional(v.string()),
    aiCalls: v.optional(v.number()),
    evaluations: v.optional(v.number()),
  }).index('by_service', ['service']),
})
