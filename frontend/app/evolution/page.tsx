'use client'

/**
 * EVOLUTION — the population, its lineage and whether generations actually improve.
 * Every specialist here shipped with an arena result: an out-of-sample equity curve
 * over recorded decisions. Promotion to champion additionally requires forward
 * evidence from real closed trades.
 */
import { useMemo, useState } from 'react'
import { post, usePoll } from '@/lib/api'
import { Badge, Button, EmptyState, ErrorNote, Panel, Select, Skeleton } from '@/components/ui/kit'
import { ago, fmtNum, fmtR } from '@/lib/format'
import { Dna, GitBranch, Play, Sparkles } from 'lucide-react'

interface Skills { badges: string[]; regimes: { key: number; label: string; trades: number; meanR: number }[]; sessions: { key: string; trades: number; meanR: number }[]; symbols: { key: string; trades: number; meanR: number }[] }
interface Specialist {
  artifactHash: string; shortHash: string; nicheKey: string; nicheLabel: string; playbook: string; instType: string; timeframe: string
  backend: string; brainModelId: string | null; generation: number; parentHash: string | null; displayName: string; lifecycle: string
  createdAt: number; promotedAt: number | null
  arena: { verdict: string | null; meanR: number | null; meanRLift: number | null; oosTrades: number | null; foldsPositive: number | null; foldsTotal: number | null; sharpe: number | null; maxDrawdownR: number | null; pValue: number | null; at: number | null; runId: number | null }
  live: { trades: number; meanR: number | null; winRate: number | null; maxDrawdownR: number | null; sumR: number | null }
  skills: Skills | null
  genome: { featureMask?: string; l2?: number; exitVariantId?: string; thresholdQuantile?: number; backend?: string }
  metrics: { fitness?: number; featuresUsed?: number; trials?: number; placeboFitness?: number | null; parentFitness?: number | null }
  trials: number; placeboScore: number | null; rejectionReason: string | null
}
interface Payload {
  summary: { specialists: number; champions: number; canaries: number; shadows: number; retired: number; topGeneration: number; withArenaEdge: number }
  validationState: string
  specialists: Specialist[]
  generations: { nicheKey: string; generation: number; born: number; bestLift: number; meanLift: number; bestSharpe: number }[]
  events: { id: number; at: number; type: string; nicheKey: string | null; detail: string }[]
  coverage: { nicheKey: string; rows: number; symbols: number }[]
  targetNiches: string[]
  legacy: { specialists: number; note: string }
}

const LIFECYCLE_TONE: Record<string, 'bull' | 'info' | 'neutral' | 'warning' | 'bear'> = { champion: 'bull', canary: 'info', shadow: 'neutral', retired: 'warning', rejected: 'bear' }

