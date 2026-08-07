'use client'

import { usePoll, post } from '@/lib/api'
import type { Health } from '@/lib/types'
import { Chip, Dot, Button } from '@/components/ui/kit'
import { ago, compactDuration, fmtUsd } from '@/lib/format'
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { useState } from 'react'

export function StatusBar() {
  const { data, error, refresh } = usePoll<Health>('/health', 4000)
  const [busy, setBusy] = useState(false)

  const toggleEngine = async () => {
    if (!data) return
    setBusy(true)
    try {
      await post('/settings', { engineEnabled: !data.engineEnabled })
      toast.success(data.engineEnabled ? 'Engine paused' : 'Engine resumed')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  if (error && !data) {
    return (
      <div className="sticky top-[52px] z-30 border-b border-bear/30 bg-bear/10 px-4 py-1.5 text-[11px] text-bear">
        Decision engine unreachable ({error}). Start it with <code className="num">cd engine &amp;&amp; yarn start</code>.
      </div>
    )
  }

  const wsOk = Boolean(data?.ws.public.healthy && data?.ws.business.healthy)
  const restTone = !data ? 'neutral' : data.rest.avgLatencyMs > 900 ? 'warning' : 'neutral'

  return (
    <div className="sticky top-[52px] z-30 border-b border-border bg-background/70 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1920px] items-center gap-1.5 overflow-x-auto px-3 py-1.5 sm:px-4 lg:px-6 [scrollbar-width:none]">
        <Chip
          tone={data?.engineEnabled ? 'bull' : 'warning'}
          data-testid="status-engine"
          title={`uptime ${compactDuration(data?.uptimeSec ?? 0)}`}
        >
          <Dot tone={data?.engineEnabled ? 'bull' : 'warning'} pulse={data?.engineEnabled} />
          {data?.engineEnabled ? 'engine live' : 'engine paused'}
          <span className="num text-muted-foreground">{compactDuration(data?.uptimeSec ?? 0)}</span>
        </Chip>

        <Chip tone={wsOk ? 'neutral' : 'bear'} data-testid="status-websocket-health" title="OKX public + business sockets">
          <Dot tone={wsOk ? 'bull' : 'bear'} pulse={wsOk} />
          ws
          <span className="num">
            {data?.ws.public.subs ?? 0}+{data?.ws.business.subs ?? 0}
          </span>
          <span className="num text-muted-foreground">{(data?.counters.wsMessages ?? 0).toLocaleString('en-US')}</span>
        </Chip>

        <Chip tone={restTone} data-testid="status-rest-latency" title="OKX REST calls / average latency / errors">
          rest <span className="num">{data?.rest.avgLatencyMs.toFixed(0) ?? '—'}ms</span>
          <span className="num text-muted-foreground">{data?.rest.calls ?? 0}</span>
          {Boolean(data?.rest.errors) && <span className="num text-warning">{data?.rest.errors} err</span>}
        </Chip>

        <Chip data-testid="status-universe" title="instruments tracked / candle memory">
          universe <span className="num">{data?.universe.instruments ?? 0}</span>
          <span className="text-muted-foreground">·</span>
          <span className="num">{data?.memory.series ?? 0}</span> series
          <span className="num text-muted-foreground">{(data?.memory.bars ?? 0).toLocaleString('en-US')} bars</span>
        </Chip>

        <Chip
          tone={data?.scanner.running ? 'info' : 'neutral'}
          data-testid="status-scanner"
          title="universe scan cadence"
        >
          scan <span className="num">{data?.scanner.scanned ?? 0}</span>
          <span className="text-muted-foreground">{ago(data?.scanner.at)}</span>
        </Chip>

        <Chip
          tone={data?.ai.configured ? 'neutral' : 'warning'}
          data-testid="status-ai"
          title={data?.ai.lastError || 'Gemini arbitration cost'}
        >
          ai <span className="num">€{data?.ai.monthlySpendEur.toFixed(3) ?? '0.000'}</span>
          <span className="num text-muted-foreground">/ €{data?.ai.monthlyBudgetEur.toFixed(0) ?? '10'}</span>
          {Boolean(data?.ai.cacheHits) && <span className="num text-bull">{data?.ai.cacheHits} cached</span>}
        </Chip>

        <Chip
          tone="neutral"
          data-testid="status-local-store"
          title="Labelled point-in-time outcomes in the local SQLite truth store"
        >
          <Dot tone="bull" />
          sqlite <span className="num">{data?.evolution.samples ?? 0} samples</span>
        </Chip>

        <Chip tone={data?.evolution.validationState === 'VALIDATED' ? 'bull' : 'warning'} data-testid="status-model-validation" title="Champions must pass out-of-sample calibration, the shuffled-label placebo and forward evidence">
          {data?.evolution.validationState ?? 'NO_VALIDATED_MODEL'}
          {data?.evolution.champions ? <span className="num text-muted-foreground">{data.evolution.champions}</span> : null}
        </Chip>

        <Chip
          tone={data?.demoExecution.configured ? 'neutral' : 'warning'}
          data-testid="status-demo"
          title={data?.demoExecution.reason || 'OKX demo execution'}
        >
          <Dot tone={data?.demoExecution.configured ? 'bull' : 'warning'} />
          okx demo <span className="num">{data?.demoExecution.filled ?? 0}/{data?.demoExecution.placed ?? 0}</span>
        </Chip>

        <Chip
          tone={data?.telegram.configured ? 'neutral' : 'warning'}
          data-testid="status-telegram"
          title={data?.telegram.lastError || 'Telegram companion'}
        >
          <Dot tone={data?.telegram.configured ? 'bull' : 'warning'} />
          {data?.telegram.username ? `@${data.telegram.username}` : 'telegram'}
          <span className="num text-muted-foreground">{data?.telegram.chats ?? 0} chat</span>
        </Chip>

        <Chip tone={data?.okxKeys ? 'neutral' : 'neutral'} title="sizing base" data-testid="status-equity">
          book <span className="num">{fmtUsd(data?.account?.totalEquityUsd ?? null) !== '—' ? fmtUsd(data?.account?.totalEquityUsd ?? null) : 'paper'}</span>
        </Chip>

        <div className="ml-auto shrink-0">
          <Button
            variant={data?.engineEnabled ? 'ghost' : 'primary'}
            size="sm"
            onClick={toggleEngine}
            disabled={busy || !data}
            data-testid="status-engine-kill-switch"
          >
            {data?.engineEnabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {data?.engineEnabled ? 'Pause' : 'Resume'}
          </Button>
        </div>
      </div>
    </div>
  )
}
