/**
 * OKX v5 REST client — shared by the Next.js server and the worker.
 *
 * Design goals
 *  - zero dependencies (Web Crypto for HMAC, so it runs on Node and Edge)
 *  - a token-bucket rate limiter per endpoint family (OKX bans aggressive keys)
 *  - transparent retries with exponential backoff + jitter on 429/5xx/network
 *  - hard-fail on OKX business errors so a bad signal can never come from
 *    silently-empty data
 */

const REST_BASE = process.env.OKX_REST_BASE?.replace(/\/$/, '') || 'https://www.okx.com'

export interface OkxCredentials {
  apiKey: string
  secretKey: string
  passphrase: string
  simulated: boolean
}

export function getCredentials(): OkxCredentials | null {
  const apiKey = process.env.OKX_API_KEY
  const secretKey = process.env.OKX_API_SECRET || process.env.OKX_SECRET_KEY
  const passphrase = process.env.OKX_API_PASSPHRASE || process.env.OKX_PASSPHRASE
  if (!apiKey || !secretKey || !passphrase) return null
  return {
    apiKey,
    secretKey,
    passphrase,
    simulated:
      process.env.OKX_SIMULATED === '1' ||
      process.env.OKX_SIMULATED === 'true' ||
      process.env.OKX_DEMO === '1',
  }
}

export function hasCredentials() {
  return getCredentials() !== null
}

export class OkxError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly path: string,
  ) {
    super(message)
    this.name = 'OkxError'
  }
}

/* -------------------------------------------------------------------------- */
/*  Signing                                                                   */
/* -------------------------------------------------------------------------- */

let keyCache: { secret: string; key: CryptoKey } | null = null

async function hmacKey(secret: string) {
  if (keyCache?.secret === secret) return keyCache.key
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  keyCache = { secret, key }
  return key
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  // btoa exists in Node 18+ and every edge runtime.
  return btoa(bin)
}

async function signRequest(
  creds: OkxCredentials,
  timestamp: string,
  method: string,
  path: string,
  body: string,
) {
  const key = await hmacKey(creds.secretKey)
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(timestamp + method.toUpperCase() + path + body),
  )
  return toBase64(mac)
}

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                             */
/* -------------------------------------------------------------------------- */

interface Bucket {
  tokens: number
  capacity: number
  refillPerSec: number
  last: number
  queue: (() => void)[]
}

const buckets = new Map<string, Bucket>()

/** OKX documents most public market endpoints at 20 req / 2s per IP. */
function bucketFor(path: string): Bucket {
  const family = path.startsWith('/api/v5/market')
    ? 'market'
    : path.startsWith('/api/v5/public')
      ? 'public'
      : path.startsWith('/api/v5/rubik')
        ? 'rubik'
        : 'account'

  let b = buckets.get(family)
  if (!b) {
    const cfg: Record<string, [number, number]> = {
      market: [18, 9],
      public: [18, 9],
      rubik: [4, 2],
      account: [8, 4],
    }
    const [capacity, refill] = cfg[family]
    b = { tokens: capacity, capacity, refillPerSec: refill, last: Date.now(), queue: [] }
    buckets.set(family, b)
  }
  return b
}

function refill(b: Bucket) {
  const now = Date.now()
  const elapsed = (now - b.last) / 1000
  if (elapsed <= 0) return
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerSec)
  b.last = now
}

async function acquire(path: string) {
  const b = bucketFor(path)
  for (;;) {
    refill(b)
    if (b.tokens >= 1) {
      b.tokens -= 1
      return
    }
    const waitMs = Math.max(25, ((1 - b.tokens) / b.refillPerSec) * 1000)
    await sleep(waitMs)
  }
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

/* -------------------------------------------------------------------------- */
/*  Core request                                                              */
/* -------------------------------------------------------------------------- */

export interface RequestOptions {
  method?: 'GET' | 'POST'
  params?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  signed?: boolean
  retries?: number
  timeoutMs?: number
  /** OKX error codes that should resolve to an empty result instead of throwing */
  tolerate?: string[]
}

interface OkxEnvelope<T> {
  code: string
  msg: string
  data: T
}

function buildPath(path: string, params?: RequestOptions['params']) {
  if (!params) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])
