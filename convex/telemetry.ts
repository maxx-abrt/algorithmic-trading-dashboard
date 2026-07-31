import { v } from 'convex/values'
import { query } from './_generated/server'

export const all = query({
  args: {},
  handler: async (ctx) => await ctx.db.query('telemetry').collect(),
})

export const marketState = query({
  args: { instId: v.string(), timeframe: v.string() },
  handler: async (ctx, { instId, timeframe }) =>
    await ctx.db
      .query('marketState')
      .withIndex('by_inst_tf', (q) =>
        q.eq('instId', instId).eq('timeframe', timeframe),
      )
      .unique(),
})
