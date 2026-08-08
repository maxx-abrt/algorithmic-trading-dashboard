'use client'

/**
 * THE ADVISOR — the page the whole system exists to serve.
 * A ranked list of concrete instructions: what to trade, which way, where to enter,
 * where the stop goes, which targets, how big, when it expires, and exactly how much
 * proven evidence stands behind it.
 */
import { useState } from 'react'
import { usePoll } from '@/lib/api'
import { Badge, Button, Dot, EmptyState, ErrorNote, Panel, Skeleton } from '@/components/ui/kit'
import { ago, fmtNum, fmtPrice, fmtR, fmtUsd } from '@/lib/format'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Newspaper, PauseCircle, ShieldCheck, Target } from 'lucide-react'

interface Vote { displayName: string; probability: number; weight: number; wouldTake: boolean; backend: string; skillMatch: string | null }
interface Call {
  key: string; instId: string; instType: string; timeframe: string; playbook: string | null
  action: 'LONG' | 'SHORT' | 'WAIT'; rank: number; score: number; price: number; conviction: number
  compositeScore: number; regime: string; entry: number | null; entryZone: [number, number] | null
  stopLoss: number | null; targets: { price: number; rr: number; allocationPct: number }[]
  expectedRr: number | null; riskUsd: number | null; leverage: number | null; sizingAdvice: string | null
  winProbability: number | null; netExpectancyR: number | null; invalidation: number | null; expiresAt: number
  committee: { consensus: string; probability: number; confidence: number; agreement: number; totalMembers: number; evidence: string; exitVariantId: string | null; votes: Vote[] } | null
  skills: string[]; vetoes: { id: string; reason: string; severity: string }[]; warnings: string[]; reasons: string[]
  liquidity: { volUsd24h: number | null; spreadBps: number | null }; changePct24h: number | null
  volatilityBucket: string; newsRisk: number | null; generatedAt: number; isProbe: boolean
}
interface Payload {
  generatedAt: number
  news: { riskScore: number; direction: number; eventProximity: number; summary: string; model: string; at: number } | null
  population: { champions: number; canaries: number; specialists: number; withArenaEdge: number }
  execution: { severity: string; title: string; detail: string; action: string }
  calls: Call[]
  counters: { signals: number; probes: number; deepScans: number; evaluations: number }
}

const EVIDENCE_TONE: Record<string, 'bull' | 'info' | 'warning'> = { arena_validated: 'bull', arena_candidate: 'info', unproven: 'warning' }

