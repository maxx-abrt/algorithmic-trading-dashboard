/**
 * Typed OKX v5 market data layer.
 *
 * Everything the brain consumes comes from here: the full tradable universe
 * (spot, perpetual swaps, dated futures and the tokenized equity swaps such as
 * NVDA-USDT-SWAP), candles, live tickers, and the derivatives context
 * (funding, open interest, order-book imbalance, taker flow, basis).
 *
 * No mock data, ever. Every field is parsed from the exchange response and
 * anything missing becomes an explicit `null`.
 */
import { numOrNull, num, okxOne, okxRequest, restStats } from './rest.js'
import type { Candle, DerivativesBlock, InstrumentSpec } from '../quant/types.js'
import { normalizeBar } from '../quant/timeframes.js'
import { clamp } from '../quant/math.js'

export type InstType = 'SPOT' | 'SWAP' | 'FUTURES'

export interface Ticker {
  instId: string
  instType: InstType
  last: number
  bid: number
  ask: number
  open24h: number
  high24h: number
  low24h: number
  vol24h: number
  volUsd24h: number
  changePct24h: number
  spreadBps: number
  ts: number
}

/* -------------------------------------------------------------------------- */
/*  Instruments                                                               */
/* -------------------------------------------------------------------------- */

const EQUITY_HINT = new Set([
  'AAPL', 'ABNB', 'AMD', 'AMZN', 'AVGO', 'BABA', 'BRKB', 'COIN', 'CRCL', 'CRWD', 'DIS', 'GLD',
  'GOOG', 'GOOGL', 'HOOD', 'INTC', 'IWM', 'JPM', 'KO', 'LLY', 'MARA', 'MCD', 'META', 'MSFT',
  'MSTR', 'MU', 'NFLX', 'NKE', 'NVDA', 'ORCL', 'PLTR', 'PYPL', 'QQQ', 'SBUX', 'SHOP', 'SLV',
  'SMCI', 'SPY', 'TQQQ', 'TSLA', 'TSM', 'UBER', 'V', 'VOO', 'WMT', 'XOM',
])

export function isEquityInstrument(instId: string) {
  const base = instId.split('-')[0]?.toUpperCase() ?? ''
  return EQUITY_HINT.has(base)
}

interface RawInstrument {
  instId: string
  instType: string
  baseCcy?: string
  quoteCcy?: string
  settleCcy?: string
  ctVal?: string
  ctValCcy?: string
  lotSz?: string
  minSz?: string
  tickSz?: string
  lever?: string
  state?: string
  expTime?: string
  ctType?: string
}

function toSpec(r: RawInstrument): InstrumentSpec {
  const instType = (r.instType as InstrumentSpec['instType']) ?? 'SWAP'
  const parts = r.instId.split('-')
  return {
    instId: r.instId,
    instType,
    ctVal: num(r.ctVal, 1),
    ctValCcy: r.ctValCcy || r.baseCcy || parts[0] || '',
    lotSz: num(r.lotSz, 0.01),
    minSz: num(r.minSz, 0.01),
    tickSz: num(r.tickSz, 0.0001),
    maxLever: num(r.lever, instType === 'SPOT' ? 1 : 10),
    baseCcy: r.baseCcy || parts[0] || '',
    quoteCcy: r.quoteCcy || r.settleCcy || parts[1] || '',
    isEquity: isEquityInstrument(r.instId),
  }
}

export async function fetchInstruments(instType: InstType): Promise<InstrumentSpec[]> {
  const rows = await okxRequest<RawInstrument>('/api/v5/public/instruments', {
    params: { instType },
  })
  return rows.filter((r) => (r.state ?? 'live') === 'live').map(toSpec)
}

/* -------------------------------------------------------------------------- */
/*  Tickers                                                                    */
/* -------------------------------------------------------------------------- */

interface RawTicker {
  instId: string
  instType: string
  last: string
  askPx: string
  bidPx: string
  open24h: string
  high24h: string
  low24h: string
  vol24h: string
  volCcy24h: string
  ts: string
}

