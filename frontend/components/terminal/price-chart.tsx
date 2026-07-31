'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
} from 'lightweight-charts'
import type { ChartPayload } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge, Switch } from '@/components/ui/kit'

export interface OverlayState {
  ema21: boolean
  ema50: boolean
  ema200: boolean
  vwap: boolean
  bollinger: boolean
  keltner: boolean
  supertrend: boolean
  volume: boolean
  patterns: boolean
  structure: boolean
  plan: boolean
  valueArea: boolean
}

export const DEFAULT_OVERLAYS: OverlayState = {
  ema21: true,
  ema50: true,
  ema200: true,
  vwap: true,
  bollinger: false,
  keltner: false,
  supertrend: false,
  volume: true,
  patterns: true,
  structure: true,
  plan: true,
  valueArea: true,
}

const LINE_DEFS: { key: string; overlay: keyof OverlayState; color: string; width: 1 | 2; dashed?: boolean; title: string }[] = [
  { key: 'ema21', overlay: 'ema21', color: '#38bdf8', width: 1, title: 'EMA21' },
  { key: 'ema50', overlay: 'ema50', color: '#f59e0b', width: 1, title: 'EMA50' },
  { key: 'ema200', overlay: 'ema200', color: '#e879f9', width: 2, title: 'EMA200' },
  { key: 'vwap', overlay: 'vwap', color: '#a3e635', width: 1, dashed: true, title: 'VWAP' },
  { key: 'bbUpper', overlay: 'bollinger', color: '#64748b', width: 1, title: 'BB+' },
  { key: 'bbLower', overlay: 'bollinger', color: '#64748b', width: 1, title: 'BB-' },
  { key: 'keltnerUpper', overlay: 'keltner', color: '#475569', width: 1, dashed: true, title: 'KC+' },
  { key: 'keltnerLower', overlay: 'keltner', color: '#475569', width: 1, dashed: true, title: 'KC-' },
  { key: 'supertrend', overlay: 'supertrend', color: '#22d3ee', width: 1, title: 'ST' },
]

const PLAN_KINDS = new Set(['entry', 'stop', 'tp'])
const STRUCTURE_KINDS = new Set(['support', 'resistance'])
const VALUE_KINDS = new Set(['poc', 'vah', 'val'])

