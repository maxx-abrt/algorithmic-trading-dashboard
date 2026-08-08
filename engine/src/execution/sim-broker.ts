/**
 * Internal execution simulator.
 *
 * The OKX demo key in this deployment is rejected (`50119 API key doesn't exist`),
 * so zero orders have ever reached an exchange and fill quality has never been
 * measured. Waiting for a working key would mean waiting forever, so execution
 * realism is modelled locally from data we DO have: the live order book, the live
 * spread, and the instrument's own liquidity profile.
 *
 * What is modelled
 *   • effective spread from the real top of book (falls back to the ticker spread)
 *   • depth consumption: the fraction of the visible top-of-book size the order
 *     would eat, which drives the slippage curve non-linearly
 *   • limit-order queue risk: an entry at or through the touch fills, an entry
 *     resting behind the touch fills only with a probability derived from how far
 *     inside the book it sits and how fast the book is turning over
 *   • latency: a fixed decision-to-exchange delay applied to the reference price
 *   • rejection: size below the instrument minimum, or a book too thin to absorb it
 *
 * The measured statistics are written to `sim_orders`, so the dashboard shows fill
 * rate, mean slippage and spread exactly as it would with a real venue — and the
 * moment a valid OKX demo key appears the same numbers become directly comparable.
 */
import type { InstrumentSpec } from '../quant/types.js'
import type { OrderBookSnapshot } from '../quant/orderbook.js'
import type { PaperTrade } from '../paper/types.js'
import type { PopulationStore } from '../store/population-store.js'

export interface SimContext {
  spec: InstrumentSpec
  book: OrderBookSnapshot | null
  /** last traded price */
  last: number
  /** ticker spread in bps, used when there is no book snapshot */
  tickerSpreadBps: number | null
  /** 24h turnover, used as a liquidity prior for instruments without a book */
  volUsd24h: number | null
}

export interface SimFill {
  state: 'filled' | 'partial' | 'rejected' | 'resting'
  intendedPx: number
  filledPx: number | null
  requestedSz: number
  filledSz: number
  spreadBps: number
  slippageBps: number
  latencyMs: number
  reason: string
}

const LATENCY_MS = 180

function roundToStep(value: number, step: number) {
  if (!(step > 0)) return value
  const decimals = Math.min(12, (String(step).split('.')[1] ?? '').length)
  return Number((Math.floor(value / step) * step).toFixed(decimals))
}

/** Size the order exactly like a real venue would: contracts for swaps, base for spot. */
export function sizeForTrade(trade: PaperTrade, spec: InstrumentSpec, multiplier = 1): { sz: number; reason: string } {
  const stopDistance = Math.abs(trade.plan.entry - trade.plan.stopLoss)
  if (!(stopDistance > 0)) return { sz: 0, reason: 'zero_stop_distance' }
  const riskUsd = Math.max(1, trade.plan.riskUsd) * multiplier
  const raw =
    spec.instType === 'SWAP' || spec.instType === 'FUTURES'
      ? riskUsd / (stopDistance * (spec.ctVal > 0 ? spec.ctVal : 1))
      : riskUsd / stopDistance
  const stepped = roundToStep(raw, spec.lotSz > 0 ? spec.lotSz : 1)
  if (stepped < spec.minSz) return { sz: roundToStep(spec.minSz, spec.lotSz > 0 ? spec.lotSz : 1), reason: `raised_to_min_sz_${spec.minSz}` }
  return { sz: stepped, reason: `risk_${riskUsd.toFixed(2)}_stop_${stopDistance.toFixed(6)}` }
}

/**
 * Simulate one entry order. Deterministic given the same book snapshot, so a replay
 * of the same day produces the same fills.
 */
