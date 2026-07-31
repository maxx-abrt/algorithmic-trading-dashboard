'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { UniverseRow } from '@/lib/types'
import { Badge, Input } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { fmtPct, fmtPrice, fmtUsd } from '@/lib/format'
import { Search } from 'lucide-react'

const TYPES = ['ALL', 'SWAP', 'SPOT', 'FUTURES'] as const
const RECENT_KEY = 'mycroft.recent-instruments'

export function InstrumentSearch({
  value,
  onSelect,
  className,
}: {
  value: string
  onSelect: (instId: string) => void
  className?: string
}) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number]>('ALL')
  const [rows, setRows] = useState<UniverseRow[]>([])
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'))
    } catch {
      setRecent([])
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let alive = true
    const id = setTimeout(async () => {
      try {
        const res = await api<{ total: number; rows: UniverseRow[] }>(
          `/universe?q=${encodeURIComponent(query)}&instType=${type}&limit=40`,
        )
        if (alive) {
          setRows(res.rows)
          setCursor(0)
        }
      } catch {
        if (alive) setRows([])
      }
    }, 140)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [query, type, open])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const pick = (instId: string) => {
    onSelect(instId)
    setOpen(false)
    setQuery('')
    const next = [instId, ...recent.filter((r) => r !== instId)].slice(0, 8)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      /* private mode */
    }
  }

  const list = useMemo(() => rows, [rows])

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="instrument-search-input"
            value={open ? query : value}
            placeholder="Search 1,900+ OKX instruments — BTC, NVDA, SOL-USDT-SWAP…"
            className="num pl-7 pr-2"
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, list.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(0, c - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const row = list[cursor]
                if (row) pick(row.instId)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
          />
        </div>
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-[38px] z-50 overflow-hidden rounded-lg border border-border bg-card shadow-float">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors',
                  type === t ? 'bg-card-2 text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
              </button>
            ))}
            {recent.length > 0 && !query && (
              <div className="ml-auto flex items-center gap-1 overflow-x-auto">
                <span className="text-[10px] text-muted-foreground">recent</span>
                {recent.slice(0, 5).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => pick(r)}
                    className="num rounded bg-card-2 px-1.5 py-0.5 text-[10px] hover:bg-muted"
                  >
                    {r.split('-')[0]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <ul data-testid="instrument-search-results" className="max-h-[420px] overflow-y-auto">
            {list.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">No instrument matches that query.</li>
            )}
            {list.map((r, idx) => (
              <li key={r.instId}>
                <button
                  type="button"
                  data-testid="instrument-search-result-item"
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => pick(r.instId)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                    idx === cursor ? 'bg-muted/50' : 'hover:bg-muted/30',
                  )}
                >
                  <span className="num w-[170px] shrink-0 truncate text-xs">{r.instId}</span>
                  <Badge tone={r.instType === 'SWAP' ? 'info' : r.instType === 'SPOT' ? 'neutral' : 'warning'}>
                    {r.instType}
                  </Badge>
                  {r.isEquity && <Badge tone="plain">xSTOCK</Badge>}
                  <span className="num ml-auto w-[92px] shrink-0 text-right text-xs">{fmtPrice(r.last)}</span>
                  <span
                    className={cn(
                      'num w-[74px] shrink-0 text-right text-xs',
                      (r.changePct24h ?? 0) >= 0 ? 'text-bull' : 'text-bear',
                    )}
                  >
                    {fmtPct(r.changePct24h, 2)}
                  </span>
                  <span className="num hidden w-[80px] shrink-0 text-right text-[11px] text-muted-foreground sm:block">
                    {fmtUsd(r.volUsd24h)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
