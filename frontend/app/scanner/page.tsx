'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { post, usePoll } from '@/lib/api'
import type { EngineSettings, ScanRow } from '@/lib/types'
import { Badge, Button, Chip, EmptyState, Panel, Select, Switch, NumberInput } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { ago, fmtPct, fmtPrice, fmtUsd, titleCase } from '@/lib/format'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Eye, Radar, RefreshCw } from 'lucide-react'

type SortKey = 'score' | 'volUsd24h' | 'changePct24h' | 'rsi' | 'adx' | 'atrPct' | 'patternScore' | 'hurst'

const COLUMNS: { key: SortKey | 'instId' | 'bias' | 'regime' | 'pattern' | 'actions'; label: string; align?: 'right' }[] = [
  { key: 'instId', label: 'Instrument' },
  { key: 'score', label: 'Score', align: 'right' },
  { key: 'bias', label: 'Bias' },
  { key: 'regime', label: 'Regime' },
  { key: 'changePct24h', label: '24h', align: 'right' },
  { key: 'rsi', label: 'RSI', align: 'right' },
  { key: 'adx', label: 'ADX', align: 'right' },
  { key: 'atrPct', label: 'ATR%', align: 'right' },
  { key: 'hurst', label: 'Hurst', align: 'right' },
  { key: 'pattern', label: 'Formation' },
  { key: 'volUsd24h', label: 'Turnover', align: 'right' },
  { key: 'actions', label: '' },
]

