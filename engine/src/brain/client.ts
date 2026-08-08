/**
 * Brain client — the engine's link to the Python learning sidecar.
 *
 * Rules this file enforces, because a learning service must never be able to hurt
 * the live decision loop:
 *
 *   • every call has a timeout
 *   • a circuit breaker opens after repeated failures and closes again on its own
 *   • predictions are batched (one HTTP round trip for hundreds of vectors) and
 *     memoised by (modelId, feature hash) for a short window
 *   • an unavailable brain is reported as "no opinion", never thrown as an error
 */
import { createHash } from 'node:crypto'
import { log } from '../log.js'

const BRAIN_URL = (process.env.BRAIN_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')

export interface BrainHealth {
  ok: boolean
  version?: string
  dbReadable?: boolean
  tapeRows?: number
  artifacts?: { count: number; kinds: Record<string, number>; directory: string }
  jobsRunning?: number
  jobsQueued?: number
  capabilities?: { lightgbm: boolean; torch: boolean }
  resources?: { rssMb: number; hostFreeMb: number; load1: number; cpuCount: number; threads: number }
  governor?: { maxRssMb: number; maxLoad: number; lastWaitSeconds: number; lastReason: string }
  reachable: boolean
  error?: string
  latencyMs?: number
}

export interface BrainJob {
  id: string
  kind: string
  niche?: { playbook: string; instType: string; timeframe: string } | null
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  progress: number
  message: string
  result: Record<string, unknown> | null
  error: string | null
}

export interface BrainModel {
  modelId: string
  kind: string
  nicheKey?: string
  playbook?: string
  instType?: string
  timeframe?: string
  featureSchema?: string
  featureCount?: number
  rows?: number
  champion?: string
  threshold?: number
  usable?: boolean
  score?: number
  metrics?: Record<string, Record<string, number>>
  importance?: { index: number; weight: number }[]
  curve?: { epoch: number; trainMeanR: number; evalMeanR: number }[]
  agentMeanR?: number
  baselineMeanR?: number
  randomMeanR?: number
  meanRLift?: number
  episodes?: number
  savedAt?: number
  trainSeconds?: number
}

export class BrainClient {
  private failures = 0
  private openUntil = 0
  private cache = new Map<string, { at: number; probabilities: number[] }>()
  lastHealth: BrainHealth = { ok: false, reachable: false, error: 'not_checked_yet' }
  lastHealthAt = 0

  get url() {
    return BRAIN_URL
  }

  get available() {
    return this.lastHealth.reachable && Date.now() >= this.openUntil
  }

  private breakerOpen() {
    return Date.now() < this.openUntil
  }

  private noteFailure(context: string, error: unknown) {
    this.failures++
    if (this.failures >= 3) {
      this.openUntil = Date.now() + 60_000
      this.failures = 0
      log.error('brain', `circuit breaker open for 60s after repeated failures (${context}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async call<T>(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<T | null> {
    if (this.breakerOpen()) return null
    try {
      const response = await fetch(`${BRAIN_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      this.failures = 0
      return (await response.json()) as T
    } catch (error) {
      this.noteFailure(path, error)
      return null
    }
  }

  private post<T>(path: string, body: unknown, timeoutMs = 20_000) {
    return this.call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs)
  }

  async health(force = false): Promise<BrainHealth> {
    if (!force && Date.now() - this.lastHealthAt < 10_000) return this.lastHealth
    const started = Date.now()
    const response = await this.call<Record<string, unknown>>('/health', undefined, 8_000)
    this.lastHealthAt = Date.now()
    this.lastHealth = response
      ? ({ ...(response as unknown as BrainHealth), reachable: true, latencyMs: Date.now() - started } as BrainHealth)
      : { ok: false, reachable: false, error: this.breakerOpen() ? 'circuit_breaker_open' : 'unreachable', latencyMs: Date.now() - started }
    return this.lastHealth
  }

  async trainTabular(niche: { playbook: string; instType: string; timeframe: string }, options: { limit?: number; folds?: number; holdoutSymbols?: string[]; models?: string[] } = {}) {
    return this.post<{ jobId: string; status: string }>('/train/tabular', {
      niche,
      limit: options.limit ?? 20_000,
      folds: options.folds ?? 4,
      holdoutSymbols: options.holdoutSymbols ?? [],
      models: options.models ?? ['logistic', 'lightgbm', 'mlp'],
      featureSchema: 'v3',
    })
  }

  async trainRl(niche: { playbook: string; instType: string; timeframe: string }, options: { limit?: number; epochs?: number } = {}) {
    return this.post<{ jobId: string; status: string }>('/train/rl', {
      niche,
      limit: options.limit ?? 8_000,
      epochs: options.epochs ?? 14,
      featureSchema: 'v3',
    })
  }

  job(jobId: string) {
    return this.call<BrainJob>(`/jobs/${jobId}`, undefined, 8_000)
  }

  jobs(limit = 40) {
    return this.call<{ jobs: BrainJob[]; running: number; queued: number }>(`/jobs?limit=${limit}`, undefined, 8_000)
  }

  cancel(jobId: string) {
    return this.post<BrainJob>(`/jobs/${jobId}/cancel`, {}, 8_000)
  }

  models(limit = 200) {
    return this.call<{ models: BrainModel[] }>(`/models?limit=${limit}`, undefined, 10_000)
  }

  model(modelId: string) {
    return this.call<BrainModel>(`/models/${modelId}`, undefined, 8_000)
  }

  best(nicheKey: string, kind = 'tabular') {
    return this.call<BrainModel>(`/best?nicheKey=${encodeURIComponent(nicheKey)}&kind=${kind}`, undefined, 8_000)
  }

  coverage() {
    return this.call<{ niches: { nicheKey: string; rows: number; sumR: number; symbols: number }[] }>('/coverage', undefined, 10_000)
  }

  /** Batched, memoised probability lookup. Returns null when the brain has no opinion. */
  async predict(modelId: string, features: readonly number[][]): Promise<number[] | null> {
    if (!features.length) return []
    const key = `${modelId}:${createHash('sha1').update(JSON.stringify(features)).digest('hex')}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < 20_000) return cached.probabilities
    const chunkSize = 512
    const out: number[] = []
    for (let index = 0; index < features.length; index += chunkSize) {
      const chunk = features.slice(index, index + chunkSize)
      const response = await this.post<{ probabilities?: number[]; error?: string }>('/predict', { modelId, features: chunk }, 25_000)
      if (!response?.probabilities) return null
      out.push(...response.probabilities)
    }
    if (this.cache.size > 400) this.cache.clear()
    this.cache.set(key, { at: Date.now(), probabilities: out })
    return out
  }

  /** Ask the RL exit agent what to do with open positions. */
  async act(modelId: string, states: readonly number[][]) {
    if (!states.length) return null
    return this.post<{ actions: number[]; labels: string[]; probabilities: number[][]; values: number[] }>('/act', { modelId, states }, 15_000)
  }
}
