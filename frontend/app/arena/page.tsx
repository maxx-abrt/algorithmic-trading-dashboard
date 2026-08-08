'use client'

/**
 * THE ARENA — where a model stops being a number and becomes a result.
 * Every row here is a purged walk-forward campaign over recorded decisions, with an
 * equity curve, a baseline to beat, per-fold consistency and an honest verdict.
 */
import { useMemo, useState } from 'react'
import { api, post, usePoll } from '@/lib/api'
import { Badge, Button, EmptyState, ErrorNote, Panel, Select, Skeleton } from '@/components/ui/kit'
import { ago, fmtNum, fmtR } from '@/lib/format'
import { FlaskConical, Play, TrendingUp } from 'lucide-react'

interface Run {
  id: number; at: number; nicheKey: string; label: string; artifactHash: string | null; kind: string; verdict: string
  rows: number; oosTrades: number; meanR: number; sumR: number; baselineMeanR: number; meanRLift: number
  sharpe: number; deflatedSharpe: number; maxDrawdownR: number; winRate: number; pValue: number
  foldsPositive: number; foldsTotal: number
}
interface Coverage { nicheKey: string; playbook: string; instType: string; timeframe: string; rows: number; wins: number; sumR: number; symbols: number; lastAt: number }
interface ArenaPayload { runs: Run[]; coverage: Coverage[]; variants: { id: string; label: string }[]; tapeRows: number }
interface Metrics { trades: number; winRate: number; meanR: number; sumR: number; sharpe: number; maxDrawdownR: number; profitFactor: number; pValue: number; equity: { at: number; equityR: number }[] }
interface RunDetail {
  id: number
  report: {
    label: string; nicheKey: string; rows: number; symbols: number; verdict: string; reasons: string[]
    policy: Metrics; baseline: Metrics; holdout: Metrics | null; meanRLift: number
    folds: { fold: number; trainRows: number; testRows: number; threshold: number; variantId: string; coverage: number; policy: Metrics; baseline: Metrics }[]
    byRegime: { key: number; metrics: Metrics }[]
    bySymbol: { key: string; metrics: Metrics }[]
    byVariant: { id: string; label: string; metrics: Metrics }[]
    byExitReason: { key: string; metrics: Metrics }[]
  }
}

const REGIME_LABELS = ['calm trend', 'calm range', 'volatile trend', 'volatile range', 'crisis']

function Sparkline({ points, tone }: { points: { equityR: number }[]; tone: string }) {
  if (points.length < 2) return <div className="h-16 rounded bg-card-2" />
  const values = points.map((point) => point.equityR)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const range = max - min || 1
  const path = values.map((value, index) => `${(index / (values.length - 1)) * 100},${100 - ((value - min) / range) * 100}`).join(' ')
  const zero = 100 - ((0 - min) / range) * 100
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full">
      <line x1="0" y1={zero} x2="100" y2={zero} stroke="currentColor" strokeWidth="0.4" className="text-border" />
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.4" vectorEffect="non-scaling-stroke" className={tone} />
    </svg>
  )
}

