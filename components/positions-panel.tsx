'use client'

import { useQuery } from 'convex/react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/convex/_generated/api'
import { cn } from '@/lib/utils'

const HEADERS = ['SIDE', 'INSTRUMENT', 'ENTRY', 'MARK', 'SL', 'TP', 'SIZE', 'PNL']

export function PositionsPanel() {
  const open = useQuery(api.positions.listOpen)
  const history = useQuery(api.positions.history, { limit: 25 })
  const stats = useQuery(api.positions.stats)

  return (
    <Card className="gap-0 overflow-hidden border-border bg-card py-0">
      <Tabs defaultValue="open">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <TabsList className="h-8 bg-secondary">
            <TabsTrigger value="open" className="font-mono text-[11px]">
              OPEN {open?.length ? `(${open.length})` : ''}
            </TabsTrigger>
            <TabsTrigger value="history" className="font-mono text-[11px]">
              HISTORY
            </TabsTrigger>
          </TabsList>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <Stat label="UNREALIZED" value={stats?.openPnlUsd} usd />
            <Stat label="REALIZED" value={stats?.realizedPnlUsd} usd />
            <Stat
              label="WIN RATE"
              value={stats?.winRate}
              suffix="%"
              neutral
            />
            <Stat
              label="PF"
              value={stats?.profitFactor}
              neutral
            />
          </div>
        </div>

        <TabsContent value="open" className="m-0">
          <PositionTable rows={open} empty="No open positions. Waiting for a validated setup." />
        </TabsContent>
        <TabsContent value="history" className="m-0">
          <PositionTable rows={history} empty="No closed trades yet." closed />
        </TabsContent>
      </Tabs>
    </Card>
  )
}

function Stat({
  label,
  value,
  usd,
  suffix,
  neutral,
}: {
  label: string
  value: number | undefined
  usd?: boolean
  suffix?: string
  neutral?: boolean
}) {
  const v = value ?? 0
  return (
    <span className="flex items-center gap-1.5">
      <span>{label}</span>
      <span
        className={cn(
          'text-xs',
          neutral && 'text-foreground',
          !neutral && v > 0 && 'text-primary',
          !neutral && v < 0 && 'text-destructive',
          !neutral && v === 0 && 'text-foreground',
        )}
      >
        {value === undefined
          ? '—'
          : `${!neutral && v > 0 ? '+' : ''}${v.toFixed(2)}${usd ? ' USD' : (suffix ?? '')}`}
      </span>
    </span>
  )
}

type Row = {
  _id: string
  side: 'LONG' | 'SHORT'
  instId: string
  entryPrice: number
  markPrice: number
  stopLoss: number
  takeProfit: number
  sizeContracts: number
  notionalUsd: number
  pnlUsd: number
  pnlPct: number
  paper: boolean
  reason?: string
}

function PositionTable({
  rows,
  empty,
  closed,
}: {
  rows: Row[] | undefined
  empty: string
  closed?: boolean
}) {
  if (!rows) {
    return <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</div>
  }
  if (!rows.length) {
    return <div className="px-4 py-8 text-center text-xs text-muted-foreground">{empty}</div>
  }

  const dec = (n: number) => (n > 100 ? 2 : 4)

  return (
    <div className="scroll-thin max-h-72 overflow-auto">
      <table className="w-full border-collapse text-left font-mono text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-[10px] tracking-widest text-muted-foreground">
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p._id} className="border-b border-border/50 last:border-0">
              <td className="px-3 py-2">
                <Badge
                  variant="outline"
                  className={cn(
                    'font-mono text-[10px]',
                    p.side === 'LONG'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-destructive/40 bg-destructive/10 text-destructive',
                  )}
                >
                  {p.side}
                </Badge>
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {p.instId.replace('-USDT-SWAP', '')}
                {p.paper && <span className="ml-1.5 text-[10px] text-muted-foreground">P</span>}
              </td>
              <td className="px-3 py-2">{p.entryPrice.toFixed(dec(p.entryPrice))}</td>
              <td className="px-3 py-2">{p.markPrice.toFixed(dec(p.markPrice))}</td>
              <td className="px-3 py-2 text-destructive/80">
                {p.stopLoss.toFixed(dec(p.stopLoss))}
              </td>
              <td className="px-3 py-2 text-primary/80">
                {p.takeProfit.toFixed(dec(p.takeProfit))}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                {p.sizeContracts} ct · {p.notionalUsd.toFixed(0)}$
              </td>
              <td
                className={cn(
                  'px-3 py-2 whitespace-nowrap',
                  p.pnlUsd > 0 && 'text-primary',
                  p.pnlUsd < 0 && 'text-destructive',
                )}
              >
                {p.pnlUsd >= 0 ? '+' : ''}
                {p.pnlUsd.toFixed(2)}$
                <span className="ml-1 text-[10px] opacity-70">
                  {p.pnlPct >= 0 ? '+' : ''}
                  {p.pnlPct.toFixed(2)}%
                </span>
                {closed && p.reason && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">{p.reason}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
