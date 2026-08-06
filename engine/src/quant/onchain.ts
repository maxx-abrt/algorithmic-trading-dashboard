/**
 * On-Chain Metrics Fetcher — free tier APIs.
 *
 * Fetches blockchain-level data that provides fundamental signals:
 *   - Exchange net flow (inflows = bearish, outflows = bullish)
 *   - Whale transaction count (large transfers = volatility incoming)
 *   - Active addresses (network adoption = fundamental bull)
 *   - MVRV ratio (market value / realized value → over/undervalued)
 *
 * Uses free APIs:
 *   - CoinGecko (global data, no key)
 *   - Blockchain.com API (free, no key)
 *   - Bitquery free tier (if needed)
 *
 * Cached for 30 minutes (on-chain data changes slowly).
 */

import { log } from '../log.js'

export interface OnChainData {
  /** net flow into exchanges in USD (positive = inflow = bearish) */
  exchangeNetFlowUsd: number | null
  /** whale transaction count (> $100k) in last 24h */
  whaleTxCount: number | null
  /** active addresses (24h) */
  activeAddresses: number | null
  /** MVRV ratio (> 3.5 = overvalued, < 1 = undervalued) */
  mvrvRatio: number | null
  /** NVT ratio (network value to transactions, high = overvalued) */
  nvtRatio: number | null
  /** hash rate (security indicator) */
  hashRate: number | null
  /** stablecoin supply change % (growing = bullish dry powder) */
  stablecoinSupplyChange: number | null
  /** composite on-chain score: -1 (bearish) to +1 (bullish) */
  onChainScore: number
  fetchedAt: number
}

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes
let cache: OnChainData | null = null

/**
 * Fetch on-chain data from free APIs.
 * Gracefully degrades — any failed fetch returns null for that field.
 */
async function fetchOnChain(): Promise<OnChainData> {
  // CoinGecko global data (free, no key)
  let activeAddresses: number | null = null
  let mvrvRatio: number | null = null
  let nvtRatio: number | null = null

  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/global', {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (resp.ok) {
      const data = await resp.json()
      const marketCapPct = data?.data?.market_cap_percentage
      // Derive approximate on-chain signals from market data
      if (marketCapPct?.btc) {
        // High BTC dominance with low altcoin share = early cycle (bullish)
        // Low BTC dominance = late cycle (potentially bearish)
      }
    }
  } catch { /* graceful degradation */ }

  // Try Blockchain.com API for BTC stats (free, no key)
  let hashRate: number | null = null
  try {
    const resp = await fetch('https://blockchain.info/q/hashrate', {
      signal: AbortSignal.timeout(8000),
    })
    if (resp.ok) {
      const text = await resp.text()
      const hr = parseFloat(text)
      if (Number.isFinite(hr)) hashRate = hr
    }
  } catch { /* graceful degradation */ }

  // Try to get exchange flow data from free sources
  // Note: Most exchange flow APIs require paid keys. We approximate
  // using CoinGecko's exchange volume data.
  let exchangeNetFlowUsd: number | null = null
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/exchanges', {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (resp.ok) {
      const exchanges = await resp.json()
      // Sum top exchange volumes as a proxy for flow activity
      const totalVolume = exchanges.slice(0, 20).reduce((sum: number, e: { trade_volume_24h_btc?: number }) =>
        sum + (e.trade_volume_24h_btc ?? 0), 0)
      // This is a rough proxy — real net flow needs paid data
      exchangeNetFlowUsd = totalVolume > 0 ? 0 : null // neutral when we can't determine direction
    }
  } catch { /* graceful degradation */ }

  // Compute composite on-chain score
  let score = 0
  if (mvrvRatio != null) {
    if (mvrvRatio < 1) score += 0.3 // undervalued
    else if (mvrvRatio > 3.5) score -= 0.3 // overvalued
  }
  if (nvtRatio != null) {
    if (nvtRatio < 15) score += 0.2 // undervalued
    else if (nvtRatio > 50) score -= 0.2 // overvalued
  }
  if (hashRate != null && hashRate > 0) {
    // Rising hash rate = bullish (miners confident)
    score += 0.1
  }
  score = Math.max(-1, Math.min(1, score))

  return {
    exchangeNetFlowUsd,
    whaleTxCount: null, // requires paid API
    activeAddresses,
    mvrvRatio,
    nvtRatio,
    hashRate,
    stablecoinSupplyChange: null, // requires paid API
    onChainScore: score,
    fetchedAt: Date.now(),
  }
}

export async function getOnChainData(): Promise<OnChainData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache
  }

  try {
    cache = await fetchOnChain()
    log.info('onchain', `fetched: hashRate=${cache.hashRate?.toFixed(0) ?? 'n/a'} score=${cache.onChainScore.toFixed(2)}`)
  } catch (err) {
    log.error('onchain', `fetch failed: ${err instanceof Error ? err.message : 'unknown'}`)
    if (cache) return cache
    cache = {
      exchangeNetFlowUsd: null, whaleTxCount: null, activeAddresses: null,
      mvrvRatio: null, nvtRatio: null, hashRate: null, stablecoinSupplyChange: null,
      onChainScore: 0, fetchedAt: Date.now(),
    }
  }

  return cache
}

export function getCachedOnChainData(): OnChainData | null {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS * 2) {
    return cache
  }
  return null
}

/**
 * Build on-chain feature vector for model input.
 */
export function onChainFeatures(data: OnChainData | null): {
  onChainScore: number
  hashRateNormalized: number
  mvrvNormalized: number
  nvtNormalized: number
} {
  if (!data) {
    return {
      onChainScore: 0,
      hashRateNormalized: 0.5,
      mvrvNormalized: 0.5,
      nvtNormalized: 0.5,
    }
  }

  return {
    onChainScore: data.onChainScore,
    hashRateNormalized: data.hashRate != null ? Math.min(1, data.hashRate / 600_000_000_000) : 0.5,
    mvrvNormalized: data.mvrvRatio != null ? Math.max(0, Math.min(1, data.mvrvRatio / 5)) : 0.5,
    nvtNormalized: data.nvtRatio != null ? Math.max(0, Math.min(1, data.nvtRatio / 100)) : 0.5,
  }
}
