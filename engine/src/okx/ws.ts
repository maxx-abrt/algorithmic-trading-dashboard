/**
 * OKX v5 public WebSocket transport.
 *
 * Two sockets, because OKX splits the channels:
 *   • /ws/v5/public    → tickers, open-interest, funding-rate, mark-price
 *   • /ws/v5/business  → candle{bar} channels
 *
 * Features: exponential-backoff reconnect with jitter, keep-alive ping every
 * 20s (OKX closes idle sockets at 30s), automatic re-subscription of every
 * channel after a reconnect, and per-socket health reporting.
 */
import WebSocket from 'ws'
import type { Candle } from '../quant/types.js'
import { normalizeBar } from '../quant/timeframes.js'

export type StreamKind = 'public' | 'business'

export interface StreamHandlers {
  onCandle?: (instId: string, bar: string, candle: Candle) => void
  onTicker?: (instId: string, last: number, ts: number) => void
  onStatus?: (kind: StreamKind, status: 'online' | 'degraded' | 'offline', meta: string) => void
}

interface Sub {
  channel: string
  instId: string
}

const URLS: Record<StreamKind, string> = {
  public: 'wss://ws.okx.com:8443/ws/v5/public',
  business: 'wss://ws.okx.com:8443/ws/v5/business',
}

class Socket {
  private ws: WebSocket | null = null
  private subs = new Map<string, Sub>()
  private ping: NodeJS.Timeout | null = null
  private retry = 0
  private closed = false
  private lastMessageAt = 0
  messages = 0

  constructor(
    private readonly kind: StreamKind,
    private readonly handlers: StreamHandlers,
  ) {}

  get healthy() {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMessageAt < 60_000
  }

  connect() {
    this.closed = false
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const ws = new WebSocket(URLS[this.kind], { handshakeTimeout: 12_000 })
    this.ws = ws

    ws.on('open', () => {
      this.retry = 0
      this.lastMessageAt = Date.now()
      this.handlers.onStatus?.(this.kind, 'online', `${this.subs.size} channels`)
      if (this.subs.size) this.send({ op: 'subscribe', args: [...this.subs.values()] })
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send('ping')
          } catch {
            /* socket died between checks */
          }
        }
      }, 20_000)
    })

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now()
      this.messages++
      const text = raw.toString()
      if (text === 'pong') return
      let msg: {
        event?: string
        arg?: { channel?: string; instId?: string }
        data?: unknown[]
        code?: string
        msg?: string
      }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.event === 'error') {
        this.handlers.onStatus?.(this.kind, 'degraded', `${msg.code}: ${msg.msg}`)
        return
      }
      if (msg.event || !msg.arg || !Array.isArray(msg.data)) return

      const channel = msg.arg.channel ?? ''
      const instId = msg.arg.instId ?? ''
      if (channel.startsWith('candle')) {
        const bar = normalizeBar(channel.replace('candle', ''))
        for (const row of msg.data as string[][]) {
          this.handlers.onCandle?.(instId, bar, {
            ts: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[6]) || Number(row[5]),
            quoteVolume: Number(row[7]) || undefined,
            confirmed: row[8] === '1',
          })
        }
      } else if (channel === 'tickers') {
        for (const row of msg.data as { last: string; ts: string }[]) {
          this.handlers.onTicker?.(instId, Number(row.last), Number(row.ts))
        }
      }
    })

    ws.on('close', () => this.scheduleReconnect('closed'))
    ws.on('error', (err: Error) => this.scheduleReconnect(err.message))
  }

  private scheduleReconnect(reason: string) {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
    this.ws = null
    if (this.closed) return
    this.retry = Math.min(this.retry + 1, 8)
    const delay = Math.min(30_000, 800 * 2 ** (this.retry - 1)) + Math.random() * 400
    this.handlers.onStatus?.(this.kind, 'degraded', `reconnecting in ${Math.round(delay)}ms (${reason})`)
    setTimeout(() => this.connect(), delay)
  }

  private send(payload: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch {
      /* will be resubscribed on reconnect */
    }
  }

  subscribe(args: Sub[]) {
    const fresh: Sub[] = []
    for (const a of args) {
      const key = `${a.channel}|${a.instId}`
      if (this.subs.has(key)) continue
      this.subs.set(key, a)
      fresh.push(a)
    }
    if (fresh.length) this.send({ op: 'subscribe', args: fresh })
  }

  unsubscribe(args: Sub[]) {
    const gone: Sub[] = []
    for (const a of args) {
      const key = `${a.channel}|${a.instId}`
      if (!this.subs.has(key)) continue
      this.subs.delete(key)
      gone.push(a)
    }
    if (gone.length) this.send({ op: 'unsubscribe', args: gone })
  }

  get subscriptions() {
    return [...this.subs.values()]
  }

  close() {
    this.closed = true
    if (this.ping) clearInterval(this.ping)
    try {
      this.ws?.close()
    } catch {
      /* noop */
    }
    this.ws = null
  }
}

export class OkxStream {
  private pub: Socket
  private biz: Socket

  constructor(handlers: StreamHandlers) {
    this.pub = new Socket('public', handlers)
    this.biz = new Socket('business', handlers)
  }

  connect() {
    this.pub.connect()
    this.biz.connect()
  }

  watchTickers(instIds: string[]) {
    this.pub.subscribe(instIds.map((instId) => ({ channel: 'tickers', instId })))
  }

  unwatchTickers(instIds: string[]) {
    this.pub.unsubscribe(instIds.map((instId) => ({ channel: 'tickers', instId })))
  }

  watchCandles(instId: string, bars: string[]) {
    this.biz.subscribe(bars.map((b) => ({ channel: `candle${normalizeBar(b)}`, instId })))
  }

  unwatchCandles(instId: string, bars: string[]) {
    this.biz.unsubscribe(bars.map((b) => ({ channel: `candle${normalizeBar(b)}`, instId })))
  }

  /** Keep only the given ticker instruments subscribed. */
  syncTickers(instIds: string[]) {
    const want = new Set(instIds)
    const have = this.pub.subscriptions.filter((s) => s.channel === 'tickers').map((s) => s.instId)
    const remove = have.filter((i) => !want.has(i))
    const add = instIds.filter((i) => !have.includes(i))
    if (remove.length) this.unwatchTickers(remove)
    if (add.length) this.watchTickers(add)
  }

  syncCandles(pairs: { instId: string; bars: string[] }[]) {
    const want = new Set<string>()
    for (const p of pairs) for (const b of p.bars) want.add(`candle${normalizeBar(b)}|${p.instId}`)
    const have = this.biz.subscriptions.map((s) => `${s.channel}|${s.instId}`)
    const remove = this.biz.subscriptions.filter((s) => !want.has(`${s.channel}|${s.instId}`))
    if (remove.length) this.biz.unsubscribe(remove)
    for (const p of pairs) {
      const missing = p.bars.filter((b) => !have.includes(`candle${normalizeBar(b)}|${p.instId}`))
      if (missing.length) this.watchCandles(p.instId, missing)
    }
  }

  health() {
    return {
      public: { healthy: this.pub.healthy, subs: this.pub.subscriptions.length, messages: this.pub.messages },
      business: { healthy: this.biz.healthy, subs: this.biz.subscriptions.length, messages: this.biz.messages },
    }
  }

  close() {
    this.pub.close()
    this.biz.close()
  }
}
