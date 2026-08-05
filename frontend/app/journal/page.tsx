'use client'

import { useState } from 'react'
import { usePoll } from '@/lib/api'
import type { PaperState } from '@/lib/types'
import { Badge, EmptyState, Panel, Row, Select } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { dateUtc, fmtPrice, fmtR, titleCase } from '@/lib/format'
import { BookOpenCheck } from 'lucide-react'

const STATUS_TONE: Record<string, 'bull' | 'bear' | 'neutral' | 'warning' | 'info'> = {
  pending: 'warning', open: 'info', closed: 'neutral', expired: 'warning', rejected: 'bear',
}

export default function JournalPage() {
  const [status, setStatus] = useState('all')
  const journal = usePoll<PaperState>(`/journal?limit=200&status=${status}`, 5000)
  const rows = journal.data?.trades ?? []
  const stats = journal.data?.stats

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <Panel
        className="xl:col-span-9"
        title="Immutable paper ledger"
        subtitle="stateful fills, partial targets, stops and costs replayed once against confirmed OKX candles"
        actions={
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-7 w-[130px]" data-testid="journal-filter-state">
            {['all', 'pending', 'open', 'closed', 'expired', 'rejected'].map((value) => <option key={value}>{value}</option>)}
          </Select>
        }
        bodyClassName="p-0"
      >
        {journal.loading && !journal.data && <div className="skeleton m-3 h-52 rounded" />}
        {!journal.loading && rows.length === 0 && (
          <EmptyState icon={<BookOpenCheck className="h-6 w-6" />} title="No paper events in this view">
            Candidates are recorded first. A paper plan is armed only when explicit playbook, cost and portfolio gates all pass.
          </EmptyState>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table data-testid="journal-table" className="w-full min-w-[1120px] border-collapse">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-2 py-2 text-left">Submitted</th><th className="px-2 py-2 text-left">Instrument</th>
                  <th className="px-2 py-2 text-left">State</th><th className="px-2 py-2 text-left">Playbook</th>
                  <th className="px-2 py-2 text-right">Entry / stop</th><th className="px-2 py-2 text-right">Targets</th>
                  <th className="px-2 py-2 text-right">MFE / MAE</th><th className="px-2 py-2 text-right">Gross</th>
                  <th className="px-2 py-2 text-right">Costs</th><th className="px-2 py-2 text-right">Net</th>
                  <th className="px-2 py-2 text-left">Last transition</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((trade) => {
                  const last = trade.events.at(-1)
                  return (
                    <tr key={trade.id} className="border-b border-border/50 hover:bg-muted/20" data-testid="journal-trade-row">
                      <td className="num px-2 py-2 text-[10px] text-muted-foreground">{dateUtc(trade.submittedAt)}</td>
                      <td className="px-2 py-2"><span className="num text-xs">{trade.plan.instId}</span><span className="num ml-1 text-[10px] text-muted-foreground">{trade.plan.timeframe}</span><Badge className="ml-1" tone={trade.plan.side === 'LONG' ? 'bull' : 'bear'}>{trade.plan.side}</Badge></td>
                      <td className="px-2 py-2"><Badge tone={STATUS_TONE[trade.status] ?? 'neutral'}>{trade.status}</Badge>{trade.exitReason && <span className="ml-1 text-[10px] text-muted-foreground">{titleCase(trade.exitReason)}</span>}</td>
                      <td className="px-2 py-2 text-[11px]">{titleCase(trade.plan.playbook)}<span className="block num text-[9px] text-muted-foreground">{trade.plan.policyVersion}</span></td>
                      <td className="num px-2 py-2 text-right text-xs">{fmtPrice(trade.fillPrice ?? trade.plan.entry)}<span className="block text-[10px] text-bear">{fmtPrice(trade.currentStop)}</span></td>
                      <td className="num px-2 py-2 text-right text-[10px]">{trade.targets.map((target) => <span key={target.price} className={cn('ml-1', target.filled ? 'text-bull' : 'text-muted-foreground')}>{fmtPrice(target.price)}</span>)}</td>
                      <td className="num px-2 py-2 text-right text-xs">{trade.mfeR.toFixed(2)} / <span className="text-bear">{trade.maeR.toFixed(2)}</span></td>
                      <td className="num px-2 py-2 text-right text-xs">{fmtR(trade.grossRealizedR)}</td>
                      <td className="num px-2 py-2 text-right text-xs text-warning">{fmtR(-(trade.feesR + trade.fundingR))}</td>
                      <td className={cn('num px-2 py-2 text-right text-xs font-medium', trade.netRealizedR > 0 ? 'text-bull' : trade.netRealizedR < 0 ? 'text-bear' : '')}>{fmtR(trade.netRealizedR)}</td>
                      <td className="max-w-[220px] px-2 py-2 text-[10px] text-muted-foreground">{last?.detail ?? 'submitted'}<span className="block num">{last ? dateUtc(last.at) : ''}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="flex flex-col gap-3 xl:col-span-3">
        <Panel title="Observed track record" data-testid="journal-aggregate-stats">
          {stats ? <div className="space-y-0.5">
            <Row label="plans" value={stats.total.toString()} /><Row label="open / closed" value={`${stats.open} / ${stats.closed}`} />
            <Row label="hit rate" value={stats.winRate == null ? 'insufficient' : `${(stats.winRate * 100).toFixed(1)}%`} tone={stats.winRate != null && stats.winRate >= 0.5 ? 'bull' : 'warning'} />
            <Row label="average net" value={stats.avgR == null ? 'insufficient' : fmtR(stats.avgR)} tone={(stats.avgR ?? 0) > 0 ? 'bull' : 'warning'} />
            <Row label="cumulative net" value={fmtR(stats.sumR)} tone={stats.sumR > 0 ? 'bull' : 'bear'} />
            <Row label="best / worst" value={`${stats.bestR == null ? '—' : fmtR(stats.bestR)} / ${stats.worstR == null ? '—' : fmtR(stats.worstR)}`} />
          </div> : <div className="skeleton h-32 rounded" />}
        </Panel>
        <Panel title="Execution assumptions">
          <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <li>Stop-first ordering when one candle touches both stop and target.</li>
            <li>Entry-zone expiration, adverse slippage, round-trip fees and funding are charged.</li>
            <li>TP1 state persists; break-even and trailing transitions are not replayed or double-counted.</li>
            <li>These are paper outcomes, not evidence that live execution would match.</li>
          </ul>
        </Panel>
      </div>
    </div>
  )
}
