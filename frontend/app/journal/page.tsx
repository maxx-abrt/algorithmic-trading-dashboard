'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api as convexApi } from '@/convex/_generated/api'
import type { SignalRow } from '@/lib/types'
import { Badge, EmptyState, Panel, Row, Select } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { dateUtc, fmtPrice, fmtR, fmtUsd, titleCase } from '@/lib/format'
import { NotebookPen } from 'lucide-react'

const STATUS_TONE: Record<string, 'bull' | 'bear' | 'neutral' | 'warning' | 'info'> = {
  live: 'info',
  tp1: 'bull',
  win: 'bull',
  loss: 'bear',
  breakeven: 'neutral',
  expired: 'warning',
}

export default function JournalPage() {
  const [status, setStatus] = useState('all')
  const signals = useQuery(convexApi.signals.list, { limit: 120, status }) as SignalRow[] | undefined
  const stats = useQuery(convexApi.signals.stats, {}) as
    | {
        total: number
        live: number
        closed: number
        winRate: number
        avgR: number
        sumR: number
        bestR: number
        worstR: number
        avgConviction: number
      }
    | undefined

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <Panel
        className="xl:col-span-9"
        title="Signal journal"
        subtitle="every actionable idea the engine issued, graded automatically against real candles"
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-7 w-[120px]">
            {['all', 'live', 'tp1', 'win', 'loss', 'breakeven', 'expired'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        }
        bodyClassName="p-0"
      >
        {signals === undefined && <div className="skeleton m-3 h-48 rounded" />}
        {signals?.length === 0 && (
          <EmptyState icon={<NotebookPen className="h-6 w-6" />} title="No ideas logged yet">
            The engine only journals a setup once conviction clears the gate and no hard blocker applies — typically a
            handful per day across the watchlist. Every entry is then replayed against real candles to grade MFE, MAE
            and realised R.
          </EmptyState>
        )}
        {signals && signals.length > 0 && (
          <div className="overflow-x-auto">
            <table data-testid="journal-table" className="w-full min-w-[940px] border-collapse">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-1.5 text-left">Opened</th>
                  <th className="px-2 py-1.5 text-left">Instrument</th>
                  <th className="px-2 py-1.5 text-left">Side</th>
                  <th className="px-2 py-1.5 text-right">Conv</th>
                  <th className="px-2 py-1.5 text-right">Entry</th>
                  <th className="px-2 py-1.5 text-right">Stop</th>
                  <th className="px-2 py-1.5 text-right">TP1</th>
                  <th className="px-2 py-1.5 text-right">MFE</th>
                  <th className="px-2 py-1.5 text-right">MAE</th>
                  <th className="px-2 py-1.5 text-right">Result</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s._id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="num px-2 py-1.5 text-[10px] text-muted-foreground">{dateUtc(s.createdAt)}</td>
                    <td className="px-2 py-1.5">
                      <span className="num text-xs">{s.instId}</span>
                      <span className="num ml-1 text-[10px] text-muted-foreground">{s.timeframe}</span>
                      {s.playbook && (
                        <span className="block text-[10px] text-muted-foreground">{titleCase(s.playbook)}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={s.decision === 'LONG' ? 'bull' : 'bear'}>{s.decision}</Badge>
                    </td>
                    <td className="num px-2 py-1.5 text-right text-xs">{s.conviction.toFixed(0)}</td>
                    <td className="num px-2 py-1.5 text-right text-xs">{fmtPrice(s.entry)}</td>
                    <td className="num px-2 py-1.5 text-right text-xs text-bear">{fmtPrice(s.stopLoss)}</td>
                    <td className="num px-2 py-1.5 text-right text-xs text-bull">{fmtPrice(s.takeProfits?.[0])}</td>
                    <td className="num px-2 py-1.5 text-right text-xs">{s.mfeR.toFixed(2)}R</td>
                    <td className="num px-2 py-1.5 text-right text-xs">{s.maeR.toFixed(2)}R</td>
                    <td
                      className={cn(
                        'num px-2 py-1.5 text-right text-xs font-medium',
                        (s.realizedR ?? 0) > 0 ? 'text-bull' : (s.realizedR ?? 0) < 0 ? 'text-bear' : '',
                      )}
                    >
                      {s.realizedR != null ? fmtR(s.realizedR) : `${s.barsHeld}/${s.timeStopBars}b`}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{s.status}</Badge>
                      {s.exitReason && (
                        <span className="block text-[10px] text-muted-foreground">{titleCase(s.exitReason)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-3 xl:col-span-3">
        <Panel title="Track record" data-testid="journal-aggregate-stats">
          {stats === undefined ? (
            <div className="skeleton h-32 rounded" />
          ) : (
            <div className="space-y-0.5">
              <Row label="ideas logged" value={stats.total.toString()} />
              <Row label="still live" value={stats.live.toString()} />
              <Row label="closed" value={stats.closed.toString()} />
              <Row
                label="hit rate"
                value={`${stats.winRate.toFixed(0)}%`}
                tone={stats.winRate >= 50 ? 'bull' : stats.winRate > 0 ? 'warning' : undefined}
              />
              <Row label="average outcome" value={fmtR(stats.avgR)} tone={stats.avgR > 0 ? 'bull' : 'bear'} />
              <Row label="cumulative" value={fmtR(stats.sumR)} tone={stats.sumR > 0 ? 'bull' : 'bear'} />
              <Row label="best / worst" value={`${fmtR(stats.bestR)} / ${fmtR(stats.worstR)}`} />
              <Row label="avg conviction" value={stats.avgConviction.toFixed(0)} />
            </div>
          )}
        </Panel>

        <Panel title="How grading works">
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <li>· Every idea is replayed bar by bar against real OKX candles.</li>
            <li>· Targets fill in order with their allocation (40 / 35 / 25%).</li>
            <li>· After TP1 the stop moves to break-even, exactly as a human would manage it.</li>
            <li>· If a bar touches both stop and target, the stop is assumed first — never flattering.</li>
            <li>· Unresolved ideas close at the time stop and book whatever R they are worth.</li>
          </ul>
        </Panel>
      </div>
    </div>
  )
}
