'use client'

import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import type { PaperState } from '@/lib/types'
import { Badge, Button, EmptyState, Gauge, Panel, Row } from '@/components/ui/kit'
import { ago, fmtPrice, fmtR, fmtUsd, titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Ban, FlaskConical, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

export default function PortfolioPage() {
  const paper = usePoll<PaperState>('/paper?limit=200', 4000)
  const [busy, setBusy] = useState(false)
  const state = paper.data
  const active = state?.trades.filter((trade) => trade.status === 'pending' || trade.status === 'open') ?? []

  const toggleKill = async () => {
    if (!state) return
    setBusy(true)
    try {
      await post('/paper/kill', { enabled: !state.killSwitch })
      await paper.refresh()
      toast.success(state.killSwitch ? 'Paper candidate arming resumed' : 'Paper candidate arming stopped')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update paper kill switch')
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Active" value={String(active.length)} hint="pending + open" />
        <Metric label="Closed" value={String(state?.stats.closed ?? 0)} hint="confirmed bars" />
        <Metric label="Net R" value={state ? fmtR(state.stats.sumR) : '—'} tone={(state?.stats.sumR ?? 0) >= 0 ? 'bull' : 'bear'} />
        <Metric label="Mean R" value={state?.stats.avgR == null ? 'insufficient' : fmtR(state.stats.avgR)} />
        <Metric label="Validation" value="PAPER ONLY" hint="no exchange orders" />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-8" title="Paper execution state" subtitle="real OKX candles, local state machine, no trading API" data-testid="paper-execution-card">
          {active.length === 0 ? (
            <EmptyState icon={<FlaskConical className="h-6 w-6" />} title="No active paper plan">
              The engine is still recording all strategy candidates and rejection reasons. It arms a paper plan only after explicit strategy, cost and portfolio gates pass.
            </EmptyState>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {active.map((trade) => {
                const filledTargets = trade.targets.filter((target) => target.filled).length
                const progress = trade.status === 'pending' ? 10 : 35 + filledTargets * 20
                return (
                  <article key={trade.id} className="rounded-lg border border-border bg-card-2/40 p-3" data-testid="paper-position-card">
                    <div className="flex items-center justify-between gap-2">
                      <div><p className="num text-sm font-medium">{trade.plan.instId}</p><p className="text-[10px] text-muted-foreground">{trade.plan.timeframe} · {titleCase(trade.plan.playbook)}</p></div>
                      <Badge tone={trade.plan.side === 'LONG' ? 'bull' : 'bear'}>{trade.plan.side}</Badge>
                    </div>
                    <div className="mt-3"><div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span data-testid="paper-state">{trade.status.toUpperCase()}</span><span>{filledTargets}/{trade.targets.length} targets</span></div><Gauge value={progress} tone={trade.plan.side === 'LONG' ? 'bull' : 'bear'} /></div>
                    <div className="mt-3 grid grid-cols-2 gap-x-5">
                      <Row label="entry" value={fmtPrice(trade.fillPrice ?? trade.plan.entry)} /><Row label="current stop" value={fmtPrice(trade.currentStop)} tone="bear" />
                      <Row label="risk budget" value={fmtUsd(trade.plan.riskUsd)} /><Row label="remaining" value={`${(trade.remaining * 100).toFixed(0)}%`} />
                      <Row label="MFE / MAE" value={`${trade.mfeR.toFixed(2)} / ${trade.maeR.toFixed(2)}R`} /><Row label="running net" value={fmtR(trade.netRealizedR)} tone={trade.netRealizedR >= 0 ? 'bull' : 'bear'} />
                    </div>
                    <div className="mt-2 border-t border-border pt-2">
                      {trade.events.slice(-4).map((event, index) => <div key={`${event.at}-${index}`} className="flex gap-2 py-1 text-[10px]"><span className="num shrink-0 text-muted-foreground">{ago(event.at)}</span><span>{event.detail}</span></div>)}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-3 xl:col-span-4">
          <Panel title="Portfolio guardrails" subtitle="hard gates before a paper plan is armed">
            <div className="space-y-0.5">
              <Row label="max open positions" value={String(state?.policy.maxOpenPositions ?? '—')} />
              <Row label="daily loss kill" value={state ? `${state.policy.maxDailyLossPct}R` : '—'} />
              <Row label="max open risk" value={state ? `${state.policy.maxOpenRiskPct}%` : '—'} />
              <Row label="max gross exposure" value={state ? `${state.policy.maxGrossExposurePct}%` : '—'} />
              <Row label="last risk verdict" value={state?.lastRiskDecision ? (state.lastRiskDecision.allowed ? 'allowed' : state.lastRiskDecision.reasons.join(', ')) : 'no candidate yet'} mono={false} tone={state?.lastRiskDecision && !state.lastRiskDecision.allowed ? 'warning' : undefined} />
            </div>
          </Panel>
          <Panel title="Paper kill switch" subtitle="stops new simulations; never sends an exchange command">
            <div className={cn('rounded-lg border p-3', state?.killSwitch ? 'border-bear/40 bg-bear/10' : 'border-bull/30 bg-bull/8')}>
              <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /><span data-testid="paper-kill-switch-status" className="text-xs font-medium">{state?.killSwitch ? 'ARMING BLOCKED' : 'ARMING ENABLED'}</span></div>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Active paper plans continue to be graded so the journal remains honest.</p>
              <Button className="mt-3 w-full" variant={state?.killSwitch ? 'primary' : 'danger'} onClick={toggleKill} disabled={busy || !state} data-testid="toggle-kill-switch-button">
                <Ban className="h-3.5 w-3.5" />{state?.killSwitch ? 'Resume paper arming' : 'Stop new paper plans'}
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'bull' | 'bear' }) {
  return <Panel><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className={cn('num mt-1 text-xl font-semibold', tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : '')}>{value}</p>{hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}</Panel>
}