function toTicker(r: RawTicker): Ticker {
  const last = num(r.last)
  const open = num(r.open24h)
  const bid = num(r.bidPx)
  const ask = num(r.askPx)
  const instType = (r.instType as InstType) ?? 'SWAP'
  // SPOT: volCcy24h is already quote volume. Derivatives: it is base volume.
  const volCcy = num(r.volCcy24h)
  const volUsd = instType === 'SPOT' ? volCcy : volCcy * last
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last
  return {
    instId: r.instId,
    instType,
    last,
    bid,
    ask,
    open24h: open,
    high24h: num(r.high24h),
    low24h: num(r.low24h),
    vol24h: num(r.vol24h),
    volUsd24h: volUsd,
    changePct24h: open > 0 ? ((last - open) / open) * 100 : 0,
    spreadBps: mid > 0 && ask > 0 && bid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
    ts: num(r.ts, Date.now()),
  }
}

export async function fetchTickers(instType: InstType): Promise<Ticker[]> {
  const rows = await okxRequest<RawTicker>('/api/v5/market/tickers', { params: { instType } })
  return rows.map(toTicker).filter((t) => t.last > 0)
}

export async function fetchTicker(instId: string): Promise<Ticker | null> {
  const row = await okxOne<RawTicker>('/api/v5/market/ticker', { params: { instId } })
  return row ? toTicker(row) : null
}

/* -------------------------------------------------------------------------- */
/*  Candles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * OKX candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
 *  • SPOT       vol = base,      volCcy = quote
 *  • SWAP/FUT   vol = contracts, volCcy = base, volCcyQuote = quote
 */
function parseCandle(row: string[], isDerivative: boolean): Candle {
  const volume = isDerivative ? num(row[6]) : num(row[5])
  const quoteVolume = isDerivative ? num(row[7]) : num(row[6])
  return {
    ts: num(row[0]),
    open: num(row[1]),
    high: num(row[2]),
    low: num(row[3]),
    close: num(row[4]),
    volume: volume > 0 ? volume : num(row[5]),
    quoteVolume,
    confirmed: row[8] === '1',
  }
}

/**
 * Fetch up to `limit` candles (OKX caps a page at 300 — we paginate backwards
 * with `after` and stitch, so 600+ bars of memory is available for the brain).
 */
export async function fetchCandles(
  instId: string,
  bar: string,
  limit = 300,
  opts: { history?: boolean } = {},
): Promise<Candle[]> {
  const b = normalizeBar(bar)
  const isDerivative = !instId.endsWith('-USDT') && !instId.endsWith('-USDC') && instId.split('-').length > 2
  const path = opts.history ? '/api/v5/market/history-candles' : '/api/v5/market/candles'
  const out: Candle[] = []
  let after: string | undefined

  while (out.length < limit) {
    const page = Math.min(300, limit - out.length)
    const rows = await okxRequest<string[]>(path, {
      params: { instId, bar: b, limit: page, after },
    })
    if (!rows.length) break
    const parsed = rows.map((r) => parseCandle(r, isDerivative))
    out.push(...parsed)
    const oldest = parsed[parsed.length - 1]
    if (!oldest) break
    after = String(oldest.ts)
    if (rows.length < page) break
  }

  // OKX returns newest-first; the engine works oldest-first.
  const dedup = new Map<number, Candle>()
  for (const c of out) if (c.ts > 0 && Number.isFinite(c.close)) dedup.set(c.ts, c)
  return [...dedup.values()].sort((a, b2) => a.ts - b2.ts)
}

/* -------------------------------------------------------------------------- */
/*  Derivatives context                                                        */
/* -------------------------------------------------------------------------- */

interface RawBook {
  asks: string[][]
  bids: string[][]
}

