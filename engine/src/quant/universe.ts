/**
 * Tradable universe selection.
 *
 * Sorting OKX tickers by 24h turnover and taking the top N looks sensible and is
 * wrong: the top of that list is full of things you must not learn from.
 *
 *   • USDC-USDT, USDT-USDC, DAI-USDT …  stable/stable pairs whose entire price
 *     range is a rounding error, so every ATR-scaled feature explodes and every
 *     "breakout" is noise
 *   • tokenized equities (SPCX, SNDK, TSLA…) which only trade during US market
 *     hours, gap violently over the weekend and follow a completely different
 *     process from 24/7 crypto
 *   • wrapped/duplicate listings of the same underlying, which inflate the
 *     apparent number of independent symbols and quietly break held-out testing
 *
 * This module is the single place that decides what the system is allowed to
 * learn from, so the same rule applies to the scanner, the tape builder and the
 * live advisor.
 */
import type { InstrumentSpec } from './types.js'


const STABLE_BASES = new Set([
  'USDT',
  'USDC',
  'DAI',
  'TUSD',
  'FDUSD',
  'USDE',
  'USDD',
  'PYUSD',
  'EURT',
  'EURC',
  'BUSD',
  'USDP',
  'GUSD',
  'LUSD',
  'CRVUSD',
  'USDS',
  'RLUSD',
  'XAUT',
  'PAXG',
])

/** Instruments whose base currency is itself a stablecoin or metal token. */
export function isStableBase(instId: string): boolean {
  const base = instId.split('-')[0]?.toUpperCase() ?? ''
  return STABLE_BASES.has(base)
}

/** Leveraged ETF-style listings OKX exposes as 3L/3S/5L/5S products. */
export function isLeveragedToken(instId: string): boolean {
  return /-(3|5)[LS](-|$)/i.test(instId) || /^[A-Z0-9]+(3|5)[LS]-/i.test(instId)
}

export interface UniverseCandidate {
  instId: string
  instType: string
  volUsd24h: number
  changePct24h?: number | null
  spreadBps?: number | null
}

export interface UniverseOptions {
  /** minimum 24h turnover in USD */
  minVolUsd24h?: number
  /** hard cap per instrument type */
  perType?: number
  quoteCcy?: string
  includeEquities?: boolean
  includeStables?: boolean
  /** always keep these, whatever the filters say */
  pinned?: readonly string[]
}

/**
 * Rank and filter tickers into a universe worth learning from.
 * Deterministic: identical inputs always produce the identical ordered list.
 */
export function selectUniverse<T extends UniverseCandidate>(
  tickers: readonly T[],
  specs: Map<string, InstrumentSpec>,
  options: UniverseOptions = {},
): T[] {
  const quote = options.quoteCcy ?? 'USDT'
  const minVol = options.minVolUsd24h ?? 3_000_000
  const perType = Math.max(1, options.perType ?? 40)
  const pinned = new Set(options.pinned ?? [])

  const eligible = tickers.filter((ticker) => {
    if (pinned.has(ticker.instId)) return true
    const spec = specs.get(ticker.instId)
    if (!spec) return false
    if (quote && !ticker.instId.includes(`-${quote}`)) return false
    if (ticker.volUsd24h < minVol) return false
    // OKX marks tokenized equities with instCategory '3'. That is authoritative and,
    // unlike a ticker blocklist, it stays correct as new listings arrive.
    if (!options.includeEquities && (spec.isEquity || spec.instCategory !== '1')) return false
    if (!options.includeStables && isStableBase(ticker.instId)) return false
    if (isLeveragedToken(ticker.instId)) return false
    return true
  })

  const byType = new Map<string, T[]>()
  for (const ticker of eligible.sort((a, b) => b.volUsd24h - a.volUsd24h)) {
    const bucket = byType.get(ticker.instType)
    if (bucket) bucket.push(ticker)
    else byType.set(ticker.instType, [ticker])
  }

  const out: T[] = []
  for (const [, bucket] of byType) out.push(...bucket.slice(0, perType))
  for (const instId of pinned) {
    if (!out.some((ticker) => ticker.instId === instId)) {
      const found = tickers.find((ticker) => ticker.instId === instId)
      if (found) out.push(found)
    }
  }
  return out.sort((a, b) => b.volUsd24h - a.volUsd24h)
}

/**
 * Structural test for "is this a 24/7 crypto market?".
 *
 * Static ticker blocklists always go stale: OKX keeps listing new tokenized
 * equities and every one of them poisons the tape with weekend gaps and flat
 * sessions. Instead of guessing from the symbol, look at the bars: a continuously
 * traded market has almost no zero-volume bars, almost no zero-range bars, and no
 * multi-hour holes in an intraday series.
 */
export function tradingContinuity(candles: readonly { ts: number; high: number; low: number; volume: number }[], barMs: number) {
  if (candles.length < 60) return { continuous: false, deadBarRatio: 1, gapRatio: 1, reason: 'too_few_bars' }
  let dead = 0
  let gaps = 0
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]
    if (!(candle.volume > 0) || !(candle.high > candle.low)) dead++
    if (index > 0) {
      const delta = candle.ts - candles[index - 1].ts
      if (delta > barMs * 1.5) gaps++
    }
  }
  const deadBarRatio = dead / candles.length
  const gapRatio = gaps / candles.length
  const continuous = deadBarRatio <= 0.05 && gapRatio <= 0.01
  return {
    continuous,
    deadBarRatio,
    gapRatio,
    reason: continuous ? 'continuous' : deadBarRatio > 0.05 ? `dead_bars_${(deadBarRatio * 100).toFixed(1)}%` : `time_gaps_${(gapRatio * 100).toFixed(1)}%`,
  }
}

/**
 * Volatility buckets, so the system can prove it is good across market profiles
 * instead of being good at one of them. `changePct24h` is a crude but honest
 * proxy that is available for every instrument without extra calls.
 */
export function volatilityBucket(changePct24h: number | null | undefined): 'quiet' | 'normal' | 'active' | 'wild' {
  const move = Math.abs(changePct24h ?? 0)
  if (move < 1.5) return 'quiet'
  if (move < 4) return 'normal'
  if (move < 10) return 'active'
  return 'wild'
}

/**
 * Spread the picks across volatility buckets and instrument types so a harvest or
 * a scan is never dominated by whatever happens to be pumping today.
 */
export function stratify<T extends UniverseCandidate>(candidates: readonly T[], perBucket: number): T[] {
  const buckets = new Map<string, T[]>()
  for (const candidate of candidates) {
    const key = `${candidate.instType}|${volatilityBucket(candidate.changePct24h)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(candidate)
    else buckets.set(key, [candidate])
  }
  const out: T[] = []
  for (const [, bucket] of buckets) out.push(...bucket.slice(0, perBucket))
  return out
}