export function PriceChart({
  payload,
  overlays,
  stale,
  height = 480,
  className,
}: {
  payload: ChartPayload | null
  overlays: OverlayState
  stale?: boolean
  height?: number
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lineRefs = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const priceLines = useRef<IPriceLine[]>([])
  const lastKey = useRef('')
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number } | null>(null)

  /* ---- create chart once ---------------------------------------------- */
  useEffect(() => {
    if (!box.current) return
    const chart = createChart(box.current, {
      // The browser locale can be invalid in some environments (e.g. "en-US@posix"),
      // which makes Intl throw inside the price formatter and blanks the canvas.
      localization: { locale: 'en-US' },
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#a1a1aa',
        fontFamily: 'var(--font-geist-mono), monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(63,63,70,0.28)' },
        horzLines: { color: 'rgba(63,63,70,0.28)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#52525b', width: 1, style: LineStyle.Dotted, labelBackgroundColor: '#27272a' },
        horzLine: { color: '#52525b', width: 1, style: LineStyle.Dotted, labelBackgroundColor: '#27272a' },
      },
      rightPriceScale: { borderColor: 'rgba(63,63,70,0.6)', scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: 'rgba(63,63,70,0.6)', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      handleScroll: true,
      handleScale: true,
      autoSize: false,
      height,
    })
    chartRef.current = chart

    candleRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      borderVisible: false,
      priceLineColor: '#71717a',
      priceLineStyle: LineStyle.Dotted,
    })

    volumeRef.current = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false })

    chart.subscribeCrosshairMove((param) => {
      const series = candleRef.current
      if (!series || !param.time) {
        setHover(null)
        return
      }
      const bar = param.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined
      if (bar) setHover({ o: bar.open, h: bar.high, l: bar.low, c: bar.close })
    })

    const ro = new ResizeObserver(() => {
      if (box.current) chart.applyOptions({ width: box.current.clientWidth, height })
    })
    ro.observe(box.current)
    chart.applyOptions({ width: box.current.clientWidth, height })

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      lineRefs.current.clear()
      priceLines.current = []
    }
  }, [height])

  /* ---- data ------------------------------------------------------------ */
  useEffect(() => {
    const chart = chartRef.current
    const candles = candleRef.current
    if (!chart || !candles || !payload) return

    candles.setData(payload.candles as never)
    volumeRef.current?.setData((overlays.volume ? payload.volume : []) as never)

    // lines: create on demand, clear when toggled off
    for (const def of LINE_DEFS) {
      const enabled = overlays[def.overlay]
      const data = payload.overlays[def.key] ?? []
      let series = lineRefs.current.get(def.key)
      if (enabled && data.length) {
        if (!series) {
          series = chart.addLineSeries({
            color: def.color,
            lineWidth: def.width,
            lineStyle: def.dashed ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: def.title,
          })
          lineRefs.current.set(def.key, series)
        }
        series.setData(data as never)
      } else if (series) {
        chart.removeSeries(series)
        lineRefs.current.delete(def.key)
      }
    }

    candles.setMarkers((overlays.patterns ? payload.markers : []) as never)

    for (const l of priceLines.current) {
      try {
        candles.removePriceLine(l)
      } catch {
        /* series recreated */
      }
    }
    priceLines.current = []

    const wanted = payload.levels.filter((l) => {
      if (PLAN_KINDS.has(l.kind)) return overlays.plan
      if (STRUCTURE_KINDS.has(l.kind)) return overlays.structure
      if (VALUE_KINDS.has(l.kind)) return overlays.valueArea
      return true
    })
    for (const l of wanted.slice(0, 18)) {
      priceLines.current.push(
        candles.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: PLAN_KINDS.has(l.kind) ? 2 : 1,
          lineStyle: PLAN_KINDS.has(l.kind) ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.label,
        }),
      )
    }

    const key = `${payload.instId}|${payload.bar}`
    if (lastKey.current !== key) {
      lastKey.current = key
      chart.timeScale().fitContent()
    }
  }, [payload, overlays])

  const legend = useMemo(() => {
    if (!payload) return null
    const last = payload.candles[payload.candles.length - 1]
    const bar = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null)
    if (!bar) return null
    const up = bar.c >= bar.o
    return (
      <div className="num pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="text-foreground">{payload.instId}</span>
        <span>{payload.bar}</span>
        <span>
          O <span className="text-foreground">{bar.o}</span>
        </span>
        <span>
          H <span className="text-foreground">{bar.h}</span>
        </span>
        <span>
          L <span className="text-foreground">{bar.l}</span>
        </span>
        <span>
          C <span className={up ? 'text-bull' : 'text-bear'}>{bar.c}</span>
        </span>
      </div>
    )
  }, [payload, hover])

  return (
    <div className={cn('relative w-full', className)}>
      {legend}
      {stale && (
        <div className="absolute right-2 top-2 z-10">
          <Badge tone="warning" data-testid="chart-stale-indicator">
            stale feed
          </Badge>
        </div>
      )}
      <div
        ref={box}
        data-testid="price-chart"
        className={cn('w-full transition-opacity', stale && 'opacity-80')}
        style={{ height }}
      />
      {!payload && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          loading candles…
        </div>
      )}
    </div>
  )
}

export function OverlayRack({
  value,
  onChange,
}: {
  value: OverlayState
  onChange: (next: OverlayState) => void
}) {
  const groups: { label: string; keys: (keyof OverlayState)[] }[] = [
    { label: 'Moving averages', keys: ['ema21', 'ema50', 'ema200'] },
    { label: 'Bands', keys: ['vwap', 'bollinger', 'keltner', 'supertrend'] },
    { label: 'Context', keys: ['volume', 'patterns', 'structure', 'valueArea', 'plan'] },
  ]
  const LABELS: Record<keyof OverlayState, string> = {
    ema21: 'EMA 21',
    ema50: 'EMA 50',
    ema200: 'EMA 200',
    vwap: 'VWAP',
    bollinger: 'Bollinger 20/2',
    keltner: 'Keltner 20/1.5',
    supertrend: 'Supertrend 10/3',
    volume: 'Volume',
    patterns: 'Pattern markers',
    structure: 'S/R levels',
    valueArea: 'POC / value area',
    plan: 'Entry / SL / TP',
  }
  return (
    <div data-testid="overlay-rack" className="flex flex-wrap gap-x-5 gap-y-2">
      {groups.map((g) => (
        <div key={g.label} className="min-w-[150px]">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{g.label}</p>
          <div className="flex flex-col gap-1">
            {g.keys.map((k) => (
              <Switch
                key={k}
                checked={value[k]}
                onChange={(v) => onChange({ ...value, [k]: v })}
                label={LABELS[k]}
                data-testid={`overlay-${k}`}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
