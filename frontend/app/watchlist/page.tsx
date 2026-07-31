'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { del, post, usePoll } from '@/lib/api'
import type { WatchRow } from '@/lib/types'
import { InstrumentSearch } from '@/components/terminal/instrument-search'
import { Badge, Button, EmptyState, Gauge, Panel, Row, Select } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { ago, fmtPct, fmtPrice, fmtR, fmtUsd, titleCase } from '@/lib/format'
import { toast } from 'sonner'
import { Eye, LineChart, Trash2 } from 'lucide-react'

const BARS = ['1m', '5m', '15m', '30m', '1H', '4H', '1D']

export default function WatchlistPage() {
  const router = useRouter()
  const list = usePoll<WatchRow[]>('/watchlist', 5000)
  const [busy, setBusy] = useState('')

  const add = async (instId: string) => {
    setBusy(instId)
    try {
      await post('/watchlist', { instId })
      toast.success(`${instId} is now surveilled`)
      await list.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy('')
    }
  }

  const remove = async (instId: string) => {
    setBusy(instId)
    try {
      await del(`/watchlist?instId=${encodeURIComponent(instId)}`)
      toast.success(`${instId} removed`)
      await list.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy('')
    }
  }

  const setTimeframe = async (instId: string, timeframe: string) => {
    try {
      await fetch(`/api/watchlist`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instId, timeframe }),
      })
      await list.refresh()
    } catch {
      toast.error('Could not change the timeframe')
    }
  }

  const open = async (instId: string, timeframe: string) => {
    await post('/settings', { instId, timeframe })
    router.push('/')
  }

  const rows = list.data ?? []

  return (
    <div className="space-y-3">
      <Panel
        title="Watchlist"
        subtitle="instruments the engine analyses on rotation and alerts on — 24/7, even when this tab is closed"
      >
        <InstrumentSearch value="" onSelect={(id) => void add(id)} className="max-w-[560px]" />
      </Panel>

      {rows.length === 0 && !list.loading && (
        <Panel>
          <EmptyState icon={<Eye className="h-6 w-6" />} title="Nothing under surveillance yet">
            Add an instrument above, or from the scanner. Watched instruments get a live WebSocket subscription, a full
            multi-timeframe evaluation on rotation, and every alert rule scoped to <span className="num">*</span>.
          </EmptyState>
        </Panel>
      )}

      <div data-testid="watchlist-grid" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((w) => {
          const tone = w.decision === 'LONG' ? 'bull' : w.decision === 'SHORT' ? 'bear' : 'neutral'
          return (
            <Panel
              key={w.instId}
              data-testid="watchlist-instrument-card"
              title={
                <span className="flex items-center gap-1.5">
                  <span className="num">{w.instId}</span>
                  <Badge tone={tone}>{w.decision ?? 'warming'}</Badge>
                </span>
              }
              subtitle={w.analysedAt ? `evaluated ${ago(w.analysedAt)}` : 'waiting for the first evaluation'}
              actions={
                <>
                  <Select
                    value={w.timeframe}
                    onChange={(e) => void setTimeframe(w.instId, e.target.value)}
                    className="h-7 w-[74px]"
                  >
                    {BARS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </Select>
                  <Button size="icon" variant="ghost" title="Open in terminal" onClick={() => void open(w.instId, w.timeframe)}>
                    <LineChart className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Remove"
                    data-testid="watchlist-remove-button"
                    disabled={busy === w.instId}
                    onClick={() => void remove(w.instId)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              }
              bodyClassName="space-y-2"
            >
              <div className="flex items-baseline justify-between">
                <span className="num text-lg font-semibold">{fmtPrice(w.last)}</span>
                <span className={cn('num text-xs', (w.changePct24h ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                  {fmtPct(w.changePct24h, 2)}
                </span>
              </div>

              {w.conviction != null && (
                <div className="space-y-1">
                  <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
                    <span>conviction</span>
                    <span className="num">{w.conviction.toFixed(0)}/100</span>
                  </div>
                  <Gauge value={w.conviction} tone={tone} />
                </div>
              )}

              <div className="grid grid-cols-2 gap-x-4">
                <Row label="regime" value={w.regime ? titleCase(w.regime) : '—'} mono={false} />
                <Row label="MTF" value={w.mtfAlignment != null ? `${w.mtfAlignment.toFixed(0)}%` : '—'} />
                <Row
                  label="composite"
                  value={w.composite != null ? `${w.composite > 0 ? '+' : ''}${w.composite.toFixed(0)}` : '—'}
                  tone={(w.composite ?? 0) > 0 ? 'bull' : (w.composite ?? 0) < 0 ? 'bear' : undefined}
                />
                <Row label="turnover" value={fmtUsd(w.volUsd24h)} />
              </div>

              {w.plan && (
                <div className="rounded border border-border bg-card-2/50 p-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {w.playbook ? titleCase(w.playbook) : 'plan'}
                  </p>
                  <Row label="entry" value={fmtPrice(w.plan.entry)} />
                  <Row label="stop" value={fmtPrice(w.plan.stopLoss)} tone="bear" />
                  <Row label="targets" value={w.plan.takeProfits.map((t) => fmtPrice(t)).join(' / ')} tone="bull" />
                  <Row label="R:R · net" value={`${w.plan.expectedRr.toFixed(2)}R · ${fmtR(w.plan.netExpectancyR)}`} />
                </div>
              )}

              {w.note && <p className="text-[10px] text-muted-foreground">{w.note}</p>}
            </Panel>
          )
        })}
      </div>
    </div>
  )
}
