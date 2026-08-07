'use client'

import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import type { ResearchState } from '@/lib/types'
import type { HarvestState } from '@/lib/evolution'
import { fmtR, niceNiche } from '@/lib/evolution'
import { Badge, Button, EmptyState, ErrorNote, Gauge, Panel, Row, Select, Skeleton } from '@/components/ui/kit'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FlaskConical, Sprout } from 'lucide-react'
import { toast } from 'sonner'

const CAMPAIGN_TYPES = [
  'baseline',
  'spot_swap',
  'multi_symbol',
  'timeframe_sweep',
  'ensemble',
  'triple_barrier',
  'feature_rich',
  'high_conviction',
  'low_conviction',
  'regime_aware',
]

export default function ResearchPage() {
  const research = usePoll<ResearchState>('/research', 10000)
  const harvest = usePoll<HarvestState>('/harvest', 5000)
  const [type, setType] = useState('baseline')
  const [busy, setBusy] = useState(false)

  const call = async (path: string, payload: unknown, label: string) => {
    setBusy(true)
    try {
      await post(path, payload)
      toast.success(label)
      await Promise.all([research.refresh(), harvest.refresh()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const progress = harvest.data?.progress

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-3 p-3 pb-24 sm:p-4 md:pb-4" data-testid="research-page">
      {research.error && <ErrorNote message={research.error} />}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Harvest real history"
          subtitle="replays confirmed OKX bars through the exact live pipeline to create point-in-time training samples"
          data-testid="harvest-panel"
          actions={
            <Button variant="primary" disabled={busy || progress?.running} onClick={() => void call('/harvest/run', { perType: 6, timeframes: ['15m', '1H'], barsPerSymbol: 900 }, 'Harvest started')} data-testid="harvest-run">
              <Sprout className="h-3.5 w-3.5" /> {progress?.running ? 'running' : 'start harvest'}
            </Button>
          }
        >
          {!progress ? (
            <Skeleton className="h-20" />
          ) : (
            <>
              <Row label="lifetime samples harvested" value={progress.totalSamplesEver} />
              <Row label="last run" value={harvest.data?.last ? `${harvest.data.last.samples} samples` : '—'} hint={harvest.data?.last ? ago(harvest.data.last.at) : undefined} />
              {progress.running && (
                <div className="mt-2 space-y-1">
                  <Gauge value={(progress.seriesDone / Math.max(1, progress.seriesTotal)) * 100} tone="info" />
                  <p className="truncate text-[10px] text-muted-foreground">
                    {progress.current} · {progress.seriesDone}/{progress.seriesTotal} series · {progress.samples} new samples
                  </p>
                </div>
              )}
              {progress.lastError && <p className="mt-1 break-words text-[10px] text-warning">{progress.lastError}</p>}
              <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
                Every decision only sees bars that closed before its own timestamp, and every sample records when its label became knowable, so overlapping labels can be purged during training.
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="Validation campaign"
          subtitle="purged walk-forward, held-out symbol, bootstrap bound and deflated Sharpe"
          data-testid="campaign-panel"
          actions={
            <Button variant="secondary" disabled={busy} onClick={() => void call('/research/run', { type }, 'Campaign finished')} data-testid="campaign-run">
              <FlaskConical className="h-3.5 w-3.5" /> run
            </Button>
          }
        >
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium">Campaign type</span>
            <Select value={type} onChange={(event) => setType(event.target.value)} data-testid="campaign-type">
              {CAMPAIGN_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </label>
          {research.data && (
            <div className="pt-2">
              <Row label="campaigns run" value={research.data.campaigns.length} />
              <Row label="trials recorded" value={research.data.trials.length} />
              <Row
                label="governor"
                value={<Badge tone={research.data.governor.allowed ? 'bull' : 'warning'}>{research.data.governor.allowed ? 'capacity available' : research.data.governor.reasons.join(', ')}</Badge>}
                mono={false}
              />
            </div>
          )}
        </Panel>
      </div>

      {harvest.data?.niches?.length ? (
        <Panel title="Evidence per niche" subtitle="where the system currently has enough resolved outcomes to learn" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Niche</th>
                  <th className="px-2 py-2 text-right">Samples</th>
                  <th className="px-2 py-2 text-right">Win rate</th>
                  <th className="px-2 py-2 text-right">Cumulative</th>
                  <th className="px-3 py-2">Newest sample</th>
                </tr>
              </thead>
              <tbody>
                {harvest.data.niches.map((niche) => (
                  <tr key={niche.nicheKey} className="border-b border-border/50">
                    <td className="px-3 py-2">{niceNiche(niche.nicheKey)}</td>
                    <td className="num px-2 py-2 text-right">{niche.samples}</td>
                    <td className="num px-2 py-2 text-right">{niche.samples ? `${((niche.wins / niche.samples) * 100).toFixed(0)}%` : '—'}</td>
                    <td className={cn('num px-2 py-2 text-right', niche.sumR > 0 ? 'text-bull' : 'text-bear')}>{fmtR(niche.sumR, 1)}</td>
                    <td className="px-3 py-2 text-[10px] text-muted-foreground">{niche.lastAt ? ago(niche.lastAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Campaign history" subtitle="a rejection is a valid result and is kept forever" bodyClassName="p-0">
        {!research.data ? (
          <Skeleton className="h-24" />
        ) : !research.data.campaigns.length ? (
          <EmptyState icon={<FlaskConical className="h-8 w-8" />} title="No campaign has run yet" />
        ) : (
          <ul className="divide-y divide-border/50">
            {research.data.campaigns.slice(0, 20).map((campaign) => (
              <li key={String(campaign.id)} className="px-3 py-2" data-testid={`campaign-${campaign.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={String(campaign.status) === 'completed' ? 'bull' : String(campaign.status) === 'failed' ? 'bear' : 'warning'}>{String(campaign.status)}</Badge>
                  <span className="text-[11px] text-muted-foreground">{ago(Number(campaign.created_at))}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed">{String(campaign.hypothesis ?? '')}</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