async function bookImbalance(instId: string, depth = 25) {
  const book = await okxOne<RawBook>('/api/v5/market/books', {
    params: { instId, sz: depth },
    tolerate: ['51001'],
  })
  if (!book?.asks?.length || !book?.bids?.length) return { imbalance: null, spreadBps: null }
  let bidVol = 0
  let askVol = 0
  const bestBid = num(book.bids[0][0])
  const bestAsk = num(book.asks[0][0])
  const mid = (bestBid + bestAsk) / 2
  // Depth-weighted: levels near the touch matter far more than the tail.
  for (const [px, sz] of book.bids) {
    const p = num(px)
    const w = mid > 0 ? Math.max(0, 1 - Math.abs(mid - p) / (mid * 0.01)) : 1
    bidVol += num(sz) * w
  }
  for (const [px, sz] of book.asks) {
    const p = num(px)
    const w = mid > 0 ? Math.max(0, 1 - Math.abs(mid - p) / (mid * 0.01)) : 1
    askVol += num(sz) * w
  }
  const total = bidVol + askVol
  return {
    imbalance: total > 0 ? (bidVol - askVol) / total : null,
    spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : null,
  }
}

/** Positioning score: contrarian on crowded funding / retail long-short skew. */
function positioningScore(d: Omit<DerivativesBlock, 'score'>) {
  const parts: { s: number; w: number }[] = []
  if (d.fundingApr != null) {
    // Very positive funding => crowded longs => bearish pressure.
    parts.push({ s: clamp(-d.fundingApr / 60, -1, 1) * 100, w: 1.2 })
  }
  if (d.longShortRatio != null) {
    parts.push({ s: clamp(-(d.longShortRatio - 1) / 0.6, -1, 1) * 100, w: 0.9 })
  }
  if (d.takerRatio != null) {
    // Aggressive taker flow is short-term momentum, not contrarian.
    parts.push({ s: clamp((d.takerRatio - 1) / 0.35, -1, 1) * 100, w: 1 })
  }
  if (d.bookImbalance != null) parts.push({ s: clamp(d.bookImbalance / 0.35, -1, 1) * 100, w: 0.8 })
  if (d.openInterestChangePct != null && d.priceChangePct != null) {
    // OI up + price up = new longs (bullish). OI up + price down = new shorts.
    const conviction = clamp(d.openInterestChangePct / 3, -1, 1)
    parts.push({ s: conviction * Math.sign(d.priceChangePct) * 60, w: 0.9 })
  }
  if (d.basisBps != null) parts.push({ s: clamp(-d.basisBps / 40, -1, 1) * 60, w: 0.5 })
  const den = parts.reduce((s, p) => s + p.w, 0)
  return den > 0 ? clamp(parts.reduce((s, p) => s + p.s * p.w, 0) / den, -100, 100) : 0
}

