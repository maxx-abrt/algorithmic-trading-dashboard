import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const list = query({
  args: { limit: v.optional(v.number()), status: v.optional(v.string()) },
  handler: async (ctx, { limit, status }) => {
    const take = Math.min(limit ?? 80, 300)
    if (status && status !== 'all') {
      return await ctx.db
        .query('signals')
        .withIndex('by_status', (q) => q.eq('status', status))
        .order('desc')
        .take(take)
    }
    return await ctx.db.query('signals').withIndex('by_createdAt').order('desc').take(take)
  },
})

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('signals').withIndex('by_createdAt').order('desc').take(400)
    const closed = rows.filter((r) => r.status !== 'live' && typeof r.realizedR === 'number')
    const wins = closed.filter((r) => (r.realizedR ?? 0) > 0)
    const sumR = closed.reduce((s, r) => s + (r.realizedR ?? 0), 0)
    return {
      total: rows.length,
      live: rows.filter((r) => r.status === 'live').length,
      closed: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      avgR: closed.length ? sumR / closed.length : 0,
      sumR,
      bestR: closed.reduce((m, r) => Math.max(m, r.realizedR ?? 0), 0),
      worstR: closed.reduce((m, r) => Math.min(m, r.realizedR ?? 0), 0),
      avgConviction: rows.length ? rows.reduce((s, r) => s + r.conviction, 0) / rows.length : 0,
    }
  },
})

export const record = mutation({
  args: { key: v.string(), signal: v.any() },
  handler: async (ctx, { key, signal }) => {
    assertWorker(key)
    return await ctx.db.insert('signals', { ...signal, createdAt: Date.now() })
  },
})

export const listLive = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query('signals')
      .withIndex('by_status', (q) => q.eq('status', 'live'))
      .take(100),
})

export const grade = mutation({
  args: { key: v.string(), id: v.string(), patch: v.any() },
  handler: async (ctx, { key, id, patch }) => {
    assertWorker(key)
    await ctx.db.patch(id as never, patch)
    return id
  },
})
