import crypto from 'node:crypto'
import WebSocket from 'ws'
import type { Candle } from './types.js'

const REST_BASE = process.env.OKX_REST_BASE ?? 'https://www.okx.com'
const WS_PUBLIC =
  process.env.OKX_WS_PUBLIC ?? 'wss://ws.okx.com:8443/ws/v5/public'

/** OKX demo (paper) trading requires this header on every private call. */
const SIMULATED = process.env.OKX_SIMULATED === 'true'

interface OkxResponse<T> {
  code: string
  msg: string
  data: T
}

/* -------------------------------------------------------------------------- */
/*  Signing                                                                    */
/* -------------------------------------------------------------------------- */

function sign(
  timestamp: string,
  method: string,
  path: string,
  body: string,
  secret: string,
) {
  return crypto
    .createHmac('sha256', secret)
    .update(timestamp + method.toUpperCase() + path + body)
    .digest('base64')
}

function privateHeaders(method: string, path: string, body: string) {
  const key = process.env.OKX_API_KEY
  const secret = process.env.OKX_API_SECRET
  const pass = process.env.OKX_API_PASSPHRASE
  if (!key || !secret || !pass) {
    throw new Error(
      'OKX credentials missing. Set OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE in .env.local',
    )
  }
  const timestamp = new Date().toISOString()
  const headers: Record<string, string> = {
    'OK-ACCESS-KEY': key,
    'OK-ACCESS-SIGN': sign(timestamp, method, path, body, secret),
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': pass,
    'Content-Type': 'application/json',
  }
  if (SIMULATED) headers['x-simulated-trading'] = '1'
  return headers
}

/* -------------------------------------------------------------------------- */
/*  Rate limiting + micro-cache (OKX API optimisation)                         */
/* -------------------------------------------------------------------------- */

/**
 * OKX public endpoints allow ~20 req/2s per IP. We serialise requests through
 * a token bucket and de-duplicate identical in-flight GETs, plus a tiny TTL
 * cache so repeated reads inside one tick cost zero network calls.
 */
class RateLimiter {
  private queue: Array<() => void> = []
  private tokens: number
  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
  ) {
    this.tokens = capacity
    setInterval(() => {
      this.tokens = this.capacity
      while (this.tokens > 0 && this.queue.length) {
        this.tokens--
        this.queue.shift()!()
      }
    }, refillMs).unref()
  }
  acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }
}

const publicLimiter = new RateLimiter(15, 2000)
const privateLimiter = new RateLimiter(8, 2000)

