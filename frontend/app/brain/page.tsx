'use client'

/**
 * THE BRAIN — real deep learning and reinforcement learning, with receipts.
 * LightGBM, a PyTorch MLP and a PPO exit agent, all trained on the same recorded
 * decisions the arena tests, with purged walk-forward validation and an economic
 * metric (net R lift) rather than a calibration proxy.
 */
import { useMemo, useState } from 'react'
import { post, usePoll } from '@/lib/api'
import { Badge, Button, EmptyState, ErrorNote, Panel, Select, Skeleton } from '@/components/ui/kit'
import { ago, fmtNum, fmtR } from '@/lib/format'
import { Brain, Cpu, Play, Square } from 'lucide-react'

interface Job { id: string; kind: string; niche: { playbook: string; instType: string; timeframe: string } | null; status: string; progress: number; message: string; createdAt: number; finishedAt: number | null; error: string | null; result: Record<string, unknown> | null }
interface Model {
  modelId: string; kind: string; nicheKey?: string; champion?: string; usable?: boolean; score?: number; rows?: number
  threshold?: number; savedAt?: number; trainSeconds?: number; featureCount?: number
  metrics?: Record<string, { auc?: number; brier?: number; brierSkill?: number; meanRLift?: number; oosRows?: number; coverage?: number }>
  importance?: { index: number; weight: number }[]
  agentMeanR?: number; baselineMeanR?: number; randomMeanR?: number; meanRLift?: number; episodes?: number
  curve?: { epoch: number; trainMeanR: number; evalMeanR: number }[]
}
interface Payload {
  health: { ok: boolean; reachable: boolean; version?: string; tapeRows?: number; capabilities?: { lightgbm: boolean; torch: boolean }; resources?: { rssMb: number; hostFreeMb: number; load1: number; cpuCount: number; threads: number }; governor?: { maxRssMb: number; lastReason: string }; error?: string; latencyMs?: number }
  jobs: Job[]; running: number; queued: number; models: Model[]; url: string; featureOrder: string[]
  rlAgents: { nicheKey: string; agent: { modelId: string; lift: number; at: number } | null }[]
}

const NICHES: string[] = []
for (const playbook of ['trend_pullback', 'volatility_breakout', 'range_fade']) {
  for (const instType of ['SWAP', 'SPOT']) for (const timeframe of ['15m', '30m', '1H', '4H']) NICHES.push(`${playbook}|${instType}|${timeframe}`)
}

