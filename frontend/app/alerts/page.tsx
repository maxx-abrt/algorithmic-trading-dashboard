'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api as convexApi } from '@/convex/_generated/api'
import { del, post, usePoll } from '@/lib/api'
import type { AlertEvent, AlertRule, WatchRow } from '@/lib/types'
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  NumberInput,
  Panel,
  Select,
  Switch,
} from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { ago, fmtPrice, titleCase } from '@/lib/format'
import { toast } from 'sonner'
import { BellRing, Plus, Send, Trash2 } from 'lucide-react'

interface Draft {
  id?: string
  name: string
  scope: string
  type: string
  timeframe: string
  threshold: number
  direction: string
  value: number
  cooldownMin: number
  telegram: boolean
  enabled: boolean
}

const EMPTY: Draft = {
  name: '',
  scope: '*',
  type: 'signal',
  timeframe: 'any',
  threshold: 65,
  direction: 'any',
  value: 0,
  cooldownMin: 30,
  telegram: true,
  enabled: true,
}

const NEEDS_VALUE = new Set(['price_cross', 'rsi_level'])
const NEEDS_DIRECTION = new Set(['signal', 'price_cross', 'rsi_level', 'pattern', 'divergence'])
const NEEDS_THRESHOLD = new Set(['signal', 'conviction', 'pct_move', 'funding_extreme', 'oi_spike', 'pattern', 'vol_spike'])

