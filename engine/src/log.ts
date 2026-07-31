/**
 * Structured logger with an in-memory ring buffer (served to the dashboard
 * terminal over HTTP) and a batched Convex flush so the history survives
 * restarts without hammering the database.
 */
import { ENV } from './env.js'

export type LogLevel = 'info' | 'signal' | 'ai' | 'alert' | 'error' | 'scan' | 'trade'

export interface LogEntry {
  ts: number
  level: LogLevel
  scope: string
  message: string
  instId?: string
  timeframe?: string
  meta?: string
}

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[90m',
  signal: '\x1b[36m',
  ai: '\x1b[35m',
  alert: '\x1b[33m',
  error: '\x1b[31m',
  scan: '\x1b[34m',
  trade: '\x1b[32m',
}

const RING_MAX = 600

class Logger {
  private ring: LogEntry[] = []
  private pending: LogEntry[] = []
  private sink: ((entries: LogEntry[]) => Promise<void>) | null = null
  private flushing = false

  /** Wire the Convex sink once the client is ready. */
  attachSink(sink: (entries: LogEntry[]) => Promise<void>) {
    this.sink = sink
  }

  push(level: LogLevel, scope: string, message: string, extra: Partial<LogEntry> = {}) {
    const entry: LogEntry = { ts: Date.now(), level, scope, message, ...extra }
    this.ring.push(entry)
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX)
    // Only persist meaningful events — `info` noise stays in RAM.
    if (level !== 'info' || scope === 'boot') this.pending.push(entry)
    const tag = `${COLORS[level] ?? ''}[${level}]\x1b[0m`
    console.log(`${tag} ${scope}: ${message}`)
  }

  info = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('info', scope, m, e)
  signal = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('signal', scope, m, e)
  ai = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('ai', scope, m, e)
  alert = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('alert', scope, m, e)
  scan = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('scan', scope, m, e)
  error = (scope: string, m: string, e?: Partial<LogEntry>) => this.push('error', scope, m, e)

  recent(limit = 200, level?: LogLevel) {
    const rows = level ? this.ring.filter((r) => r.level === level) : this.ring
    return rows.slice(-limit).reverse()
  }

  async flush() {
    if (this.flushing || !this.sink || !this.pending.length) return
    this.flushing = true
    const batch = this.pending.splice(0, 40)
    try {
      await this.sink(batch)
    } catch {
      // Never lose the console trail because Convex hiccuped.
    } finally {
      this.flushing = false
    }
  }
}

export const log = new Logger()

export function describeError(err: unknown) {
  if (err instanceof Error) return err.message
  return String(err)
}

export const BOOT_BANNER = `APEX-02 engine · port ${ENV.port}`
