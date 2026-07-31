'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Badge, Panel } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { clockUtc } from '@/lib/format'
import type { LogEntry } from '@/lib/types'
import { useState } from 'react'

const LEVEL_TONE: Record<string, string> = {
  info: 'text-muted-foreground',
  signal: 'text-bull',
  ai: 'text-info',
  alert: 'text-warning',
  error: 'text-bear',
  scan: 'text-info',
  trade: 'text-bull',
}

const FILTERS = ['all', 'signal', 'ai', 'alert', 'scan', 'error'] as const

export function LogTerminal({ className }: { className?: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const rows = useQuery(api.logs.list, { limit: 150 }) as LogEntry[] | undefined
  const filtered = (rows ?? []).filter((r) => (filter === 'all' ? true : r.level === filter))

  return (
    <Panel
      className={className}
      title="Engine terminal"
      subtitle="reactive stream from Convex — quant evaluations, AI verdicts, alerts"
      actions={
        <div className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              data-testid={`log-filter-${f}`}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors',
                filter === f ? 'bg-card-2 text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      }
      bodyClassName="p-0"
    >
      <div data-testid="log-terminal" className="max-h-[280px] min-h-[140px] overflow-y-auto px-2.5 py-2">
        {rows === undefined && <div className="skeleton h-24 rounded" />}
        {rows !== undefined && filtered.length === 0 && (
          <p className="py-8 text-center text-xs text-muted-foreground">No log lines at this level yet.</p>
        )}
        <ul className="space-y-0.5">
          {filtered.map((r, idx) => (
            <li key={r._id ?? `${r.ts}-${idx}`} className="num flex items-start gap-2 text-[11px] leading-relaxed">
              <span className="shrink-0 text-muted-foreground/70">{clockUtc(r.ts)}</span>
              <span className={cn('w-[46px] shrink-0 uppercase', LEVEL_TONE[r.level] ?? 'text-muted-foreground')}>
                {r.level}
              </span>
              <span className="shrink-0 text-muted-foreground">{r.scope}</span>
              <span className="min-w-0 flex-1 break-words text-foreground/90">{r.message}</span>
              {r.instId && (
                <Badge tone="neutral" className="shrink-0">
                  {r.instId.split('-')[0]}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}
