'use client'

import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import type { ResearchState } from '@/lib/types'
import { Badge, Button, EmptyState, NumberInput, Panel, Row, Select } from '@/components/ui/kit'
import { ago, fmtR, titleCase } from '@/lib/format'
import { Beaker, Loader2, Play, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'

export default function ResearchPage() {
  const research = usePoll<ResearchState>('/research', 8000)
  const [timeframe, setTimeframe] = useState<'5m' | '15m' | '1H'>('15m')
  const [evaluations, setEvaluations] = useState(40)
  const [hypothesis, setHypothesis] = useState('Explicit playbooks retain positive net R across purged chronological folds and a held-out symbol.')
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true)
    try {
      const result = await post<{ validationState: string; promotionReasons: string[] }>('/research/run', {
        timeframe, maxEvaluations: evaluations, hypothesis, symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
      })
      toast.success(`${result.validationState}: ${result.promotionReasons.length ? result.promotionReasons.join(', ') : 'passed shadow gates'}`)
      await research.refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Research campaign failed') }
    finally { setRunning(false) }
  }

  const data = research.data
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-4" title="Bounded campaign" subtitle="preregister, run, reject or shadow — never auto-promote to trading">
          <div className="space-y-3">
            <label className="block"><span className="mb-1 block text-[11px] text-muted-foreground">Hypothesis</span><textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-xs focus:border-ring focus:outline-none" data-testid="research-hypothesis-input" /></label>
            <div className="grid grid-cols-2 gap-3"><label><span className="mb-1 block text-[11px] text-muted-foreground">Timeframe</span><Select value={timeframe} onChange={(event) => setTimeframe(event.target.value as typeof timeframe)} data-testid="research-timeframe-select"><option>5m</option><option>15m</option><option>1H</option></Select></label><label><span className="mb-1 block text-[11px] text-muted-foreground">Max evaluations / symbol</span><NumberInput min={12} max={80} value={evaluations} onChangeValue={setEvaluations} data-testid="research-evaluations-input" /></label></div>
            <div className="rounded border border-border bg-card-2/50 p-2 text-[10px] leading-relaxed text-muted-foreground">Fixed universe: BTC and ETH perpetuals. Confirmed candles only. Purge + embargo: 12 bars. Held-out symbol gate required. Maximum 80 evaluations per symbol.</div>
            <Button className="w-full" variant="primary" onClick={run} disabled={running || !data?.governor.allowed} data-testid="run-backtest-button">{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Run real-data campaign</Button>
            {data?.governor && <div className="grid grid-cols-2 gap-x-4"><Row label="RSS" value={`${data.governor.rssMb.toFixed(0)} MB`} /><Row label="load" value={data.governor.load1.toFixed(2)} /><Row label="governor" value={data.governor.allowed ? 'ready' : data.governor.reasons.join(', ')} tone={data.governor.allowed ? 'bull' : 'warning'} /></div>}
          </div>
        </Panel>

        <Panel className="xl:col-span-8" title="Research registry" subtitle={`${data?.campaigns.length ?? 0} campaigns · ${data?.trials.length ?? 0} trials · immutable manifests`} bodyClassName="p-0">
          {!data?.campaigns.length ? <EmptyState icon={<Beaker className="h-6 w-6" />} title="No campaign has run yet">The system starts with no validated edge. Run a bounded campaign to collect evidence without changing live decisions.</EmptyState> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] border-collapse" data-testid="research-campaign-table"><thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground"><th className="px-3 py-2 text-left">Created</th><th className="px-3 py-2 text-left">Campaign</th><th className="px-3 py-2 text-left">Status</th><th className="px-3 py-2 text-left">Hypothesis</th><th className="px-3 py-2 text-right">Trials</th></tr></thead><tbody>{data.campaigns.map((campaign) => { const id = String(campaign.id); return <tr key={id} className="border-b border-border/50"><td className="num px-3 py-2 text-[10px] text-muted-foreground">{ago(Number(campaign.created_at))}</td><td className="num px-3 py-2 text-[10px]">{id.slice(0, 24)}</td><td className="px-3 py-2"><Badge tone={campaign.status === 'completed' ? 'bull' : campaign.status === 'failed' ? 'bear' : 'warning'}>{String(campaign.status)}</Badge></td><td className="max-w-md px-3 py-2 text-[11px]">{String(campaign.hypothesis)}</td><td className="num px-3 py-2 text-right text-xs">{data.trials.filter((trial) => trial.campaign_id === id).length}</td></tr>})}</tbody></table></div>}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-8" title="Trial evidence" subtitle="null means insufficient evidence, never zero-filled">
          {!data?.trials.length ? <p className="py-8 text-center text-xs text-muted-foreground">No trial metrics yet.</p> : <div className="grid gap-3 md:grid-cols-2">{data.trials.slice(0, 8).map((trial) => { const m = trial.metrics_json; return <article key={trial.id} className="rounded-lg border border-border bg-card-2/40 p-3"><div className="flex justify-between gap-2"><span className="num text-[10px]">{trial.id.split(':').at(-1)}</span><Badge tone={trial.status === 'completed' ? 'bull' : 'warning'}>{trial.status}</Badge></div><div className="mt-2 grid grid-cols-2 gap-x-5"><Row label="sample" value={String(m.sample ?? 0)} /><Row label="mean R" value={m.meanR == null ? 'insufficient' : fmtR(Number(m.meanR))} /><Row label="win rate" value={m.winRate == null ? 'insufficient' : `${(Number(m.winRate) * 100).toFixed(1)}%`} /><Row label="max DD" value={m.maxDrawdownR == null ? '—' : fmtR(-Number(m.maxDrawdownR))} /><Row label="deflated Sharpe" value={m.deflatedSharpe == null ? 'insufficient' : Number(m.deflatedSharpe).toFixed(2)} /><Row label="folds" value={String(m.folds ?? 0)} /></div></article>})}</div>}
        </Panel>
        <Panel className="xl:col-span-4" title="Promotion state" data-testid="advisory-model-state">
          <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-warning" /><Badge tone={data?.validationState === 'VALIDATED' ? 'bull' : 'warning'}>{data?.validationState ?? 'NO_VALIDATED_MODEL'}</Badge></div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">A model can only enter shadow state after sample, bootstrap lower bound, deflated Sharpe, drawdown and held-out-symbol gates pass. This interface cannot promote a model into live execution because no execution capability exists.</p>
          <div className="mt-3 space-y-2">{data?.models.slice(0, 5).map((model) => <div key={model.id} className="rounded border border-border p-2"><div className="flex justify-between"><span className="num text-[10px]">{model.version}</span><Badge tone={model.state === 'shadow_candidate' ? 'info' : 'neutral'}>{titleCase(model.state)}</Badge></div>{model.rollback_reason && <p className="mt-1 text-[10px] text-muted-foreground">{model.rollback_reason}</p>}</div>)}</div>
        </Panel>
      </div>
    </div>
  )
}