const inflight = new Map<string, Promise<unknown>>()
const cache = new Map<string, { at: number; value: unknown }>()

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; auth?: boolean; cacheMs?: number } = {},
): Promise<T> {
  const { body, auth = false, cacheMs = 0 } = opts
  const bodyStr = body ? JSON.stringify(body) : ''
  const cacheKey = `${method}:${path}:${bodyStr}`

  if (cacheMs > 0) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < cacheMs) return hit.value as T
    const pending = inflight.get(cacheKey)
    if (pending) return pending as Promise<T>
  }

  const exec = (async () => {
    await (auth ? privateLimiter : publicLimiter).acquire()

    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        const res = await fetch(REST_BASE + path, {
          method,
          headers: auth
            ? privateHeaders(method, path, bodyStr)
            : { 'Content-Type': 'application/json' },
          body: bodyStr || undefined,
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (res.status === 429 || res.status >= 500) {
          throw new Error(`OKX HTTP ${res.status}`)
        }
        const json = (await res.json()) as OkxResponse<T>
        if (json.code !== '0') {
          throw new Error(`OKX ${json.code}: ${json.msg || 'unknown error'}`)
        }
        if (cacheMs > 0) cache.set(cacheKey, { at: Date.now(), value: json.data })
        return json.data
      } catch (err) {
        lastError = err
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  })()

  if (cacheMs > 0) {
    inflight.set(cacheKey, exec)
    exec.finally(() => inflight.delete(cacheKey))
  }
  return exec as Promise<T>
}

/* -------------------------------------------------------------------------- */
/*  Public market data                                                         */
/* -------------------------------------------------------------------------- */

/** OKX bar codes: 1m 3m 5m 15m 30m 1H 2H 4H then UTC variants 6Hutc 1Dutc... */
export function normalizeBar(tf: string): string {
  const t = tf.trim()
  const map: Record<string, string> = {
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D',
    '1w': '1W',
  }
  return map[t.toLowerCase()] ?? t
}

function parseCandles(rows: string[][]): Candle[] {
  // OKX returns newest first: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  return rows
    .map((r) => ({
      ts: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      confirmed: r[8] === '1',
    }))
    .sort((a, b) => a.ts - b.ts)
}

/** Fetch up to 300 historical candles (OKX caps a single page at 300). */
export async function fetchCandles(
  instId: string,
  timeframe: string,
  limit = 300,
): Promise<Candle[]> {
  const bar = normalizeBar(timeframe)
  const rows = await request<string[][]>(
    'GET',
    `/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${Math.min(limit, 300)}`,
    { cacheMs: 2_000 },
  )
  return parseCandles(rows)
}

export async function fetchTicker(instId: string) {
  const [t] = await request<Array<{ last: string; instId: string }>>(
    'GET',
    `/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
    { cacheMs: 1_000 },
  )
  return { instId: t.instId, last: Number(t.last) }
}

export interface Instrument {
  instId: string
  ctVal: number // contract value (base units per contract)
  ctValCcy: string
  lotSz: number
  minSz: number
  tickSz: number
  lever: number
}

/** Contract specs — cached 10 min, they never move intraday. */
export async function fetchInstrument(instId: string): Promise<Instrument> {
  const instType = instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT'
  const rows = await request<
    Array<{
      instId: string
      ctVal: string
      ctValCcy: string
      lotSz: string
      minSz: string
      tickSz: string
      lever: string
    }>
  >(
    'GET',
    `/api/v5/public/instruments?instType=${instType}&instId=${encodeURIComponent(instId)}`,
    { cacheMs: 600_000 },
  )
  const r = rows[0]
  if (!r) throw new Error(`Unknown OKX instrument: ${instId}`)
  return {
    instId: r.instId,
    ctVal: Number(r.ctVal || 1),
    ctValCcy: r.ctValCcy,
    lotSz: Number(r.lotSz || 1),
    minSz: Number(r.minSz || 1),
    tickSz: Number(r.tickSz || 0.1),
    lever: Number(r.lever || 10),
  }
}

/** Tradable USDT swaps, used to populate the asset selector. */
export async function fetchSwapUniverse(): Promise<string[]> {
  const rows = await request<Array<{ instId: string; state: string }>>(
    'GET',
    '/api/v5/public/instruments?instType=SWAP',
    { cacheMs: 900_000 },
  )
  return rows
    .filter((r) => r.state === 'live' && r.instId.endsWith('-USDT-SWAP'))
    .map((r) => r.instId)
    .sort()
}

/* -------------------------------------------------------------------------- */
/*  Private account + trading                                                  */
/* -------------------------------------------------------------------------- */

export async function fetchBalance(ccy = 'USDT'): Promise<number> {
  const data = await request<
    Array<{ details: Array<{ ccy: string; eq: string; availEq: string }> }>
  >('GET', `/api/v5/account/balance?ccy=${ccy}`, { auth: true, cacheMs: 5_000 })
  const detail = data[0]?.details?.find((d) => d.ccy === ccy)
  return Number(detail?.eq ?? detail?.availEq ?? 0)
}

export async function setLeverage(instId: string, lever: number, mgnMode = 'isolated') {
  return await request('POST', '/api/v5/account/set-leverage', {
    auth: true,
    body: { instId, lever: String(lever), mgnMode },
  })
}

export interface OkxPosition {
  instId: string
  posSide: string
  pos: string
  avgPx: string
  upl: string
  uplRatio: string
  lever: string
  markPx: string
}

export async function fetchPositions(instId?: string): Promise<OkxPosition[]> {
  const qs = instId ? `?instId=${encodeURIComponent(instId)}` : '?instType=SWAP'
  return await request<OkxPosition[]>('GET', `/api/v5/account/positions${qs}`, {
    auth: true,
    cacheMs: 2_000,
  })
}

export interface PlaceOrderParams {
  instId: string
  side: 'buy' | 'sell'
  /** contracts (already rounded to lotSz) */
  size: number
  tpTriggerPx: number
  slTriggerPx: number
  ordType?: 'market' | 'limit'
  price?: number
  mgnMode?: 'isolated' | 'cross'
  clOrdId?: string
}

/**
 * Market/limit order with attached TP/SL (OKX one-way position mode).
 * `attachAlgoOrds` keeps the bracket server-side so protection survives a
 * worker crash.
 */
export async function placeOrder(p: PlaceOrderParams) {
  const body = {
    instId: p.instId,
    tdMode: p.mgnMode ?? 'isolated',
    side: p.side,
    ordType: p.ordType ?? 'market',
    sz: String(p.size),
    ...(p.ordType === 'limit' && p.price ? { px: String(p.price) } : {}),
    ...(p.clOrdId ? { clOrdId: p.clOrdId } : {}),
    attachAlgoOrds: [
      {
        tpTriggerPx: String(p.tpTriggerPx),
        tpOrdPx: '-1', // -1 => market execution on trigger
        slTriggerPx: String(p.slTriggerPx),
        slOrdPx: '-1',
        tpTriggerPxType: 'last',
        slTriggerPxType: 'last',
      },
    ],
  }
  const data = await request<Array<{ ordId: string; sCode: string; sMsg: string }>>(
    'POST',
    '/api/v5/trade/order',
    { auth: true, body },
  )
  const r = data[0]
  if (r && r.sCode !== '0') throw new Error(`OKX order rejected ${r.sCode}: ${r.sMsg}`)
  return r
}

export async function closePositionMarket(instId: string, mgnMode = 'isolated') {
  return await request('POST', '/api/v5/trade/close-position', {
    auth: true,
    body: { instId, mgnMode, autoCxl: true },
  })
}

/* -------------------------------------------------------------------------- */
/*  WebSocket (public) with heartbeat + auto reconnect                         */
/* -------------------------------------------------------------------------- */

type WsHandlers = {
  onCandle?: (instId: string, bar: string, candle: Candle) => void
  onTicker?: (instId: string, last: number) => void
  onStatus?: (status: 'online' | 'degraded' | 'offline', meta?: string) => void
}

export class OkxPublicStream {
  private ws: WebSocket | null = null
  private subs = new Set<string>() // JSON-stringified channel args
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private closedByUser = false
  private lastMessageAt = 0

  constructor(private readonly handlers: WsHandlers = {}) {}

  connect() {
    this.closedByUser = false
    this.ws = new WebSocket(WS_PUBLIC)

    this.ws.on('open', () => {
      this.reconnectAttempt = 0
      this.lastMessageAt = Date.now()
      this.handlers.onStatus?.('online', 'ws connected')
      if (this.subs.size) {
        this.send({ op: 'subscribe', args: [...this.subs].map((s) => JSON.parse(s)) })
      }
      this.startPing()
    })

    this.ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      const text = raw.toString()
      if (text === 'pong') return
      let msg: any
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.event === 'error') {
        this.handlers.onStatus?.('degraded', `ws error ${msg.code}: ${msg.msg}`)
        return
      }
      if (!msg.arg || !msg.data) return

      const channel: string = msg.arg.channel
      const instId: string = msg.arg.instId

      if (channel.startsWith('candle')) {
        const bar = channel.replace('candle', '')
        for (const row of msg.data as string[][]) {
          this.handlers.onCandle?.(instId, bar, {
            ts: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            confirmed: row[8] === '1',
          })
        }
      } else if (channel === 'tickers') {
        const last = Number((msg.data as Array<{ last: string }>)[0]?.last)
        if (Number.isFinite(last)) this.handlers.onTicker?.(instId, last)
      }
    })

    this.ws.on('close', () => this.scheduleReconnect('closed'))
    this.ws.on('error', (err) => this.scheduleReconnect(err.message))
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    // OKX drops idle sockets after 30s.
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping')
        if (Date.now() - this.lastMessageAt > 45_000) {
          this.handlers.onStatus?.('degraded', 'stale socket, forcing reconnect')
          this.ws.terminate()
        }
      }
    }, 15_000)
    this.pingTimer.unref()
  }

  private scheduleReconnect(reason: string) {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.closedByUser) return
    this.handlers.onStatus?.('offline', `reconnecting: ${reason}`)
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, 30_000)
    setTimeout(() => this.connect(), delay).unref()
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  subscribeCandles(instId: string, timeframe: string) {
    const arg = { channel: `candle${normalizeBar(timeframe)}`, instId }
    this.subs.add(JSON.stringify(arg))
    this.send({ op: 'subscribe', args: [arg] })
  }

  subscribeTicker(instId: string) {
    const arg = { channel: 'tickers', instId }
    this.subs.add(JSON.stringify(arg))
    this.send({ op: 'subscribe', args: [arg] })
  }

  /** Drop every subscription (used when the active instrument changes). */
  unsubscribeAll() {
    if (this.subs.size) {
      this.send({ op: 'unsubscribe', args: [...this.subs].map((s) => JSON.parse(s)) })
    }
    this.subs.clear()
  }

  close() {
    this.closedByUser = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
  }
}

/** Round a contract size down to the instrument lot size. */
export function roundToLot(size: number, lotSz: number) {
  if (!Number.isFinite(lotSz) || lotSz <= 0) return Math.floor(size)
  const decimals = (String(lotSz).split('.')[1] ?? '').length
  return Number((Math.floor(size / lotSz) * lotSz).toFixed(decimals))
}

/** Round a price to the instrument tick size. */
export function roundToTick(price: number, tickSz: number) {
  if (!Number.isFinite(tickSz) || tickSz <= 0) return price
  const decimals = (String(tickSz).split('.')[1] ?? '').length
  return Number((Math.round(price / tickSz) * tickSz).toFixed(decimals))
}
