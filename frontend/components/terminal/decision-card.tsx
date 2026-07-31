'use client'

import { useState } from 'react'
import type { Analysis } from '@/lib/types'
import { Badge, Button, Gauge, Panel, Row } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { fmtPct, fmtPrice, fmtR, fmtUsd, titleCase } from '@/lib/format'
import { post } from '@/lib/api'
import { toast } from 'sonner'
import { Brain, Copy, Eye, Loader2 } from 'lucide-react'

const VERDICT: Record<string, string> = {
  LONG: 'border-bull/40 bg-bull/12 text-bull',
  SHORT: 'border-bear/40 bg-bear/12 text-bear',
  WAIT: 'border-border bg-muted/40 text-muted-foreground',
}

function planText(a: Analysis) {
  const p = a.plan ?? a.shadowPlan
  if (!p) return `${a.instId} ${a.timeframe} — ${a.decision}`
  return [
    `${a.decision === 'WAIT' ? `WATCHING ${p.side}` : a.decision} ${a.instId} ${a.timeframe}`,
    `entry ${p.entryZone[0]} - ${p.entryZone[1]}`,
    `stop ${p.stopLoss} (${p.stopBasis})`,
    ...p.takeProfits.map((t, i) => `tp${i + 1} ${t.price} (${t.rr.toFixed(2)}R, ${t.allocationPct}%, ${t.basis})`),
    `size ${p.contracts} contracts ≈ ${fmtUsd(p.notionalUsd)} at ${p.leverage}x, margin ${fmtUsd(p.marginUsd)}`,
    `risk ${fmtUsd(p.riskUsd)} · blended ${p.expectedRr.toFixed(2)}R · net ${p.netExpectancyR.toFixed(2)}R`,
    `invalidation ${p.invalidation} · time stop ${p.timeStopBars} bars`,
    `conviction ${a.conviction.toFixed(0)}/100 · ${a.regime} · MTF ${a.mtfAlignment.toFixed(0)}%`,
  ].join('\n')
}

