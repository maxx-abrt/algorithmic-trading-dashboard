'use client'

/**
 * AUTOPILOT — what the system is doing to improve itself, right now.
 * The orchestrator's intent queue, its job history, execution quality, the news
 * signal and the nightly post-mortem, all in one place.
 */
import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import { Badge, Button, EmptyState, ErrorNote, Panel, Skeleton } from '@/components/ui/kit'
import { ago, fmtNum } from '@/lib/format'
import { Activity, AlertTriangle, Gauge, Newspaper, Rocket } from 'lucide-react'

interface Task { kind: string; target: string; priority: number; reason: string }
interface Orchestrator {
  state: { running: boolean; currentTask: Task | null; lastTask: (Task & { status: string; detail: string; durationMs: number; at: number }) | null; queue: Task[]; cycles: number; skipped: string | null; resources: { rssMb: number; freeMb: number; load1: number }; brainJobs: string[] }
  jobs: { id: number; at: number; kind: string; target: string | null; status: string; detail: string | null; durationMs: number | null }[]
  summary: { specialists: number; champions: number; canaries: number; withArenaEdge: number }
  coverage: { nicheKey: string; rows: number }[]
  niches: string[]
  plan: Task[]
  pendingBrainJobs: { jobId: string; kind: string; nicheKey: string }[]
  settings: { enabled: boolean; intervalSec: number }
}
interface Execution {
  diagnosis: { severity: string; code: string; title: string; detail: string; action: string }
  simulator: { orders: number; filled: number; rejected: number; fillRate: number | null; meanSlippageBps: number | null; worstSlippageBps: number | null; meanSpreadBps: number | null; meanLatencyMs: number | null; note: string }
  simOrders: { id: number; at: number; instId: string; side: string; intendedPx: number; filledPx: number | null; requestedSz: number; filledSz: number; spreadBps: number | null; slippageBps: number | null; state: string; reason: string | null }[]
  demo: { placed: number; filled: number; rejected: number; lastError: string }
}
interface News {
  current: { at: number; riskScore: number; direction: number; eventProximity: number; summary: string; model: string; headlines: { title: string; assets: string[]; impact: string; direction: number }[] } | null
  history: { id: number; at: number; riskScore: number; direction: number; summary: string; costEur: number }[]
  postMortem: { at: number; text: string; model: string } | null
  budget: { spentEur: number; budgetEur: number }
}

