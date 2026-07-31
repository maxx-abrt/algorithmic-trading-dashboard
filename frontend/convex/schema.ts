import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

/**
 * APEX-02 / MYCROFT — Convex data model.
 *
 * Split of responsibilities (deliberate, to keep Convex usage tiny and the UI live):
 *   • Convex  = durable system of record + realtime push for CONFIG and HISTORY
 *               (settings, watchlist, alert rules, alert events, signal journal,
 *                logs, telemetry, telegram chats).
 *   • Engine  = live market truth (candles, indicators, analyses, scanner) served
 *               over HTTP on /api/* and polled by the dashboard every few seconds.
 *
 * Every mutation is guarded by WORKER_API_KEY: the browser never writes directly,
 * it always goes through the engine, which is the single writer.
 */

const weights = v.object({
  trend: v.number(),
  momentum: v.number(),
  volatility: v.number(),
  volume: v.number(),
  structure: v.number(),
  pattern: v.number(),
  derivatives: v.number(),
  mtf: v.number(),
  stats: v.number(),
  edge: v.number(),
})

export default defineSchema({
  /** Singleton runtime configuration (docKey === "global"). */
  settings: defineTable({
    docKey: v.literal('global'),

    // ── focus ──────────────────────────────────────────────────────────────
    instId: v.string(),
    timeframe: v.string(),
    htfTimeframe: v.string(),
    htf2Timeframe: v.string(),

    // ── decision engine ───────────────────────────────────────────────────
    strategy: v.string(), // adaptive | trend_momentum | mean_reversion | breakout | pattern_confirm
    minConfidence: v.number(),
    minCompositeScore: v.number(),
    requireMtfAlignment: v.boolean(),
    usePatterns: v.boolean(),
    useDerivatives: v.boolean(),
    useEmpiricalEdge: v.boolean(),
    maxAtrPct: v.number(),
    minAdx: v.number(),
    weights,

    // ── risk ──────────────────────────────────────────────────────────────
    riskPerTradePct: v.number(),
    leverage: v.number(), // ceiling, engine may lower it
    rrRatio: v.number(),
    equityUsd: v.number(),
    useAccountBalance: v.boolean(),
    takerFeeBps: v.number(),

    // ── ai ────────────────────────────────────────────────────────────────
    ai: v.object({
      enabled: v.boolean(),
      model: v.string(),
      temperature: v.number(),
      maxOutputTokens: v.number(),
      thinkingBudget: v.number(),
      cooldownMs: v.number(),
      minConvictionToAsk: v.number(),
      contextDepth: v.string(), // compact | standard | deep
    }),

    // ── scanner ───────────────────────────────────────────────────────────
    scanner: v.object({
      enabled: v.boolean(),
      timeframe: v.string(),
      instTypes: v.array(v.string()),
      quoteCcy: v.string(),
      minVol24hUsd: v.number(),
      universeSize: v.number(),
      intervalMs: v.number(),
      includeEquities: v.boolean(),
    }),

    // ── telegram ──────────────────────────────────────────────────────────
    telegram: v.object({
      enabled: v.boolean(),
      minConviction: v.number(),
      onlyWatchlist: v.boolean(),
      quietHoursStart: v.number(), // 0-23, equal values disable quiet hours
      quietHoursEnd: v.number(),
      sendScanDigest: v.boolean(),
      digestIntervalMin: v.number(),
    }),

    engineEnabled: v.boolean(),
    updatedAt: v.number(),
  }).index('by_key', ['docKey']),

  /** Instruments actively surveilled by the engine (deep analysis + alerts). */
  watchlist: defineTable({
    instId: v.string(),
    instType: v.string(),
    timeframe: v.string(),
    enabled: v.boolean(),
    alertsEnabled: v.boolean(),
    note: v.optional(v.string()),
    addedAt: v.number(),
  }).index('by_inst', ['instId']),

  /** User-defined alert rules. */
  alertRules: defineTable({
    name: v.string(),
    /** instId or "*" (whole watchlist) or "SCANNER" (top scanner hits) */
    scope: v.string(),
    type: v.string(),
    timeframe: v.string(),
    params: v.object({
      threshold: v.optional(v.number()),
      direction: v.optional(v.string()), // above | below | any | LONG | SHORT
      value: v.optional(v.number()),
      text: v.optional(v.string()),
    }),
    cooldownMs: v.number(),
    telegram: v.boolean(),
    enabled: v.boolean(),
    lastFiredAt: v.number(),
    firedCount: v.number(),
    createdAt: v.number(),
  }).index('by_enabled', ['enabled']),

  /** Every alert that actually fired. */
  alertEvents: defineTable({
    ruleId: v.optional(v.string()),
    ruleName: v.string(),
    type: v.string(),
    severity: v.string(), // info | opportunity | warning | critical
    instId: v.string(),
    timeframe: v.string(),
    title: v.string(),
    message: v.string(),
    decision: v.optional(v.string()),
    conviction: v.optional(v.number()),
    price: v.number(),
    payload: v.optional(v.string()),
    telegramDelivered: v.boolean(),
    ts: v.number(),
  })
    .index('by_ts', ['ts'])
    .index('by_inst', ['instId']),

  /** Signal journal — every actionable idea, graded automatically afterwards. */
  signals: defineTable({
    instId: v.string(),
    instType: v.string(),
    timeframe: v.string(),
    decision: v.string(), // LONG | SHORT
    playbook: v.optional(v.string()),
    regime: v.string(),
    conviction: v.number(),
    composite: v.number(),
    mtfAlignment: v.number(),

    entry: v.number(),
    entryZone: v.array(v.number()),
    stopLoss: v.number(),
    takeProfits: v.array(v.number()),
    tpAllocations: v.array(v.number()),
    expectedRr: v.number(),
    riskDistance: v.number(),
    leverage: v.number(),
    contracts: v.number(),
    notionalUsd: v.number(),
    marginUsd: v.number(),
    riskUsd: v.number(),
    liquidation: v.optional(v.number()),
    timeStopBars: v.number(),

    edgeWinRate: v.optional(v.number()),
    edgeSample: v.optional(v.number()),
    expectancyR: v.number(),

    aiDecision: v.optional(v.string()),
    aiConfidence: v.optional(v.number()),
    aiReasoning: v.optional(v.string()),
    aiModel: v.optional(v.string()),

    narrative: v.array(v.string()),
    compact: v.optional(v.string()),

    /** live | tp1 | win | loss | breakeven | expired | invalidated */
    status: v.string(),
    mfeR: v.number(),
    maeR: v.number(),
    exitPrice: v.optional(v.number()),
    exitReason: v.optional(v.string()),
    realizedR: v.optional(v.number()),
    barsHeld: v.number(),
    lastPrice: v.number(),
    createdAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index('by_createdAt', ['createdAt'])
    .index('by_status', ['status'])
    .index('by_inst', ['instId']),

  /** Engine terminal stream. */
  logs: defineTable({
    ts: v.number(),
    level: v.string(), // info | signal | ai | alert | error | scan
    scope: v.string(),
    message: v.string(),
    instId: v.optional(v.string()),
    timeframe: v.optional(v.string()),
    meta: v.optional(v.string()),
  }).index('by_ts', ['ts']),

  /** Service health + cost counters. */
  telemetry: defineTable({
    service: v.string(), // engine | okx_rest | okx_ws | ai | telegram | convex
    status: v.string(), // online | degraded | offline
    lastPing: v.number(),
    meta: v.optional(v.string()),
    counters: v.optional(
      v.object({
        evaluations: v.optional(v.number()),
        aiCalls: v.optional(v.number()),
        aiCacheHits: v.optional(v.number()),
        tokensIn: v.optional(v.number()),
        tokensOut: v.optional(v.number()),
        restCalls: v.optional(v.number()),
        wsMessages: v.optional(v.number()),
        alerts: v.optional(v.number()),
        errors: v.optional(v.number()),
      }),
    ),
  }).index('by_service', ['service']),

  /** Telegram chats registered through /start. */
  telegramChats: defineTable({
    chatId: v.number(),
    firstName: v.optional(v.string()),
    username: v.optional(v.string()),
    muted: v.boolean(),
    registeredAt: v.number(),
    lastSeenAt: v.number(),
  }).index('by_chat', ['chatId']),
})
