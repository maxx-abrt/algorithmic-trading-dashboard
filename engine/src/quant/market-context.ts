/**
 * Free market context APIs — sentiment, fear/greed, trending coins, and news.
 *
 * All sources are free, no API keys required:
 *   • Fear & Greed Index: alternative.me (free, no key)
 *   • Trending coins: CoinGecko (free, no key)
 *   • Bitcoin dominance: CoinGecko global (free, no key)
 *
 * Data is cached for 15 minutes to avoid rate limits. The module is designed
 * to fail gracefully — if any API is down, the system continues with partial
 * or no context, never blocking the analysis pipeline.
 */
import { log } from '../log.js'

export interface MarketContext {
  fearGreedIndex: number | null
  fearGreedClassification: string | null
  btcDominance: number | null
  marketCapChange24h: number | null
  trendingCoins: string[]
  fetchedAt: number
  /** normalized sentiment score -100..100 (extreme fear = -100, extreme greed = +100) */
  sentimentScore: number | null
}

const CACHE_TTL_MS = 15 * 60_000
let cached: MarketContext | null = null

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchFearGreed(): Promise<{ value: number; classification: string } | null> {
  const data = await fetchJson('https://api.alternative.me/fng/?limit=1')
  if (!data || typeof data !== 'object') return null
  const arr = (data as Record<string, unknown[]>).data
  if (!Array.isArray(arr) || !arr.length) return null
  const row = arr[0] as Record<string, string>
  const value = Number(row.value)
  if (!Number.isFinite(value)) return null
  return { value, classification: String(row.value_classification ?? 'unknown') }
}

async function fetchGlobal(): Promise<{ btcDominance: number; marketCapChange24h: number } | null> {
  const data = await fetchJson('https://api.coingecko.com/api/v3/global')
  if (!data || typeof data !== 'object') return null
  const d = (data as Record<string, Record<string, unknown>>).data
  if (!d) return null
  const mcp = d.market_cap_percentage as Record<string, number> | undefined
  const btcDominance = mcp?.BTC
  const marketCapChange24h = d.market_cap_change_percentage_24h_usd as number | undefined
  if (btcDominance == null && marketCapChange24h == null) return null
  return { btcDominance: btcDominance ?? 0, marketCapChange24h: marketCapChange24h ?? 0 }
}

async function fetchTrending(): Promise<string[]> {
  const data = await fetchJson('https://api.coingecko.com/api/v3/search/trending')
  if (!data || typeof data !== 'object') return []
  const coins = (data as Record<string, Array<Record<string, Record<string, string>>>>).coins
  if (!Array.isArray(coins)) return []
  return coins.slice(0, 5).map((c) => c.item?.symbol ?? '').filter(Boolean)
}

export async function fetchMarketContext(): Promise<MarketContext> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached

  const [fearGreed, global, trending] = await Promise.all([
    fetchFearGreed(),
    fetchGlobal(),
    fetchTrending(),
  ])

  // Compute a normalized sentiment score from fear & greed (0-100 → -100..+100)
  let sentimentScore: number | null = null
  if (fearGreed) {
    sentimentScore = (fearGreed.value - 50) * 2
  }

  const ctx: MarketContext = {
    fearGreedIndex: fearGreed?.value ?? null,
    fearGreedClassification: fearGreed?.classification ?? null,
    btcDominance: global?.btcDominance ?? null,
    marketCapChange24h: global?.marketCapChange24h ?? null,
    trendingCoins: trending,
    fetchedAt: Date.now(),
    sentimentScore,
  }

  cached = ctx
  const parts: string[] = []
  if (ctx.fearGreedIndex != null) parts.push(`F&G ${ctx.fearGreedIndex}(${ctx.fearGreedClassification})`)
  if (ctx.btcDominance != null) parts.push(`BTC.D ${ctx.btcDominance.toFixed(1)}%`)
  if (ctx.marketCapChange24h != null) parts.push(`MCap ${ctx.marketCapChange24h > 0 ? '+' : ''}${ctx.marketCapChange24h.toFixed(1)}%`)
  if (ctx.trendingCoins.length) parts.push(`trending: ${ctx.trendingCoins.join(', ')}`)
  log.info('market-context', parts.length ? parts.join(' · ') : 'all sources unavailable')
  return ctx
}

/** Synchronous access to the last cached context (null if never fetched). */
export function getCachedMarketContext(): MarketContext | null {
  return cached
}
