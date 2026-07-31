'use server'

import { ConvexHttpClient } from 'convex/browser'
import { api } from '@/convex/_generated/api'

/**
 * All writes go through the server so WORKER_API_KEY never reaches the browser.
 * The browser only ever subscribes to queries.
 */
const url = process.env.NEXT_PUBLIC_CONVEX_URL
const client = url ? new ConvexHttpClient(url) : null

export type SettingsPatch = {
  instId?: string
  timeframe?: string
  htfTimeframe?: string
  strategy?: 'trend_momentum' | 'mean_reversion' | 'hybrid'
  riskPerTradePct?: number
  leverage?: number
  rrRatio?: number
  minConfidence?: number
  aiModel?: string
  autoTrade?: boolean
  paperMode?: boolean
  engineEnabled?: boolean
  maxOpenPositions?: number
  maxDailyLossPct?: number
}

const ALLOWED_TF = new Set(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '1D'])
const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
])

export async function updateSettings(
  patch: SettingsPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = process.env.WORKER_API_KEY
  if (!client) return { ok: false, error: 'NEXT_PUBLIC_CONVEX_URL is not set.' }
  if (!key) return { ok: false, error: 'WORKER_API_KEY is not set in .env.local.' }

  // Server-side allow-listing: never forward arbitrary values to Convex.
  if (patch.timeframe && !ALLOWED_TF.has(patch.timeframe))
    return { ok: false, error: 'Invalid timeframe.' }
  if (patch.htfTimeframe && !ALLOWED_TF.has(patch.htfTimeframe))
    return { ok: false, error: 'Invalid HTF timeframe.' }
  if (patch.aiModel && !ALLOWED_MODELS.has(patch.aiModel))
    return { ok: false, error: 'Invalid model.' }

  try {
    await client.mutation(api.settings.update, { key, ...patch })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Flatten every open position at the current mark price (panic button). */
export async function flattenAll(
  instId: string,
  exitPrice: number,
): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.WORKER_API_KEY
  if (!client || !key) return { ok: false, error: 'Server not configured.' }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0)
    return { ok: false, error: 'No live price available yet.' }
  try {
    await client.mutation(api.trading.closePosition, {
      key,
      instId,
      exitPrice,
      reason: 'manual_flatten',
    })
    await client.mutation(api.settings.update, { key, autoTrade: false })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Which secrets are present — booleans only, never the values. */
export async function getEnvHealth() {
  return {
    convex: Boolean(process.env.NEXT_PUBLIC_CONVEX_URL),
    workerKey: Boolean(process.env.WORKER_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    okx: Boolean(
      process.env.OKX_API_KEY &&
        process.env.OKX_API_SECRET &&
        process.env.OKX_API_PASSPHRASE,
    ),
    simulated: process.env.OKX_SIMULATED === 'true',
  }
}
