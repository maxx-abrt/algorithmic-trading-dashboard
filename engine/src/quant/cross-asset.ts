/**
 * Cross-Asset Signal Fetcher — free APIs.
 *
 * Fetches data from traditional finance markets that correlate with crypto:
 *   - VIX (volatility index) → crypto fear proxy
 *   - DXY (dollar index)     → inverse correlation with crypto
 *   - S&P 500 (SPY)          → risk-on/risk-off regime
 *   - Gold (GLD)             → flight-to-safety
 *   - US 10Y yield (^TNX)    → cost of capital
 *
 * Uses Yahoo Finance free API (no key required).
 * Cached for 15 minutes to avoid rate limits.
 */

import { log } from '../log.js'

export interface CrossAssetData {
  vix: number | null
  vixChange: number | null
  dxy: number | null
  dxyChange: number | null
  spy: number | null
  spyChange: number | null
  gold: number | null
  goldChange: number | null
  treasury10y: number | null
  treasuryChange: number | null
  /** risk-on/risk-off score: -1 (extreme risk off) to +1 (extreme risk on) */
  riskScore: number
  fetchedAt: number
}

const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
let cache: CrossAssetData | null = null

const YAHOO_SYMBOLS: Record<string, { yahoo: string; key: string }> = {
  vix: { yahoo: '^VIX', key: 'vix' },
  dxy: { yahoo: 'DX-Y.NYB', key: 'dxy' },
  spy: { yahoo: 'SPY', key: 'spy' },
  gold: { yahoo: 'GLD', key: 'gold' },
  treasury: { yahoo: '^TNX', key: 'treasury10y' },
}

async function fetchYahooQuote(symbol: string): Promise<{ price: number; change: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const result = data?.chart?.result?.[0]
    if (!result) return null

    const closes = result.indicators?.quote?.[0]?.close?.filter((v: number | null) => v != null) ?? []
    if (closes.length < 2) return null

    const price = closes[closes.length - 1]
    const prev = closes[closes.length - 2]
    const change = ((price - prev) / prev) * 100

    return { price, change }
  } catch {
    return null
  }
}

async function fetchAllCrossAsset(): Promise<CrossAssetData> {
  const entries = Object.entries(YAHOO_SYMBOLS)
  const results = await Promise.all(
    entries.map(async ([key, { yahoo }]) => {
      const quote = await fetchYahooQuote(yahoo)
      return { key, quote }
    })
  )

  const data: Record<string, { price: number; change: number } | null> = {}
  for (const { key, quote } of results) {
    data[key] = quote
  }

  // Compute risk-on/risk-off score
  // VIX low + SPY up + DXY down + Gold down = risk on (positive)
  // VIX high + SPY down + DXY up + Gold up = risk off (negative)
  let riskScore = 0
  if (data.vix) {
    riskScore += data.vix.price > 25 ? -0.3 : data.vix.price < 15 ? 0.2 : 0
  }
  if (data.spy) {
    riskScore += data.spy.change > 0.5 ? 0.25 : data.spy.change < -0.5 ? -0.25 : 0
  }
  if (data.dxy) {
    riskScore += data.dxy.change < -0.2 ? 0.2 : data.dxy.change > 0.2 ? -0.2 : 0
  }
  if (data.gold) {
    riskScore += data.gold.change > 1 ? -0.15 : data.gold.change < -1 ? 0.1 : 0
  }
  riskScore = Math.max(-1, Math.min(1, riskScore))

  return {
    vix: data.vix?.price ?? null,
    vixChange: data.vix?.change ?? null,
    dxy: data.dxy?.price ?? null,
    dxyChange: data.dxy?.change ?? null,
    spy: data.spy?.price ?? null,
    spyChange: data.spy?.change ?? null,
    gold: data.gold?.price ?? null,
    goldChange: data.gold?.change ?? null,
    treasury10y: data.treasury?.price ?? null,
    treasuryChange: data.treasury?.change ?? null,
    riskScore,
    fetchedAt: Date.now(),
  }
}

export async function getCrossAssetData(): Promise<CrossAssetData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache
  }

  try {
    cache = await fetchAllCrossAsset()
    log.info('cross-asset', `fetched: VIX=${cache.vix?.toFixed(1) ?? 'n/a'} DXY=${cache.dxy?.toFixed(2) ?? 'n/a'} SPY=${cache.spy?.toFixed(2) ?? 'n/a'} risk=${cache.riskScore.toFixed(2)}`)
  } catch (err) {
    log.error('cross-asset', `fetch failed: ${err instanceof Error ? err.message : 'unknown'}`)
    if (cache) return cache
    // Return neutral defaults
    cache = {
      vix: null, vixChange: null, dxy: null, dxyChange: null,
      spy: null, spyChange: null, gold: null, goldChange: null,
      treasury10y: null, treasuryChange: null,
      riskScore: 0, fetchedAt: Date.now(),
    }
  }

  return cache
}

/**
 * Get cached cross-asset data (synchronous, may be stale).
 */
export function getCachedCrossAssetData(): CrossAssetData | null {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS * 2) {
    return cache
  }
  return null
}

/**
 * Build cross-asset feature vector for model input.
 * Returns normalized features suitable for the feature vector.
 */
export function crossAssetFeatures(data: CrossAssetData | null): {
  vixNormalized: number
  dxyChangeNormalized: number
  spyChangeNormalized: number
  riskScore: number
  goldChangeNormalized: number
} {
  if (!data) {
    return {
      vixNormalized: 0.5,
      dxyChangeNormalized: 0,
      spyChangeNormalized: 0,
      riskScore: 0,
      goldChangeNormalized: 0,
    }
  }

  return {
    vixNormalized: data.vix != null ? Math.max(0, Math.min(1, data.vix / 50)) : 0.5,
    dxyChangeNormalized: data.dxyChange != null ? Math.max(-1, Math.min(1, data.dxyChange / 2)) : 0,
    spyChangeNormalized: data.spyChange != null ? Math.max(-1, Math.min(1, data.spyChange / 3)) : 0,
    riskScore: data.riskScore,
    goldChangeNormalized: data.goldChange != null ? Math.max(-1, Math.min(1, data.goldChange / 3)) : 0,
  }
}
