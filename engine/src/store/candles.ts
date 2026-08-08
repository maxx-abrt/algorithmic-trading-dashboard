/**
 * Rolling candle memory.
 *
 * Every (instrument, timeframe) pair keeps up to 600 bars in RAM: enough for
 * EMA200 + Ichimoku(52,26) warm-up, a 180-bar volume profile and the empirical
 * edge back-scan, while staying tiny. REST seeds the series, the WebSocket keeps
 * it hot, and gaps are repaired automatically from history-candles.
 */
import { fetchCandles } from '../okx/market.js'
import { barMs, normalizeBar } from '../quant/timeframes.js'
import type { Candle } from '../quant/types.js'
import type { DurableStore } from './durable.js'

const MAX_BARS = 600
const SEED_BARS = 480
/** Hard wall-clock budget for one seed before the caller is handed what exists. */
const SEED_TIMEOUT_MS = Number(process.env.CANDLE_SEED_TIMEOUT_MS || 25_000)

interface Series {
  instId: string
  bar: string
  candles: Candle[]
  seededAt: number
  updatedAt: number
  wsUpdatedAt: number
  gaps: number
  repairs: number
}

function key(instId: string, bar: string) {
  return `${instId}|${normalizeBar(bar)}`
}

export class CandleStore {
  private series = new Map<string, Series>()
  private inflight = new Map<string, Promise<Candle[]>>()
  private durable: DurableStore | null = null

  attachDurableStore(store: DurableStore) {
    this.durable = store
  }

  size() {
    return this.series.size
  }

  stats() {
    let bars = 0
    let gaps = 0
    for (const s of this.series.values()) {
      bars += s.candles.length
      gaps += s.gaps
    }
    return { series: this.series.size, bars, gaps }
  }

  peek(instId: string, bar: string): Candle[] | null {
    return this.series.get(key(instId, bar))?.candles ?? null
  }

  meta(instId: string, bar: string) {
    const s = this.series.get(key(instId, bar))
    if (!s) return null
    const { candles, ...rest } = s
    return { ...rest, bars: candles.length, lastTs: candles[candles.length - 1]?.ts ?? 0 }
  }

