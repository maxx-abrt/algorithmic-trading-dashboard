/**
 * Chart payload builder.
 *
 * The browser never talks to OKX (no CORS, and we want one source of truth), so
 * the engine ships everything the chart needs in a single response: candles,
 * every overlay series already aligned to the bar timestamps, pattern markers,
 * confluence levels, value-area / imbalance zones and the plan lines.
 */
import type { Analysis, Candle } from '../quant/types.js'
import { emaSeries, smaSeries, toOhlcv, atrSeries } from '../quant/indicators.js'
import { computeVwap } from '../quant/indicators.js'
import { BollingerBands } from 'technicalindicators'

export interface ChartSeriesPoint {
  time: number
  value: number
}

export interface ChartPayload {
  instId: string
  bar: string
  candles: { time: number; open: number; high: number; low: number; close: number }[]
  volume: { time: number; value: number; color: string }[]
  overlays: Record<string, ChartSeriesPoint[]>
  markers: { time: number; position: 'aboveBar' | 'belowBar'; color: string; shape: string; text: string }[]
  levels: { price: number; label: string; color: string; kind: string; strength: number }[]
  zones: { top: number; bottom: number; label: string; side: string }[]
  lastPrice: number
  updatedAt: number
}

const sec = (ms: number) => Math.floor(ms / 1000)

function align(series: number[], candles: readonly Candle[]): ChartSeriesPoint[] {
  const offset = candles.length - series.length
  const out: ChartSeriesPoint[] = []
  for (let i = 0; i < series.length; i++) {
    const c = candles[i + offset]
    if (!c || !Number.isFinite(series[i])) continue
    out.push({ time: sec(c.ts), value: series[i] })
  }
  return out
}

/** Running session-anchored VWAP, recomputed bar by bar (cheap enough). */
function vwapSeries(candles: readonly Candle[], bar: string): ChartSeriesPoint[] {
  const out: ChartSeriesPoint[] = []
  for (let i = 20; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1)
    const { vwap } = computeVwap(slice, bar)
    if (Number.isFinite(vwap) && vwap > 0) out.push({ time: sec(candles[i].ts), value: vwap })
  }
  return out
}

function supertrendSeries(candles: readonly Candle[], period = 10, factor = 3): ChartSeriesPoint[] {
  const d = toOhlcv(candles)
  const atr = atrSeries(d, period)
  const offset = candles.length - atr.length
  const out: ChartSeriesPoint[] = []
  let upper = 0
  let lower = 0
  let bull = true
  for (let i = 0; i < atr.length; i++) {
    const idx = offset + i
    const mid = (d.high[idx] + d.low[idx]) / 2
    const bu = mid + factor * atr[i]
    const bl = mid - factor * atr[i]
    const prevClose = d.close[idx - 1] ?? d.close[idx]
    upper = i === 0 || bu < upper || prevClose > upper ? bu : upper
    lower = i === 0 || bl > lower || prevClose < lower ? bl : lower
    if (d.close[idx] > upper) bull = true
    else if (d.close[idx] < lower) bull = false
    out.push({ time: sec(candles[idx].ts), value: bull ? lower : upper })
  }
  return out
}