export default function ScannerPage() {
  const router = useRouter()
  const scan = usePoll<{ at: number; scanned: number; running: boolean; rows: ScanRow[]; config: EngineSettings['scanner'] }>(
    '/scanner',
    8000,
  )
  const [sort, setSort] = useState<SortKey>('score')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [bias, setBias] = useState('ALL')
  const [regime, setRegime] = useState('ALL')
  const [minScore, setMinScore] = useState(0)
  const [equities, setEquities] = useState(true)
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    const all = scan.data?.rows ?? []
    const filtered = all
      .filter((r) => (bias === 'ALL' ? true : r.bias === bias))
      .filter((r) => (regime === 'ALL' ? true : r.regime === regime))
      .filter((r) => Math.abs(r.score) >= minScore)
      .filter((r) => (equities ? true : !r.isEquity))
    return filtered.sort((a, b) => {
      const va = sort === 'score' ? Math.abs(a[sort]) : a[sort]
      const vb = sort === 'score' ? Math.abs(b[sort]) : b[sort]
      return dir === 'desc' ? vb - va : va - vb
    })
  }, [scan.data, bias, regime, minScore, equities, sort, dir])

  const regimes = useMemo(
    () => ['ALL', ...new Set((scan.data?.rows ?? []).map((r) => r.regime))],
    [scan.data],
  )

  const load = async (instId: string) => {
    try {
      await post('/settings', { instId })
      router.push('/')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const watch = async (instId: string) => {
    try {
      await post('/watchlist', { instId })
      toast.success(`${instId} added to the watchlist`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const rescan = async () => {
    setBusy(true)
    try {
      const res = await post<{ targets: number }>('/scanner/run')
      toast.success(`Rescanning ${res.targets} instruments`)
      setTimeout(() => void scan.refresh(), 4000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <Panel
        title="Universe scanner"
        subtitle={
          scan.data
            ? `${scan.data.scanned} instruments scored ${ago(scan.data.at)} · ${scan.data.config.instTypes.join('/')} · min turnover ${fmtUsd(scan.data.config.minVol24hUsd)} · ${scan.data.config.timeframe}`
            : 'loading…'
        }
        actions={
          <Button size="sm" variant="secondary" onClick={rescan} disabled={busy} data-testid="scanner-rescan-button">
            <RefreshCw className={cn('h-3.5 w-3.5', (busy || scan.data?.running) && 'animate-spin')} />
            Rescan
          </Button>
        }
        bodyClassName="p-0"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            bias
            <Select value={bias} onChange={(e) => setBias(e.target.value)} className="h-7 w-[110px]">
              {['ALL', 'BULLISH', 'BEARISH', 'NEUTRAL'].map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            regime
            <Select value={regime} onChange={(e) => setRegime(e.target.value)} className="h-7 w-[150px]">
              {regimes.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            min |score|
            <NumberInput value={minScore} onChangeValue={setMinScore} className="h-7 w-[70px]" min={0} max={100} />
          </label>
          <Switch checked={equities} onChange={setEquities} label="include tokenized equities" />
          <Chip tone="neutral" className="ml-auto">
            {rows.length} shown
          </Chip>
        </div>

        {scan.loading && !scan.data && <div className="skeleton m-3 h-64 rounded" />}
        {scan.data && rows.length === 0 && (
          <EmptyState icon={<Radar className="h-6 w-6" />} title="Nothing matches those filters">
            The engine scores the most liquid slice of the OKX universe every minute. Loosen the filters or lower the
            minimum score.
          </EmptyState>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table data-testid="scanner-table" className="w-full min-w-[1080px] border-collapse">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border">
                  {COLUMNS.map((c) => {
                    const sortable = ['score', 'volUsd24h', 'changePct24h', 'rsi', 'adx', 'atrPct', 'hurst'].includes(
                      c.key,
                    )
                    return (
                      <th
                        key={c.key}
                        className={cn(
                          'whitespace-nowrap px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground',
                          c.align === 'right' ? 'text-right' : 'text-left',
                          sortable && 'cursor-pointer select-none hover:text-foreground',
                        )}
                        onClick={() => {
                          if (!sortable) return
                          const k = c.key as SortKey
                          if (sort === k) setDir(dir === 'desc' ? 'asc' : 'desc')
                          else {
                            setSort(k)
                            setDir('desc')
                          }
                        }}
                      >
                        <span className="inline-flex items-center gap-1">
                          {c.label}
                          {sort === c.key &&
                            (dir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                        </span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.instId}
                    data-testid="scanner-table-row"
                    className="group border-b border-border/50 transition-colors hover:bg-muted/25"
                  >
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="num text-xs">{r.instId}</span>
                        {r.isEquity && <Badge tone="plain">xSTOCK</Badge>}
                        {r.squeeze && <Badge tone="warning">SQZ</Badge>}
                        {r.climax && <Badge tone="veto">CLIMAX</Badge>}
                        {r.divergence && (
                          <Badge tone={r.divergence.side === 'LONG' ? 'bull' : 'bear'}>
                            {r.divergence.source} div
                          </Badge>
                        )}
                      </div>
                      <span className="num text-[10px] text-muted-foreground">{fmtPrice(r.price)}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span
                        className={cn('num text-xs font-medium', r.score > 0 ? 'text-bull' : r.score < 0 ? 'text-bear' : '')}
                      >
                        {r.score > 0 ? '+' : ''}
                        {r.score.toFixed(0)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={r.bias === 'BULLISH' ? 'bull' : r.bias === 'BEARISH' ? 'bear' : 'neutral'}>
                        {r.bias}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-muted-foreground">
                      {titleCase(r.regime)}
                      {r.bos && <span className="ml-1 text-[10px]">{r.bos} BOS</span>}
                    </td>
                    <td className={cn('num px-2 py-1.5 text-right text-xs', r.changePct24h >= 0 ? 'text-bull' : 'text-bear')}>
                      {fmtPct(r.changePct24h, 1)}
                    </td>
                    <td className="num px-2 py-1.5 text-right text-xs">{r.rsi.toFixed(0)}</td>
                    <td className="num px-2 py-1.5 text-right text-xs">{r.adx.toFixed(0)}</td>
                    <td className="num px-2 py-1.5 text-right text-xs">
                      {r.atrPct.toFixed(2)}
                      <span className="ml-1 text-[10px] text-muted-foreground">{r.atrPercentile}th</span>
                    </td>
                    <td className="num px-2 py-1.5 text-right text-xs">{r.hurst.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-[11px]">
                      {r.topPattern ? (
                        <span className={r.topPattern.side === 'LONG' ? 'text-bull' : 'text-bear'}>
                          {r.topPattern.label} <span className="num">{(r.topPattern.confirmed * 100).toFixed(0)}%</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="num px-2 py-1.5 text-right text-xs text-muted-foreground">{fmtUsd(r.volUsd24h)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          size="sm"
                          variant="secondary"
                          data-testid="scanner-load-instrument-button"
                          onClick={() => void load(r.instId)}
                        >
                          Load
                        </Button>
                        <Button size="icon" variant="ghost" title="Watch" onClick={() => void watch(r.instId)}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}
