'use client'

import { useQuery } from 'convex/react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { api } from '@/convex/_generated/api'
import { cn } from '@/lib/utils'

function fmt(n: number | undefined, d = 4) {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function MarketPanel({
  instId,
  timeframe,
}: {
  instId: string
  timeframe: string
}) {
  const state = useQuery(api.telemetry.marketState, { instId, timeframe })

  const bias = state?.htfBias ?? 'NEUTRAL'
  const setup = state?.setup ?? 'NONE'
  const price = state?.price ?? 0

  // Position of price inside the Keltner band, for the visual gauge.
  const lo = state?.keltnerLower ?? 0
  const hi = state?.keltnerUpper ?? 0
  const pct = hi > lo ? Math.min(100, Math.max(0, ((price - lo) / (hi - lo)) * 100)) : 50

  return (
    <Card className="gap-0 border-border bg-card py-0">
      <CardContent className="flex flex-col gap-4 px-4 py-4">
        {/* Price header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs tracking-widest text-muted-foreground">
                {instId}
              </span>
              <Badge variant="outline" className="border-border font-mono text-[10px]">
                {timeframe}
              </Badge>
            </div>
            <span className="font-mono text-3xl leading-none font-semibold tracking-tight">
              {price > 0 ? fmt(price, price > 100 ? 2 : 4) : '—'}
            </span>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                'gap-1 font-mono text-[10px]',
                bias === 'BULLISH' && 'border-primary/40 bg-primary/10 text-primary',
                bias === 'BEARISH' && 'border-destructive/40 bg-destructive/10 text-destructive',
                bias === 'NEUTRAL' && 'border-border text-muted-foreground',
              )}
            >
              {bias === 'BULLISH' ? (
                <TrendingUp className="size-3" aria-hidden="true" />
              ) : bias === 'BEARISH' ? (
                <TrendingDown className="size-3" aria-hidden="true" />
              ) : null}
              HTF {bias}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                'font-mono text-[10px]',
                setup === 'LONG_SETUP' && 'border-primary/40 bg-primary/10 text-primary',
                setup === 'SHORT_SETUP' &&
                  'border-destructive/40 bg-destructive/10 text-destructive',
                setup === 'NONE' && 'border-border text-muted-foreground',
              )}
            >
              {setup === 'NONE' ? 'NO SETUP' : setup.replace('_', ' ')}
            </Badge>
          </div>
        </div>

        {/* Keltner gauge */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
            <span>KELTNER LOW {fmt(lo, 2)}</span>
            <span>MID {fmt(state?.keltnerMiddle, 2)}</span>
            <span>HIGH {fmt(hi, 2)}</span>
          </div>
          <div className="relative h-1.5 w-full rounded-full bg-secondary">
            <div
              className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
              style={{ left: `${pct}%` }}
              aria-hidden="true"
            />
          </div>
        </div>

        {/* Indicator grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Metric
            label="RSI 14"
            value={state ? state.rsi.toFixed(1) : '—'}
            tone={
              state && state.rsi < 32 ? 'up' : state && state.rsi > 68 ? 'down' : 'flat'
            }
          />
          <Metric label="ATR %" value={state ? `${state.atrPct.toFixed(2)}%` : '—'} />
          <Metric
            label="VWAP DEV"
            value={state ? `${state.vwapDeviationPct >= 0 ? '+' : ''}${state.vwapDeviationPct.toFixed(2)}%` : '—'}
            tone={
              state && state.vwapDeviationPct > 0
                ? 'up'
                : state && state.vwapDeviationPct < 0
                  ? 'down'
                  : 'flat'
            }
          />
          <Metric label="VWAP" value={fmt(state?.vwap, 2)} />
          <Metric label="POC" value={fmt(state?.poc, 2)} />
          <Metric label="EMA 200" value={fmt(state?.ema200, 2)} />
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({
  label,
  value,
  tone = 'flat',
}: {
  label: string
  value: string
  tone?: 'up' | 'down' | 'flat'
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-sm',
          tone === 'up' && 'text-primary',
          tone === 'down' && 'text-destructive',
        )}
      >
        {value}
      </span>
    </div>
  )
}