export async function fetchDerivatives(
  instId: string,
  instType: InstType,
  priceChangePct: number | null = null,
): Promise<DerivativesBlock> {
  const base: Omit<DerivativesBlock, 'score'> = {
    fundingRate: null,
    nextFundingRate: null,
    fundingApr: null,
    nextFundingTime: null,
    openInterest: null,
    openInterestUsd: null,
    openInterestChangePct: null,
    takerRatio: null,
    longShortRatio: null,
    bookImbalance: null,
    spreadBps: null,
    markPrice: null,
    indexPrice: null,
    basisBps: null,
    priceChangePct,
    maxLeverage: null,
  }

  const ccy = instId.split('-')[0]
  const isDeriv = instType !== 'SPOT'

  const [book, funding, oiNow, oiHist, mark, index, taker, lsr] = await Promise.allSettled([
    bookImbalance(instId),
    isDeriv
      ? okxOne<{ fundingRate: string; nextFundingRate: string; fundingTime: string; nextFundingTime: string }>(
          '/api/v5/public/funding-rate',
          { params: { instId }, tolerate: ['51001', '51000'] },
        )
      : Promise.resolve(null),
    isDeriv
      ? okxOne<{ oi: string; oiCcy: string; oiUsd: string }>('/api/v5/public/open-interest', {
          params: { instType, instId },
          tolerate: ['51001'],
        })
      : Promise.resolve(null),
    isDeriv
      ? okxRequest<string[]>('/api/v5/rubik/stat/contracts/open-interest-volume', {
          params: { ccy, period: '1H' },
          tolerate: ['51001', '50011'],
          retries: 1,
        })
      : Promise.resolve([]),
    isDeriv
      ? okxOne<{ markPx: string }>('/api/v5/public/mark-price', {
          params: { instType, instId },
          tolerate: ['51001'],
        })
      : Promise.resolve(null),
    okxOne<{ idxPx: string }>('/api/v5/market/index-tickers', {
      params: { instId: `${instId.split('-')[0]}-${instId.split('-')[1]}` },
      tolerate: ['51001', '51000'],
    }),
    okxRequest<string[]>('/api/v5/rubik/stat/taker-volume', {
      params: { ccy, instType: isDeriv ? 'CONTRACTS' : 'SPOT', period: '1H' },
      tolerate: ['51001', '50011'],
      retries: 1,
    }),
    okxRequest<string[]>('/api/v5/rubik/stat/contracts/long-short-account-ratio', {
      params: { ccy, period: '1H' },
      tolerate: ['51001', '50011'],
      retries: 1,
    }),
  ])

  if (book.status === 'fulfilled') {
    base.bookImbalance = book.value.imbalance
    base.spreadBps = book.value.spreadBps
  }
  if (funding.status === 'fulfilled' && funding.value) {
    base.fundingRate = numOrNull(funding.value.fundingRate)
    base.nextFundingRate = numOrNull(funding.value.nextFundingRate)
    base.nextFundingTime = numOrNull(funding.value.nextFundingTime)
    if (base.fundingRate != null) base.fundingApr = base.fundingRate * 3 * 365 * 100
  }
  if (oiNow.status === 'fulfilled' && oiNow.value) {
    base.openInterest = numOrNull(oiNow.value.oiCcy) ?? numOrNull(oiNow.value.oi)
    base.openInterestUsd = numOrNull(oiNow.value.oiUsd)
  }
  if (oiHist.status === 'fulfilled' && oiHist.value.length >= 2) {
    // rows: [ts, oi, vol] newest first
    const rows = oiHist.value
    const newest = num(rows[0]?.[1])
    const older = num(rows[Math.min(4, rows.length - 1)]?.[1])
    if (newest > 0 && older > 0) base.openInterestChangePct = ((newest - older) / older) * 100
  }
  if (mark.status === 'fulfilled' && mark.value) base.markPrice = numOrNull(mark.value.markPx)
  if (index.status === 'fulfilled' && index.value) base.indexPrice = numOrNull(index.value.idxPx)
  if (base.markPrice && base.indexPrice && base.indexPrice > 0) {
    base.basisBps = ((base.markPrice - base.indexPrice) / base.indexPrice) * 10_000
  }
  if (taker.status === 'fulfilled' && taker.value.length) {
    // rows: [ts, sellVol, buyVol]
    const r = taker.value[0]
    const sell = num(r?.[1])
    const buy = num(r?.[2])
    if (sell > 0) base.takerRatio = buy / sell
  }
  if (lsr.status === 'fulfilled' && lsr.value.length) {
    base.longShortRatio = numOrNull(lsr.value[0]?.[1])
  }

  return { ...base, score: positioningScore(base) }
}

/* -------------------------------------------------------------------------- */
/*  Account (read-only, optional)                                              */
/* -------------------------------------------------------------------------- */

export interface AccountSnapshot {
  totalEquityUsd: number
  availableUsdt: number
  currencies: { ccy: string; eq: number; availBal: number }[]
  fetchedAt: number
}

/**
 * Read-only balance snapshot. The engine NEVER places, amends or cancels orders:
 * there is deliberately no trade endpoint anywhere in this codebase.
 */
export async function fetchAccount(): Promise<AccountSnapshot | null> {
  const row = await okxOne<{
    totalEq: string
    details: { ccy: string; eq: string; availBal: string; eqUsd: string }[]
  }>('/api/v5/account/balance', { signed: true })
  if (!row) return null
  const details = (row.details ?? []).map((d) => ({
    ccy: d.ccy,
    eq: num(d.eqUsd, num(d.eq)),
    availBal: num(d.availBal),
  }))
  return {
    totalEquityUsd: num(row.totalEq),
    availableUsdt: details.find((d) => d.ccy === 'USDT')?.availBal ?? 0,
    currencies: details.filter((d) => d.eq > 0.5).sort((a, b) => b.eq - a.eq),
    fetchedAt: Date.now(),
  }
}

export { restStats }
