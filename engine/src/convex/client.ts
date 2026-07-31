/**
 * Convex bridge.
 *
 * The engine is the single writer: every mutation carries WORKER_API_KEY.
 * Convex holds configuration and history (settings, watchlist, alert rules and
 * events, signal journal, logs, telemetry, telegram chats) while live market
 * state stays in RAM and is served over HTTP — that keeps the database call
 * volume at a few thousand writes a day instead of hundreds of thousands.
 *
 * Every call is defensive: a Convex outage degrades the product, it never
 * crashes the engine.
 */
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { ENV, HAS_CONVEX } from '../env.js'
import { log } from '../log.js'
import type { LogEntry } from '../log.js'

export interface ConvexHealth {
  configured: boolean
  status: 'online' | 'degraded' | 'offline'
  lastError: string
  lastOkAt: number
  writes: number
  reads: number
}

class ConvexBridge {
  private client: ConvexHttpClient | null = null
  health: ConvexHealth = {
    configured: HAS_CONVEX,
    status: HAS_CONVEX ? 'degraded' : 'offline',
    lastError: HAS_CONVEX ? '' : 'CONVEX_URL / WORKER_API_KEY missing',
    lastOkAt: 0,
    writes: 0,
    reads: 0,
  }

  constructor() {
    if (HAS_CONVEX) this.client = new ConvexHttpClient(ENV.convexUrl)
  }

  get configured() {
    return this.client !== null
  }

  private ok() {
    this.health.status = 'online'
    this.health.lastOkAt = Date.now()
  }

  private fail(scope: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    this.health.status = 'degraded'
    this.health.lastError = `${scope}: ${message}`.slice(0, 240)
    return null
  }

  private async query<T>(fn: unknown, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.client) return null
    try {
      const res = (await this.client.query(fn as never, args as never)) as T
      this.health.reads++
      this.ok()
      return res
    } catch (err) {
      return this.fail('query', err) as null
    }
  }

  private async mutate<T>(fn: unknown, args: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.client) return null
    try {
      const res = (await this.client.mutation(fn as never, {
        key: ENV.workerKey,
        ...args,
      } as never)) as T
      this.health.writes++
      this.ok()
      return res
    } catch (err) {
      return this.fail('mutation', err) as null
    }
  }

  /* ---- settings ------------------------------------------------------- */
  getSettings = () => this.query<Record<string, unknown>>(anyApi.settings.get)
  updateSettings = (patch: Record<string, unknown>) => this.mutate<string>(anyApi.settings.update, { patch })

  /* ---- watchlist ------------------------------------------------------ */
  listWatchlist = () => this.query<WatchRow[]>(anyApi.watchlist.list)
  addWatch = (instId: string, instType: string, timeframe: string, note?: string) =>
    this.mutate<string>(anyApi.watchlist.add, { instId, instType, timeframe, note })
  patchWatch = (instId: string, patch: Partial<WatchRow>) =>
    this.mutate<string>(anyApi.watchlist.patch, { instId, ...patch })
  removeWatch = (instId: string) => this.mutate<boolean>(anyApi.watchlist.remove, { instId })

  /* ---- alerts --------------------------------------------------------- */
  listRules = () => this.query<AlertRuleRow[]>(anyApi.alerts.listRules)
  upsertRule = (rule: Record<string, unknown>) => this.mutate<string>(anyApi.alerts.upsertRule, rule)
  deleteRule = (id: string) => this.mutate<boolean>(anyApi.alerts.deleteRule, { id })
  markRuleFired = (id: string, ts: number) => this.mutate<string>(anyApi.alerts.markFired, { id, ts })
  recordAlert = (event: Record<string, unknown>) => this.mutate<string>(anyApi.alerts.record, event)
  listAlertEvents = (limit = 60) => this.query<AlertEventRow[]>(anyApi.alerts.listEvents, { limit })

  /* ---- journal -------------------------------------------------------- */
  recordSignal = (signal: Record<string, unknown>) => this.mutate<string>(anyApi.signals.record, { signal })
  gradeSignal = (id: string, patch: Record<string, unknown>) => this.mutate<string>(anyApi.signals.grade, { id, patch })
  listLiveSignals = () => this.query<SignalRow[]>(anyApi.signals.listLive)
  listSignals = (limit = 80, status = 'all') => this.query<SignalRow[]>(anyApi.signals.list, { limit, status })
  signalStats = () => this.query<Record<string, number>>(anyApi.signals.stats)

  /* ---- logs / telemetry ----------------------------------------------- */
  appendLogs = (entries: LogEntry[]) => this.mutate<number>(anyApi.logs.append, { entries })
  ping = (service: string, status: string, meta?: string, counters?: Record<string, number>) =>
    this.mutate<string>(anyApi.telemetry.ping, { service, status, meta, counters })
  listTelemetry = () => this.query<TelemetryRow[]>(anyApi.telemetry.list)

  /* ---- telegram ------------------------------------------------------- */
  listChats = () => this.query<ChatRow[]>(anyApi.telegram.list)
  registerChat = (chatId: number, firstName?: string, username?: string) =>
    this.mutate<string>(anyApi.telegram.register, { chatId, firstName, username })
  muteChat = (chatId: number, muted: boolean) => this.mutate<boolean>(anyApi.telegram.setMuted, { chatId, muted })

  async selfTest() {
    if (!this.client) return { ok: false, error: 'not configured' }
    const before = await this.getSettings()
    if (!before) return { ok: false, error: this.health.lastError || 'query failed' }
    const res = await this.ping('engine', 'online', 'self-test')
    if (!res) return { ok: false, error: this.health.lastError || 'mutation failed' }
    const rows = await this.listTelemetry()
    return { ok: Boolean(rows?.some((r) => r.service === 'engine')), error: '' }
  }
}

export interface WatchRow {
  _id: string
  instId: string
  instType: string
  timeframe: string
  enabled: boolean
  alertsEnabled: boolean
  note?: string
  addedAt: number
}

export interface AlertRuleRow {
  _id: string
  name: string
  scope: string
  type: string
  timeframe: string
  params: { threshold?: number; direction?: string; value?: number; text?: string }
  cooldownMs: number
  telegram: boolean
  enabled: boolean
  lastFiredAt: number
  firedCount: number
  createdAt: number
}

export interface AlertEventRow {
  _id: string
  ruleName: string
  type: string
  severity: string
  instId: string
  timeframe: string
  title: string
  message: string
  decision?: string
  conviction?: number
  price: number
  ts: number
}

export interface SignalRow {
  _id: string
  instId: string
  timeframe: string
  decision: string
  status: string
  entry: number
  stopLoss: number
  takeProfits: number[]
  riskDistance: number
  mfeR: number
  maeR: number
  barsHeld: number
  lastPrice: number
  timeStopBars: number
  createdAt: number
  realizedR?: number
  conviction: number
}

export interface TelemetryRow {
  service: string
  status: string
  lastPing: number
  meta?: string
}

export interface ChatRow {
  _id: string
  chatId: number
  firstName?: string
  username?: string
  muted: boolean
}

export const convex = new ConvexBridge()

// Persist meaningful log lines without blocking the hot path.
if (convex.configured) {
  log.attachSink(async (entries) => {
    await convex.appendLogs(entries)
  })
}
