'use client'

import { useQuery } from 'convex/react'
import { Activity } from 'lucide-react'
import { api } from '@/convex/_generated/api'
import { cn } from '@/lib/utils'

const SERVICES = [
  { id: 'worker', label: 'WORKER' },
  { id: 'okx_ws', label: 'OKX WS' },
  { id: 'okx_rest', label: 'OKX REST' },
  { id: 'ai', label: 'GEMINI' },
] as const

export function StatusBar({ envOk }: { envOk: { gemini: boolean; okx: boolean } }) {
  const telemetry = useQuery(api.telemetry.all)

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border px-4 py-3 lg:px-6">
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-primary" aria-hidden="true" />
        <span className="font-mono text-sm font-semibold tracking-tight">APEX-01</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Autonomous OKX Execution Terminal
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px]">
        {SERVICES.map((svc) => {
          const row = telemetry?.find((t) => t.service === svc.id)
          const stale = row ? Date.now() - row.lastPing > 20_000 : false
          const status = !row ? 'offline' : stale ? 'degraded' : row.status
          return (
            <div key={svc.id} className="flex items-center gap-1.5" title={row?.meta ?? ''}>
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  status === 'online' && 'bg-primary shadow-[0_0_6px_currentColor]',
                  status === 'degraded' && 'bg-chart-4',
                  status === 'offline' && 'bg-muted-foreground/40',
                )}
                aria-hidden="true"
              />
              <span className="text-muted-foreground">{svc.label}</span>
              <span className="sr-only">{status}</span>
            </div>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
        {!envOk.okx && <span className="text-chart-4">OKX keys missing — public data only</span>}
        {!envOk.gemini && <span className="text-chart-4">GEMINI_API_KEY missing</span>}
      </div>
    </header>
  )
}
