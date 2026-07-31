'use client'

import { useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/convex/_generated/api'
import { cn } from '@/lib/utils'

const FILTERS = ['all', 'ai', 'signal', 'trade', 'error'] as const
type Filter = (typeof FILTERS)[number]

const LEVEL_STYLE: Record<string, string> = {
  info: 'text-muted-foreground',
  signal: 'text-chart-4',
  ai: 'text-foreground',
  trade: 'text-primary',
  error: 'text-destructive',
}

export function LogTerminal() {
  const logs = useQuery(api.logs.recent, { limit: 150 })
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const rows = (logs ?? []).filter((l) => filter === 'all' || l.level === filter)

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [rows.length])

  const totalTokens = (logs ?? []).reduce(
    (s, l) => s + (l.tokensIn ?? 0) + (l.tokensOut ?? 0),
    0,
  )

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-0 border-border bg-card py-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <CardTitle className="font-mono text-xs tracking-widest text-muted-foreground">
          QUANT / AI STREAM
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="border-border font-mono text-[10px]">
            {totalTokens.toLocaleString('en-US')} tok
          </Badge>
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'secondary' : 'ghost'}
              className="h-6 px-2 font-mono text-[10px] tracking-wider uppercase"
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 p-0">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="scroll-thin h-full max-h-[calc(100vh-22rem)] min-h-64 overflow-auto px-4 py-3"
          aria-live="polite"
          aria-label="Trading engine log stream"
        >
          {!logs && <p className="font-mono text-xs text-muted-foreground">Connecting…</p>}
          {logs && !rows.length && (
            <p className="font-mono text-xs text-muted-foreground">
              No entries yet. Start the worker with{' '}
              <code className="text-foreground">pnpm worker</code>.
            </p>
          )}

          <ol className="flex flex-col gap-1">
            {rows.map((l) => (
              <li key={l._id} className="font-mono text-[11px] leading-relaxed">
                <button
                  type="button"
                  className="flex w-full gap-2 text-left hover:bg-secondary/40"
                  onClick={() => setExpanded(expanded === l._id ? null : l._id)}
                  disabled={!l.snapshot}
                >
                  <span className="shrink-0 text-muted-foreground/60">
                    {new Date(l.ts).toLocaleTimeString('en-GB', { hour12: false })}
                  </span>
                  <span
                    className={cn(
                      'w-14 shrink-0 tracking-wider uppercase',
                      LEVEL_STYLE[l.level],
                    )}
                  >
                    {l.level}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-foreground/90">
                    {l.message}
                    {l.confidence !== undefined && l.level === 'ai' && (
                      <span
                        className={cn(
                          'ml-2',
                          l.confidence >= 70 ? 'text-primary' : 'text-chart-4',
                        )}
                      >
                        [{l.confidence}%]
                      </span>
                    )}
                  </span>
                </button>
                {expanded === l._id && l.snapshot && (
                  <pre className="scroll-thin mt-1 mb-2 max-h-48 overflow-auto rounded-md border border-border bg-secondary/40 p-2 text-[10px] text-muted-foreground">
                    {safePretty(l.snapshot)}
                  </pre>
                )}
              </li>
            ))}
          </ol>
        </div>
      </CardContent>
    </Card>
  )
}

function safePretty(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