export default function ArenaPage() {
  const { data, error, loading, refresh } = usePoll<ArenaPayload>('/arena?limit=60', 10_000)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [niche, setNiche] = useState('')

  const niches = useMemo(() => (data?.coverage ?? []).filter((row) => row.rows >= 200).sort((a, b) => b.rows - a.rows), [data])
  const selected = niche || niches[0]?.nicheKey || ''

  const open = async (id: number) => {
    try {
      setDetail(await api<RunDetail>(`/arena/run?id=${id}`))
    } catch (issue) {
      setNote(issue instanceof Error ? issue.message : String(issue))
    }
  }

  const runCampaign = async (artifactHash: string | null) => {
    if (!selected) return
    const [playbook, instType, timeframe] = selected.split('|')
    setBusy(true)
    setNote(null)
    try {
      const result = await post<RunDetail>('/arena/run', { playbook, instType, timeframe, artifactHash })
      setDetail(result)
      setNote(`campaign #${result.id} complete — ${result.report.verdict}`)
      await refresh()
    } catch (issue) {
      setNote(issue instanceof Error ? issue.message : String(issue))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-24 pt-3 sm:px-4 md:pb-6 lg:px-6" data-testid="arena-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight">Strategy arena</h1>
        <Badge tone="info">{data?.tapeRows ?? 0} recorded decisions</Badge>
        <Badge tone="neutral">{data?.runs.length ?? 0} campaigns</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select value={selected} onChange={(event) => setNiche(event.target.value)} data-testid="arena-niche-select">
            {niches.map((row) => <option key={row.nicheKey} value={row.nicheKey}>{row.nicheKey.replace(/\|/g, ' · ')} ({row.rows})</option>)}
          </Select>
          <Button variant="primary" disabled={busy || !selected} onClick={() => void runCampaign(null)} data-testid="arena-run-baseline">
            <Play className="h-3 w-3" />{busy ? 'running…' : 'test all exits'}
          </Button>
          <Button onClick={() => void refresh()} data-testid="arena-refresh">refresh</Button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}
      {note && <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="arena-note">{note}</p>}

      <Panel title="Evidence coverage" subtitle="a niche cannot produce a model until it has recorded decisions" data-testid="arena-coverage">
        <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {(data?.coverage ?? []).sort((a, b) => b.rows - a.rows).map((row) => (
            <div key={row.nicheKey} className="flex items-center gap-2 rounded-md border border-border bg-card-2/40 px-2 py-1.5 text-[11px]">
              <span className="flex-1 truncate">{row.nicheKey.replace(/\|/g, ' · ')}</span>
              <Badge tone={row.rows >= 1000 ? 'bull' : row.rows >= 260 ? 'info' : 'warning'}>{row.rows}</Badge>
              <span className="w-14 text-right font-mono text-muted-foreground">{((row.wins / Math.max(1, row.rows)) * 100).toFixed(0)}% win</span>
              <span className="w-16 text-right font-mono text-muted-foreground">{row.symbols} sym</span>
            </div>
          ))}
        </div>
      </Panel>

      {loading && !data && <Skeleton className="h-40" />}

      <Panel title="Campaigns" subtitle="purged walk-forward · threshold and exit chosen on the training slice only" data-testid="arena-runs">
        {!data?.runs.length ? (
          <EmptyState title="No campaign yet">{"Pick a niche and press 'test all exits' to compare every exit policy over the recorded decisions."}</EmptyState>
        ) : (
          <div className="-mx-3 overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-1.5 font-medium">when</th>
                  <th className="px-2 py-1.5 font-medium">niche</th>
                  <th className="px-2 py-1.5 font-medium">label</th>
                  <th className="px-2 py-1.5 text-right font-medium">OOS trades</th>
                  <th className="px-2 py-1.5 text-right font-medium">mean R</th>
                  <th className="px-2 py-1.5 text-right font-medium">lift</th>
                  <th className="px-2 py-1.5 text-right font-medium">sharpe</th>
                  <th className="px-2 py-1.5 text-right font-medium">max DD</th>
                  <th className="px-2 py-1.5 text-right font-medium">folds</th>
                  <th className="px-2 py-1.5 text-right font-medium">p</th>
                  <th className="px-2 py-1.5 font-medium">verdict</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id} className="cursor-pointer border-b border-border/50 hover:bg-muted/30" onClick={() => void open(run.id)} data-testid={`arena-run-${run.id}`}>
                    <td className="px-3 py-1.5 text-muted-foreground">{ago(run.at)}</td>
                    <td className="px-2 py-1.5 font-mono">{run.nicheKey.replace(/\|/g, ' · ')}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{run.label}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{run.oosTrades}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${run.meanR >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtR(run.meanR)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${run.meanRLift >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtR(run.meanRLift)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtNum(run.sharpe, 2)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtNum(run.maxDrawdownR, 1)}R</td>
                    <td className="px-2 py-1.5 text-right font-mono">{run.foldsPositive}/{run.foldsTotal}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtNum(run.pValue, 3)}</td>
                    <td className="px-2 py-1.5"><Badge tone={run.verdict === 'edge' ? 'bull' : run.verdict === 'no_edge' ? 'bear' : 'neutral'}>{run.verdict}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {detail && (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="arena-detail">
          <Panel title={<span className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-info" />Equity curve · {detail.report.label}</span>} subtitle={`${detail.report.nicheKey.replace(/\|/g, ' · ')} · ${detail.report.rows} decisions · ${detail.report.symbols} symbols`}>
            <Sparkline points={detail.report.policy.equity} tone={detail.report.policy.sumR >= 0 ? 'text-bull' : 'text-bear'} />
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
              <Stat label="policy sum" value={fmtR(detail.report.policy.sumR)} tone={detail.report.policy.sumR >= 0} />
              <Stat label="baseline sum" value={fmtR(detail.report.baseline.sumR)} tone={detail.report.baseline.sumR >= 0} />
              <Stat label="lift / trade" value={fmtR(detail.report.meanRLift)} tone={detail.report.meanRLift >= 0} />
              <Stat label="win rate" value={`${(detail.report.policy.winRate * 100).toFixed(0)}%`} tone={detail.report.policy.winRate >= 0.5} />
              <Stat label="profit factor" value={fmtNum(detail.report.policy.profitFactor, 2)} tone={detail.report.policy.profitFactor >= 1} />
              <Stat label="max drawdown" value={`${fmtNum(detail.report.policy.maxDrawdownR, 1)}R`} tone={false} />
              <Stat label="held-out symbol" value={detail.report.holdout ? fmtR(detail.report.holdout.meanR) : '—'} tone={(detail.report.holdout?.meanR ?? 0) >= 0} />
              <Stat label="verdict" value={detail.report.verdict} tone={detail.report.verdict === 'edge'} />
            </div>
            {detail.report.reasons.length > 0 && (
              <p className="mt-2 text-[11px] text-warning">rejection reasons: {detail.report.reasons.join(', ')}</p>
            )}
          </Panel>

          <Panel title="Folds, regimes and exits" subtitle="consistency matters more than one lucky window">
            <div className="space-y-2 text-[11px]">
              <div>
                <p className="mb-1 uppercase tracking-wider text-muted-foreground">walk-forward folds</p>
                {detail.report.folds.map((fold) => (
                  <div key={fold.fold} className="flex items-center gap-2 border-b border-border/40 py-1">
                    <span className="w-10 text-muted-foreground">#{fold.fold}</span>
                    <span className="w-24 font-mono">{fold.variantId}</span>
                    <span className="w-20 text-muted-foreground">cov {(fold.coverage * 100).toFixed(0)}%</span>
                    <span className={`w-20 text-right font-mono ${fold.policy.sumR >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtR(fold.policy.sumR)}</span>
                    <span className="w-24 text-right font-mono text-muted-foreground">base {fmtR(fold.baseline.sumR)}</span>
                    <span className="ml-auto text-muted-foreground">{fold.policy.trades} trades</span>
                  </div>
                ))}
              </div>
              {detail.report.byRegime.length > 0 && (
                <div>
                  <p className="mb-1 uppercase tracking-wider text-muted-foreground">by regime</p>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.report.byRegime.map((row) => (
                      <Badge key={row.key} tone={row.metrics.meanR >= 0 ? 'bull' : 'bear'}>{REGIME_LABELS[row.key] ?? row.key}: {fmtR(row.metrics.meanR)} ({row.metrics.trades})</Badge>
                    ))}
                  </div>
                </div>
              )}
              {detail.report.byVariant.length > 0 && (
                <div>
                  <p className="mb-1 uppercase tracking-wider text-muted-foreground">exit-policy leaderboard (in-sample diagnostic)</p>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.report.byVariant.slice(0, 10).map((row) => (
                      <Badge key={row.id} tone={row.metrics.meanR >= 0 ? 'bull' : 'neutral'} title={row.label}>{row.id}: {fmtR(row.metrics.meanR)}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {detail.report.byExitReason.length > 0 && (
                <div>
                  <p className="mb-1 uppercase tracking-wider text-muted-foreground">how trades ended</p>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.report.byExitReason.map((row) => (
                      <Badge key={row.key} tone={row.metrics.meanR >= 0 ? 'bull' : 'bear'}>{row.key.replace(/_/g, ' ')}: {row.metrics.trades} · {fmtR(row.metrics.meanR)}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><FlaskConical className="h-3 w-3" />A negative result is a valid result: the arena exists to reject false edge, not to manufacture a good-looking report.</p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: boolean }) {
  return (
    <div className="rounded-md border border-border bg-card-2/40 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`font-mono text-xs ${tone ? 'text-bull' : 'text-foreground'}`}>{value}</p>
    </div>
  )
}
