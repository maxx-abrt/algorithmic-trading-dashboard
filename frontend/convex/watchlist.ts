import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const list = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query('watchlist').collect()).sort((a, b) => b.addedAt - a.addedAt),
})

export const add = mutation({
  args: {
    key: v.string(),
    instId: v.string(),
    instType: v.string(),
    timeframe: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { key, instId, instType, timeframe, note }) => {
    assertWorker(key)
    const existing = await ctx.db
      .query('watchlist')
      .withIndex('by_inst', (q) => q.eq('instId', instId))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { timeframe, enabled: true, note })
      return existing._id
    }
    return await ctx.db.insert('watchlist', {
      instId,
      instType,
      timeframe,
      enabled: true,
      alertsEnabled: true,
      note,
      addedAt: Date.now(),
    })
  },
})

export const patch = mutation({
  args: {
    key: v.string(),
    instId: v.string(),
    enabled: v.optional(v.boolean()),
    alertsEnabled: v.optional(v.boolean()),
    timeframe: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { key, instId, ...rest }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('watchlist')
      .withIndex('by_inst', (q) => q.eq('instId', instId))
      .unique()
    if (!row) return null
    const clean: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(rest)) if (val !== undefined) clean[k] = val
    await ctx.db.patch(row._id, clean)
    return row._id
  },
})

export const remove = mutation({
  args: { key: v.string(), instId: v.string() },
  handler: async (ctx, { key, instId }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('watchlist')
      .withIndex('by_inst', (q) => q.eq('instId', instId))
      .unique()
    if (row) await ctx.db.delete(row._id)
    return true
  },
})
