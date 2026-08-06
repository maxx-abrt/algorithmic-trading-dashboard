'use client'

import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import type { ChampionResponse, ResearchState } from '@/lib/types'
import { Badge, Button, EmptyState, NumberInput, Panel, Row, Select } from '@/components/ui/kit'
import { ago, fmtR, titleCase } from '@/lib/format'
import { Beaker, Loader2, Play, ShieldAlert, TrendingUp, RotateCcw, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

export default function ResearchPage() {
  const research = usePoll<ResearchState>('/research', 8000)
  const champion = usePoll<ChampionResponse>('/research/champion', 8000)
  const [timeframe, setTimeframe] = useState<'5m' | '15m' | '1H'>('15m')
  const [evaluations, setEvaluations] = useState(40)
  const [hypothesis, setHypothesis] = useState('Explicit playbooks retain positive net R across purged chronological folds and a held-out symbol.')
  const [running, setRunning] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [retraining, setRetraining] = useState(false)

  const run = async () => {
    setRunning(true)
    try {
      const result = await post<{ validationState: string; promotionReasons: string[] }>('/research/run', {
        timeframe, maxEvaluations: evaluations, hypothesis, symbols: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'],
      })
      toast.success(`${result.validationState}: ${result.promotionReasons.length ? result.promotionReasons.join(', ') : 'passed shadow gates'}`)
      await Promise.all([research.refresh(), champion.refresh()])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Research campaign failed') }
    finally { setRunning(false) }
  }

  const promote = async (modelId: string) => {
    setPromoting(true)
    try {
      await post('/research/promote', { modelId })
      toast.success(`Promoted ${modelId} to paper champion`)
      await Promise.all([research.refresh(), champion.refresh()])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Promotion failed') }
    finally { setPromoting(false) }
  }

  const rollback = async () => {
    setRollingBack(true)
    try {
      const result = await post<{ ok: boolean; fallback: string }>('/research/rollback', { reason: 'manual_rollback' })
      toast.success(`Rolled back: ${result.fallback}`)
      await Promise.all([research.refresh(), champion.refresh()])
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Rollback failed') }
    finally { setRollingBack(false) }
  }

  const retrain = async () => {
    setRetraining(true)
    try {
      const result = await post<{ accepted: boolean; reason: string }>('/research/retrain')
      if (result.accepted) toast.success(`Retrained: ${result.reason}`)
      else toast.error(`Retrain rejected: ${result.reason}`)
      await champion.refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Retrain failed') }
    finally { setRetraining(false) }
  }

  const data = research.data
  const champ = champion.data
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-4" title="Bounded campaign" subtitle={champ?.championModel?.modelId ? `champion ${champ.championModel.version} live` : 'no champion — heuristic baseline active'}>
          <div className="space-y-3">
            <label className="block"><span className="mb-1 block text-[11px] text-muted-foreground">Hypothesis</span><textarea value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} className="min-h-24 w-full rounded-md border border-border bg-background p-2 text-xs focus:border-ring focus:outline-none" data-testid="research-hypothesis-input" /></label>
            <div className="grid grid-cols-2 gap-3"><label><span className="mb-1 block text-[11px] text-muted-foreground">Timeframe</span><Select value={timeframe} onChange={(event) => setTimeframe(event.target.value as typeof timeframe)} data-testid="research-timeframe-select"><option>5m</option><option>15m</option><option>1H</option></Select></label><label><span className="mb-1 block text-[11px] text-muted-foreground">Max evaluations / symbol</span><NumberInput min={12} max={80} value={evaluations} onChangeValue={setEvaluations} data-testid="research-evaluations-input" /></label></div>
            <div className="rounded border border-border bg-card-2/50 p-2 text-[10px] leading-relaxed text-muted-foreground">Fixed universe: BTC and ETH perpetuals. Confirmed candles only. Purge + embargo: 12 bars. Held-out symbol gate required. Maximum 80 evaluations per symbol. Automatic campaigns: {data?.schedule.enabled ? `every ${data.schedule.intervalHours}h` : 'disabled'}.</div>
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
        <Panel className="xl:col-span-4" title="Champion lifecycle" data-testid="champion-lifecycle-panel">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            <Badge tone={champ?.championModel?.modelId ? 'bull' : 'warning'}>{champ?.championModel?.version ?? 'heuristic-baseline'}</Badge>
          </div>
          {champ?.championModel?.modelId ? (
            <>
              <div className="mt-3 grid grid-cols-2 gap-x-4">
                <Row label="live mean R" value={champ.health?.meanR != null ? fmtR(champ.health.meanR) : '—'} tone={champ.health?.meanR != null && champ.health.meanR > 0 ? 'bull' : 'bear'} />
                <Row label="live win rate" value={champ.health?.winRate != null ? `${(champ.health.winRate * 100).toFixed(0)}%` : '—'} />
                <Row label="live trades" value={String(champ.health?.trades ?? 0)} />
                <Row label="max DD" value={champ.health?.maxDrawdownR != null ? fmtR(-champ.health.maxDrawdownR) : '—'} />
                <Row label="training rows" value={String(champ.trainingRows ?? 0)} />
                <Row label="rollback" value={champ.health?.shouldRollback ? 'triggered' : 'ok'} tone={champ.health?.shouldRollback ? 'bear' : 'bull'} />
              </div>
              {champ.health?.reason && <p className="mt-2 text-[10px] text-muted-foreground">{champ.health.reason}</p>}
              <div className="mt-3 flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={retrain} disabled={retraining} data-testid="retrain-button">{retraining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}Retrain</Button>
                <Button variant="secondary" className="flex-1" onClick={rollback} disabled={rollingBack} data-testid="rollback-button">{rollingBack ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Rollback</Button>
              </div>
            </>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">No champion model is live. The system uses the heuristic baseline. Run a campaign to produce a shadow candidate, which will enter canary automatically if it passes gates.</p>
          )}
          {champ?.canary && (
            <div className="mt-3 rounded border border-warning/30 bg-warning/10 p-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-warning">Canary in progress</span>
                <Badge tone="warning">{String(champ.canary.version ?? '?')}</Badge>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-4">
                <Row label="canary trades" value={String(champ.canaryTrades ?? 0)} />
                <Row label="min for promote" value="20" />
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        <Panel className="xl:col-span-12" title="Promotion state" data-testid="advisory-model-state">
          <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-warning" /><Badge tone={data?.validationState === 'VALIDATED' ? 'bull' : 'warning'}>{data?.validationState ?? 'NO_VALIDATED_MODEL'}</Badge></div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">A model enters shadow state after sample, bootstrap, deflated Sharpe, drawdown and held-out gates pass. Shadow candidates are auto-evaluated for canary promotion against the current champion.</p>
          <div className="mt-3 space-y-2">{data?.models.slice(0, 5).map((model) => <div key={model.id} className="rounded border border-border p-2"><div className="flex justify-between"><span className="num text-[10px]">{model.version}</span><div className="flex items-center gap-1"><Badge tone={model.state === 'shadow_candidate' ? 'info' : model.state === 'paper_champion' ? 'bull' : model.state === 'paper_canary' ? 'warning' : 'neutral'}>{titleCase(model.state)}</Badge>{model.state === 'shadow_candidate' && <Button variant="ghost" className="h-5 px-2 text-[10px]" onClick={() => promote(model.id)} disabled={promoting} data-testid={`promote-${model.id}`}>Promote</Button>}</div></div>{model.rollback_reason && <p className="mt-1 text-[10px] text-muted-foreground">{model.rollback_reason}</p>}</div>)}</div>
        </Panel>
      </div>
    </div>
  )
}
