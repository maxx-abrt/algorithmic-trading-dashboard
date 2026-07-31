import { v } from 'convex/values'
import { query } from './_generated/server'

export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('logs')
      .withIndex('by_ts')
      .order('desc')
      .take(Math.min(limit ?? 120, 300))
    return rows.reverse() // oldest -> newest for terminal rendering
  },
})
