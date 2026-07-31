import { v } from 'convex/values'
import { query } from './_generated/server'

export const listOpen = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query('positions')
      .withIndex('by_status', (q) => q.eq('status', 'open'))
      .order('desc')
      .take(20),
})

export const history = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query('positions')
      .withIndex('by_status', (q) => q.eq('status', 'closed'))
      .order('desc')
      .take(Math.min(limit ?? 25, 100)),
})

/** Aggregated performance over the last 200 closed trades. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    const closed = await ctx.db
      .query('positions')
      .withIndex('by_status', (q) => q.eq('status', 'closed'))
      .order('desc')
      .take(200)
    const open = await ctx.db
      .query('positions')
      .withIndex('by_status', (q) => q.eq('status', 'open'))
      .collect()

    const wins = closed.filter((p) => p.pnlUsd > 0)
    const losses = closed.filter((p) => p.pnlUsd <= 0)
    const grossWin = wins.reduce((s, p) => s + p.pnlUsd, 0)
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p.pnlUsd, 0))

    return {
      openCount: open.length,
      openPnlUsd: open.reduce((s, p) => s + p.pnlUsd, 0),
      closedCount: closed.length,
      realizedPnlUsd: closed.reduce((s, p) => s + p.pnlUsd, 0),
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
      avgWinPct: wins.length ? wins.reduce((s, p) => s + p.pnlPct, 0) / wins.length : 0,
      avgLossPct: losses.length
        ? losses.reduce((s, p) => s + p.pnlPct, 0) / losses.length
        : 0,
    }
  },
})