export default function BrainPage() {
  const { data, error, loading, refresh } = usePoll<Payload>('/brain?limit=30', 5000)
  const [niche, setNiche] = useState(NICHES[3])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const tabular = useMemo(() => (data?.models ?? []).filter((model) => model.kind === 'tabular'), [data])
  const agents = useMemo(() => (data?.models ?? []).filter((model) => model.kind === 'rl_exit'), [data])

  const train = async (kind: 'tabular' | 'rl') => {
    const [playbook, instType, timeframe] = niche.split('|')
    setBusy(true)
    setNote(null)
    try {
      const result = await post<{ jobId: string }>('/brain/train', { kind, playbook, instType, timeframe })
      setNote(`${kind} job ${result.jobId} queued`)
      await refresh()
    } catch (issue) {
      setNote(issue instanceof Error ? issue.message : String(issue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-24 pt-3 sm:px-4 md:pb-6 lg:px-6" data-testid="brain-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-1.5 text-base font-semibold tracking-tight"><Brain className="h-4 w-4 text-info" />Deep brain</h1>
        <Badge tone={data?.health.reachable ? 'bull' : 'bear'} data-testid="brain-status">{data?.health.reachable ? `online ${data.health.version ?? ''}` : `offline: ${data?.health.error ?? 'unreachable'}`}</Badge>
        {data?.health.capabilities && <Badge tone="neutral">lightgbm {data.health.capabilities.lightgbm ? 'yes' : 'no'} · torch {data.health.capabilities.torch ? 'yes' : 'no'}</Badge>}
        {data?.health.resources && <Badge tone="plain"><Cpu className="h-3 w-3" />{data.health.resources.rssMb}MB · load {data.health.resources.load1} · {data.health.resources.threads} threads</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select value={niche} onChange={(event) => setNiche(event.target.value)} data-testid="brain-niche-select">
            {NICHES.map((key) => <option key={key} value={key}>{key.replace(/\|/g, ' · ')}</option>)}
          </Select>
          <Button variant="primary" disabled={busy || !data?.health.reachable} onClick={() => void train('tabular')} data-testid="brain-train-tabular"><Play className="h-3 w-3" />train GBM + MLP</Button>
          <Button variant="primary" disabled={busy || !data?.health.reachable} onClick={() => void train('rl')} data-testid="brain-train-rl"><Play className="h-3 w-3" />train PPO exit agent</Button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {note && <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="brain-note">{note}</p>}
      {loading && !data && <Skeleton className="h-40" />}

      <Panel title="Training jobs" subtitle={`${data?.running ?? 0} running · ${data?.queued ?? 0} queued · tape ${data?.health.tapeRows ?? 0} decisions`} data-testid="brain-jobs">
        {!data?.jobs.length ? <EmptyState title="No job yet">{"The orchestrator queues training automatically once a niche has enough recorded decisions, or you can trigger one above."}</EmptyState> : (
          <div className="space-y-1.5">
            {data.jobs.map((job) => (
              <div key={job.id} className="rounded-md border border-border bg-card-2/40 p-2 text-[11px]" data-testid={`brain-job-${job.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={job.status === 'done' ? 'bull' : job.status === 'failed' ? 'bear' : job.status === 'running' ? 'info' : 'neutral'}>{job.status}</Badge>
                  <span className="font-mono">{job.kind}</span>
                  {job.niche && <span className="text-muted-foreground">{`${job.niche.playbook} · ${job.niche.instType} · ${job.niche.timeframe}`}</span>}
                  <span className="text-muted-foreground">{ago(job.createdAt)}</span>
                  <span className="ml-auto truncate text-muted-foreground">{job.message}</span>
                  {(job.status === 'running' || job.status === 'queued') && (
                    <Button variant="ghost" size="icon" onClick={() => void post('/brain/cancel', { jobId: job.id }).then(() => refresh())} aria-label="cancel"><Square className="h-3 w-3" /></Button>
                  )}
                </div>
                {job.status === 'running' && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-muted"><div className="h-full bg-info transition-all" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
                )}
                {job.error && <p className="mt-1 text-bear">{job.error}</p>}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Supervised models" subtitle="purged walk-forward · judged on net R lift, not log loss" data-testid="brain-models">
          {!tabular.length ? <EmptyState title="No supervised model yet" /> : (
            <div className="space-y-2">
              {tabular.slice(0, 12).map((model) => (
                <div key={model.modelId} className="rounded-md border border-border bg-card-2/40 p-2 text-[11px]" data-testid={`brain-model-${model.modelId}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={model.usable ? 'bull' : 'warning'}>{model.usable ? 'usable' : 'not usable'}</Badge>
                    <span className="font-mono">{model.modelId}</span>
                    <span className="text-muted-foreground">{model.nicheKey?.replace(/\|/g, ' · ')}</span>
                    <span className="ml-auto text-muted-foreground">{ago(model.savedAt)} · {fmtNum(model.trainSeconds, 1)}s</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.entries(model.metrics ?? {}).map(([name, metric]) => (
                      <Badge key={name} tone={name === model.champion ? 'info' : 'neutral'} title={`brier ${fmtNum(metric.brier, 4)} · coverage ${fmtNum((metric.coverage ?? 0) * 100, 0)}%`}>
                        {name}: auc {fmtNum(metric.auc, 3)} · lift {fmtR(metric.meanRLift)}
                      </Badge>
                    ))}
                  </div>
                  {model.importance?.length ? (
                    <p className="mt-1 truncate text-muted-foreground">top features: {model.importance.slice(0, 6).map((row) => data?.featureOrder[row.index] ?? row.index).join(', ')}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="PPO exit agents" subtitle="reinforcement learning on real recorded price paths" data-testid="brain-agents">
          {!agents.length ? <EmptyState title="No exit agent yet">{"The agent learns trade management: hold, scale out, move to break-even, trail, or close."}</EmptyState> : (
            <div className="space-y-2">
              {agents.slice(0, 10).map((model) => (
                <div key={model.modelId} className="rounded-md border border-border bg-card-2/40 p-2 text-[11px]" data-testid={`brain-agent-${model.modelId}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={model.usable ? 'bull' : 'warning'}>{model.usable ? 'beats the plan' : 'not usable'}</Badge>
                    <span className="font-mono">{model.modelId}</span>
                    <span className="text-muted-foreground">{model.nicheKey?.replace(/\|/g, ' · ')}</span>
                    <span className="ml-auto text-muted-foreground">{ago(model.savedAt)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={(model.agentMeanR ?? 0) >= 0 ? 'bull' : 'bear'}>agent {fmtR(model.agentMeanR)}</Badge>
                    <Badge tone="neutral">plan exit {fmtR(model.baselineMeanR)}</Badge>
                    <Badge tone="neutral">untrained {fmtR(model.randomMeanR)}</Badge>
                    <Badge tone="plain">{model.episodes ?? 0} episodes</Badge>
                  </div>
                  {model.curve?.length ? (
                    <p className="mt-1 truncate font-mono text-muted-foreground">eval curve: {model.curve.map((point) => point.evalMeanR.toFixed(2)).join(' → ')}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
