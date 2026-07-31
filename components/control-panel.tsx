'use client'

import { useQuery } from 'convex/react'
import { Loader2, Power, ShieldAlert } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { flattenAll, updateSettings, type SettingsPatch } from '@/app/actions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { api } from '@/convex/_generated/api'

const PRESETS = [
  'BTC-USDT-SWAP',
  'ETH-USDT-SWAP',
  'SOL-USDT-SWAP',
  'XRP-USDT-SWAP',
  'DOGE-USDT-SWAP',
  'NVDA-USDT-SWAP',
  'MU-USDT-SWAP',
  'TSLA-USDT-SWAP',
  'AAPL-USDT-SWAP',
]
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '1D']
const HTF = ['15m', '30m', '1H', '2H', '4H', '1D']
const MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — balanced' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite — cheapest' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — deepest' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash — legacy' },
]
const STRATEGIES = [
  { id: 'hybrid', label: 'Hybrid (trend + reversion)' },
  { id: 'trend_momentum', label: 'Trend & Momentum' },
  { id: 'mean_reversion', label: 'Mean Reversion (VWAP/POC)' },
] as const

export function ControlPanel({ markPrice }: { markPrice: number }) {
  const settings = useQuery(api.settings.get)
  const [pending, startTransition] = useTransition()
  const [customPair, setCustomPair] = useState('')

  // Local mirrors so sliders feel instant while the mutation is in flight.
  const [risk, setRisk] = useState<number | null>(null)
  const [lev, setLev] = useState<number | null>(null)
  const [conf, setConf] = useState<number | null>(null)

  useEffect(() => {
    if (!settings) return
    setRisk((v) => (v === null ? settings.riskPerTradePct : v))
    setLev((v) => (v === null ? settings.leverage : v))
    setConf((v) => (v === null ? settings.minConfidence : v))
  }, [settings])

  const push = (patch: SettingsPatch, label?: string) => {
    startTransition(async () => {
      const res = await updateSettings(patch)
      if (!res.ok) toast.error(res.error)
      else if (label) toast.success(label)
    })
  }

  if (!settings) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Connecting to Convex…
        </CardContent>
      </Card>
    )
  }

  const live = !settings.paperMode

  return (
    <Card className="gap-0 border-border bg-card py-0">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3">
        <CardTitle className="font-mono text-xs tracking-widest text-muted-foreground">
          EXECUTION CONTROL
        </CardTitle>
        <Badge
          variant="outline"
          className={
            live
              ? 'border-destructive/50 bg-destructive/10 font-mono text-[10px] text-destructive'
              : 'border-border font-mono text-[10px] text-muted-foreground'
          }
        >
          {live ? 'LIVE CAPITAL' : 'PAPER'}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 px-4 py-4">
        {/* Instrument + timeframes */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
              INSTRUMENT
            </Label>
            <Select
              value={PRESETS.includes(settings.instId) ? settings.instId : '__custom'}
              onValueChange={(v: string | null) => {
                if (v && v !== '__custom') push({ instId: v }, `Switched to ${v}`)
              }}
            >
              <SelectTrigger className="font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p} value={p} className="font-mono text-xs">
                    {p.replace('-USDT-SWAP', '')}
                    <span className="ml-2 text-muted-foreground">USDT · perp</span>
                  </SelectItem>
                ))}
                {!PRESETS.includes(settings.instId) && (
                  <SelectItem value="__custom" className="font-mono text-xs">
                    {settings.instId}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input
                value={customPair}
                onChange={(e) => setCustomPair(e.target.value.toUpperCase())}
                placeholder="ANY-OKX-SWAP"
                className="h-8 font-mono text-xs"
                aria-label="Custom OKX instrument id"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 text-xs"
                disabled={!customPair || pending}
                onClick={() => {
                  push({ instId: customPair }, `Switched to ${customPair}`)
                  setCustomPair('')
                }}
              >
                Load
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
                ENTRY TF
              </Label>
              <Select
                value={settings.timeframe}
                onValueChange={(v: string | null) => v && push({ timeframe: v })}
              >
                <SelectTrigger className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEFRAMES.map((t) => (
                    <SelectItem key={t} value={t} className="font-mono text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
                TREND TF
              </Label>
              <Select
                value={settings.htfTimeframe}
                onValueChange={(v) => push({ htfTimeframe: v })}
              >
                <SelectTrigger className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HTF.map((t) => (
                    <SelectItem key={t} value={t} className="font-mono text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
              STRATEGY
            </Label>
            <Select
              value={settings.strategy}
              onValueChange={(v) => push({ strategy: v as SettingsPatch['strategy'] })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGIES.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
              AI MODEL
            </Label>
            <Select value={settings.aiModel} onValueChange={(v) => push({ aiModel: v })}>
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Separator />

        {/* Risk */}
        <div className="flex flex-col gap-4">
          <SliderRow
            label="RISK / TRADE"
            value={risk ?? settings.riskPerTradePct}
            display={`${(risk ?? settings.riskPerTradePct).toFixed(1)}%`}
            min={0.1}
            max={5}
            step={0.1}
            onChange={setRisk}
            onCommit={(v) => push({ riskPerTradePct: v })}
          />
          <SliderRow
            label="LEVERAGE"
            value={lev ?? settings.leverage}
            display={`${lev ?? settings.leverage}x`}
            min={1}
            max={25}
            step={1}
            onChange={setLev}
            onCommit={(v) => push({ leverage: v })}
          />
          <SliderRow
            label="MIN CONFIDENCE"
            value={conf ?? settings.minConfidence}
            display={`${conf ?? settings.minConfidence}%`}
            min={0}
            max={95}
            step={5}
            onChange={setConf}
            onCommit={(v) => push({ minConfidence: v })}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberRow
              label="R:R MIN"
              value={settings.rrRatio}
              step={0.5}
              min={1}
              max={10}
              onCommit={(v) => push({ rrRatio: v })}
            />
            <NumberRow
              label="MAX DD %"
              value={settings.maxDailyLossPct}
              step={0.5}
              min={0.5}
              max={50}
              onCommit={(v) => push({ maxDailyLossPct: v })}
            />
          </div>
        </div>

        <Separator />

        {/* Switches */}
        <div className="flex flex-col gap-3">
          <ToggleRow
            label="Engine"
            hint="Master kill switch for the quant loop"
            checked={settings.engineEnabled}
            onChange={(v) => push({ engineEnabled: v }, v ? 'Engine started' : 'Engine paused')}
          />
          <ToggleRow
            label="Auto-trade"
            hint="Off = signals only, no orders"
            checked={settings.autoTrade}
            onChange={(v) => push({ autoTrade: v }, v ? 'Auto-trade armed' : 'Auto-trade disarmed')}
          />
          <ToggleRow
            label="Paper mode"
            hint="On = simulated fills, OKX untouched"
            checked={settings.paperMode}
            danger={!settings.paperMode}
            onChange={(v) =>
              push(
                { paperMode: v },
                v ? 'Paper mode enabled' : 'LIVE MODE — real capital at risk',
              )
            }
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 text-xs"
            disabled={pending}
            onClick={() => push({ engineEnabled: !settings.engineEnabled })}
          >
            <Power className="size-3.5" aria-hidden="true" />
            {settings.engineEnabled ? 'Pause' : 'Start'}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="flex-1 text-xs"
            disabled={pending || markPrice <= 0}
            onClick={() =>
              startTransition(async () => {
                const res = await flattenAll(settings.instId, markPrice)
                if (res.ok) toast.success('All positions flattened, auto-trade disarmed')
                else toast.error(res.error ?? 'Flatten failed')
              })
            }
          >
            <ShieldAlert className="size-3.5" aria-hidden="true" />
            Flatten all
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SliderRow({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onCommit: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
          {label}
        </Label>
        <span className="font-mono text-sm text-foreground">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        onValueCommit={([v]) => onCommit(v)}
        aria-label={label}
      />
    </div>
  )
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (v: number) => void
}) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => setLocal(String(value)), [value])
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-mono text-[10px] tracking-widest text-muted-foreground">
        {label}
      </Label>
      <Input
        type="number"
        value={local}
        min={min}
        max={max}
        step={step}
        className="h-8 font-mono text-xs"
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local)
          if (Number.isFinite(n) && n !== value) onCommit(n)
        }}
      />
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  danger,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
  danger?: boolean
}) {
  const id = `toggle-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <Label htmlFor={id} className={danger ? 'text-sm text-destructive' : 'text-sm'}>
          {label}
        </Label>
        <span className="text-[11px] leading-relaxed text-muted-foreground">{hint}</span>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