export function DecisionCard({
  analysis,
  onAsk,
  asking,
}: {
  analysis: Analysis | null
  onAsk: () => void
  asking: boolean
}) {
  const [watching, setWatching] = useState(false)
  if (!analysis) {
    return (
      <Panel title="Decision" data-testid="decision-card">
        <div className="space-y-2">
          <div className="skeleton h-9 rounded" />
          <div className="skeleton h-24 rounded" />
        </div>
      </Panel>
    )
  }

  const a = analysis
  const p = a.plan
  const shadow = a.shadowPlan
  const shown = p ?? shadow
  const hard = a.vetoes.filter((v) => v.severity === 'hard')

  const addWatch = async () => {
    setWatching(true)
    try {
      await post('/watchlist', { instId: a.instId, timeframe: a.timeframe })
      toast.success(`${a.instId} added to the watchlist`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setWatching(false)
    }
  }

  return (
    <Panel
      data-testid="decision-card"
      title={
        <span className="flex items-center gap-2">
          Decision
          <Badge tone={a.regime.startsWith('TRENDING') ? 'info' : a.regime === 'CHOPPY' ? 'warning' : 'neutral'}>
            {titleCase(a.regime)}
          </Badge>
          {a.session.isEquity && (
            <Badge tone={a.session.marketOpen ? 'bull' : 'warning'} title={a.session.note}>
              {a.session.session}
            </Badge>
          )}
        </span>
      }
      subtitle={`${a.instId} · ${a.timeframe} vs ${a.htfTimeframe}/${a.htf2Timeframe} · ${a.dataQuality.ltfBars} bars`}
      actions={
        <>
          <Button
            size="icon"
            variant="ghost"
            title="Copy the plan"
            data-testid="decision-copy-plan-button"
            onClick={() => {
              void navigator.clipboard?.writeText(planText(a))
              toast.success('Plan copied')
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Add to watchlist"
            data-testid="decision-add-watchlist-button"
            onClick={addWatch}
            disabled={watching}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            title="Ask the AI risk officer now"
            data-testid="decision-ask-ai-button"
            onClick={onAsk}
            disabled={asking}
          >
            {asking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" />}
            Ask AI
          </Button>
        </>
      }
      bodyClassName="space-y-3"
    >
      {/* verdict */}
      <div className="flex items-stretch gap-3">
        <div
          data-testid="decision-verdict"
          className={cn(
            'flex w-[104px] shrink-0 flex-col items-center justify-center rounded-md border py-2',
            VERDICT[a.decision],
          )}
        >
          <span className="text-lg font-semibold leading-none tracking-tight">{a.decision}</span>
          <span className="mt-1 text-[10px] uppercase tracking-wider opacity-80">
            {a.decision === 'WAIT' ? 'stand aside' : (a.playbook ?? '').replace(/_/g, ' ') || 'confluence'}
          </span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-muted-foreground">conviction</span>
            <span className="num text-sm font-medium">{a.conviction.toFixed(0)}/100</span>
          </div>
          <Gauge
            value={a.conviction}
            tone={a.decision === 'LONG' ? 'bull' : a.decision === 'SHORT' ? 'bear' : 'neutral'}
            data-testid="decision-conviction-gauge"
          />
          <div className="grid grid-cols-3 gap-2 pt-1">
            <Row label="composite" value={`${a.compositeScore > 0 ? '+' : ''}${a.compositeScore.toFixed(0)}`} tone={a.compositeScore > 0 ? 'bull' : a.compositeScore < 0 ? 'bear' : 'neutral'} />
            <Row label="MTF" value={`${a.mtfAlignment.toFixed(0)}%`} />
            <Row label="price" value={fmtPrice(a.price)} />
          </div>
        </div>
      </div>

      {/* hard blockers */}
      {hard.length > 0 && (
        <div className="rounded-md border border-veto/40 bg-veto/10 p-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-veto">hard blockers</p>
          <ul className="mt-1 space-y-0.5">
            {hard.map((v) => (
              <li key={v.id + v.reason} className="text-[11px] leading-snug text-foreground/90">
                · {v.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* plan */}
      {shown ? (
        <div className={cn('rounded-md border p-2.5', p ? 'border-border bg-card-2/60' : 'border-dashed border-border')}>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {p ? 'trade plan' : `shadow plan — would be ${shown.side} if it confirms`}
            </p>
            <Badge tone={shown.netExpectancyR > 0 ? 'bull' : 'warning'}>net {fmtR(shown.netExpectancyR)}</Badge>
          </div>

          <div className="grid gap-x-5 gap-y-0.5 sm:grid-cols-2">
            <Row label="entry zone" value={`${fmtPrice(shown.entryZone[0])} → ${fmtPrice(shown.entryZone[1])}`} />
            <Row
              label={`stop · ${shown.stopBasis}`}
              value={`${fmtPrice(shown.stopLoss)}`}
              hint={`${(((shown.stopLoss - shown.entry) / shown.entry) * 100).toFixed(2)}% · ${shown.riskDistanceAtr.toFixed(2)} ATR`}
              tone="bear"
            />
            {shown.takeProfits.map((t, idx) => (
              <Row
                key={idx}
                label={`tp${idx + 1} · ${t.basis}`}
                value={fmtPrice(t.price)}
                hint={`${t.rr.toFixed(2)}R · ${t.allocationPct}%`}
                tone="bull"
              />
            ))}
            <Row label="blended R:R" value={`${shown.expectedRr.toFixed(2)}R`} />
            <Row label="win probability" value={`${(shown.winProbability * 100).toFixed(0)}%`} />
            <Row label="expectancy (gross)" value={fmtR(shown.expectancyR)} />
            <Row label="expectancy (net of costs)" value={fmtR(shown.netExpectancyR)} tone={shown.netExpectancyR > 0 ? 'bull' : 'warning'} />
          </div>

          <div className="mt-2 grid gap-x-5 gap-y-0.5 border-t border-border pt-2 sm:grid-cols-2">
            <Row label="leverage" value={`${shown.leverage}×`} />
            <Row label="contracts" value={shown.contracts.toString()} />
            <Row label="notional" value={fmtUsd(shown.notionalUsd)} />
            <Row label="margin" value={fmtUsd(shown.marginUsd)} hint={`${shown.marginPctOfEquity.toFixed(1)}%`} />
            <Row label="risk if stopped" value={fmtUsd(shown.riskUsd)} tone="bear" />
            <Row label="liquidation" value={shown.liquidationEstimate ? fmtPrice(shown.liquidationEstimate) : '—'} />
            <Row label="fees + slippage" value={`${fmtUsd(shown.feesUsd)} · ${shown.slippageBps.toFixed(1)}bps`} />
            <Row label="funding over hold" value={fmtUsd(shown.fundingCostUsd)} />
            <Row label="time to tp1" value={`~${shown.expectedBarsToTarget} bars`} />
            <Row label="time stop" value={`${shown.timeStopBars} bars`} />
            <Row label="break-even trigger" value={fmtPrice(shown.breakevenTrigger)} />
            <Row label="invalidation" value={fmtPrice(shown.invalidation)} />
          </div>

          <p className="mt-2 rounded border border-border bg-background/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
            {shown.sizingAdvice}
          </p>

          {shown.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {shown.warnings.map((w, i) => (
                <li key={i} className="text-[11px] leading-snug text-warning">
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
          No plan: the engine has nothing worth risking capital on right now.
        </div>
      )}

      {/* narrative */}
      <div className="space-y-1 border-t border-border pt-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">reasoning</p>
        {a.narrative.slice(0, 4).map((n, i) => (
          <p key={i} className="text-[11px] leading-relaxed text-foreground/85">
            {n}
          </p>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground">
        24h {fmtPct(((a.price - (a.mtf[0]?.price ?? a.price)) / (a.mtf[0]?.price || 1)) * 100, 2) === '—' ? '—' : ''}
        turnover {fmtUsd(a.liquidity.volUsd24h)} · spread{' '}
        {a.liquidity.spreadBps != null ? `${a.liquidity.spreadBps.toFixed(2)}bps` : '—'} · execute manually on OKX
      </p>
    </Panel>
  )
}