export default function AutopilotPage() {
  const orchestrator = usePoll<Orchestrator>('/orchestrator', 5000)
  const execution = usePoll<Execution>('/execution?limit=40', 12_000)
  const news = usePoll<News>('/news?limit=12', 30_000)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const trigger = async (kind: string) => {
    setBusy(true)
    setNote(null)
    try {
      const result = await post<{ detail?: string; inserted?: number }>('/orchestrator/run', { kind })
      setNote(result.detail ?? `${result.inserted ?? 0} decisions recorded`)
      await orchestrator.refresh()
    } catch (issue) {
      setNote(issue instanceof Error ? issue.message : String(issue))
    } finally {
      setBusy(false)
    }
  }

  const data = orchestrator.data
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-24 pt-3 sm:px-4 md:pb-6 lg:px-6" data-testid="autopilot-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-1.5 text-base font-semibold tracking-tight"><Rocket className="h-4 w-4 text-info" />Autopilot</h1>
        <Badge tone={data?.settings.enabled ? 'bull' : 'warning'} data-testid="autopilot-status">{data?.settings.enabled ? `on · every ${data.settings.intervalSec}s` : 'off'}</Badge>
        <Badge tone="neutral">{data?.state.cycles ?? 0} cycles</Badge>
        {data?.state.resources && <Badge tone="plain"><Gauge className="h-3 w-3" />engine {data.state.resources.rssMb}MB · free {data.state.resources.freeMb}MB · load {data.state.resources.load1}</Badge>}
        <Badge tone={(data?.summary.champions ?? 0) > 0 ? 'bull' : 'info'}>{data?.coverage.length ?? 0}/{data?.niches.length ?? 24} niches covered</Badge>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button variant="primary" disabled={busy} onClick={() => void trigger('tick')} data-testid="autopilot-tick">run next action</Button>
          <Button disabled={busy} onClick={() => void trigger('news')} data-testid="autopilot-news">refresh news</Button>
          <Button disabled={busy} onClick={() => void trigger('postmortem')} data-testid="autopilot-postmortem">post-mortem</Button>
        </div>
      </div>

      {orchestrator.error && <ErrorNote message={orchestrator.error} />}
      {note && <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="autopilot-note">{note}</p>}
      {orchestrator.loading && !data && <Skeleton className="h-40" />}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Intent queue" subtitle="the single most valuable next action, and what comes after it" data-testid="autopilot-queue">
          {data?.state.currentTask && (
            <div className="mb-2 rounded-md border border-info/40 bg-info/10 p-2 text-[11px]">
              <p className="flex items-center gap-1.5"><Activity className="h-3 w-3 text-info" /><span className="font-medium">running: {data.state.currentTask.kind}</span><span className="text-muted-foreground">{data.state.currentTask.target}</span></p>
              <p className="mt-0.5 text-muted-foreground">{data.state.currentTask.reason}</p>
            </div>
          )}
          {data?.state.skipped && <p className="mb-2 text-[11px] text-warning">{data.state.skipped}</p>}
          {!data?.plan.length ? <EmptyState title="Nothing due">{"Every niche is covered and every model is freshly verified."}</EmptyState> : (
            <ul className="space-y-1 text-[11px]">
              {data.plan.map((task, index) => (
                <li key={`${task.kind}-${task.target}-${index}`} className="flex flex-wrap items-center gap-2 border-b border-border/30 pb-1">
                  <Badge tone={index === 0 ? 'info' : 'neutral'}>{task.kind}</Badge>
                  <span className="font-mono">{task.target.replace(/\|/g, ' · ')}</span>
                  <span className="text-muted-foreground">p{fmtNum(task.priority, 0)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent actions" subtitle="every self-improvement step, with its result" data-testid="autopilot-jobs">
          {!data?.jobs.length ? <EmptyState title="No action yet" /> : (
            <ul className="space-y-1 text-[11px]">
              {data.jobs.slice(0, 24).map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-2 border-b border-border/30 pb-1">
                  <span className="w-14 shrink-0 text-muted-foreground">{ago(job.at)}</span>
                  <Badge tone={job.status === 'done' ? 'bull' : 'bear'}>{job.kind}</Badge>
                  <span className="min-w-0 flex-1 text-muted-foreground">{job.detail}</span>
                  {job.durationMs != null && <span className="text-muted-foreground">{(job.durationMs / 1000).toFixed(1)}s</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {execution.data && (
        <Panel
          title={<span className="flex items-center gap-1.5">{execution.data.diagnosis.severity === 'ok' ? <Activity className="h-3.5 w-3.5 text-bull" /> : <AlertTriangle className="h-3.5 w-3.5 text-warning" />}Execution quality</span>}
          subtitle={execution.data.simulator.note}
          data-testid="autopilot-execution"
        >
          <div className="mb-2 rounded-md border border-border bg-card-2/40 p-2 text-[11px]">
            <p className="font-medium">{execution.data.diagnosis.title} {execution.data.diagnosis.code !== 'ok' && <Badge tone="bear">{execution.data.diagnosis.code}</Badge>}</p>
            <p className="mt-0.5 text-muted-foreground">{execution.data.diagnosis.detail}</p>
            {execution.data.diagnosis.action && <p className="mt-1">{execution.data.diagnosis.action}</p>}
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
            <Stat label="simulated orders" value={String(execution.data.simulator.orders)} />
            <Stat label="fill rate" value={execution.data.simulator.fillRate == null ? '—' : `${(execution.data.simulator.fillRate * 100).toFixed(0)}%`} />
            <Stat label="mean slippage" value={execution.data.simulator.meanSlippageBps == null ? '—' : `${fmtNum(execution.data.simulator.meanSlippageBps, 1)}bps`} />
            <Stat label="mean spread" value={execution.data.simulator.meanSpreadBps == null ? '—' : `${fmtNum(execution.data.simulator.meanSpreadBps, 1)}bps`} />
          </div>
          {execution.data.simOrders.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px]">
              {execution.data.simOrders.slice(0, 10).map((order) => (
                <li key={order.id} className="flex flex-wrap items-center gap-2 border-b border-border/30 pb-0.5">
                  <span className="w-14 text-muted-foreground">{ago(order.at)}</span>
                  <Badge tone={order.state === 'filled' ? 'bull' : order.state === 'rejected' ? 'bear' : 'warning'}>{order.state}</Badge>
                  <span className="font-mono">{order.instId}</span>
                  <span className="text-muted-foreground">{order.side}</span>
                  <span className="text-muted-foreground">slip {fmtNum(order.slippageBps, 1)}bps</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{order.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={<span className="flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5 text-info" />News &amp; macro signal</span>} subtitle={news.data ? `€${news.data.budget.spentEur.toFixed(4)} of €${news.data.budget.budgetEur} used this month` : ''} data-testid="autopilot-news-panel">
          {!news.data?.current ? <EmptyState title="No digest yet">{"Headlines are pulled from public RSS and classified in one batched call on the cheapest capable model."}</EmptyState> : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Badge tone={news.data.current.riskScore > 0.7 ? 'bear' : news.data.current.riskScore > 0.4 ? 'warning' : 'bull'}>risk {(news.data.current.riskScore * 100).toFixed(0)}%</Badge>
                <Badge tone={news.data.current.direction > 0.15 ? 'bull' : news.data.current.direction < -0.15 ? 'bear' : 'neutral'}>tilt {news.data.current.direction.toFixed(2)}</Badge>
                <Badge tone="neutral">event {(news.data.current.eventProximity * 100).toFixed(0)}%</Badge>
                <Badge tone="plain">{news.data.current.model}</Badge>
                <span className="text-muted-foreground">{ago(news.data.current.at)}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{news.data.current.summary}</p>
              <ul className="mt-1.5 space-y-0.5 text-[11px]">
                {news.data.current.headlines.slice(0, 8).map((headline, index) => (
                  <li key={index} className="flex gap-2">
                    <Badge tone={headline.impact === 'high' ? 'bear' : headline.impact === 'medium' ? 'warning' : 'neutral'}>{headline.impact}</Badge>
                    <span className="min-w-0 flex-1 truncate">{headline.title}</span>
                    <span className="text-muted-foreground">{headline.assets.join(' ')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title="Daily post-mortem" subtitle={news.data?.postMortem ? `${news.data.postMortem.model} · ${ago(news.data.postMortem.at)}` : 'written once a day from real attribution data'} data-testid="autopilot-postmortem-panel">
          {news.data?.postMortem ? (
            <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{news.data.postMortem.text}</pre>
          ) : <EmptyState title="No report yet">{"It needs a day of closed trades and arena results to be worth writing."}</EmptyState>}
        </Panel>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card-2/40 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-xs">{value}</p>
    </div>
  )
}
