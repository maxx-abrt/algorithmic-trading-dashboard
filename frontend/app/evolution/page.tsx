'use client'

import { useMemo, useState } from 'react'
import { post, usePoll } from '@/lib/api'
import { Badge, Button, Chip, EmptyState, ErrorNote, Gauge, Panel, Row, Skeleton, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fmtPctValue, fmtR, LIFECYCLE_TONE, niceNiche, type EvolutionState, type HarvestState, type SpecialistRow } from '@/lib/evolution'
import { Dna, FlaskConical, GitBranch, Play, Sprout } from 'lucide-react'
import { toast } from 'sonner'

export default function EvolutionPage() {
  const { data, error, refresh } = usePoll<EvolutionState>('/evolution', 6000)
  const harvest = usePoll<HarvestState>('/harvest', 6000)
  const [tab, setTab] = useState('population')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const specialists = data?.specialists ?? []
  const champions = specialists.filter((row) => row.lifecycle === 'champion')
  const byNiche = useMemo(() => {
    const map = new Map<string, SpecialistRow[]>()
    for (const row of specialists) map.set(row.nicheKey, [...(map.get(row.nicheKey) ?? []), row])
    for (const rows of map.values()) rows.sort((a, b) => b.generation - a.generation || b.createdAt - a.createdAt)
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [specialists])

  const run = async (path: string, payload?: unknown, label = 'Done') => {
    setBusy(true)
    try {
      const res = await post<Record<string, unknown>>(path, payload)
      toast.success(typeof res?.reason === 'string' ? String(res.reason) : label)
      await refresh()
      await harvest.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const detail = specialists.find((row) => row.artifactHash === selected) ?? null
  const nicheReady = data ? (harvest.data?.niches ?? data.niches).filter((row) => row.samples >= data.settings.minNicheSamples).length : 0

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 p-3 pb-24 sm:p-4 md:pb-4" data-testid="evolution-page">
      {error && <ErrorNote message={error} />}

      {/* ---- headline: is there a validated edge, honestly? ---- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel title="Validation state" data-testid="evo-state-panel">
          <div className="flex items-center gap-2">
            <Badge tone={data?.validationState === 'VALIDATED' ? 'bull' : 'warning'} data-testid="evo-validation-state">
              {data?.validationState === 'VALIDATED' ? 'validated' : 'no validated model'}
            </Badge>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {data?.validationState === 'VALIDATED'
              ? `${champions.length} champion${champions.length === 1 ? '' : 's'} passed out-of-sample calibration, the shuffled-label placebo and forward paper evidence.`
              : 'No specialist has cleared every gate yet. The system stays on deterministic playbook logic — that is the honest state, not a bug.'}
          </p>
        </Panel>
        <Panel title="Evidence base" data-testid="evo-evidence-panel">
          <Row label="labelled outcomes" value={data?.summary.samples ?? '—'} />
          <Row label="niches tracked" value={data?.niches.length ?? '—'} />
          <Row label={`niches ≥ ${data?.settings.minNicheSamples ?? 60} samples`} value={nicheReady} tone={nicheReady > 0 ? 'bull' : 'neutral'} />
        </Panel>
        <Panel title="Population" data-testid="evo-population-panel">
          <Row label="specialists born" value={data?.summary.specialists ?? '—'} />
          <Row label="champions" value={champions.length} tone={champions.length ? 'bull' : 'neutral'} />
          <Row label="top generation" value={specialists.length ? Math.max(...specialists.map((row) => row.generation)) : '—'} />
        </Panel>
        <Panel
          title="Actions"
          data-testid="evo-actions-panel"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void refresh()} data-testid="evo-refresh">
              refresh
            </Button>
          }
        >
          <div className="flex flex-col gap-1.5">
            <Button
              variant="primary"
              disabled={busy || harvest.data?.progress.running}
              onClick={() => void run('/harvest/run', { perType: 6, timeframes: ['15m'], barsPerSymbol: 900 }, 'Harvest started')}
              data-testid="evo-harvest-btn"
            >
              <Sprout className="h-3.5 w-3.5" /> Harvest real history
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void run('/evolution/run', undefined, 'Evolution cycle finished')}
              data-testid="evo-run-btn"
            >
              <Dna className="h-3.5 w-3.5" /> Evolve best niche now
            </Button>
          </div>
          {harvest.data?.progress.running && (
            <div className="mt-2 space-y-1">
              <Gauge value={(harvest.data.progress.seriesDone / Math.max(1, harvest.data.progress.seriesTotal)) * 100} tone="info" />
              <p className="truncate text-[10px] text-muted-foreground">
                harvesting {harvest.data.progress.current} · {harvest.data.progress.samples} new samples
              </p>
            </div>
          )}
        </Panel>
      </div>

      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab id="population" count={specialists.length}>Population</Tab>
          <Tab id="lineage" count={byNiche.length}>Lineage</Tab>
          <Tab id="niches" count={data?.niches.length}>Niches</Tab>
          <Tab id="events" count={data?.events.length}>Timeline</Tab>
        </TabList>

        {/* ---------------------------------------------------- population --- */}
        <TabPanel id="population" className="pt-3">
          {!data ? (
            <div className="space-y-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : !specialists.length ? (
            <EmptyState icon={<Dna className="h-8 w-8" />} title="No specialist has been born yet">
              Each niche needs {data.settings.minNicheSamples} labelled outcomes before evolution runs. Harvest real history to bootstrap the evidence base, or let the engine trade and wait.
            </EmptyState>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
              <Panel title="Specialists" subtitle="every model, its niche, its generation and its real forward record" bodyClassName="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2">Model</th>
                        <th className="px-3 py-2">Specialisation</th>
                        <th className="px-2 py-2 text-right">Gen</th>
                        <th className="px-2 py-2 text-right">Brier</th>
                        <th className="px-2 py-2 text-right">Skill</th>
                        <th className="px-2 py-2 text-right">AUC</th>
                        <th className="px-2 py-2 text-right">R-lift</th>
                        <th className="px-2 py-2 text-right">Live</th>
                        <th className="px-3 py-2">State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {specialists.map((row) => (
                        <tr
                          key={row.artifactHash}
                          onClick={() => setSelected(row.artifactHash)}
                          className={cn('cursor-pointer border-b border-border/50 hover:bg-muted/30', selected === row.artifactHash && 'bg-card-2')}
                          data-testid={`specialist-row-${row.shortHash}`}
                        >
                          <td className="px-3 py-2 font-medium">{row.displayName}</td>
                          <td className="px-3 py-2 text-[11px] text-muted-foreground">{niceNiche(row.nicheKey)}</td>
                          <td className="num px-2 py-2 text-right">{row.generation}</td>
                          <td className="num px-2 py-2 text-right">{row.metrics.brier?.toFixed(4) ?? '—'}</td>
                          <td className={cn('num px-2 py-2 text-right', (row.metrics.brierSkill ?? 0) > 0 ? 'text-bull' : 'text-bear')}>{fmtPctValue(row.metrics.brierSkill)}</td>
                          <td className="num px-2 py-2 text-right">{row.metrics.auc?.toFixed(3) ?? '—'}</td>
                          <td className={cn('num px-2 py-2 text-right', (row.metrics.meanRLift ?? 0) > 0 ? 'text-bull' : 'text-muted-foreground')}>{fmtR(row.metrics.meanRLift)}</td>
                          <td className="num px-2 py-2 text-right">
                            {row.liveTrades ? (
                              <span className={row.liveMeanR != null && row.liveMeanR > 0 ? 'text-bull' : 'text-bear'}>
                                {fmtR(row.liveMeanR)} <span className="text-[10px] text-muted-foreground">/{row.liveTrades}</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground">no trades</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={LIFECYCLE_TONE[row.lifecycle]}>{row.lifecycle}</Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <Panel title={detail ? detail.displayName : 'Select a specialist'} subtitle={detail ? niceNiche(detail.nicheKey) : 'click any row'} data-testid="specialist-detail">
                {!detail ? (
                  <p className="text-xs text-muted-foreground">Pick a model to see how it was validated, what it looks at and how it is performing on real forward trades.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={LIFECYCLE_TONE[detail.lifecycle]}>{detail.lifecycle}</Badge>
                      <Badge tone="plain">generation {detail.generation}</Badge>
                      <Badge tone="neutral">{detail.shortHash}</Badge>
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Out-of-sample validation</p>
                      <Row label="Brier score" value={detail.metrics.brier?.toFixed(4) ?? '—'} hint={`vs base rate ${detail.metrics.baselineBrier?.toFixed(4) ?? '—'}`} />
                      <Row label="Brier skill" value={fmtPctValue(detail.metrics.brierSkill)} tone={(detail.metrics.brierSkill ?? 0) > 0 ? 'bull' : 'bear'} />
                      <Row label="placebo skill" value={fmtPctValue(detail.placeboSkill)} hint="shuffled labels" />
                      <Row label="AUC" value={detail.metrics.auc?.toFixed(3) ?? '—'} />
                      <Row label="log loss" value={detail.metrics.logLoss?.toFixed(4) ?? '—'} />
                      <Row label="accuracy" value={fmtPctValue(detail.metrics.accuracy)} />
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Economic value</p>
                      <Row label="mean R, top decile" value={fmtR(detail.metrics.meanRAtThreshold)} />
                      <Row label="mean R, take everything" value={fmtR(detail.metrics.meanRAll)} />
                      <Row label="selection lift" value={fmtR(detail.metrics.meanRLift)} tone={(detail.metrics.meanRLift ?? 0) > 0 ? 'bull' : 'bear'} />
                      <Row label="coverage" value={fmtPctValue(detail.metrics.coverage)} />
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Data</p>
                      <Row label="train rows" value={detail.metrics.trainRows ?? '—'} />
                      <Row label="purged for overlap" value={detail.metrics.purgedRows ?? '—'} />
                      <Row label="holdout rows" value={detail.metrics.holdoutRows ?? '—'} />
                      <Row label="features used" value={`${detail.metrics.featuresUsed ?? '—'}/32`} />
                      <Row label="search trials" value={detail.trials} />
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Forward evidence (real trades only)</p>
                      <Row label="trades" value={detail.liveTrades} />
                      <Row label="mean net R" value={fmtR(detail.liveMeanR)} tone={(detail.liveMeanR ?? 0) > 0 ? 'bull' : 'bear'} />
                      <Row label="win rate" value={fmtPctValue(detail.liveWinRate)} />
                      <Row label="max drawdown" value={fmtR(detail.liveMaxDrawdownR)} />
                    </div>
                    {detail.rejectionReason && <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">{detail.rejectionReason}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {detail.lifecycle !== 'champion' && (
                        <Button variant="primary" disabled={busy} onClick={() => void run('/evolution/lifecycle', { artifactHash: detail.artifactHash, lifecycle: 'champion' }, 'Promoted')} data-testid="promote-specialist">
                          Promote to champion
                        </Button>
                      )}
                      {detail.lifecycle !== 'retired' && (
                        <Button variant="danger" disabled={busy} onClick={() => void run('/evolution/lifecycle', { artifactHash: detail.artifactHash, lifecycle: 'retired', reason: 'manual' }, 'Retired')} data-testid="retire-specialist">
                          Retire
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </TabPanel>

        {/* ------------------------------------------------------- lineage --- */}
        <TabPanel id="lineage" className="pt-3">
          {!byNiche.length ? (
            <EmptyState icon={<GitBranch className="h-8 w-8" />} title="No lineage yet">
              Lineage appears as soon as the first generation is born. Each child records the hash of the parent it had to beat out of sample.
            </EmptyState>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {byNiche.map(([key, rows]) => (
                <Panel key={key} title={niceNiche(key)} subtitle={`${rows.length} generation${rows.length === 1 ? '' : 's'}`} data-testid={`lineage-${key}`}>
                  <ol className="space-y-2">
                    {rows.map((row, index) => (
                      <li key={row.artifactHash} className="relative pl-5">
                        <span className={cn('absolute left-0 top-1.5 h-2 w-2 rounded-full', row.lifecycle === 'champion' ? 'bg-bull' : row.lifecycle === 'canary' ? 'bg-info' : 'bg-muted-foreground')} />
                        {index < rows.length - 1 && <span className="absolute left-[3px] top-4 h-full w-px bg-border" />}
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="text-xs font-medium">{row.displayName}</span>
                          <Badge tone="plain">G{row.generation}</Badge>
                          <Badge tone={LIFECYCLE_TONE[row.lifecycle]}>{row.lifecycle}</Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          brier {row.metrics.brier?.toFixed(4) ?? '—'} · skill {fmtPctValue(row.metrics.brierSkill)} · {row.metrics.featuresUsed ?? '—'} features · {ago(row.createdAt)}
                          {row.parentHash && <span className="ml-1">← parent {row.parentHash.slice(0, 8)}</span>}
                        </p>
                      </li>
                    ))}
                  </ol>
                </Panel>
              ))}
            </div>
          )}
        </TabPanel>

        {/* -------------------------------------------------------- niches --- */}
        <TabPanel id="niches" className="pt-3">
          <Panel title="Evidence per niche" subtitle="a specialist can only be born where there is enough real, resolved outcome data" bodyClassName="p-0">
            {!data?.niches.length ? (
              <EmptyState icon={<FlaskConical className="h-8 w-8" />} title="No labelled outcomes yet">
                Run a harvest, or let the engine arm and close paper trades.
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Niche</th>
                      <th className="px-2 py-2 text-right">Samples</th>
                      <th className="px-2 py-2 text-right">Win rate</th>
                      <th className="px-2 py-2 text-right">Cumulative</th>
                      <th className="px-2 py-2">Readiness</th>
                      <th className="px-3 py-2">Champion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(harvest.data?.niches ?? data.niches).map((niche) => {
                      const champion = champions.find((row) => row.nicheKey === niche.nicheKey)
                      const readiness = Math.min(100, (niche.samples / Math.max(1, data.settings.minNicheSamples)) * 100)
                      return (
                        <tr key={niche.nicheKey} className="border-b border-border/50" data-testid={`niche-row-${niche.nicheKey}`}>
                          <td className="px-3 py-2">{niceNiche(niche.nicheKey)}</td>
                          <td className="num px-2 py-2 text-right">{niche.samples}</td>
                          <td className="num px-2 py-2 text-right">{niche.samples ? `${((niche.wins / niche.samples) * 100).toFixed(0)}%` : '—'}</td>
                          <td className={cn('num px-2 py-2 text-right', niche.sumR > 0 ? 'text-bull' : 'text-bear')}>{fmtR(niche.sumR, 1)}</td>
                          <td className="w-28 px-2 py-2">
                            <Gauge value={readiness} tone={readiness >= 100 ? 'bull' : 'info'} ticks={false} />
                          </td>
                          <td className="px-3 py-2">
                            {champion ? (
                              <span className="text-[11px]">
                                {champion.displayName} <span className="text-muted-foreground">G{champion.generation}</span>
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">none</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </TabPanel>

        {/* -------------------------------------------------------- events --- */}
        <TabPanel id="events" className="pt-3">
          <Panel title="Evolution timeline" subtitle="births, canaries, promotions, retirements and rollbacks">
            {!data?.events.length ? (
              <EmptyState icon={<Play className="h-8 w-8" />} title="No evolution events yet" />
            ) : (
              <ul className="space-y-2">
                {data.events.map((event) => (
                  <li key={event.id} className="flex flex-col gap-0.5 border-b border-border/40 pb-2 last:border-0" data-testid={`evolution-event-${event.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip tone={event.type === 'promoted' ? 'bull' : event.type === 'rolled_back' ? 'bear' : event.type === 'born' ? 'info' : 'neutral'}>{event.type}</Chip>
                      {event.niche_key && <span className="text-[10px] text-muted-foreground">{niceNiche(event.niche_key)}</span>}
                      <span className="ml-auto text-[10px] text-muted-foreground">{ago(event.at)}</span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{event.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabPanel>
      </Tabs>
    </div>
  )
}
