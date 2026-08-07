'use client'

import { usePoll, post } from '@/lib/api'
import type { Health } from '@/lib/types'
import type { ExecutionState } from '@/lib/evolution'
import { fmtR } from '@/lib/evolution'
import { Badge, Button, Chip, EmptyState, ErrorNote, Gauge, Panel, Row, Skeleton } from '@/components/ui/kit'
import { ago, compactDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Archive, Database, HardDrive, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useState } from 'react'

interface OperationsState {
  health: Health
  qualityEvents: { id: number; observed_at: number; inst_id: string; timeframe: string; kind: string; severity: string; detail: string }[]
  lastBackup: { destination: string; at: number; pages: number } | null
  backups: { name: string; bytes: number; at: number }[]
  disk: { dataDir: string; backupDir: string; dbBytes: number; backupBytes: number; freeBytes: number | null; totalBytes: number | null; usedPct: number | null }
  database: { path: string; bytes: number; restoredFrom: string | null }
  aiUsage: { spend: number; tokensIn: number; tokensOut: number; calls: number }
  demo: ExecutionState['demo']
}

const gb = (bytes: number | null | undefined) => (bytes == null ? '—' : `${(bytes / 1e9).toFixed(2)} GB`)
const mb = (bytes: number | null | undefined) => (bytes == null ? '—' : `${(bytes / 1e6).toFixed(1)} MB`)

