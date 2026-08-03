'use client'

import { useEffect, useMemo, useState } from 'react'
import { post, usePoll, useFlash, api } from '@/lib/api'
import type { Analysis, ChartPayload, EngineSettings } from '@/lib/types'
import { InstrumentSearch } from '@/components/terminal/instrument-search'
import { DEFAULT_OVERLAYS, OverlayRack, PriceChart, type OverlayState } from '@/components/terminal/price-chart'
import { DecisionCard } from '@/components/terminal/decision-card'
import { StrategyCandidates } from '@/components/terminal/strategy-candidates'
import { EvidenceRail } from '@/components/terminal/evidence-rail'
import { LogTerminal } from '@/components/terminal/log-terminal'
import { Badge, Button, Panel, Row } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { ago, fmtPct, fmtPrice, fmtUsd } from '@/lib/format'
import { toast } from 'sonner'
import { RefreshCw, SlidersHorizontal } from 'lucide-react'

const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D', '1W']
const OVERLAY_KEY = 'mycroft.overlays'

const BAR_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1H': 60,
  '2H': 120,
  '4H': 240,
  '6H': 360,
  '12H': 720,
  '1D': 1440,
  '1W': 10080,
}

export default function TerminalPage() {
  const [instId, setInstId] = useState<string>('')
  const [bar, setBar] = useState<string>('')
  const [overlays, setOverlays] = useState<OverlayState>(DEFAULT_OVERLAYS)
  const [showRack, setShowRack] = useState(false)
  const [asking, setAsking] = useState(false)

  /* ---- bootstrap from the engine focus -------------------------------- */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const s = await api<EngineSettings>('/settings')
        if (!alive) return
        setInstId(s.instId)
        setBar(s.timeframe)
      } catch {
        if (alive) {
          setInstId('BTC-USDT-SWAP')
          setBar('15m')
        }
      }
    })()
    try {
      const saved = localStorage.getItem(OVERLAY_KEY)
      if (saved) setOverlays({ ...DEFAULT_OVERLAYS, ...JSON.parse(saved) })
    } catch {
      /* ignore */
    }
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlays))
    } catch {
      /* ignore */
    }
  }, [overlays])

  const ready = Boolean(instId && bar)
  const query = ready ? `?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}` : ''
  const analysis = usePoll<Analysis>(ready ? `/analysis${query}` : null, 4000)
  const chart = usePoll<ChartPayload>(ready ? `/chart${query}&limit=320` : null, 6000)

  const a = analysis.data
  const flash = useFlash(a?.price ?? null)
  // A closed bar is naturally up to one bar old \u2014 only flag a genuinely frozen feed.
  const stale = Boolean(a && a.dataQuality.staleMs > (BAR_MINUTES[a.timeframe] ?? 15) * 60_000 * 2)

  /* ---- focus changes move the engine, not just the view --------------- */
  const focus = async (nextInst: string, nextBar: string) => {
    setInstId(nextInst)
    setBar(nextBar)
    try {
      await post('/settings', { instId: nextInst, timeframe: nextBar })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move engine focus')
    }
  }

  const askAi = async () => {
    if (!ready) return
    setAsking(true)
    try {
      const res = await post<{ opinion: { decision: string; confidence: number } | null }>('/analysis/ai', {
        instId,
        bar,
      })
      await analysis.refresh()
      toast.success(
        res.opinion
          ? `AI verdict: ${res.opinion.decision} at ${res.opinion.confidence.toFixed(0)}% confidence`
          : 'AI returned no opinion',
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI call failed')
    } finally {
      setAsking(false)
    }
  }

  const change24h = useMemo(() => {
    const c = chart.data?.candles
    if (!c || c.length < 2 || !a) return null
    const first = c[Math.max(0, c.length - 96)]
    return first ? ((a.price - first.close) / first.close) * 100 : null
  }, [chart.data, a])

  return (
    <div className="space-y-3">
      {/* command row */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <InstrumentSearch value={instId} onSelect={(id) => void focus(id, bar)} className="lg:w-[520px]" />

        <div className="flex flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {BARS.map((b) => (
            <button
              key={b}
              type="button"
              data-testid={`timeframe-${b}`}
              onClick={() => void focus(instId, b)}
              className={cn(
                'num shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors',
                bar === b
                  ? 'border-bull/40 bg-bull/12 text-bull'
                  : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
              )}
            >
              {b}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-baseline gap-2 rounded-md border border-border px-2.5 py-1">
            <span
              data-testid="terminal-price"
              className={cn(
                'num text-base font-semibold',
                flash === 'up' && 'flash-bull',
                flash === 'down' && 'flash-bear',
              )}
            >
              {fmtPrice(a?.price)}
            </span>
            {change24h != null && (
              <span className={cn('num text-[11px]', change24h >= 0 ? 'text-bull' : 'text-bear')}>
                {fmtPct(change24h, 2)}
              </span>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => setShowRack((v) => !v)} title="Chart overlays" data-testid="toggle-overlay-rack">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Force a fresh evaluation"
            data-testid="terminal-refresh"
            onClick={() => {
              void api<Analysis>(`/analysis${query}&force=1`).then(() => analysis.refresh())
              void chart.refresh()
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {analysis.error && (
        <div className="rounded-md border border-bear/30 bg-bear/10 px-3 py-2 text-xs text-bear">
          {analysis.error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
        {/* left: chart + logs */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-8">
          <Panel
            title={
              <span className="flex items-center gap-2">
                {instId || 'loading'}
                <Badge tone="neutral">{bar}</Badge>
                {a?.session.isEquity && (
                  <Badge tone={a.session.marketOpen ? 'bull' : 'warning'} title={a.session.note}>
                    {a.session.session}
                  </Badge>
                )}
                {a && (
                  <Badge tone={a.decision === 'LONG' ? 'bull' : a.decision === 'SHORT' ? 'bear' : 'neutral'}>
                    {a.decision} {a.conviction.toFixed(0)}
                  </Badge>
                )}
              </span>
            }
            subtitle={
              chart.data
                ? `${chart.data.candles.length} bars · ${chart.data.levels.length} levels · ${chart.data.markers.length} markers · updated ${ago(chart.updatedAt)}`
                : 'loading candles…'
            }
            bodyClassName="p-0"
          >
            {showRack && (
              <div className="border-b border-border bg-card-2/40 p-3">
                <OverlayRack value={overlays} onChange={setOverlays} />
              </div>
            )}
            <PriceChart payload={chart.data} overlays={overlays} stale={stale} height={470} />
          </Panel>

          <LogTerminal />
        </div>

        {/* right: decision + evidence */}
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-4">
          <DecisionCard analysis={a} onAsk={askAi} asking={asking} />
          <StrategyCandidates instId={instId} />
          <EvidenceRail analysis={a} />

          {a && (
            <Panel title="Data quality" subtitle="a decision is only as good as its feed">
              <div className="grid gap-x-5 sm:grid-cols-2">
                <Row label={`${a.timeframe} bars`} value={a.dataQuality.ltfBars.toString()} />
                <Row label={`${a.htfTimeframe} bars`} value={a.dataQuality.htfBars.toString()} />
                <Row label={`${a.htf2Timeframe} bars`} value={a.dataQuality.htf2Bars.toString()} />
                <Row
                  label="last close age"
                  value={a.dataQuality.staleMs >= 0 ? `${Math.round(a.dataQuality.staleMs / 1000)}s` : '—'}
                  tone={stale ? 'warning' : undefined}
                />
                <Row label="turnover 24h" value={fmtUsd(a.liquidity.volUsd24h)} />
                <Row
                  label="spread"
                  value={a.liquidity.spreadBps != null ? `${a.liquidity.spreadBps.toFixed(2)}bps` : '—'}
                />
              </div>
              {a.dataQuality.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
                  {a.dataQuality.warnings.map((w, i) => (
                    <li key={i} className="text-[10px] leading-snug text-muted-foreground">
                      · {w.replace('[info] ', '')}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}
