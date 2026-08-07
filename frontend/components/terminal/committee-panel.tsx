'use client'

import { usePoll } from '@/lib/api'
import type { EvolutionState } from '@/lib/evolution'
import { fmtPctValue, fmtR, LIFECYCLE_TONE, niceNiche } from '@/lib/evolution'
import { Badge, Panel, Row } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import Link from 'next/link'

/**
 * Which experts are qualified to speak about the instrument on screen, and what
 * they actually did on real forward trades. Sparse gating: an expert only appears
 * if its niche matches, or partially matches, this context.
 */
export function CommitteePanel({ instType, timeframe }: { instType?: string | null; timeframe?: string | null }) {
  const { data } = usePoll<EvolutionState>('/evolution', 15000)
  const all = data?.specialists ?? []
  const active = all.filter((row) => row.lifecycle === 'champion' || row.lifecycle === 'canary')

  const scored = active
    .map((row) => ({
      row,
      trust: row.instType === instType && row.timeframe === timeframe ? 1 : row.timeframe === timeframe ? 0.55 : row.instType === instType ? 0.3 : 0,
    }))
    .filter((entry) => entry.trust > 0)
    .sort((a, b) => b.trust - a.trust || b.row.generation - a.row.generation)

  return (
    <Panel
      title="Specialist committee"
      subtitle={data ? `${active.length} live expert${active.length === 1 ? '' : 's'} · ${data.summary.samples} labelled outcomes` : 'loading'}
      data-testid="committee-panel"
      actions={
        <Link href="/evolution" className="text-[10px] uppercase tracking-wider text-info hover:underline" data-testid="committee-open-evolution">
          evolution
        </Link>
      }
    >
      {!data ? (
        <p className="text-xs text-muted-foreground">Loading population…</p>
      ) : !active.length ? (
        <div className="space-y-1.5">
          <Badge tone="warning">no validated model</Badge>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            No specialist has cleared out-of-sample calibration, the shuffled-label placebo and forward evidence yet. Decisions come from the deterministic playbooks alone, and probabilities are labelled as heuristic.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {data.summary.samples} of {data.settings.minNicheSamples} samples needed in a single niche.
          </p>
        </div>
      ) : !scored.length ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {active.length} expert{active.length === 1 ? '' : 's'} exist, but none is qualified for {instType ?? '—'} on {timeframe ?? '—'}. The engine keeps trading this niche on deterministic logic so it can accumulate the evidence to learn it.
        </p>
      ) : (
        <div className="space-y-2">
          {scored.slice(0, 5).map(({ row, trust }) => (
            <div key={row.artifactHash} className="border-b border-border/40 pb-2 last:border-0 last:pb-0" data-testid={`committee-member-${row.shortHash}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium">{row.displayName}</span>
                <Badge tone="plain">G{row.generation}</Badge>
                <Badge tone={LIFECYCLE_TONE[row.lifecycle]}>{row.lifecycle}</Badge>
                <span className={cn('ml-auto text-[10px]', trust === 1 ? 'text-bull' : 'text-muted-foreground')}>{trust === 1 ? 'exact niche' : `adjacent ×${trust}`}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{niceNiche(row.nicheKey)}</p>
              <div className="mt-1 grid grid-cols-2 gap-x-3">
                <Row label="brier skill" value={fmtPctValue(row.metrics.brierSkill)} tone={(row.metrics.brierSkill ?? 0) > 0 ? 'bull' : 'bear'} />
                <Row label="auc" value={row.metrics.auc?.toFixed(3) ?? '—'} />
                <Row label="R-lift" value={fmtR(row.metrics.meanRLift)} tone={(row.metrics.meanRLift ?? 0) > 0 ? 'bull' : 'neutral'} />
                <Row label="live" value={row.liveTrades ? `${fmtR(row.liveMeanR)} / ${row.liveTrades}t` : 'no trades'} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