export default function AdvisorPage() {
  const { data, error, loading, refresh } = usePoll<Payload>('/advisor?limit=30', 6000)
  const [onlyActionable, setOnlyActionable] = useState(true)
  const calls = (data?.calls ?? []).filter((call) => (onlyActionable ? call.action !== 'WAIT' : true))

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-3 px-3 pb-24 pt-3 sm:px-4 md:pb-6 lg:px-6" data-testid="advisor-page">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight">Advisor</h1>
        <Badge tone="info" data-testid="advisor-updated">updated {ago(data?.generatedAt)}</Badge>
        <Badge tone={data && data.population.champions > 0 ? 'bull' : data && data.population.withArenaEdge > 0 ? 'info' : 'warning'}>
          {data?.population.champions ?? 0} champions · {data?.population.canaries ?? 0} canaries · {data?.population.withArenaEdge ?? 0} arena-proven
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant={onlyActionable ? 'primary' : 'secondary'} onClick={() => setOnlyActionable((value) => !value)} data-testid="advisor-toggle-actionable">
            {onlyActionable ? 'actionable only' : 'showing all'}
          </Button>
          <Button onClick={() => void refresh()} data-testid="advisor-refresh">refresh</Button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      {data?.news && (
        <Panel title={<span className="flex items-center gap-1.5"><Newspaper className="h-3.5 w-3.5 text-info" />News &amp; macro risk</span>} subtitle={`${data.news.model} · ${ago(data.news.at)}`} data-testid="advisor-news">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={data.news.riskScore > 0.7 ? 'bear' : data.news.riskScore > 0.4 ? 'warning' : 'bull'}>risk {(data.news.riskScore * 100).toFixed(0)}%</Badge>
            <Badge tone={data.news.direction > 0.15 ? 'bull' : data.news.direction < -0.15 ? 'bear' : 'neutral'}>tilt {data.news.direction > 0 ? '+' : ''}{data.news.direction.toFixed(2)}</Badge>
            <Badge tone={data.news.eventProximity > 0.7 ? 'warning' : 'neutral'}>event {(data.news.eventProximity * 100).toFixed(0)}%</Badge>
            <p className="min-w-[220px] flex-1 text-muted-foreground">{data.news.summary}</p>
          </div>
        </Panel>
      )}

      {data?.execution && data.execution.severity !== 'ok' && (
        <Panel title={<span className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-warning" />{data.execution.title}</span>} data-testid="advisor-execution-banner">
          <p className="text-xs text-muted-foreground">{data.execution.detail}</p>
          {data.execution.action && <p className="mt-1.5 text-xs text-foreground">{data.execution.action}</p>}
        </Panel>
      )}

      {loading && !data && <Skeleton className="h-40" />}
      {!loading && !calls.length && <EmptyState title="No actionable call right now">{"The scanner is still measuring, or every candidate is vetoed. Turn off 'actionable only' to see what the engine is watching and why it is waiting."}</EmptyState>}

      <div className="grid gap-3 xl:grid-cols-2" data-testid="advisor-calls">
        {calls.map((call) => (
          <Panel
            key={call.key}
            className={call.action === 'LONG' ? 'border-bull/30' : call.action === 'SHORT' ? 'border-bear/30' : ''}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px]">{call.instId}</span>
                <Badge tone={call.action === 'LONG' ? 'bull' : call.action === 'SHORT' ? 'bear' : 'neutral'}>
                  {call.action === 'LONG' ? <ArrowUpRight className="h-3 w-3" /> : call.action === 'SHORT' ? <ArrowDownRight className="h-3 w-3" /> : <PauseCircle className="h-3 w-3" />} {call.action}
                </Badge>
                <Badge tone="plain">{call.timeframe}</Badge>
                {call.playbook && <Badge tone="neutral">{call.playbook.replace(/_/g, ' ')}</Badge>}
                {call.isProbe && <Badge tone="warning" title="Taken at reduced size to buy information for a niche with little evidence">probe</Badge>}
              </span>
            }
            subtitle={`#${call.rank} · score ${fmtNum(call.score, 1)} · conviction ${call.conviction} · ${call.regime} · ${call.volatilityBucket} · ${fmtUsd(call.liquidity.volUsd24h)} 24h · spread ${fmtNum(call.liquidity.spreadBps, 1)}bps`}
            actions={<span className="flex items-center gap-1 text-[10px] text-muted-foreground"><Clock className="h-3 w-3" />{ago(call.expiresAt)}</span>}
            data-testid={`advisor-call-${call.instId}`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-muted-foreground">price</span><span className="font-mono">{fmtPrice(call.price)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">entry</span><span className="font-mono">{call.entryZone ? `${fmtPrice(call.entryZone[0])} – ${fmtPrice(call.entryZone[1])}` : '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">stop</span><span className="font-mono text-bear">{fmtPrice(call.stopLoss)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">invalidation</span><span className="font-mono">{fmtPrice(call.invalidation)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">risk / size</span><span className="font-mono">{fmtUsd(call.riskUsd)} · {fmtNum(call.leverage, 1)}x</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">net expectancy</span><span className="font-mono">{fmtR(call.netExpectancyR)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">win probability</span><span className="font-mono">{call.winProbability == null ? '—' : `${(call.winProbability * 100).toFixed(1)}%`}</span></div>
              </div>
              <div className="space-y-1.5">
                <p className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground"><Target className="h-3 w-3" />targets</p>
                {call.targets.length ? (
                  <ul className="space-y-1 text-xs">
                    {call.targets.map((target, index) => (
                      <li key={index} className="flex justify-between">
                        <span className="text-muted-foreground">TP{index + 1} · {target.allocationPct.toFixed(0)}%</span>
                        <span className="font-mono text-bull">{fmtPrice(target.price)} <span className="text-muted-foreground">({fmtNum(target.rr, 1)}R)</span></span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">no ladder yet</p>}
                {call.committee && (
                  <div className="mt-2 rounded-md border border-border bg-card-2/50 p-2">
                    <p className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <ShieldCheck className="h-3 w-3 text-info" />
                      <span className="uppercase tracking-wider text-muted-foreground">committee</span>
                      <Badge tone={call.committee.consensus === 'take' ? 'bull' : call.committee.consensus === 'reduce' ? 'warning' : 'neutral'}>{call.committee.consensus}</Badge>
                      <Badge tone={EVIDENCE_TONE[call.committee.evidence] ?? 'neutral'}>{call.committee.evidence.replace(/_/g, ' ')}</Badge>
                      <span className="text-muted-foreground">{(call.committee.probability * 100).toFixed(0)}% · {call.committee.agreement}/{call.committee.totalMembers} take</span>
                      {call.committee.exitVariantId && <Badge tone="plain">exit {call.committee.exitVariantId}</Badge>}
                    </p>
                    <ul className="mt-1.5 space-y-0.5 text-[11px]">
                      {call.committee.votes.map((vote) => (
                        <li key={vote.displayName} className="flex items-center gap-1.5">
                          <Dot tone={vote.wouldTake ? 'bull' : 'neutral'} />
                          <span className="truncate font-mono">{vote.displayName}</span>
                          <span className="text-muted-foreground">{(vote.probability * 100).toFixed(0)}%</span>
                          <span className="text-muted-foreground">w{vote.weight.toFixed(2)}</span>
                          {vote.skillMatch && <span className="truncate text-info">{vote.skillMatch}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            {(call.vetoes.length > 0 || call.reasons.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {call.reasons.slice(0, 4).map((reason) => <Badge key={reason} tone="neutral">{reason}</Badge>)}
                {call.vetoes.map((veto) => <Badge key={veto.id} tone={veto.severity === 'hard' ? 'veto' : 'warning'} title={veto.reason}>{veto.id.replace(/_/g, ' ')}</Badge>)}
                {call.skills.map((skill) => <Badge key={skill} tone="info">{skill}</Badge>)}
              </div>
            )}
            {call.sizingAdvice && <p className="mt-2 text-[11px] text-muted-foreground">{call.sizingAdvice}</p>}
          </Panel>
        ))}
      </div>
    </div>
  )
}
