import { v } from 'convex/values'
import { mutation } from './_generated/server'
import { assertKey } from './lib/auth'

/** Append a line to the terminal stream. Trimmed to the last 500 rows. */
export const log = mutation({
  args: {
    key: v.string(),
    level: v.union(
      v.literal('info'),
      v.literal('signal'),
      v.literal('ai'),
      v.literal('trade'),
      v.literal('error'),
    ),
    message: v.string(),
    instId: v.optional(v.string()),
    timeframe: v.optional(v.string()),
    decision: v.optional(v.string()),
    confidence: v.optional(v.number()),
    snapshot: v.optional(v.string()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const { key: _key, ...row } = args
    await ctx.db.insert('logs', { ...row, ts: Date.now() })

    // Cheap retention: drop the oldest rows beyond 500.
    const old = await ctx.db.query('logs').withIndex('by_ts').order('asc').take(600)
    if (old.length > 500) {
      for (const doc of old.slice(0, old.length - 500)) await ctx.db.delete(doc._id)
    }
  },
})

/** Push the current indicator snapshot (upsert per instId+timeframe). */
export const syncMarketState = mutation({
  args: {
    key: v.string(),
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
    htfBias: v.string(),
    setup: v.string(),
  },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const { key: _key, ...row } = args
    const existing = await ctx.db
      .query('marketState')
      .withIndex('by_inst_tf', (q) =>
        q.eq('instId', row.instId).eq('timeframe', row.timeframe),
      )
      .unique()
    const doc = { ...row, updatedAt: Date.now() }
    if (existing) return await ctx.db.patch(existing._id, doc)
    return await ctx.db.insert('marketState', doc)
  },
})

/** Open (or refresh) a position. */
export const openPosition = mutation({
  args: {
    key: v.string(),
    instId: v.string(),
    side: v.union(v.literal('LONG'), v.literal('SHORT')),
    entryPrice: v.number(),
    takeProfit: v.number(),
    stopLoss: v.number(),
    leverage: v.number(),
    sizeContracts: v.number(),
    notionalUsd: v.number(),
    riskUsd: v.number(),
    paper: v.boolean(),
    ordId: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const { key: _key, ...row } = args
    return await ctx.db.insert('positions', {
      ...row,
      status: 'open',
      markPrice: row.entryPrice,
      pnlUsd: 0,
      pnlPct: 0,
      openedAt: Date.now(),
    })
  },
})

/** Live mark-to-market of every open position for an instrument. */
export const markPositions = mutation({
  args: { key: v.string(), instId: v.string(), markPrice: v.number() },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const open = await ctx.db
      .query('positions')
      .withIndex('by_inst_status', (q) =>
        q.eq('instId', args.instId).eq('status', 'open'),
      )
      .collect()
    for (const p of open) {
      const dir = p.side === 'LONG' ? 1 : -1
      const move = (args.markPrice - p.entryPrice) / p.entryPrice
      const pnlPct = move * dir * 100 * p.leverage
      const pnlUsd = p.notionalUsd * move * dir
      await ctx.db.patch(p._id, { markPrice: args.markPrice, pnlPct, pnlUsd })
    }
    return open.length
  },
})

export const closePosition = mutation({
  args: {
    key: v.string(),
    positionId: v.optional(v.id('positions')),
    instId: v.optional(v.string()),
    exitPrice: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const targets = args.positionId
      ? [await ctx.db.get(args.positionId)]
      : await ctx.db
          .query('positions')
          .withIndex('by_inst_status', (q) =>
            q.eq('instId', args.instId ?? '').eq('status', 'open'),
          )
          .collect()

    let closed = 0
    for (const p of targets) {
      if (!p || p.status === 'closed') continue
      const dir = p.side === 'LONG' ? 1 : -1
      const move = (args.exitPrice - p.entryPrice) / p.entryPrice
      await ctx.db.patch(p._id, {
        status: 'closed',
        markPrice: args.exitPrice,
        pnlPct: move * dir * 100 * p.leverage,
        pnlUsd: p.notionalUsd * move * dir,
        closedAt: Date.now(),
        reason: args.reason ?? p.reason,
      })
      closed++
    }
    return closed
  },
})

export const heartbeat = mutation({
  args: {
    key: v.string(),
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
    meta: v.optional(v.string()),
    aiCalls: v.optional(v.number()),
    evaluations: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const { key: _key, ...row } = args
    const existing = await ctx.db
      .query('telemetry')
      .withIndex('by_service', (q) => q.eq('service', row.service))
      .unique()
    const doc = { ...row, lastPing: Date.now() }
    if (existing) return await ctx.db.patch(existing._id, doc)
    return await ctx.db.insert('telemetry', doc)
  },
})
