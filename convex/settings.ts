import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { assertKey } from './lib/auth'

export const DEFAULT_SETTINGS = {
  docKey: 'global' as const,
  instId: 'BTC-USDT-SWAP',
  timeframe: '15m',
  htfTimeframe: '1H',
  strategy: 'hybrid' as const,
  riskPerTradePct: 1,
  leverage: 5,
  rrRatio: 2,
  minConfidence: 65,
  aiModel: 'gemini-2.5-flash',
  autoTrade: false,
  paperMode: true,
  engineEnabled: true,
  maxOpenPositions: 1,
  maxDailyLossPct: 5,
}

/** Public read — the dashboard subscribes to this. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('settings')
      .withIndex('by_key', (q) => q.eq('docKey', 'global'))
      .unique()
    return row ?? { ...DEFAULT_SETTINGS, updatedAt: 0, _id: null, _creationTime: 0 }
  },
})

const patchArgs = {
  instId: v.optional(v.string()),
  timeframe: v.optional(v.string()),
  htfTimeframe: v.optional(v.string()),
  strategy: v.optional(
    v.union(
      v.literal('trend_momentum'),
      v.literal('mean_reversion'),
      v.literal('hybrid'),
    ),
  ),
  riskPerTradePct: v.optional(v.number()),
  leverage: v.optional(v.number()),
  rrRatio: v.optional(v.number()),
  minConfidence: v.optional(v.number()),
  aiModel: v.optional(v.string()),
  autoTrade: v.optional(v.boolean()),
  paperMode: v.optional(v.boolean()),
  engineEnabled: v.optional(v.boolean()),
  maxOpenPositions: v.optional(v.number()),
  maxDailyLossPct: v.optional(v.number()),
}

/** Guarded write — called from Next.js server actions only. */
export const update = mutation({
  args: { key: v.string(), ...patchArgs },
  handler: async (ctx, args) => {
    assertKey(args.key)
    const { key: _key, ...patch } = args

    // Sanity clamps (never trust the client).
    if (patch.riskPerTradePct !== undefined)
      patch.riskPerTradePct = clamp(patch.riskPerTradePct, 0.1, 10)
    if (patch.leverage !== undefined) patch.leverage = Math.round(clamp(patch.leverage, 1, 50))
    if (patch.rrRatio !== undefined) patch.rrRatio = clamp(patch.rrRatio, 1, 10)
    if (patch.minConfidence !== undefined)
      patch.minConfidence = Math.round(clamp(patch.minConfidence, 0, 100))
    if (patch.maxOpenPositions !== undefined)
      patch.maxOpenPositions = Math.round(clamp(patch.maxOpenPositions, 1, 10))
    if (patch.maxDailyLossPct !== undefined)
      patch.maxDailyLossPct = clamp(patch.maxDailyLossPct, 0.5, 50)
    if (patch.instId !== undefined) {
      if (!/^[A-Z0-9]{1,12}-[A-Z0-9]{2,8}(-SWAP)?$/.test(patch.instId)) {
        throw new Error(`Invalid OKX instId: ${patch.instId}`)
      }
    }

    const existing = await ctx.db
      .query('settings')
      .withIndex('by_key', (q) => q.eq('docKey', 'global'))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, { ...patch, updatedAt: Date.now() })
      return existing._id
    }
    return await ctx.db.insert('settings', {
      ...DEFAULT_SETTINGS,
      ...patch,
      updatedAt: Date.now(),
    })
  },
})

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
