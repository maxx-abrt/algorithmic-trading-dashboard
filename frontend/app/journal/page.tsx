'use client'

import { useMemo, useState } from 'react'
import { usePoll, post } from '@/lib/api'
import type { PaperState, PaperTrade } from '@/lib/types'
import type { AttributionState } from '@/lib/evolution'
import { fmtR, fmtPctValue } from '@/lib/evolution'
import { Badge, Button, EmptyState, ErrorNote, Panel, Row, Skeleton, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { ago, fmtPrice } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BookOpenCheck, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

const STATUS_TONE: Record<string, 'bull' | 'bear' | 'info' | 'warning' | 'neutral'> = {
  open: 'info',
  pending: 'warning',
  closed: 'neutral',
  expired: 'neutral',
  rejected: 'bear',
}

export default function JournalPage() {
  const paper = usePoll<PaperState>('/paper?limit=250', 6000)
  const attribution = usePoll<AttributionState>('/attribution?limit=250', 8000)
  const [tab, setTab] = useState('open')
  const [busy, setBusy] = useState(false)

  const trades = paper.data?.trades ?? []
  const open = trades.filter((trade) => trade.status === 'open' || trade.status === 'pending')
  const closed = trades.filter((trade) => trade.status === 'closed' || trade.status === 'expired')
  const rejected = trades.filter((trade) => trade.status === 'rejected')
  const reasonById = useMemo(() => new Map((attribution.data?.rows ?? []).map((row) => [row.trade_id, row] as const)), [attribution.data])
  const equityCurve = useMemo(() => {
    let cumulative = 0
    return [...closed]
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
      .map((trade) => {
        cumulative += trade.netRealizedR
        return cumulative
      })
  }, [closed])

  const toggleKill = async () => {
    setBusy(true)
    try {
      const res = await post<{ enabled: boolean }>('/paper/kill', { enabled: !paper.data?.killSwitch })
      toast.success(res.enabled ? 'Arming paused' : 'Arming resumed')
      await paper.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const TradeTable = ({ rows, showReason }: { rows: PaperTrade[]; showReason?: boolean }) =>
    !rows.length ? (
      <EmptyState icon={<BookOpenCheck className="h-8 w-8" />} title="Nothing here yet">
        The engine arms a paper trade only when a playbook is eligible, the committee does not veto it and every portfolio gate passes.
      </EmptyState>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Instrument</th>
              <th className="px-2 py-2">Playbook</th>
              <th className="px-2 py-2">Side</th>
              <th className="px-2 py-2 text-right">Entry</th>
              <th className="px-2 py-2 text-right">Stop</th>
              <th className="px-2 py-2 text-right">MFE</th>
              <th className="px-2 py-2 text-right">Net</th>
              {showReason && <th className="px-3 py-2">Why it ended</th>}
              <th className="px-3 py-2">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((trade) => {
              const reason = reasonById.get(trade.id)
              return (
                <tr key={trade.id} className="border-b border-border/50 align-top" data-testid={`journal-row-${trade.id}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{trade.plan.instId}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {trade.plan.timeframe} · {ago(trade.plan.signalAt)}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-[11px] text-muted-foreground">{trade.plan.playbook.replace(/_/g, ' ')}</td>
                  <td className="px-2 py-2">
                    <Badge tone={trade.plan.side === 'LONG' ? 'bull' : 'bear'}>{trade.plan.side}</Badge>
                  </td>
                  <td className="num px-2 py-2 text-right">{fmtPrice(trade.fillPrice ?? trade.plan.entry)}</td>
                  <td className="num px-2 py-2 text-right">{fmtPrice(trade.currentStop)}</td>
                  <td className="num px-2 py-2 text-right text-muted-foreground">{trade.mfeR.toFixed(2)}R</td>
                  <td className={cn('num px-2 py-2 text-right font-medium', trade.netRealizedR >= 0 ? 'text-bull' : 'text-bear')}>{fmtR(trade.netRealizedR)}</td>
                  {showReason && (
                    <td className="max-w-[280px] px-3 py-2">
                      {reason ? (
                        <>
                          <Badge tone={reason.realised_r >= 0 ? 'bull' : 'warning'}>{reason.reason_code.replace(/_/g, ' ').toLowerCase()}</Badge>
                          <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{reason.detail}</p>
                        </>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">{trade.exitReason ?? '—'}</span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[trade.status] ?? 'neutral'}>{trade.status}</Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 p-3 pb-24 sm:p-4 md:pb-4" data-testid="journal-page">
      {paper.error && <ErrorNote message={paper.error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel title="Realised performance" data-testid="journal-performance">
          {!paper.data ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <Row label="closed trades" value={paper.data.stats.closed} />
              <Row label="win rate" value={fmtPctValue(paper.data.stats.winRate)} hint={`n=${paper.data.stats.closed}`} />
              <Row label="mean net" value={fmtR(paper.data.stats.avgR)} tone={(paper.data.stats.avgR ?? 0) >= 0 ? 'bull' : 'bear'} />
              <Row label="cumulative" value={fmtR(paper.data.stats.sumR, 1)} tone={paper.data.stats.sumR >= 0 ? 'bull' : 'bear'} />
            </>
          )}
        </Panel>
        <Panel title="Live exposure" data-testid="journal-exposure">
          <Row label="open" value={open.filter((t) => t.status === 'open').length} />
          <Row label="pending entry" value={open.filter((t) => t.status === 'pending').length} />
          <Row label="blocked by risk" value={rejected.length} tone={rejected.length ? 'warning' : 'neutral'} />
          <Row label="max open positions" value={paper.data?.policy.maxOpenPositions ?? '—'} />
        </Panel>
        <Panel title="Equity curve (R)" subtitle={`${closed.length} closed trades`} data-testid="journal-curve">
          {equityCurve.length < 2 ? (
            <p className="text-xs text-muted-foreground">At least two closed trades are needed before a curve means anything.</p>
          ) : (
            <svg viewBox={`0 0 100 40`} preserveAspectRatio="none" className="h-16 w-full">
              <polyline
                fill="none"
                stroke={equityCurve[equityCurve.length - 1] >= 0 ? 'var(--color-bull)' : 'var(--color-bear)'}
                strokeWidth="1"
                points={equityCurve
                  .map((value, index) => {
                    const min = Math.min(...equityCurve, 0)
                    const max = Math.max(...equityCurve, 0)
                    const x = (index / (equityCurve.length - 1)) * 100
                    const y = 38 - ((value - min) / Math.max(1e-9, max - min)) * 36
                    return `${x.toFixed(2)},${y.toFixed(2)}`
                  })
                  .join(' ')}
              />
            </svg>
          )}
        </Panel>
        <Panel
          title="Kill switch"
          data-testid="journal-kill"
          actions={
            <Button variant={paper.data?.killSwitch ? 'primary' : 'danger'} disabled={busy} onClick={() => void toggleKill()} data-testid="journal-kill-toggle">
              {paper.data?.killSwitch ? 'Resume arming' : 'Pause arming'}
            </Button>
          }
        >
          <div className="flex items-start gap-2">
            <ShieldAlert className={cn('mt-0.5 h-4 w-4', paper.data?.killSwitch ? 'text-bear' : 'text-muted-foreground')} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {paper.data?.killSwitch
                ? 'Arming is paused. Existing positions are still managed; no new candidate will be armed.'
                : 'Arming is active. Candidates that pass every gate become paper trades and, when demo keys are present, real OKX demo orders.'}
            </p>
          </div>
        </Panel>
      </div>

      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab id="open" count={open.length}>Live positions</Tab>
          <Tab id="closed" count={closed.length}>Closed</Tab>
          <Tab id="why" count={attribution.data?.summary.length}>Why trades end</Tab>
          <Tab id="blocked" count={rejected.length}>Blocked</Tab>
        </TabList>
        <TabPanel id="open" className="pt-3">
          <Panel bodyClassName="p-0">{paper.data ? <TradeTable rows={open} /> : <Skeleton className="h-24" />}</Panel>
        </TabPanel>
        <TabPanel id="closed" className="pt-3">
          <Panel bodyClassName="p-0">{paper.data ? <TradeTable rows={closed} showReason /> : <Skeleton className="h-24" />}</Panel>
        </TabPanel>
        <TabPanel id="why" className="pt-3">
          <Panel title="Deterministic exit attribution" subtitle="a loss is not automatically a mistake and a win is not proof of a good decision">
            {!attribution.data?.summary.length ? (
              <EmptyState icon={<BookOpenCheck className="h-8 w-8" />} title="No closed trades yet" />
            ) : (
              <div className="space-y-2">
                {attribution.data.summary.map((bucket) => {
                  const total = attribution.data!.summary.reduce((sum, row) => sum + row.count, 0)
                  return (
                    <div key={bucket.reasonCode} data-testid={`attribution-${bucket.reasonCode}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs">{attribution.data!.labels[bucket.reasonCode] ?? bucket.reasonCode}</span>
                        <span className="num shrink-0 text-[11px] text-muted-foreground">
                          {bucket.count} · {((bucket.count / total) * 100).toFixed(0)}% · <span className={bucket.meanR >= 0 ? 'text-bull' : 'text-bear'}>{fmtR(bucket.meanR)}</span>
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', bucket.meanR >= 0 ? 'bg-bull' : 'bg-bear')} style={{ width: `${(bucket.count / total) * 100}%` }} />
                      </div>
                    </div>
                  )
                })}
                <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
                  The dominant bucket automatically becomes the hypothesis for the next research campaign, so the system fixes the reason rather than chasing the P&amp;L.
                </p>
              </div>
            )}
          </Panel>
        </TabPanel>
        <TabPanel id="blocked" className="pt-3">
          <Panel bodyClassName="p-0" title="Blocked before arming" subtitle="kept on purpose: a gate that only reduces activity must be measurable">
            {paper.data ? <TradeTable rows={rejected} showReason /> : <Skeleton className="h-24" />}
          </Panel>
        </TabPanel>
      </Tabs>
    </div>
  )
}
