/**
 * Order Book Imbalance — OKX free API.
 *
 * Fetches L2 order book snapshot and computes microstructure features:
 *   - Bid-ask imbalance: (bidVol - askVol) / (bidVol + askVol)
 *   - Depth profile: volume at top 5 levels
 *   - Spread analysis: bid-ask spread in bps
 *   - Large order detection: walls in the book
 *   - Order flow ratio: taker buy / taker sell (from recent trades)
 *
 * These features capture supply/demand imbalance that price-only
 * indicators miss. This is the edge that market makers use.
 */

import { log } from '../log.js'

export interface OrderBookSnapshot {
  /** best bid */
  bestBid: number
  /** best ask */
  bestAsk: number
  /** spread in bps */
  spreadBps: number
  /** bid volume (top N levels) */
  bidVolume: number
  /** ask volume (top N levels) */
  askVolume: number
  /** imbalance: -1 (all asks) to +1 (all bids) */
  imbalance: number
  /** weighted imbalance (closer levels weighted more) */
  weightedImbalance: number
  /** largest bid wall size */
  bidWallSize: number
  /** largest ask wall size */
  askWallSize: number
  /** bid wall price (as % from mid) */
  bidWallDistance: number
  /** ask wall price (as % from mid) */
  askWallDistance: number
  /** depth ratio: volume within 0.1% / volume within 0.5% */
  depthConcentration: number
  /** taker buy / taker sell ratio (from recent trades) */
  takerBuyRatio: number
  /** microstructure signal: -1 (bearish) to +1 (bullish) */
  microSignal: number
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 1000 // 5 seconds — order book changes fast
const cache = new Map<string, { data: OrderBookSnapshot; ts: number }>()

/**
 * Fetch order book from OKX (free, no key required).
 */
export async function fetchOrderBook(instId: string, depth = 50): Promise<OrderBookSnapshot | null> {
  const cached = cache.get(instId)
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data
  }

  try {
    // OKX order book endpoint (free, no auth)
    const url = `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=${depth}`
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const book = data?.data?.[0]
    if (!book?.asks?.length || !book?.bids?.length) return null

    const bids: [number, number, number][] = book.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1]), parseFloat(b[3] ?? '0')])
    const asks: [number, number, number][] = book.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1]), parseFloat(a[3] ?? '0')])

    const bestBid = bids[0][0]
    const bestAsk = asks[0][0]
    const mid = (bestBid + bestAsk) / 2
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10000 : 0

    // Compute volume at top levels
    const topN = Math.min(20, bids.length, asks.length)
    let bidVolume = 0, askVolume = 0
    let weightedBid = 0, weightedAsk = 0
    let totalWeight = 0

    for (let i = 0; i < topN; i++) {
      const weight = 1 / (i + 1) // closer levels weighted more
      bidVolume += bids[i][1]
      askVolume += asks[i][1]
      weightedBid += bids[i][1] * weight
      weightedAsk += asks[i][1] * weight
      totalWeight += weight
    }

    const imbalance = (bidVolume - askVolume) / (bidVolume + askVolume || 1)
    const weightedImbalance = (weightedBid - weightedAsk) / (weightedBid + weightedAsk || 1)

    // Find largest walls
    let bidWallSize = 0, bidWallIdx = 0
    let askWallSize = 0, askWallIdx = 0
    for (let i = 0; i < topN; i++) {
      if (bids[i][1] > bidWallSize) { bidWallSize = bids[i][1]; bidWallIdx = i }
      if (asks[i][1] > askWallSize) { askWallSize = asks[i][1]; askWallIdx = i }
    }
    const bidWallDistance = mid > 0 ? ((mid - bids[bidWallIdx][0]) / mid) * 100 : 0
    const askWallDistance = mid > 0 ? ((asks[askWallIdx][0] - mid) / mid) * 100 : 0

    // Depth concentration: volume within 0.1% / volume within 0.5%
    const bidVol01 = bids.filter((b) => (mid - b[0]) / mid < 0.001).reduce((s, b) => s + b[1], 0)
    const bidVol05 = bids.filter((b) => (mid - b[0]) / mid < 0.005).reduce((s, b) => s + b[1], 0)
    const askVol01 = asks.filter((a) => (a[0] - mid) / mid < 0.001).reduce((s, a) => s + a[1], 0)
    const askVol05 = asks.filter((a) => (a[0] - mid) / mid < 0.005).reduce((s, a) => s + a[1], 0)
    const depthConcentration = (bidVol05 + askVol05) > 0 ? (bidVol01 + askVol01) / (bidVol05 + askVol05) : 0.5

    // Fetch recent trades for taker ratio
    let takerBuyRatio = 1.0
    try {
      const tradesUrl = `https://www.okx.com/api/v5/market/trades?instId=${encodeURIComponent(instId)}&limit=100`
      const tradesResp = await fetch(tradesUrl, { signal: AbortSignal.timeout(5000) })
      if (tradesResp.ok) {
        const tradesData = await tradesResp.json()
        const trades = tradesData?.data ?? []
        let buyVol = 0, sellVol = 0
        for (const t of trades) {
          const side = t.side // 'buy' or 'sell'
          const sz = parseFloat(t.sz)
          if (side === 'buy') buyVol += sz
          else sellVol += sz
        }
        takerBuyRatio = (buyVol + sellVol) > 0 ? buyVol / (buyVol + sellVol) : 0.5
      }
    } catch { /* graceful degradation */ }

    // Compute microstructure signal
    // Positive imbalance + bid wall closer + taker buying = bullish
    let microSignal = 0
    microSignal += imbalance * 0.3
    microSignal += weightedImbalance * 0.3
    microSignal += (takerBuyRatio - 0.5) * 0.4
    // Wall proximity: bid wall closer = support = bullish
    if (bidWallDistance > 0 && askWallDistance > 0) {
      microSignal += (askWallDistance - bidWallDistance) / (askWallDistance + bidWallDistance) * 0.2
    }
    microSignal = Math.max(-1, Math.min(1, microSignal))

    const snapshot: OrderBookSnapshot = {
      bestBid, bestAsk, spreadBps,
      bidVolume, askVolume, imbalance, weightedImbalance,
      bidWallSize, askWallSize, bidWallDistance, askWallDistance,
      depthConcentration, takerBuyRatio, microSignal,
      fetchedAt: Date.now(),
    }

    cache.set(instId, { data: snapshot, ts: Date.now() })
    return snapshot
  } catch (err) {
    log.error('orderbook', `fetch failed for ${instId}: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

/**
 * Build order book feature vector for model input.
 */
export function orderBookFeatures(snapshot: OrderBookSnapshot | null): {
  imbalance: number
  weightedImbalance: number
  spreadBps: number
  microSignal: number
  takerBuyRatio: number
  depthConcentration: number
} {
  if (!snapshot) {
    return {
      imbalance: 0,
      weightedImbalance: 0,
      spreadBps: 0,
      microSignal: 0,
      takerBuyRatio: 0.5,
      depthConcentration: 0.5,
    }
  }

  return {
    imbalance: Math.max(-1, Math.min(1, snapshot.imbalance)),
    weightedImbalance: Math.max(-1, Math.min(1, snapshot.weightedImbalance)),
    spreadBps: Math.max(0, Math.min(1, snapshot.spreadBps / 50)),
    microSignal: Math.max(-1, Math.min(1, snapshot.microSignal)),
    takerBuyRatio: Math.max(0, Math.min(1, snapshot.takerBuyRatio)),
    depthConcentration: Math.max(0, Math.min(1, snapshot.depthConcentration)),
  }
}
