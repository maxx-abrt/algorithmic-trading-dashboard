import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query('telemetry').collect(),
})

export const ping = mutation({
  args: {
    key: v.string(),
    service: v.string(),
    status: v.string(),
    meta: v.optional(v.string()),
    counters: v.optional(v.any()),
  },
  handler: async (ctx, { key, service, status, meta, counters }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('telemetry')
      .withIndex('by_service', (q) => q.eq('service', service))
      .unique()
    const doc = { service, status, meta, counters, lastPing: Date.now() }
    if (row) {
      await ctx.db.replace(row._id, doc)
      return row._id
    }
    return await ctx.db.insert('telemetry', doc)
  },
})