export default function EvolutionPage() {
  const { data, error, loading, refresh } = usePoll<Payload>('/population?limit=300', 8000)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [niche, setNiche] = useState('')

  const breedable = useMemo(() => (data?.coverage ?? []).filter((row) => row.rows >= 200).sort((a, b) => b.rows - a.rows), [data])
  const selected = niche || breedable[0]?.nicheKey || ''
  const missing = useMemo(() => (data?.targetNiches ?? []).filter((key) => !(data?.coverage ?? []).some((row) => row.nicheKey === key && row.rows >= 200)), [data])

  const act = async (kind: string, payload: Record<string, unknown>) => {
    setBusy(true)
    setNote(null)
    try {
      const result = await post<{ detail?: string; inserted?: number }>('/orchestrator/run', { kind, ...payload })
      setNote(result.detail ?? `${result.inserted ?? 0} decisions recorded`)
      await refresh()
    } catch (issue) {
      setNote(issue instanceof Error ? issue.message : String(issue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-24 pt-3 sm:px-4 md:pb-6 lg:px-6" data-testid="evolution-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-1.5 text-base font-semibold tracking-tight"><Dna className="h-4 w-4 text-info" />Evolution</h1>
        <Badge tone={data?.validationState === 'VALIDATED' ? 'bull' : data?.validationState === 'ARENA_VALIDATED_PENDING_FORWARD' ? 'info' : 'warning'} data-testid="validation-state">
          {data?.validationState ?? '—'}
        </Badge>
        <Badge tone="neutral">{data?.summary.specialists ?? 0} born · {data?.summary.champions ?? 0} champions · {data?.summary.canaries ?? 0} canaries · gen {data?.summary.topGeneration ?? 0}</Badge>
        <Badge tone="info">{data?.summary.withArenaEdge ?? 0} with proven arena edge</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select value={selected} onChange={(event) => setNiche(event.target.value)} data-testid="evolution-niche-select">
            {breedable.map((row) => <option key={row.nicheKey} value={row.nicheKey}>{row.nicheKey.replace(/\|/g, ' · ')} ({row.rows})</option>)}
          </Select>
          <Button variant="primary" disabled={busy || !selected} onClick={() => { const [playbook, instType, timeframe] = selected.split('|'); void act('breed', { playbook, instType, timeframe }) }} data-testid="evolution-breed">
            <Sparkles className="h-3 w-3" />{busy ? 'working…' : 'evolve now'}
          </Button>
          <Button disabled={busy} onClick={() => void act('tape_build', {})} data-testid="evolution-harvest"><Play className="h-3 w-3" />record evidence</Button>
          <Button disabled={busy} onClick={() => void act('lifecycle', {})} data-testid="evolution-lifecycle">promote / demote</Button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {note && <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="evolution-note">{note}</p>}
      {loading && !data && <Skeleton className="h-40" />}

      {missing.length > 0 && (
        <Panel title="Coverage gaps" subtitle="these niches cannot produce a specialist until they have recorded decisions" data-testid="evolution-gaps">
          <div className="flex flex-wrap gap-1.5">
            {missing.map((key) => <Badge key={key} tone="warning">{key.replace(/\|/g, ' · ')}</Badge>)}
          </div>
        </Panel>
      )}

      {data?.generations.length ? (
        <Panel title={<span className="flex items-center gap-1.5"><GitBranch className="h-3.5 w-3.5 text-info" />Generation-over-generation improvement</span>} subtitle="best out-of-sample net R lift per generation, per niche" data-testid="evolution-generations">
          <div className="-mx-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[11px]">
              <thead className="text-muted-foreground"><tr className="border-b border-border"><th className="px-3 py-1.5">niche</th><th className="px-2 py-1.5">gen</th><th className="px-2 py-1.5 text-right">born</th><th className="px-2 py-1.5 text-right">best lift</th><th className="px-2 py-1.5 text-right">mean lift</th><th className="px-2 py-1.5 text-right">best sharpe</th></tr></thead>
              <tbody>
                {data.generations.map((row) => (
                  <tr key={`${row.nicheKey}-${row.generation}`} className="border-b border-border/40">
                    <td className="px-3 py-1 font-mono">{row.nicheKey.replace(/\|/g, ' · ')}</td>
                    <td className="px-2 py-1">G{row.generation}</td>
                    <td className="px-2 py-1 text-right font-mono">{row.born}</td>
                    <td className={`px-2 py-1 text-right font-mono ${row.bestLift >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtR(row.bestLift)}</td>
                    <td className="px-2 py-1 text-right font-mono text-muted-foreground">{fmtR(row.meanLift)}</td>
                    <td className="px-2 py-1 text-right font-mono">{fmtNum(row.bestSharpe, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Specialists" subtitle="every model, the arena evidence it shipped with, and its real forward record" data-testid="evolution-specialists">
        {!data?.specialists.length ? (
          <EmptyState title="No specialist yet">{"The orchestrator records decisions first, then breeds and arena-tests policies. Press 'record evidence' then 'evolve now' to force the cycle."}</EmptyState>
        ) : (
          <div className="space-y-2">
            {data.specialists.map((row) => (
              <div key={row.artifactHash} className="rounded-md border border-border bg-card-2/40 p-2 text-[11px]" data-testid={`specialist-${row.shortHash}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={LIFECYCLE_TONE[row.lifecycle] ?? 'neutral'}>{row.lifecycle}</Badge>
                  <span className="font-medium">{row.displayName}</span>
                  <span className="text-muted-foreground">{row.nicheLabel}</span>
                  <Badge tone="plain">G{row.generation}</Badge>
                  <Badge tone={row.backend === 'brain' ? 'info' : 'neutral'}>{row.backend}</Badge>
                  {row.genome.exitVariantId && <Badge tone="neutral">exit {row.genome.exitVariantId}</Badge>}
                  <span className="ml-auto text-muted-foreground">{ago(row.createdAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={row.arena.verdict === 'edge' ? 'bull' : 'warning'}>arena {row.arena.verdict ?? '—'}</Badge>
                  <Badge tone={(row.arena.meanRLift ?? 0) > 0 ? 'bull' : 'bear'}>lift {fmtR(row.arena.meanRLift)}</Badge>
                  <Badge tone="neutral">mean {fmtR(row.arena.meanR)}</Badge>
                  <Badge tone="neutral">{row.arena.oosTrades ?? 0} OOS trades</Badge>
                  <Badge tone="neutral">{row.arena.foldsPositive ?? 0}/{row.arena.foldsTotal ?? 0} folds</Badge>
                  <Badge tone="neutral">sharpe {fmtNum(row.arena.sharpe, 2)}</Badge>
                  <Badge tone="neutral">dd {fmtNum(row.arena.maxDrawdownR, 1)}R</Badge>
                  <Badge tone="neutral">p {fmtNum(row.arena.pValue, 3)}</Badge>
                  <Badge tone={row.live.trades > 0 ? ((row.live.meanR ?? 0) >= 0 ? 'bull' : 'bear') : 'neutral'}>
                    forward {row.live.trades ? `${row.live.trades} trades ${fmtR(row.live.meanR)}` : 'no trades yet'}
                  </Badge>
                  {row.metrics.featuresUsed != null && <Badge tone="plain">{row.metrics.featuresUsed} features</Badge>}
                  {row.placeboScore != null && <Badge tone="neutral" title="fitness of the identical search on shuffled features">placebo {fmtNum(row.placeboScore, 2)}</Badge>}
                </div>
                {row.skills?.badges?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {row.skills.badges.map((badge) => <Badge key={badge} tone="info">{badge}</Badge>)}
                  </div>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {row.lifecycle !== 'champion' && (
                    <Button variant="ghost" onClick={() => void post('/population/lifecycle', { artifactHash: row.artifactHash, lifecycle: 'champion' }).then(() => refresh())} data-testid={`promote-${row.shortHash}`}>promote</Button>
                  )}
                  {row.lifecycle !== 'retired' && (
                    <Button variant="ghost" onClick={() => void post('/population/lifecycle', { artifactHash: row.artifactHash, lifecycle: 'retired' }).then(() => refresh())} data-testid={`retire-${row.shortHash}`}>retire</Button>
                  )}
                  {row.rejectionReason && <span className="text-warning">{row.rejectionReason}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Population timeline" subtitle="births, promotions, rollbacks and honest rejections — kept forever" data-testid="evolution-timeline">
        {!data?.events.length ? <EmptyState title="No event yet" /> : (
          <ul className="space-y-1 text-[11px]">
            {data.events.map((event) => (
              <li key={event.id} className="flex gap-2 border-b border-border/30 pb-1">
                <span className="w-16 shrink-0 text-muted-foreground">{ago(event.at)}</span>
                <Badge tone={event.type === 'promoted' || event.type === 'born' ? 'bull' : event.type === 'rejected' || event.type === 'brain_rejected' ? 'neutral' : 'warning'}>{event.type}</Badge>
                <span className="min-w-0 flex-1 text-muted-foreground">{event.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {data?.legacy.specialists ? <p className="text-[11px] text-muted-foreground">{data.legacy.specialists} legacy v2 specialists exist in the database. {data.legacy.note}</p> : null}
    </div>
  )
}