export function buildChartPayload(
  instId: string,
  bar: string,
  allCandles: readonly Candle[],
  analysis: Analysis | null,
  visibleCount = 320,
): ChartPayload {
  // Indicators are computed on the FULL memory (so EMA200 exists) and only then
  // trimmed to the visible window.
  const candles = allCandles
  const from = candles[Math.max(0, candles.length - visibleCount)]?.ts ?? 0
  const fromSec = sec(from)
  const trim = (points: ChartSeriesPoint[]) => points.filter((p) => p.time >= fromSec)
  const d = toOhlcv(candles)
  const bb = (() => {
    try {
      return BollingerBands.calculate({ period: 20, stdDev: 2, values: d.close })
    } catch {
      return []
    }
  })()
  const bbOffset = candles.length - bb.length

  const overlays: Record<string, ChartSeriesPoint[]> = {
    ema21: align(emaSeries(d.close, 21), candles),
    ema50: align(emaSeries(d.close, 50), candles),
    ema200: align(emaSeries(d.close, 200), candles),
    sma20: align(smaSeries(d.close, 20), candles),
    vwap: vwapSeries(candles, bar),
    supertrend: supertrendSeries(candles),
    bbUpper: bb.map((b, i) => ({ time: sec(candles[i + bbOffset]?.ts ?? 0), value: b.upper })).filter((p) => p.time > 0),
    bbLower: bb.map((b, i) => ({ time: sec(candles[i + bbOffset]?.ts ?? 0), value: b.lower })).filter((p) => p.time > 0),
  }

  // Keltner (EMA20 ± 1.5 ATR20) drawn from the same maths the engine trades on.
  const kMid = emaSeries(d.close, 20)
  const kAtr = atrSeries(d, 20)
  const kOffset = candles.length - Math.min(kMid.length, kAtr.length)
  const kUpper: ChartSeriesPoint[] = []
  const kLower: ChartSeriesPoint[] = []
  for (let i = 0; i < Math.min(kMid.length, kAtr.length); i++) {
    const c = candles[i + kOffset]
    if (!c) continue
    const mid = kMid[kMid.length - Math.min(kMid.length, kAtr.length) + i]
    const a = kAtr[kAtr.length - Math.min(kMid.length, kAtr.length) + i]
    kUpper.push({ time: sec(c.ts), value: mid + 1.5 * a })
    kLower.push({ time: sec(c.ts), value: mid - 1.5 * a })
  }
  overlays.keltnerUpper = kUpper
  overlays.keltnerLower = kLower
  for (const k of Object.keys(overlays)) overlays[k] = trim(overlays[k])

  const visible = candles.slice(Math.max(0, candles.length - visibleCount))

  const markers: ChartPayload['markers'] = []
  const levels: ChartPayload['levels'] = []
  const zones: ChartPayload['zones'] = []

  if (analysis) {
    const i = analysis.indicators
    for (const p of i.patterns.slice(0, 8)) {
      markers.push({
        time: sec(p.ts),
        position: p.side === 'LONG' ? 'belowBar' : 'aboveBar',
        color: p.side === 'LONG' ? '#22c55e' : '#ef4444',
        shape: p.side === 'LONG' ? 'arrowUp' : 'arrowDown',
        text: `${p.label} ${(p.confirmed * 100).toFixed(0)}%`,
      })
    }
    for (const s of i.structure.swings.slice(-14)) {
      markers.push({
        time: sec(s.ts),
        position: s.kind === 'high' ? 'aboveBar' : 'belowBar',
        color: '#71717a',
        shape: 'circle',
        text: s.kind === 'high' ? 'H' : 'L',
      })
    }

    levels.push({ price: i.profile.poc, label: 'POC', color: '#f59e0b', kind: 'poc', strength: 100 })
    levels.push({ price: i.profile.vah, label: 'VAH', color: '#a3a3a3', kind: 'vah', strength: 60 })
    levels.push({ price: i.profile.val, label: 'VAL', color: '#a3a3a3', kind: 'val', strength: 60 })
    for (const l of i.structure.levels.slice(0, 8)) {
      levels.push({
        price: l.price,
        label: `${l.kind === 'support' ? 'S' : 'R'} ${l.source}`,
        color: l.kind === 'support' ? '#14b8a6' : '#f43f5e',
        kind: l.kind,
        strength: l.strength,
      })
    }
    if (analysis.plan) {
      const p = analysis.plan
      levels.push({ price: p.entry, label: 'Entry', color: '#3b82f6', kind: 'entry', strength: 100 })
      levels.push({ price: p.stopLoss, label: 'Stop', color: '#ef4444', kind: 'stop', strength: 100 })
      p.takeProfits.forEach((t, idx) =>
        levels.push({
          price: t.price,
          label: `TP${idx + 1} (${t.rr.toFixed(1)}R)`,
          color: '#22c55e',
          kind: 'tp',
          strength: 100,
        }),
      )
    }
    for (const g of i.structure.fvg) {
      zones.push({ top: g.top, bottom: g.bottom, label: `${g.side} FVG`, side: g.side })
    }
    zones.push({ top: i.profile.vah, bottom: i.profile.val, label: 'Value area', side: 'VALUE' })
  }

  return {
    instId,
    bar,
    candles: visible.map((c) => ({
      time: sec(c.ts),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
    volume: visible.map((c) => ({
      time: sec(c.ts),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
    })),
    overlays,
    markers: markers.filter((m) => m.time >= fromSec).sort((a, b) => a.time - b.time),
    levels,
    zones,
    lastPrice: candles[candles.length - 1]?.close ?? 0,
    updatedAt: Date.now(),
  }
}