export default function OperationsPage() {
  const { data, error, refresh } = usePoll<OperationsState>('/operations', 8000)
  const execution = usePoll<ExecutionState>('/execution?limit=60', 10000)
  const [busy, setBusy] = useState(false)

  const backupNow = async () => {
    setBusy(true)
    try {
      const res = await post<{ destination: string; pages: number }>('/operations/backup')
      toast.success(`Snapshot written (${res.pages} pages)`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backup failed')
    } finally {
      setBusy(false)
    }
  }

  const h = data?.health

  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-3 p-3 pb-24 sm:p-4 md:pb-4" data-testid="operations-page">
      {error && <ErrorNote message={error} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel title="Uptime" data-testid="ops-uptime">
          {!h ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <p className="num text-xl font-semibold">{compactDuration(h.uptimeSec)}</p>
              <Row label="engine" value={<Badge tone={h.engineEnabled ? 'bull' : 'warning'}>{h.engineEnabled ? 'running' : 'paused'}</Badge>} mono={false} />
              <Row label="instruments" value={h.universe.instruments} />
              <Row label="evaluations" value={h.counters.evaluations} />
            </>
          )}
        </Panel>

        <Panel title="Resources" data-testid="ops-resources">
          {!h ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <Row label="engine RSS" value={`${h.resources.rssMb.toFixed(0)} MB`} tone={h.resources.rssMb > 900 ? 'warning' : 'neutral'} />
              <Row label="host free RAM" value={`${(h.resources.freeMemoryMb / 1024).toFixed(2)} GB`} />
              <Row label="load (1m)" value={h.resources.load1.toFixed(2)} />
              <Row label="candle series" value={h.memory.series} hint={`${h.memory.bars} bars`} />
            </>
          )}
        </Panel>

        <Panel
          title="Storage"
          data-testid="ops-storage"
          actions={
            <Button variant="secondary" disabled={busy} onClick={() => void backupNow()} data-testid="ops-backup-now">
              <Archive className="h-3.5 w-3.5" /> snapshot
            </Button>
          }
        >
          {!data ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <Row label="database" value={mb(data.disk.dbBytes)} />
              <Row label="snapshots" value={`${data.backups.length} · ${mb(data.disk.backupBytes)}`} />
              <Row label="disk free" value={gb(data.disk.freeBytes)} tone={(data.disk.freeBytes ?? Infinity) < 20e9 ? 'warning' : 'bull'} />
              {data.disk.usedPct != null && <Gauge value={data.disk.usedPct} tone={data.disk.usedPct > 85 ? 'bear' : 'info'} className="mt-1" />}
            </>
          )}
        </Panel>

        <Panel title="AI spend this month" data-testid="ops-ai">
          {!data || !h ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <p className="num text-xl font-semibold">
                €{data.aiUsage.spend.toFixed(3)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">/ €{h.ai.monthlyBudgetEur.toFixed(2)}</span>
              </p>
              <Gauge value={(data.aiUsage.spend / Math.max(0.01, h.ai.monthlyBudgetEur)) * 100} tone={h.ai.budgetBlocked ? 'bear' : 'info'} className="mt-1" />
              <Row label="calls" value={data.aiUsage.calls} />
              <Row label="tokens" value={`${data.aiUsage.tokensIn} in / ${data.aiUsage.tokensOut} out`} />
            </>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Persistence" subtitle="a redeploy must never cost the system its memory" data-testid="ops-persistence">
          {!data ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <Database className="mt-0.5 h-4 w-4 text-info" />
                <div className="min-w-0">
                  <p className="break-all text-[11px]">{data.database.path}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {mb(data.database.bytes)} · {data.database.restoredFrom ? `restored from ${data.database.restoredFrom} on boot` : 'opened in place'}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <HardDrive className="mt-0.5 h-4 w-4 text-info" />
                <div className="min-w-0">
                  <p className="break-all text-[11px]">{data.disk.backupDir}</p>
                  <p className="text-[10px] text-muted-foreground">rolling snapshots every 6h, newest 12 kept</p>
                </div>
              </div>
              {data.backups.length ? (
                <ul className="max-h-40 space-y-1 overflow-y-auto pt-1">
                  {data.backups.map((file) => (
                    <li key={file.name} className="flex items-baseline justify-between gap-2 text-[10px]">
                      <span className="truncate text-muted-foreground">{file.name}</span>
                      <span className="num shrink-0">{mb(file.bytes)} · {ago(file.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11px] text-warning">No snapshot yet. One is written automatically within the first 6 hours.</p>
              )}
            </div>
          )}
        </Panel>

        <Panel title="OKX demo execution" subtitle="real orders on the simulated account make fill quality measurable" data-testid="ops-demo">
          {!data ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={data.demo.configured ? 'bull' : 'warning'}>{data.demo.configured ? 'connected' : 'disabled'}</Badge>
                {data.demo.simulated && <Badge tone="info">simulated</Badge>}
              </div>
              {!data.demo.configured && <p className="rounded border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">{data.demo.reason}</p>}
              <Row label="demo equity" value={data.demo.equityUsd == null ? '—' : `$${data.demo.equityUsd.toFixed(2)}`} />
              <Row label="orders placed" value={data.demo.placed} />
              <Row label="filled" value={data.demo.filled} tone={data.demo.filled ? 'bull' : 'neutral'} />
              <Row label="rejected" value={data.demo.rejected} tone={data.demo.rejected ? 'warning' : 'neutral'} />
              {execution.data && (
                <>
                  <Row label="fill rate" value={execution.data.parity.fillRate == null ? '—' : `${(execution.data.parity.fillRate * 100).toFixed(0)}%`} hint={`n=${execution.data.parity.terminal}`} />
                  <Row
                    label="mean entry slippage"
                    value={execution.data.parity.meanEntrySlippageBps == null ? '—' : `${execution.data.parity.meanEntrySlippageBps.toFixed(1)} bps`}
                    tone={(execution.data.parity.meanEntrySlippageBps ?? 0) > 5 ? 'warning' : 'neutral'}
                  />
                </>
              )}
              {data.demo.lastError && <p className="break-words text-[10px] text-bear">{data.demo.lastError}</p>}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Feed health" data-testid="ops-feed">
          {!h ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1.5">
                <Chip tone={h.ws.public.healthy ? 'bull' : 'bear'}>public ws · {h.ws.public.subs} subs</Chip>
                <Chip tone={h.ws.business.healthy ? 'bull' : 'bear'}>business ws · {h.ws.business.subs} subs</Chip>
                <Chip tone={h.rest.errors > 0 ? 'warning' : 'bull'}>rest · {h.rest.calls} calls</Chip>
              </div>
              <Row label="rest latency" value={`${h.rest.avgLatencyMs.toFixed(0)} ms`} />
              <Row label="ws messages" value={h.counters.wsMessages} />
              <Row label="errors" value={h.counters.errors} tone={h.counters.errors ? 'warning' : 'neutral'} />
              <Row label="scanner" value={`${h.scanner.scanned} scored`} hint={h.scanner.at ? ago(h.scanner.at) : 'pending'} />
              <Row label="telegram" value={`${h.telegram.chats} chat(s)`} hint={h.telegram.configured ? 'online' : 'not configured'} />
            </div>
          )}
        </Panel>

        <Panel title="Data quality events" subtitle="gaps, stale feeds and repairs, never silently forward-filled" data-testid="ops-quality">
          {!data ? (
            <Skeleton className="h-24" />
          ) : !data.qualityEvents.length ? (
            <EmptyState icon={<Server className="h-8 w-8" />} title="No data-quality events">
              Every confirmed bar arrived in sequence.
            </EmptyState>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {data.qualityEvents.map((event) => (
                <li key={event.id} className="flex flex-wrap items-baseline gap-2 border-b border-border/40 pb-1.5 text-[11px] last:border-0">
                  <Badge tone={event.severity === 'error' ? 'bear' : event.severity === 'warn' ? 'warning' : 'neutral'}>{event.kind}</Badge>
                  <span className="font-medium">{event.inst_id}</span>
                  <span className="text-muted-foreground">{event.timeframe}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{ago(event.observed_at)}</span>
                  <p className="w-full text-[10px] text-muted-foreground">{event.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {execution.data?.orders?.length ? (
        <Panel title="Recent OKX demo orders" subtitle="raw exchange truth, reconciled into the ledger" bodyClassName="p-0" data-testid="ops-orders">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-xs">
              <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Instrument</th>
                  <th className="px-2 py-2">Side</th>
                  <th className="px-2 py-2 text-right">Size</th>
                  <th className="px-2 py-2 text-right">Limit</th>
                  <th className="px-2 py-2 text-right">Avg fill</th>
                  <th className="px-2 py-2">State</th>
                  <th className="px-3 py-2">When</th>
                </tr>
              </thead>
              <tbody>
                {execution.data.orders.slice(0, 30).map((order) => (
                  <tr key={String(order.cl_ord_id)} className="border-b border-border/50">
                    <td className="px-3 py-2">{String(order.inst_id)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={String(order.side) === 'buy' ? 'bull' : 'bear'}>{String(order.side)}</Badge>
                    </td>
                    <td className="num px-2 py-2 text-right">{String(order.sz)}</td>
                    <td className="num px-2 py-2 text-right">{order.px == null ? '—' : String(order.px)}</td>
                    <td className="num px-2 py-2 text-right">{order.avg_px == null ? '—' : String(order.avg_px)}</td>
                    <td className="px-2 py-2">
                      <Badge tone={String(order.state) === 'filled' ? 'bull' : String(order.state) === 'rejected' ? 'bear' : 'neutral'}>{String(order.state)}</Badge>
                    </td>
                    <td className="px-3 py-2 text-[10px] text-muted-foreground">{ago(Number(order.created_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {h?.evolution ? (
        <Panel title="Learning state" subtitle="what the system currently knows" data-testid="ops-learning">
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
            <Row label="validation state" value={<Badge tone={h.evolution.validationState === 'VALIDATED' ? 'bull' : 'warning'}>{h.evolution.validationState}</Badge>} mono={false} />
            <Row label="labelled samples" value={h.evolution.samples} />
            <Row label="specialists" value={h.evolution.specialists} />
            <Row label="champions" value={h.evolution.champions} />
          </div>
          {h.evolution.championList?.length ? (
            <ul className="mt-2 space-y-1">
              {h.evolution.championList.map((row) => (
                <li key={row.displayName} className="flex flex-wrap items-baseline gap-2 text-[11px]">
                  <span className="font-medium">{row.displayName}</span>
                  <Badge tone="plain">G{row.generation}</Badge>
                  <span className="text-muted-foreground">{row.nicheKey}</span>
                  <span className={cn('num ml-auto', (row.liveMeanR ?? 0) >= 0 ? 'text-bull' : 'text-bear')}>
                    {fmtR(row.liveMeanR)} <span className="text-muted-foreground">/ {row.liveTrades}t</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}
    </div>
  )
}
