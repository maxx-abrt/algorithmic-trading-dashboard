'use client'

import { useEffect, useState } from 'react'
import { api, post, usePoll } from '@/lib/api'
import type { EngineSettings, Health } from '@/lib/types'
import { Badge, Button, NumberInput, Panel, Row, Select, Slider, Switch, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { ago, fmtUsd, titleCase } from '@/lib/format'
import { toast } from 'sonner'
import { Loader2, Save, Send } from 'lucide-react'

const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D']
const WEIGHTS = ['trend', 'momentum', 'volatility', 'volume', 'structure', 'pattern', 'derivatives', 'mtf', 'stats', 'edge']

export default function SettingsPage() {
  const health = usePoll<Health>('/health', 6000)
  const [s, setS] = useState<EngineSettings | null>(null)
  const [models, setModels] = useState<{ name: string; inputTokenLimit: number; outputTokenLimit: number }[]>([])
  const [tab, setTab] = useState('engine')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api<EngineSettings>('/settings').then(setS).catch(() => setS(null))
    void api<{ models: typeof models }>('/ai/models')
      .then((r) => setModels(r.models ?? []))
      .catch(() => setModels([]))
  }, [])

  const save = async (patch: Partial<EngineSettings>) => {
    setBusy(true)
    try {
      const next = await post<EngineSettings>('/settings', patch)
      setS(next)
      toast.success('Engine reconfigured')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  const testTelegram = async () => {
    try {
      const res = await post<{ delivered: number }>('/telegram/test')
      toast.success(`Status card delivered to ${res.delivered} chat(s)`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed')
    }
  }

  if (!s) {
    return (
      <Panel title="Settings">
        <div className="skeleton h-64 rounded" />
      </Panel>
    )
  }

  const set = (patch: Partial<EngineSettings>) => setS({ ...s, ...patch })

  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <Panel
        className="xl:col-span-8"
        title="Engine configuration"
        subtitle="changes are persisted locally in SQLite and applied by the running engine immediately"
        actions={
          <Button size="sm" variant="primary" onClick={() => void save(s)} disabled={busy} data-testid="settings-save-button">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save all
          </Button>
        }
        bodyClassName="p-0"
      >
        <Tabs value={tab} onChange={setTab}>
          <TabList>
            <Tab id="engine">Decision</Tab>
            <Tab id="risk">Risk</Tab>
            <Tab id="weights">Weights</Tab>
            <Tab id="ai">AI</Tab>
            <Tab id="scanner">Scanner</Tab>
            <Tab id="telegram">Telegram</Tab>
          </TabList>

          <div className="p-3">
            <TabPanel id="engine">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="focus instrument">
                  <input
                    className="num h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm"
                    value={s.instId}
                    onChange={(e) => set({ instId: e.target.value.toUpperCase() })}
                  />
                </Field>
                <Field label="entry timeframe">
                  <Select value={s.timeframe} onChange={(e) => set({ timeframe: e.target.value })}>
                    {BARS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="context timeframe (HTF)">
                  <Select value={s.htfTimeframe} onChange={(e) => set({ htfTimeframe: e.target.value })}>
                    <option value="auto">auto (ladder)</option>
                    {BARS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="macro timeframe (HTF2)">
                  <Select value={s.htf2Timeframe} onChange={(e) => set({ htf2Timeframe: e.target.value })}>
                    <option value="auto">auto (ladder)</option>
                    {BARS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="strategy bias">
                  <Select value={s.strategy} onChange={(e) => set({ strategy: e.target.value })}>
                    {['adaptive', 'trend_momentum', 'mean_reversion', 'breakout', 'pattern_confirm'].map((v) => (
                      <option key={v} value={v}>
                        {titleCase(v)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`min conviction to act · ${s.minConfidence}`} hint="lower = more signals, more noise">
                  <Slider value={s.minConfidence} min={30} max={90} onChange={(v) => set({ minConfidence: v })} />
                </Field>
                <Field label={`min |composite| · ${s.minCompositeScore}`}>
                  <Slider value={s.minCompositeScore} min={5} max={60} onChange={(v) => set({ minCompositeScore: v })} />
                </Field>
                <Field label={`ADX floor · ${s.minAdx}`}>
                  <Slider value={s.minAdx} min={0} max={35} onChange={(v) => set({ minAdx: v })} />
                </Field>
                <Field label={`max ATR% · ${s.maxAtrPct}`} hint="volatility ceiling before standing aside">
                  <Slider value={s.maxAtrPct} min={1} max={25} step={0.5} onChange={(v) => set({ maxAtrPct: v })} />
                </Field>
                <div className="space-y-2">
                  <Switch
                    checked={s.requireMtfAlignment}
                    onChange={(v) => set({ requireMtfAlignment: v })}
                    label="require multi-timeframe alignment for trend playbooks"
                  />
                  <Switch checked={s.usePatterns} onChange={(v) => set({ usePatterns: v })} label="candlestick confirmation layer" />
                  <Switch checked={s.useDerivatives} onChange={(v) => set({ useDerivatives: v })} label="derivatives context (funding, OI, book)" />
                  <Switch
                    checked={s.useEmpiricalEdge}
                    onChange={(v) => set({ useEmpiricalEdge: v })}
                    label="empirical edge back-scan"
                  />
                  <Switch checked={s.engineEnabled} onChange={(v) => set({ engineEnabled: v })} label="engine running" />
                </div>
              </div>
            </TabPanel>

            <TabPanel id="risk">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`risk per trade · ${s.riskPerTradePct}% of equity`}>
                  <Slider value={s.riskPerTradePct} min={0.1} max={5} step={0.1} onChange={(v) => set({ riskPerTradePct: v })} />
                </Field>
                <Field label={`max leverage · ${s.leverage}×`} hint="the engine lowers it when volatility demands">
                  <Slider value={s.leverage} min={1} max={50} onChange={(v) => set({ leverage: v })} />
                </Field>
                <Field label={`minimum R:R · ${s.rrRatio}`}>
                  <Slider value={s.rrRatio} min={1} max={6} step={0.1} onChange={(v) => set({ rrRatio: v })} />
                </Field>
                <Field label="sizing equity (USD)" hint="used when no OKX balance is available">
                  <NumberInput value={s.equityUsd} onChangeValue={(v) => set({ equityUsd: v })} />
                </Field>
                <Field label="taker fee (bps)" hint="OKX perp taker is 5bps by default">
                  <NumberInput value={s.takerFeeBps} onChangeValue={(v) => set({ takerFeeBps: v })} />
                </Field>
                <Field label="maximum open paper positions">
                  <NumberInput value={s.maxOpenPositions} min={1} max={10} onChangeValue={(v) => set({ maxOpenPositions: v })} />
                </Field>
                <Field label="daily paper loss kill (R)">
                  <NumberInput value={s.maxDailyLossPct} min={0.5} max={20} step={0.5} onChangeValue={(v) => set({ maxDailyLossPct: v })} />
                </Field>
                <Field label="maximum open risk (% equity)">
                  <NumberInput value={s.maxOpenRiskPct} min={0.5} max={20} step={0.5} onChangeValue={(v) => set({ maxOpenRiskPct: v })} />
                </Field>
                <Field label="maximum gross paper exposure (%)">
                  <NumberInput value={s.maxGrossExposurePct} min={10} max={500} step={10} onChangeValue={(v) => set({ maxGrossExposurePct: v })} />
                </Field>
                <Field label="read-only OKX balance" hint={health.data?.okxKeys ? 'API keys detected' : 'not required for paper research'}>
                  <Switch
                    checked={s.useAccountBalance}
                    onChange={(v) => set({ useAccountBalance: v })}
                    label="size from the real account balance"
                    disabled={!health.data?.okxKeys}
                  />
                </Field>
              </div>
              <p className="mt-3 rounded border border-border bg-card-2/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                The engine has no order endpoint at all: sizing, leverage and targets are advisory numbers for manual
                execution on OKX. Read-only keys only unlock balance-aware position sizing.
              </p>
            </TabPanel>

            <TabPanel id="weights">
              <p className="mb-3 text-[11px] text-muted-foreground">
                Multipliers applied on top of the regime-adaptive base weights. 1.0 keeps the tuned default.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {WEIGHTS.map((k) => (
                  <Field key={k} label={`${titleCase(k)} · ${(s.weights[k] ?? 1).toFixed(2)}×`}>
                    <Slider
                      value={s.weights[k] ?? 1}
                      min={0}
                      max={2.5}
                      step={0.05}
                      onChange={(v) => set({ weights: { ...s.weights, [k]: v } })}
                    />
                  </Field>
                ))}
              </div>
            </TabPanel>

            <TabPanel id="ai">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="model" hint={`${models.length} models available on your key`}>
                  <Select value={s.ai.model} onChange={(e) => set({ ai: { ...s.ai, model: e.target.value } })} data-testid="settings-ai-model">
                    {models.length === 0 && <option value={s.ai.model}>{s.ai.model}</option>}
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="context depth" hint="how much of the brief the model receives">
                  <Select value={s.ai.contextDepth} onChange={(e) => set({ ai: { ...s.ai, contextDepth: e.target.value } })}>
                    <option value="compact">compact (~300 tokens)</option>
                    <option value="standard">standard (~2.5k tokens)</option>
                    <option value="deep">deep (full evidence, ~5k tokens)</option>
                  </Select>
                </Field>
                <Field label={`temperature · ${s.ai.temperature.toFixed(2)}`}>
                  <Slider value={s.ai.temperature} min={0} max={1} step={0.05} onChange={(v) => set({ ai: { ...s.ai, temperature: v } })} />
                </Field>
                <Field label="max output tokens">
                  <NumberInput value={s.ai.maxOutputTokens} onChangeValue={(v) => set({ ai: { ...s.ai, maxOutputTokens: v } })} />
                </Field>
                <Field label="thinking budget" hint="0 disables reasoning tokens (cheapest)">
                  <NumberInput value={s.ai.thinkingBudget} onChangeValue={(v) => set({ ai: { ...s.ai, thinkingBudget: v } })} />
                </Field>
                <Field label={`ask only above conviction · ${s.ai.minConvictionToAsk}`}>
                  <Slider value={s.ai.minConvictionToAsk} min={0} max={90} onChange={(v) => set({ ai: { ...s.ai, minConvictionToAsk: v } })} />
                </Field>
                <Field label="cooldown (seconds per instrument)">
                  <NumberInput
                    value={Math.round(s.ai.cooldownMs / 1000)}
                    onChangeValue={(v) => set({ ai: { ...s.ai, cooldownMs: Math.max(15, v) * 1000 } })}
                  />
                </Field>
                <Field label="monthly AI budget (EUR)" hint="hard circuit breaker across manual and automatic calls">
                  <NumberInput value={s.aiMonthlyBudgetEur} min={0} max={10} step={0.5} onChangeValue={(v) => set({ aiMonthlyBudgetEur: Math.min(10, Math.max(0, v)) })} data-testid="settings-ai-budget" />
                </Field>
                <Field label="enabled">
                  <Switch checked={s.ai.enabled} onChange={(v) => set({ ai: { ...s.ai, enabled: v } })} label="consult the AI risk officer" />
                </Field>
              </div>
              {health.data && (
                <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
                  <Row label="calls" value={health.data.ai.calls.toString()} />
                  <Row label="cache hits" value={health.data.ai.cacheHits.toString()} />
                  <Row label="tokens in / out" value={`${health.data.ai.tokensIn.toLocaleString('en-US')} / ${health.data.ai.tokensOut.toLocaleString('en-US')}`} />
                  <Row label="errors" value={health.data.ai.errors.toString()} tone={health.data.ai.errors ? 'warning' : undefined} />
                  {health.data.ai.lastError && <Row label="last error" value={health.data.ai.lastError} mono={false} tone="warning" />}
                </div>
              )}
            </TabPanel>

            <TabPanel id="scanner">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="scan timeframe">
                  <Select value={s.scanner.timeframe} onChange={(e) => set({ scanner: { ...s.scanner, timeframe: e.target.value } })}>
                    {BARS.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="instrument types">
                  <Select
                    value={s.scanner.instTypes.join(',')}
                    onChange={(e) => set({ scanner: { ...s.scanner, instTypes: e.target.value.split(',') } })}
                  >
                    <option value="SWAP">Perpetual swaps</option>
                    <option value="SPOT">Spot</option>
                    <option value="SWAP,SPOT">Swaps + spot</option>
                    <option value="SWAP,SPOT,FUTURES">Everything</option>
                  </Select>
                </Field>
                <Field label="quote currency">
                  <Select value={s.scanner.quoteCcy} onChange={(e) => set({ scanner: { ...s.scanner, quoteCcy: e.target.value } })}>
                    {['USDT', 'USDC', 'USD', ''].map((q) => (
                      <option key={q || 'any'} value={q}>
                        {q || 'any'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="minimum 24h turnover (USD)">
                  <NumberInput value={s.scanner.minVol24hUsd} onChangeValue={(v) => set({ scanner: { ...s.scanner, minVol24hUsd: v } })} />
                </Field>
                <Field label={`universe size · ${s.scanner.universeSize}`} hint="deep-scanned instruments per cycle">
                  <Slider value={s.scanner.universeSize} min={10} max={200} step={5} onChange={(v) => set({ scanner: { ...s.scanner, universeSize: v } })} />
                </Field>
                <Field label="scan interval (seconds)">
                  <NumberInput
                    value={Math.round(s.scanner.intervalMs / 1000)}
                    onChangeValue={(v) => set({ scanner: { ...s.scanner, intervalMs: Math.max(15, v) * 1000 } })}
                  />
                </Field>
                <div className="space-y-2">
                  <Switch checked={s.scanner.enabled} onChange={(v) => set({ scanner: { ...s.scanner, enabled: v } })} label="scanner running" />
                  <Switch
                    checked={s.scanner.includeEquities}
                    onChange={(v) => set({ scanner: { ...s.scanner, includeEquities: v } })}
                    label="include tokenized equities (xStocks)"
                  />
                </div>
              </div>
            </TabPanel>

            <TabPanel id="telegram">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`minimum conviction to notify · ${s.telegram.minConviction}`}>
                  <Slider value={s.telegram.minConviction} min={0} max={95} onChange={(v) => set({ telegram: { ...s.telegram, minConviction: v } })} />
                </Field>
                <Field label="quiet hours (UTC)" hint="equal values disable quiet hours">
                  <div className="flex items-center gap-2">
                    <NumberInput value={s.telegram.quietHoursStart} onChangeValue={(v) => set({ telegram: { ...s.telegram, quietHoursStart: v } })} />
                    <span className="text-muted-foreground">→</span>
                    <NumberInput value={s.telegram.quietHoursEnd} onChangeValue={(v) => set({ telegram: { ...s.telegram, quietHoursEnd: v } })} />
                  </div>
                </Field>
                <div className="space-y-2">
                  <Switch checked={s.telegram.enabled} onChange={(v) => set({ telegram: { ...s.telegram, enabled: v } })} label="push notifications" />
                  <Switch
                    checked={s.telegram.onlyWatchlist}
                    onChange={(v) => set({ telegram: { ...s.telegram, onlyWatchlist: v } })}
                    label="only notify for watchlist instruments"
                  />
                </div>
                <Field label="delivery test">
                  <Button size="sm" variant="secondary" onClick={testTelegram} data-testid="settings-telegram-test">
                    <Send className="h-3.5 w-3.5" />
                    Send status card
                  </Button>
                </Field>
              </div>
              {health.data && (
                <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
                  <Row label="bot" value={health.data.telegram.username ? `@${health.data.telegram.username}` : 'not configured'} mono={false} />
                  <Row label="registered chats" value={health.data.telegram.chats.toString()} />
                  <Row label="sent / failed" value={`${health.data.telegram.sent} / ${health.data.telegram.failed}`} />
                  <Row label="commands received" value={health.data.telegram.received.toString()} />
                </div>
              )}
              <p className="mt-3 rounded border border-border bg-card-2/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                Send <span className="num">/start</span> to the bot from any Telegram account to register it. Commands:
                <span className="num"> /status /analyze BTC 15m /watch NVDA 1H /unwatch /list /scan /settings /mute</span>.
              </p>
            </TabPanel>
          </div>
        </Tabs>
      </Panel>

      <div className="flex flex-col gap-3 xl:col-span-4">
        <Panel title="Live engine state">
          {health.data ? (
            <div className="space-y-0.5">
              <Row label="engine" value={health.data.engineEnabled ? 'running' : 'paused'} tone={health.data.engineEnabled ? 'bull' : 'warning'} mono={false} />
              <Row label="uptime" value={`${Math.floor(health.data.uptimeSec / 60)}m`} />
              <Row label="focus" value={`${health.data.focus.instId} ${health.data.focus.timeframe}`} />
              <Row label="instruments" value={health.data.universe.instruments.toLocaleString('en-US')} />
              <Row label="candle series" value={`${health.data.memory.series} · ${health.data.memory.bars.toLocaleString('en-US')} bars`} />
              <Row label="gaps detected" value={health.data.memory.gaps.toString()} />
              <Row label="evaluations" value={health.data.counters.evaluations.toLocaleString('en-US')} />
              <Row label="alerts fired" value={health.data.counters.alerts.toString()} />
              <Row label="ideas journaled" value={health.data.counters.signals.toString()} />
              <Row label="REST calls" value={`${health.data.rest.calls} · ${health.data.rest.avgLatencyMs.toFixed(0)}ms`} />
              <Row label="WS messages" value={health.data.counters.wsMessages.toLocaleString('en-US')} />
              <Row label="last scan" value={ago(health.data.scanner.at)} mono={false} />
              <Row label="convex" value={`${health.data.convex.status} · ${health.data.convex.writes}w / ${health.data.convex.reads}r`} mono={false} />
              {health.data.account && (
                <>
                  <Row label="account equity" value={fmtUsd(health.data.account.totalEquityUsd)} />
                  <Row label="free USDT" value={fmtUsd(health.data.account.availableUsdt)} />
                </>
              )}
            </div>
          ) : (
            <div className="skeleton h-40 rounded" />
          )}
        </Panel>

        <Panel title="Data sources">
          <div className="space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              <Badge tone="bull">OKX v5</Badge> public REST + two WebSocket families for candles, tickers, funding, open
              interest, order book and index prices. No key required for market data.
            </p>
            <p>
              <Badge tone="info">SQLite WAL</Badge> is the local source of truth for settings, candidates, paper events, research and operations. Convex is an optional mirror only.
            </p>
            <p>
              <Badge tone="plain">Gemini</Badge> is consulted only when the local stack finds a real setup, with a dense
              pre-computed brief and a response cache.
            </p>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-muted-foreground/70">{hint}</span>}
    </label>
  )
}