export function simulateEntry(trade: PaperTrade, context: SimContext, multiplier = 1): SimFill {
  const side = trade.plan.side === 'LONG' ? 'buy' : 'sell'
  const { sz, reason: sizeReason } = sizeForTrade(trade, context.spec, multiplier)
  const intendedPx = trade.plan.entry

  if (!(sz > 0)) {
    return { state: 'rejected', intendedPx, filledPx: null, requestedSz: 0, filledSz: 0, spreadBps: 0, slippageBps: 0, latencyMs: LATENCY_MS, reason: sizeReason }
  }

  const book = context.book
  const spreadBps = book?.spreadBps != null && book.spreadBps > 0 ? book.spreadBps : (context.tickerSpreadBps ?? 4)
  const reference = context.last > 0 ? context.last : intendedPx
  const half = (spreadBps / 2 / 10_000) * reference
  const touch = side === 'buy' ? reference + half : reference - half

  // Notional we are asking the book to absorb, versus what is visibly resting near
  // the touch. `topDepthUsd` is derived from the book when present, otherwise from a
  // conservative fraction of 24h turnover.
  const notionalUsd = context.spec.instType === 'SPOT' ? sz * reference : sz * reference * (context.spec.ctVal > 0 ? context.spec.ctVal : 1)
  const topDepthUsd = book
    ? Math.max(1, (side === 'buy' ? book.askVolume : book.bidVolume) * reference * (context.spec.instType === 'SPOT' ? 1 : context.spec.ctVal > 0 ? context.spec.ctVal : 1))
    : Math.max(2_000, (context.volUsd24h ?? 1e6) * 0.00002)
  const consumption = notionalUsd / topDepthUsd

  if (consumption > 6) {
    return {
      state: 'rejected',
      intendedPx,
      filledPx: null,
      requestedSz: sz,
      filledSz: 0,
      spreadBps,
      slippageBps: 0,
      latencyMs: LATENCY_MS,
      reason: `book_too_thin: order ${Math.round(notionalUsd)} USD vs ${Math.round(topDepthUsd)} USD visible`,
    }
  }

  // A limit price at or through the touch is an aggressive order: it pays the spread
  // plus a depth-dependent impact. A price resting behind the touch pays nothing
  // extra but may not fill at all.
  const aggressive = side === 'buy' ? intendedPx >= touch : intendedPx <= touch
  const distanceBps = Math.abs((intendedPx - touch) / reference) * 10_000

  if (!aggressive) {
    // Probability that price comes back to a resting order within the entry window.
    const fillProbability = Math.max(0.05, Math.min(0.95, 1 - distanceBps / Math.max(6, spreadBps * 6)))
    const roll = deterministicUnit(`${trade.id}:${Math.round(intendedPx * 1e6)}`)
    if (roll > fillProbability) {
      return {
        state: 'resting',
        intendedPx,
        filledPx: null,
        requestedSz: sz,
        filledSz: 0,
        spreadBps,
        slippageBps: 0,
        latencyMs: LATENCY_MS,
        reason: `resting_${distanceBps.toFixed(1)}bps_behind_touch_p${(fillProbability * 100).toFixed(0)}%`,
      }
    }
    return {
      state: 'filled',
      intendedPx,
      filledPx: intendedPx,
      requestedSz: sz,
      filledSz: sz,
      spreadBps,
      slippageBps: 0,
      latencyMs: LATENCY_MS,
      reason: `maker_fill_${distanceBps.toFixed(1)}bps_inside`,
    }
  }

  // Aggressive fill: half spread + square-root impact of the depth we consume, plus
  // a latency term proportional to the instrument's short-term volatility proxy.
  const impactBps = (spreadBps / 2) * Math.max(1, Math.sqrt(1 + consumption * 3))
  const latencyDriftBps = Math.min(6, spreadBps * 0.25)
  const slippageBps = impactBps + latencyDriftBps
  const filledPx = side === 'buy' ? reference * (1 + slippageBps / 10_000) : reference * (1 - slippageBps / 10_000)
  const partial = consumption > 1.5
  const filledSz = partial ? roundToStep(sz / Math.max(1, consumption), context.spec.lotSz > 0 ? context.spec.lotSz : 1) : sz

  return {
    state: partial && filledSz < sz ? 'partial' : 'filled',
    intendedPx,
    filledPx,
    requestedSz: sz,
    filledSz: Math.max(filledSz, context.spec.minSz),
    spreadBps,
    slippageBps,
    latencyMs: LATENCY_MS,
    reason: `taker_fill consumption ${(consumption * 100).toFixed(0)}% of visible depth`,
  }
}

/** Stable pseudo-random in [0,1) derived from a string, so replays are identical. */
function deterministicUnit(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return ((hash >>> 0) % 100_000) / 100_000
}

export class SimulatedBroker {
  constructor(private readonly store: PopulationStore) {}

  place(trade: PaperTrade, context: SimContext, multiplier = 1): SimFill {
    const fill = simulateEntry(trade, context, multiplier)
    this.store.recordSimOrder({
      tradeId: trade.id,
      instId: trade.plan.instId,
      instType: context.spec.instType,
      side: trade.plan.side === 'LONG' ? 'buy' : 'sell',
      intendedPx: fill.intendedPx,
      filledPx: fill.filledPx,
      requestedSz: fill.requestedSz,
      filledSz: fill.filledSz,
      spreadBps: fill.spreadBps,
      slippageBps: fill.slippageBps,
      latencyMs: fill.latencyMs,
      state: fill.state,
      reason: fill.reason,
    })
    return fill
  }

  health() {
    const quality = this.store.simFillQuality()
    return {
      kind: 'internal_simulator' as const,
      ...quality,
      note: 'Fills are modelled from the live order book, spread and depth. Enable OKX demo keys to measure real venue fills.',
    }
  }

  recent(limit = 60) {
    return this.store.simOrders(limit)
  }
}