/** 50011 = too many requests, 50013 = system busy, 50026 = system error */
const RETRYABLE_CODES = new Set(['50011', '50013', '50026', '50004'])

/** Live REST health, surfaced on the dashboard status bar. */
export const restStats = {
  calls: 0,
  errors: 0,
  retries: 0,
  lastLatencyMs: 0,
  avgLatencyMs: 0,
  lastError: '' as string,
  lastErrorAt: 0,
}

export async function okxRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T[]> {
  const method = opts.method ?? 'GET'
  const retries = opts.retries ?? 3
  const timeoutMs = opts.timeoutMs ?? 12_000
  const fullPath = buildPath(path, opts.params)
  const bodyStr = opts.body ? JSON.stringify(opts.body) : ''

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(4_000, 300 * 2 ** (attempt - 1))
      await sleep(backoff + Math.random() * 250)
    }
    await acquire(path)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    if (opts.signed) {
      const creds = getCredentials()
      if (!creds) {
        throw new OkxError(
          'OKX API credentials are not configured (OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE).',
          'NO_CREDENTIALS',
          0,
          path,
        )
      }
      const ts = new Date().toISOString()
      headers['OK-ACCESS-KEY'] = creds.apiKey
      headers['OK-ACCESS-SIGN'] = await signRequest(creds, ts, method, fullPath, bodyStr)
      headers['OK-ACCESS-TIMESTAMP'] = ts
      headers['OK-ACCESS-PASSPHRASE'] = creds.passphrase
      if (creds.simulated) headers['x-simulated-trading'] = '1'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(REST_BASE + fullPath, {
        method,
        headers,
        body: bodyStr || undefined,
        signal: controller.signal,
        cache: 'no-store',
      })

      const text = await res.text()

      if (!res.ok) {
        if (RETRYABLE_HTTP.has(res.status) && attempt < retries) {
          lastError = new OkxError(`HTTP ${res.status}`, String(res.status), res.status, path)
          continue
        }
        throw new OkxError(
          `OKX HTTP ${res.status}: ${text.slice(0, 200)}`,
          String(res.status),
          res.status,
          path,
        )
      }

      let json: OkxEnvelope<T[]>
      try {
        json = JSON.parse(text)
      } catch {
        if (attempt < retries) {
          lastError = new OkxError('Malformed JSON', 'PARSE', res.status, path)
          continue
        }
        throw new OkxError(`OKX returned malformed JSON for ${path}`, 'PARSE', res.status, path)
      }

      if (json.code !== '0') {
        if (opts.tolerate?.includes(json.code)) return []
        if (RETRYABLE_CODES.has(json.code) && attempt < retries) {
          lastError = new OkxError(json.msg, json.code, res.status, path)
          continue
        }
        throw new OkxError(
          `OKX ${json.code} on ${path}: ${json.msg || 'unknown error'}`,
          json.code,
          res.status,
          path,
        )
      }

      return Array.isArray(json.data) ? json.data : json.data ? [json.data] : []
    } catch (err) {
      const e = err as Error
      if (e instanceof OkxError && !RETRYABLE_CODES.has(e.code) && !RETRYABLE_HTTP.has(e.httpStatus)) {
        throw e
      }
      lastError = e
      if (attempt >= retries) break
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError ?? new OkxError(`OKX request failed: ${path}`, 'UNKNOWN', 0, path)
}

/** First row helper. */
export async function okxOne<T = unknown>(path: string, opts?: RequestOptions): Promise<T | null> {
  const rows = await okxRequest<T>(path, opts)
  return rows[0] ?? null
}

export const num = (v: unknown, fallback = 0) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fallback
}

export const numOrNull = (v: unknown): number | null => {
  if (v === '' || v === null || v === undefined) return null
  const n = Number.parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}
