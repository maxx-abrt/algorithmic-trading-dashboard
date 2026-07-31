import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query('logs')
      .withIndex('by_ts')
      .order('desc')
      .take(Math.min(limit ?? 120, 400)),
})

export const append = mutation({
  args: {
    key: v.string(),
    entries: v.array(
      v.object({
        ts: v.number(),
        level: v.string(),
        scope: v.string(),
        message: v.string(),
        instId: v.optional(v.string()),
        timeframe: v.optional(v.string()),
        meta: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { key, entries }) => {
    assertWorker(key)
    for (const e of entries) await ctx.db.insert('logs', e)
    // Bounded retention: drop the oldest rows once we exceed 1200.
    const all = await ctx.db.query('logs').withIndex('by_ts').order('asc').take(200)
    const total = (await ctx.db.query('logs').collect()).length
    if (total > 1200) {
      const excess = total - 1200
      for (const row of all.slice(0, excess)) await ctx.db.delete(row._id)
    }
    return entries.length
  },
})