  /**
   * Guarantee a warm series. Re-seeds when the data is missing, too short, or
   * older than two bars (which happens after a long WS outage).
   */
  async ensure(instId: string, bar: string, minBars = 260, maxAgeMs?: number): Promise<Candle[]> {
    const k = key(instId, bar)
    const step = barMs(bar)
    const existing = this.series.get(k)
    const age = existing ? Date.now() - existing.updatedAt : Infinity
    const stale = age > (maxAgeMs ?? step * 1.2)
    const enough = (existing?.candles.length ?? 0) >= minBars

    if (existing && enough && !stale) return existing.candles

    const pending = this.inflight.get(k)
    if (pending) return pending

    const task = (async () => {
      const wanted = Math.max(minBars, SEED_BARS)

      /* ---- disk first ---------------------------------------------------- *
       * The database already holds millions of confirmed bars. Re-downloading
       * them on every boot wastes the OKX REST budget the live decision loops
       * need, and makes a cold start depend on the network being fast. Hydrate
       * from disk, and only reach for REST when the local tail is genuinely
       * missing or stale.
       */
      if (!existing && this.durable) {
        const local = this.durable.loadCandles(instId, normalizeBar(bar), wanted).filter((candle) => candle.confirmed)
        if (local.length >= minBars) {
          const newest = local[local.length - 1]?.ts ?? 0
          const localStale = Date.now() - newest > step * 3
          const hydrated: Series = {
            instId,
            bar: normalizeBar(bar),
            candles: local.slice(-MAX_BARS),
            seededAt: Date.now(),
            updatedAt: localStale ? 0 : Date.now(),
            wsUpdatedAt: 0,
            gaps: 0,
            repairs: 0,
          }
          hydrated.gaps = this.countGaps(hydrated.candles, step)
          this.series.set(k, hydrated)
          // Fresh enough to trade on immediately; the WebSocket keeps it hot from here.
          if (!localStale) return hydrated.candles
          // Stale tail: top up from REST, but we now only need the recent bars.
          const tail = await fetchCandles(instId, bar, Math.min(300, wanted))
          const merged = this.merge(hydrated.candles, tail)
          hydrated.candles = merged
          hydrated.updatedAt = Date.now()
          hydrated.gaps = this.countGaps(merged, step)
          this.series.set(k, hydrated)
          this.durable?.upsertCandles(instId, hydrated.bar, merged)
          return merged
        }
      }

      const fresh = await fetchCandles(instId, bar, wanted)
      const merged = this.merge(existing?.candles ?? [], fresh)
      const s: Series = {
        instId,
        bar: normalizeBar(bar),
        candles: merged,
        seededAt: existing?.seededAt ?? Date.now(),
        updatedAt: Date.now(),
        wsUpdatedAt: existing?.wsUpdatedAt ?? 0,
        gaps: 0,
        repairs: existing?.repairs ?? 0,
      }
      s.gaps = this.countGaps(s.candles, step)
      this.series.set(k, s)
      this.durable?.upsertCandles(instId, s.bar, s.candles)
      if (s.gaps > 0) {
        this.durable?.recordQualityEvent({ instId, timeframe: s.bar, kind: 'candle_gap', severity: 'warning', detail: `${s.gaps} missing bars detected during seed` })
        await this.repair(instId, s.bar)
      }
      return s.candles
    })().finally(() => this.inflight.delete(k))

    this.inflight.set(k, task)
    // Never let a slow exchange wedge a decision loop. The seed keeps running in the
    // background and will be ready for the next call; this call returns whatever is
    // already known. A short series simply produces no decision, which is correct.
    task.catch(() => [])
    const budgetMs = Math.max(4_000, SEED_TIMEOUT_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    const fallback = new Promise<Candle[]>((resolve) => {
      timer = setTimeout(() => resolve(this.series.get(k)?.candles ?? existing?.candles ?? []), budgetMs)
    })
    try {
      return await Promise.race([task, fallback])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Apply a live WebSocket bar. */
  upsert(instId: string, bar: string, candle: Candle) {
    const k = key(instId, bar)
    const s = this.series.get(k)
    if (!s) return false
    const arr = s.candles
    const lastIdx = arr.length - 1
    if (lastIdx >= 0 && arr[lastIdx].ts === candle.ts) {
      arr[lastIdx] = candle
    } else if (lastIdx < 0 || candle.ts > arr[lastIdx].ts) {
      arr.push(candle)
      if (arr.length > MAX_BARS) arr.splice(0, arr.length - MAX_BARS)
    } else {
      // out-of-order late tick: patch in place
      const idx = arr.findIndex((c) => c.ts === candle.ts)
      if (idx >= 0) arr[idx] = candle
      else return false
    }
    s.updatedAt = Date.now()
    s.wsUpdatedAt = Date.now()
    if (candle.confirmed) this.durable?.upsertCandles(instId, s.bar, [candle])
    return true
  }

  /** Repair holes using the history endpoint (dated + delisted-safe). */
  async repair(instId: string, bar: string) {
    const k = key(instId, bar)
    const s = this.series.get(k)
    if (!s) return 0
    const step = barMs(bar)
    const before = this.countGaps(s.candles, step)
    if (!before) return 0
    const history = await fetchCandles(instId, bar, SEED_BARS, { history: true })
    s.candles = this.merge(s.candles, history)
    s.gaps = this.countGaps(s.candles, step)
    s.repairs++
    s.updatedAt = Date.now()
    this.durable?.upsertCandles(instId, s.bar, s.candles)
    this.durable?.recordQualityEvent({
      instId,
      timeframe: s.bar,
      kind: 'gap_repair',
      severity: s.gaps === 0 ? 'info' : 'warning',
      detail: `repair recovered ${before - s.gaps} of ${before} missing bars`,
      repairedAt: Date.now(),
    })
    return before - s.gaps
  }

  private merge(a: Candle[], b: Candle[]) {
    const map = new Map<number, Candle>()
    for (const c of a) map.set(c.ts, c)
    for (const c of b) {
      const prev = map.get(c.ts)
      // A confirmed bar always wins over a forming one.
      if (!prev || c.confirmed || !prev.confirmed) map.set(c.ts, c)
    }
    const out = [...map.values()].sort((x, y) => x.ts - y.ts)
    return out.length > MAX_BARS ? out.slice(out.length - MAX_BARS) : out
  }

  private countGaps(candles: Candle[], step: number) {
    let gaps = 0
    for (let i = 1; i < candles.length; i++) {
      const dt = candles[i].ts - candles[i - 1].ts
      if (dt > step * 1.6) gaps += Math.round(dt / step) - 1
    }
    return gaps
  }

  /** Drop series nobody asked for in a while (keeps memory flat). */
  evict(keep: Set<string>, maxIdleMs = 20 * 60_000) {
    const now = Date.now()
    for (const [k, s] of this.series) {
      if (keep.has(s.instId)) continue
      if (now - s.updatedAt > maxIdleMs) this.series.delete(k)
    }
  }
}

export const candleStore = new CandleStore()
