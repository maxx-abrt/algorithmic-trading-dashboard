'use client'

import { useState } from 'react'
import { post, usePoll } from '@/lib/api'
import type { OperationsState } from '@/lib/types'
import { Badge, Button, EmptyState, Gauge, Panel, Row } from '@/components/ui/kit'
import { ago } from '@/lib/format'
import { DatabaseBackup, HardDrive, Loader2, RadioTower } from 'lucide-react'
import { toast } from 'sonner'

export default function OperationsPage() {
  const ops = usePoll<OperationsState>('/operations', 6000)
  const [backingUp, setBackingUp] = useState(false)
  const [exporting, setExporting] = useState(false)
  const data = ops.data
  const health = data?.health
  const memoryPct = health ? (health.resources.rssMb / Math.max(1, health.resources.totalMemoryMb)) * 100 : 0
  const budgetPct = health ? (health.ai.monthlySpendEur / Math.max(0.01, health.ai.monthlyBudgetEur)) * 100 : 0

  const backup = async () => {
    setBackingUp(true)
    try { await post('/operations/backup'); toast.success('SQLite backup completed and registered'); await ops.refresh() }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Backup failed') }
    finally { setBackingUp(false) }
  }

  const exportParquet = async () => {
    setExporting(true)
    try { await post('/operations/export', {}); toast.success('Canonical candle store exported to Parquet'); await ops.refresh() }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Parquet export failed') }
    finally { setExporting(false) }
  }

  return <div className="space-y-3">
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Panel title="OKX feed" data-testid="ops-feed-freshness"><div className="flex items-center gap-2"><RadioTower className="h-4 w-4" /><Badge tone={health?.ws.public.healthy && health?.ws.business.healthy ? 'bull' : 'bear'}>{health?.ws.public.healthy && health?.ws.business.healthy ? 'LIVE' : 'DEGRADED'}</Badge></div><div className="mt-3 space-y-0.5"><Row label="REST latency" value={health ? `${health.rest.avgLatencyMs.toFixed(0)} ms` : '—'} /><Row label="WS messages" value={health?.counters.wsMessages.toLocaleString() ?? '—'} /><Row label="candle gaps" value={String(health?.memory.gaps ?? '—')} /></div></Panel>
      <Panel title="Process resources"><div className="mb-2 flex justify-between text-[10px] text-muted-foreground"><span>RSS / host RAM</span><span className="num">{health?.resources.rssMb.toFixed(0) ?? '—'} MB</span></div><Gauge value={memoryPct} tone={memoryPct > 70 ? 'warning' : 'info'} /><div className="mt-3 space-y-0.5"><Row label="host free" value={health ? `${health.resources.freeMemoryMb.toFixed(0)} MB` : '—'} /><Row label="load 1m" value={health?.resources.load1.toFixed(2) ?? '—'} /></div></Panel>
      <Panel title="AI budget" data-testid="ops-budget-meter"><div className="mb-2 flex justify-between text-[10px] text-muted-foreground"><span>estimated monthly spend</span><span className="num">€{health?.ai.monthlySpendEur.toFixed(4) ?? '0.0000'} / €{health?.ai.monthlyBudgetEur.toFixed(2) ?? '10.00'}</span></div><Gauge value={budgetPct} tone={budgetPct > 80 ? 'warning' : 'bull'} /><div className="mt-3 space-y-0.5"><Row label="calls" value={String(data?.aiUsage.calls ?? 0)} /><Row label="tokens" value={String((data?.aiUsage.tokensIn ?? 0) + (data?.aiUsage.tokensOut ?? 0))} /><Row label="circuit breaker" value={health?.ai.budgetBlocked ? 'blocked' : 'ready'} tone={health?.ai.budgetBlocked ? 'warning' : 'bull'} /></div></Panel>
      <Panel title="Local truth store"><div className="flex items-center gap-2"><HardDrive className="h-4 w-4" /><Badge tone="info">SQLite WAL</Badge></div><div className="mt-3 space-y-0.5"><Row label="database" value={data ? `${(data.database.bytes / 1024 / 1024).toFixed(2)} MB` : '—'} /><Row label="candles" value={String(health?.localStore.candles ?? '—')} /><Row label="decisions" value={String(health?.localStore.decisions ?? '—')} /><Row label="paper events" value={String(health?.localStore.paperEvents ?? '—')} /></div></Panel>
    </div>

    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <Panel className="xl:col-span-8" title="Data quality event stream" subtitle="gaps, repairs and source anomalies are explicit, never silently filled" bodyClassName="p-0" data-testid="ops-panel">
        {!data?.qualityEvents.length ? <EmptyState icon={<RadioTower className="h-6 w-6" />} title="No quality event recorded">A quiet ledger is expected while OKX continuity remains intact.</EmptyState> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] border-collapse"><thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground"><th className="px-3 py-2 text-left">Observed</th><th className="px-3 py-2 text-left">Instrument</th><th className="px-3 py-2 text-left">Kind</th><th className="px-3 py-2 text-left">Detail</th><th className="px-3 py-2 text-left">Repair</th></tr></thead><tbody>{data.qualityEvents.map((event) => <tr key={event.id} className="border-b border-border/50"><td className="num px-3 py-2 text-[10px]">{ago(event.observed_at)}</td><td className="num px-3 py-2 text-xs">{event.inst_id} {event.timeframe}</td><td className="px-3 py-2"><Badge tone={event.severity === 'warning' ? 'warning' : 'info'}>{event.kind}</Badge></td><td className="px-3 py-2 text-[11px]">{event.detail}</td><td className="px-3 py-2 text-[10px] text-muted-foreground">{event.repaired_at ? ago(event.repaired_at) : 'pending / not needed'}</td></tr>)}</tbody></table></div>}
      </Panel>
      <Panel className="xl:col-span-4" title="Backup and recovery" data-testid="ops-last-backup"><div className="flex items-start gap-3"><DatabaseBackup className="mt-0.5 h-5 w-5 text-info" /><div><p className="text-xs font-medium">Consistent SQLite snapshot</p><p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Uses SQLite online backup while WAL writes continue. Coolify must mount the data and backups directories as persistent volumes.</p></div></div><div className="mt-4 space-y-0.5"><Row label="last backup" value={data?.lastBackup ? ago(data.lastBackup.at) : 'never'} mono={false} /><Row label="pages copied" value={String(data?.lastBackup?.pages ?? '—')} /><Row label="Parquet export" value={data?.lastParquetExport ? `${data.lastParquetExport.rows.toLocaleString()} rows · ${ago(data.lastParquetExport.at)}` : 'never'} mono={false} /><Row label="research governor" value={health?.research.governor.allowed ? 'ready' : health?.research.governor.reasons.join(', ')} tone={health?.research.governor.allowed ? 'bull' : 'warning'} /></div><div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2"><Button variant="secondary" onClick={backup} disabled={backingUp} data-testid="operations-backup-button">{backingUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DatabaseBackup className="h-3.5 w-3.5" />}Backup SQLite</Button><Button variant="secondary" onClick={exportParquet} disabled={exporting} data-testid="operations-parquet-export-button">{exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDrive className="h-3.5 w-3.5" />}Export Parquet</Button></div></Panel>
    </div>
  </div>
}
