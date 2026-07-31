import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import { assertWorker } from './lib/auth'

export const DEFAULTS = {
  docKey: 'global' as const,
  instId: 'BTC-USDT-SWAP',
  timeframe: '15m',
  htfTimeframe: '1H',
  htf2Timeframe: '4H',
  strategy: 'adaptive',
  minConfidence: 60,
  minCompositeScore: 20,
  requireMtfAlignment: true,
  usePatterns: true,
  useDerivatives: true,
  useEmpiricalEdge: true,
  maxAtrPct: 8,
  minAdx: 16,
  weights: {
    trend: 1,
    momentum: 1,
    volatility: 1,
    volume: 1,
    structure: 1,
    pattern: 1,
    derivatives: 1,
    mtf: 1,
    stats: 1,
    edge: 1,
  },
  riskPerTradePct: 1,
  leverage: 5,
  rrRatio: 2,
  equityUsd: 10000,
  useAccountBalance: false,
  takerFeeBps: 5,
  ai: {
    enabled: true,
    model: 'gemini-2.5-flash',
    temperature: 0.15,
    maxOutputTokens: 1200,
    thinkingBudget: 0,
    cooldownMs: 90000,
    minConvictionToAsk: 45,
    contextDepth: 'standard',
  },
  scanner: {
    enabled: true,
    timeframe: '15m',
    instTypes: ['SWAP'],
    quoteCcy: 'USDT',
    minVol24hUsd: 5000000,
    universeSize: 60,
    intervalMs: 60000,
    includeEquities: true,
  },
  telegram: {
    enabled: true,
    minConviction: 62,
    onlyWatchlist: false,
    quietHoursStart: 0,
    quietHoursEnd: 0,
    sendScanDigest: false,
    digestIntervalMin: 240,
  },
  engineEnabled: true,
}

export const get = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('settings')
      .withIndex('by_key', (q) => q.eq('docKey', 'global'))
      .unique()
    if (row) return row
    return { ...DEFAULTS, updatedAt: 0, _id: null, _creationTime: 0 }
  },
})

/** Engine-only upsert. Accepts a partial patch and merges it. */
export const update = mutation({
  args: {
    key: v.string(),
    patch: v.any(),
  },
  handler: async (ctx, { key, patch }) => {
    assertWorker(key)
    const row = await ctx.db
      .query('settings')
      .withIndex('by_key', (q) => q.eq('docKey', 'global'))
      .unique()
    const merged = {
      ...DEFAULTS,
      ...(row ?? {}),
      ...patch,
      weights: { ...DEFAULTS.weights, ...(row?.weights ?? {}), ...(patch?.weights ?? {}) },
      ai: { ...DEFAULTS.ai, ...(row?.ai ?? {}), ...(patch?.ai ?? {}) },
      scanner: { ...DEFAULTS.scanner, ...(row?.scanner ?? {}), ...(patch?.scanner ?? {}) },
      telegram: { ...DEFAULTS.telegram, ...(row?.telegram ?? {}), ...(patch?.telegram ?? {}) },
      docKey: 'global' as const,
      updatedAt: Date.now(),
    }
    delete (merged as Record<string, unknown>)._id
    delete (merged as Record<string, unknown>)._creationTime
    if (row) {
      await ctx.db.replace(row._id, merged)
      return row._id
    }
    return await ctx.db.insert('settings', merged)
  },
})
