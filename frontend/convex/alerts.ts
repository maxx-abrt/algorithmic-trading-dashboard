import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

/* ── rules ─────────────────────────────────────────────────────────────── */

export const listRules = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query('alertRules').collect()).sort((a, b) => b.createdAt - a.createdAt),
})

export const upsertRule = mutation({
  args: {
    key: v.string(),
    id: v.optional(v.string()),
    name: v.string(),
    scope: v.string(),
    type: v.string(),
    timeframe: v.string(),
    params: v.object({
      threshold: v.optional(v.number()),
      direction: v.optional(v.string()),
      value: v.optional(v.number()),
      text: v.optional(v.string()),
    }),
    cooldownMs: v.number(),
    telegram: v.boolean(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { key, id, ...rest }) => {
    assertWorker(key)
    if (id) {
      const existing = await ctx.db.get(id as never)
      if (existing) {
        await ctx.db.patch(id as never, rest)
        return id
      }
    }
    return await ctx.db.insert('alertRules', {
      ...rest,
      lastFiredAt: 0,
      firedCount: 0,
      createdAt: Date.now(),
    })
  },
})

export const deleteRule = mutation({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, { key, id }) => {
    assertWorker(key)
    await ctx.db.delete(id as never)
    return true
  },
})

export const markFired = mutation({
  args: { key: v.string(), id: v.string(), ts: v.number() },
  handler: async (ctx, { key, id, ts }) => {
    assertWorker(key)
    const row = await ctx.db.get(id as never)
    if (!row) return null
    await ctx.db.patch(id as never, {
      lastFiredAt: ts,
      firedCount: ((row as { firedCount?: number }).firedCount ?? 0) + 1,
    })
    return id
  },
})

/* ── events ────────────────────────────────────────────────────────────── */

export const listEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    await ctx.db
      .query('alertEvents')
      .withIndex('by_ts')
      .order('desc')
      .take(Math.min(limit ?? 60, 200)),
})

export const record = mutation({
  args: {
    key: v.string(),
    ruleId: v.optional(v.string()),
    ruleName: v.string(),
    type: v.string(),
    severity: v.string(),
    instId: v.string(),
    timeframe: v.string(),
    title: v.string(),
    message: v.string(),
    decision: v.optional(v.string()),
    conviction: v.optional(v.number()),
    price: v.number(),
    payload: v.optional(v.string()),
    telegramDelivered: v.boolean(),
  },
  handler: async (ctx, { key, ...rest }) => {
    assertWorker(key)
    const id = await ctx.db.insert('alertEvents', { ...rest, ts: Date.now() })
    // keep the table bounded
    const old = await ctx.db.query('alertEvents').withIndex('by_ts').order('asc').take(1)
    const count = (await ctx.db.query('alertEvents').collect()).length
    if (count > 500 && old[0]) await ctx.db.delete(old[0]._id)
    return id
  },
})