export default function AlertsPage() {
  const state = usePoll<{ rules: AlertRule[]; types: { type: string; label: string }[] }>('/alerts', 8000)
  const watchlist = usePoll<WatchRow[]>('/watchlist', 20000)
  const events = useQuery(convexApi.alerts.listEvents, { limit: 60 }) as AlertEvent[] | undefined
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await post('/alerts/rules', {
        id: draft.id,
        name: draft.name || `${titleCase(draft.type)} · ${draft.scope}`,
        scope: draft.scope,
        type: draft.type,
        timeframe: draft.timeframe,
        threshold: NEEDS_THRESHOLD.has(draft.type) ? draft.threshold : undefined,
        direction: NEEDS_DIRECTION.has(draft.type) ? draft.direction : undefined,
        value: NEEDS_VALUE.has(draft.type) ? draft.value : undefined,
        cooldownMs: Math.max(1, draft.cooldownMin) * 60_000,
        telegram: draft.telegram,
        enabled: draft.enabled,
      })
      toast.success(draft.id ? 'Rule updated' : 'Rule created')
      setDraft(null)
      await state.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    try {
      await del(`/alerts/rules?id=${id}`)
      toast.success('Rule deleted')
      await state.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const toggle = async (r: AlertRule) => {
    try {
      await post('/alerts/rules', {
        id: r._id,
        name: r.name,
        scope: r.scope,
        type: r.type,
        timeframe: r.timeframe,
        threshold: r.params.threshold,
        direction: r.params.direction,
        value: r.params.value,
        cooldownMs: r.cooldownMs,
        telegram: r.telegram,
        enabled: !r.enabled,
      })
      await state.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const sendTest = async () => {
    try {
      const res = await post<{ delivered: number }>('/alerts/test', {})
      toast.success(`Signal card delivered to ${res.delivered} Telegram chat(s)`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  const rules = state.data?.rules ?? []
  const types = state.data?.types ?? []

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <Panel
        className="xl:col-span-8"
        title="Alert rules"
        subtitle="the engine evaluates these on every instrument it analyses, 24/7"
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={sendTest} data-testid="alerts-send-test-card-button">
              <Send className="h-3.5 w-3.5" />
              Test card
            </Button>
            <Button size="sm" variant="primary" onClick={() => setDraft(EMPTY)} data-testid="alerts-create-rule-button">
              <Plus className="h-3.5 w-3.5" />
              New rule
            </Button>
          </>
        }
        bodyClassName="p-0"
      >
        {rules.length === 0 && (
          <EmptyState icon={<BellRing className="h-6 w-6" />} title="No alert rules">
            Create one and the engine will watch for it continuously, then push a full decision card to Telegram.
          </EmptyState>
        )}
        {rules.length > 0 && (
          <div className="divide-y divide-border">
            {rules.map((r) => (
              <div key={r._id} className="flex flex-wrap items-center gap-3 px-3 py-2 hover:bg-muted/20">
                <Switch checked={r.enabled} onChange={() => void toggle(r)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{r.name}</span>
                    <Badge tone="info">{r.type}</Badge>
                    <Badge tone="neutral">{r.scope === '*' ? 'watchlist' : r.scope}</Badge>
                    {r.timeframe !== 'any' && <Badge tone="neutral">{r.timeframe}</Badge>}
                    {r.telegram && <Badge tone="bull">telegram</Badge>}
                  </div>
                  <p className="num mt-0.5 text-[10px] text-muted-foreground">
                    {r.params.threshold != null && `threshold ${r.params.threshold} · `}
                    {r.params.value != null && r.params.value !== 0 && `level ${r.params.value} · `}
                    {r.params.direction && r.params.direction !== 'any' && `${r.params.direction} · `}
                    cooldown {Math.round(r.cooldownMs / 60000)}m · fired {r.firedCount}× ·{' '}
                    {r.lastFiredAt ? `last ${ago(r.lastFiredAt)}` : 'never fired'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDraft({
                      id: r._id,
                      name: r.name,
                      scope: r.scope,
                      type: r.type,
                      timeframe: r.timeframe,
                      threshold: r.params.threshold ?? 65,
                      direction: r.params.direction ?? 'any',
                      value: r.params.value ?? 0,
                      cooldownMin: Math.round(r.cooldownMs / 60000),
                      telegram: r.telegram,
                      enabled: r.enabled,
                    })
                  }
                >
                  Edit
                </Button>
                <Button size="icon" variant="ghost" onClick={() => void remove(r._id)} title="Delete">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        className="xl:col-span-4"
        title="Trigger history"
        subtitle="reactive feed from Convex"
        bodyClassName="p-0"
      >
        <div data-testid="alerts-trigger-history" className="max-h-[640px] overflow-y-auto divide-y divide-border/60">
          {events === undefined && <div className="skeleton m-3 h-24 rounded" />}
          {events?.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              Nothing has triggered yet. Rules only fire on real market events.
            </p>
          )}
          {events?.map((e) => (
            <div key={e._id} className="px-3 py-2">
              <div className="flex items-center gap-1.5">
                <Badge
                  tone={
                    e.severity === 'opportunity'
                      ? 'bull'
                      : e.severity === 'warning'
                        ? 'warning'
                        : e.severity === 'critical'
                          ? 'veto'
                          : 'neutral'
                  }
                >
                  {e.severity}
                </Badge>
                <span className="num truncate text-[11px] font-medium">{e.title}</span>
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{e.message}</p>
              <div className="num mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>{e.instId}</span>
                <span>{e.timeframe}</span>
                <span>{fmtPrice(e.price)}</span>
                <span className="ml-auto">{ago(e.ts)}</span>
                {e.telegramDelivered && <span className="text-bull">sent</span>}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Dialog open={draft !== null} onClose={() => setDraft(null)} title={draft?.id ? 'Edit rule' : 'New alert rule'}>
        {draft && (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-muted-foreground">name</span>
              <Input
                value={draft.name}
                placeholder="Actionable setup on watchlist"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">condition</span>
                <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                  {types.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">scope</span>
                <Select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
                  <option value="*">Whole watchlist</option>
                  <option value="ANY">Anything the engine analyses</option>
                  {(watchlist.data ?? []).map((w) => (
                    <option key={w.instId} value={w.instId}>
                      {w.instId}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">timeframe</span>
                <Select value={draft.timeframe} onChange={(e) => setDraft({ ...draft, timeframe: e.target.value })}>
                  {['any', '1m', '5m', '15m', '30m', '1H', '4H', '1D'].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">cooldown (minutes)</span>
                <NumberInput value={draft.cooldownMin} onChangeValue={(v) => setDraft({ ...draft, cooldownMin: v })} />
              </label>
              {NEEDS_THRESHOLD.has(draft.type) && (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted-foreground">threshold</span>
                  <NumberInput value={draft.threshold} onChangeValue={(v) => setDraft({ ...draft, threshold: v })} />
                </label>
              )}
              {NEEDS_VALUE.has(draft.type) && (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted-foreground">level</span>
                  <NumberInput value={draft.value} onChangeValue={(v) => setDraft({ ...draft, value: v })} />
                </label>
              )}
              {NEEDS_DIRECTION.has(draft.type) && (
                <label className="block">
                  <span className="mb-1 block text-[11px] text-muted-foreground">direction</span>
                  <Select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value })}>
                    {['any', 'LONG', 'SHORT', 'above', 'below'].map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </div>

            <div className="flex items-center gap-4">
              <Switch checked={draft.telegram} onChange={(v) => setDraft({ ...draft, telegram: v })} label="push to Telegram" />
              <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="enabled" />
            </div>

            <p className="rounded border border-border bg-card-2/50 p-2 text-[10px] leading-relaxed text-muted-foreground">
              {types.find((t) => t.type === draft.type)?.label}. Alerts are de-duplicated by content for 10 minutes on
              top of the rule cooldown, so a flapping tape cannot spam you.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={busy} data-testid="alerts-save-rule-button">
                {draft.id ? 'Save rule' : 'Create rule'}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
