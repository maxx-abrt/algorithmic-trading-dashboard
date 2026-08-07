'use client'

import { useEffect, useRef, useState } from 'react'
import { api, post } from '@/lib/api'
import type { EngineSettings } from '@/lib/types'
import { Badge, Button, ErrorNote, NumberInput, Panel, Select, Skeleton, Switch, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { ago } from '@/lib/format'
import { Check, CircleAlert, Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

const BARS = ['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D']
const STRATEGIES = ['adaptive', 'trend', 'meanReversion', 'breakout', 'scalp', 'swing']
const INST_TYPES = ['SWAP', 'SPOT', 'FUTURES']

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/** A labelled control row: dense, mobile-first, and it always explains itself. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 py-1.5">
      <span className="text-[11px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[10px] leading-snug text-muted-foreground">{hint}</span>}
    </label>
  )
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<EngineSettings | null>(null)
  const [savedAt, setSavedAt] = useState<number>(0)
  const [state, setState] = useState<SaveState>('idle')
  const [errors, setErrors] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState('signal')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void api<EngineSettings>('/settings')
      .then((next) => {
        setSettings(next)
        setSavedAt(next.savedAt ?? 0)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'failed to load settings'))
  }, [])

  /**
   * Every change is written straight to SQLite and read back, so what you see on
   * this page is exactly what the engine will use on the next tick.
   */
  const save = async (patch: Record<string, unknown>) => {
    setState('saving')
    setErrors([])
    try {
      const next = await post<EngineSettings>('/settings', patch)
      setSettings(next)
      setSavedAt(next.savedAt ?? Date.now())
      setState('saved')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 2200)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'save failed'
      setErrors([message])
      setState('error')
      toast.error(`Rejected: ${message}`)
    }
  }

  if (loadError) return <div className="p-4"><ErrorNote message={loadError} /></div>
  if (!settings)
    return (
      <div className="mx-auto max-w-[1100px] space-y-3 p-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )

  const s = settings

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-3 p-3 pb-24 sm:p-4 md:pb-4" data-testid="settings-page">
      {/* ---- persistent save banner: the old build silently reverted edits ---- */}
      <div className="sticky top-[52px] z-30 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <span className="text-[13px] font-medium">Configuration</span>
        <Badge tone={s.engineEnabled ? 'bull' : 'warning'}>{s.engineEnabled ? 'engine running' : 'engine paused'}</Badge>
        <div className="ml-auto flex items-center gap-2" data-testid="settings-save-state">
          {state === 'saving' && (
            <span className="flex items-center gap-1 text-[11px] text-info">
              <Loader2 className="h-3 w-3 animate-spin" /> saving
            </span>
          )}
          {state === 'saved' && (
            <span className="flex items-center gap-1 text-[11px] text-bull">
              <Check className="h-3 w-3" /> saved to disk
            </span>
          )}
          {state === 'error' && (
            <span className="flex items-center gap-1 text-[11px] text-bear">
              <CircleAlert className="h-3 w-3" /> rejected
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">{savedAt ? `last saved ${ago(savedAt)}` : 'defaults'}</span>
          <Button variant="secondary" onClick={() => void save({})} data-testid="settings-verify">
            <Save className="h-3.5 w-3.5" /> verify
          </Button>
        </div>
      </div>
      {errors.length > 0 && <ErrorNote message={errors.join(' · ')} />}

      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab id="signal">Signal</Tab>
          <Tab id="risk">Risk</Tab>
          <Tab id="evolution">Evolution</Tab>
          <Tab id="execution">Execution</Tab>
          <Tab id="scanner">Scanner</Tab>
          <Tab id="telegram">Telegram</Tab>
          <Tab id="ai">AI budget</Tab>
        </TabList>

        {/* ------------------------------------------------------- signal --- */}
        <TabPanel id="signal" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="Focus" subtitle="what the terminal analyses every 4 seconds">
            <Field label="Instrument">
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25"
                defaultValue={s.instId}
                onBlur={(event) => event.target.value !== s.instId && void save({ instId: event.target.value.trim().toUpperCase() })}
                data-testid="settings-instId"
              />
            </Field>
            <Field label="Entry timeframe">
              <Select value={s.timeframe} onChange={(event) => void save({ timeframe: event.target.value })} data-testid="settings-timeframe">
                {BARS.map((bar) => (
                  <option key={bar} value={bar}>{bar}</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Higher timeframe">
                <Select value={s.htfTimeframe} onChange={(event) => void save({ htfTimeframe: event.target.value })}>
                  {BARS.map((bar) => (
                    <option key={bar} value={bar}>{bar}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Context timeframe">
                <Select value={s.htf2Timeframe} onChange={(event) => void save({ htf2Timeframe: event.target.value })}>
                  {BARS.map((bar) => (
                    <option key={bar} value={bar}>{bar}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Strategy filter" hint="which playbook family may be returned; the committee still decides whether to act">
              <Select value={s.strategy} onChange={(event) => void save({ strategy: event.target.value })} data-testid="settings-strategy">
                {STRATEGIES.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>
          </Panel>

          <Panel title="Gates" subtitle="deliberately permissive at the start so the system can generate evidence">
            <Field label="Minimum conviction" hint="below this, nothing is armed">
              <NumberInput value={s.minConfidence} onChangeValue={(value) => void save({ minConfidence: value })} data-testid="settings-minConfidence" />
            </Field>
            <Field label="Minimum composite score">
              <NumberInput value={s.minCompositeScore} onChangeValue={(value) => void save({ minCompositeScore: value })} />
            </Field>
            <Field label="Minimum ADX">
              <NumberInput value={s.minAdx} onChangeValue={(value) => void save({ minAdx: value })} />
            </Field>
            <Field label="Maximum ATR %">
              <NumberInput value={s.maxAtrPct} onChangeValue={(value) => void save({ maxAtrPct: value })} />
            </Field>
            <div className="space-y-2 pt-2">
              <Switch checked={s.requireMtfAlignment} onChange={(value) => void save({ requireMtfAlignment: value })} label="require multi-timeframe alignment" />
              <Switch checked={s.usePatterns} onChange={(value) => void save({ usePatterns: value })} label="candlestick patterns" />
              <Switch checked={s.useDerivatives} onChange={(value) => void save({ useDerivatives: value })} label="funding / OI / positioning" />
              <Switch checked={s.useEmpiricalEdge} onChange={(value) => void save({ useEmpiricalEdge: value })} label="empirical analogue scan" />
              <Switch checked={s.engineEnabled} onChange={(value) => void save({ engineEnabled: value })} label="engine enabled" data-testid="settings-engineEnabled" />
            </div>
          </Panel>

          <Panel title="Factor weights" subtitle="0 disables a family entirely" className="md:col-span-2">
            <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(s.weights).map(([name, value]) => (
                <Field key={name} label={name}>
                  <NumberInput value={value} step={0.1} onChangeValue={(next) => void save({ weights: { [name]: next } })} data-testid={`settings-weight-${name}`} />
                </Field>
              ))}
            </div>
          </Panel>
        </TabPanel>

        {/* --------------------------------------------------------- risk --- */}
        <TabPanel id="risk" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="Per trade">
            <Field label="Risk per trade (%)">
              <NumberInput value={s.riskPerTradePct} step={0.05} onChangeValue={(value) => void save({ riskPerTradePct: value })} data-testid="settings-riskPerTradePct" />
            </Field>
            <Field label="Maximum leverage">
              <NumberInput value={s.leverage} onChangeValue={(value) => void save({ leverage: value })} />
            </Field>
            <Field label="Minimum reward:risk">
              <NumberInput value={s.rrRatio} step={0.1} onChangeValue={(value) => void save({ rrRatio: value })} />
            </Field>
            <Field label="Taker fee (bps)">
              <NumberInput value={s.takerFeeBps} step={0.5} onChangeValue={(value) => void save({ takerFeeBps: value })} />
            </Field>
          </Panel>
          <Panel title="Portfolio" subtitle="enforced before any candidate is armed">
            <Field label="Paper equity (USD)" hint="replaced by the real demo balance when account sync is on">
              <NumberInput value={s.equityUsd} onChangeValue={(value) => void save({ equityUsd: value })} />
            </Field>
            <Switch checked={s.useAccountBalance} onChange={(value) => void save({ useAccountBalance: value })} label="use the OKX account balance" />
            <Field label="Max open positions">
              <NumberInput value={s.maxOpenPositions} onChangeValue={(value) => void save({ maxOpenPositions: value })} data-testid="settings-maxOpenPositions" />
            </Field>
            <Field label="Daily loss limit (R)">
              <NumberInput value={s.maxDailyLossPct} step={0.5} onChangeValue={(value) => void save({ maxDailyLossPct: value })} />
            </Field>
            <Field label="Max aggregate open risk (%)">
              <NumberInput value={s.maxOpenRiskPct} step={0.5} onChangeValue={(value) => void save({ maxOpenRiskPct: value })} />
            </Field>
            <Field label="Max gross exposure (%)">
              <NumberInput value={s.maxGrossExposurePct} step={10} onChangeValue={(value) => void save({ maxGrossExposurePct: value })} />
            </Field>
          </Panel>
        </TabPanel>

        {/* ---------------------------------------------------- evolution --- */}
        <TabPanel id="evolution" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="Search" subtitle="bounded on purpose: the live engine always has CPU priority">
            <Switch checked={s.evolution.enabled} onChange={(value) => void save({ evolution: { enabled: value } })} label="self-improvement enabled" data-testid="settings-evolution-enabled" />
            <Field label="Population size" hint="models trained per generation">
              <NumberInput value={s.evolution.populationSize} onChangeValue={(value) => void save({ evolution: { populationSize: value } })} data-testid="settings-populationSize" />
            </Field>
            <Field label="Generations per cycle">
              <NumberInput value={s.evolution.generations} onChangeValue={(value) => void save({ evolution: { generations: value } })} />
            </Field>
            <Field label="Cycle interval (minutes)">
              <NumberInput value={s.evolution.intervalMinutes} onChangeValue={(value) => void save({ evolution: { intervalMinutes: value } })} />
            </Field>
          </Panel>
          <Panel title="Birth gates" subtitle="what a challenger must prove before it exists">
            <Field label="Minimum samples per niche" hint="labelled, resolved outcomes">
              <NumberInput value={s.evolution.minNicheSamples} onChangeValue={(value) => void save({ evolution: { minNicheSamples: value } })} data-testid="settings-minNicheSamples" />
            </Field>
            <Field label="New samples before re-evolving">
              <NumberInput value={s.evolution.minNewSamples} onChangeValue={(value) => void save({ evolution: { minNewSamples: value } })} />
            </Field>
            <Field label="Minimum Brier skill" hint="out-of-sample improvement over the base rate; 0.01 is already meaningful">
              <NumberInput value={s.evolution.minBrierSkill} step={0.01} onChangeValue={(value) => void save({ evolution: { minBrierSkill: value } })} />
            </Field>
            <Switch
              checked={s.evolution.placebo}
              onChange={(value) => void save({ evolution: { placebo: value } })}
              label="require beating the shuffled-label placebo"
              data-testid="settings-placebo"
            />
          </Panel>
          <Panel title="Promotion &amp; rollback" subtitle="forward evidence only, never backfilled" className="md:col-span-2">
            <div className="grid gap-x-4 sm:grid-cols-3">
              <Field label="Canary trades before promotion">
                <NumberInput value={s.evolution.canaryMinTrades} onChangeValue={(value) => void save({ evolution: { canaryMinTrades: value } })} />
              </Field>
              <Field label="Rollback window (trades)">
                <NumberInput value={s.evolution.rollbackWindow} onChangeValue={(value) => void save({ evolution: { rollbackWindow: value } })} />
              </Field>
              <Field label="Rollback drawdown (R)">
                <NumberInput value={s.evolution.rollbackMaxDrawdownR} step={0.5} onChangeValue={(value) => void save({ evolution: { rollbackMaxDrawdownR: value } })} />
              </Field>
            </div>
          </Panel>
        </TabPanel>

        {/* ---------------------------------------------------- execution --- */}
        <TabPanel id="execution" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="OKX demo mirroring" subtitle="armed candidates become real orders on the simulated account">
            <Switch checked={s.execution.okxDemoEnabled} onChange={(value) => void save({ execution: { okxDemoEnabled: value } })} label="place real demo orders" data-testid="settings-okxDemoEnabled" />
            <Field label="Max concurrent demo orders">
              <NumberInput value={s.execution.maxConcurrentDemoOrders} onChangeValue={(value) => void save({ execution: { maxConcurrentDemoOrders: value } })} />
            </Field>
            <Field label="Size multiplier" hint="scales the risk-derived size before rounding to the instrument lot size">
              <NumberInput value={s.execution.demoSizeMultiplier} step={0.1} onChangeValue={(value) => void save({ execution: { demoSizeMultiplier: value } })} />
            </Field>
            <Field label="Markets" hint="a cash spot account cannot short, so SHORT candidates on SPOT are skipped automatically">
              <div className="flex flex-wrap gap-3 pt-1">
                {(['SWAP', 'SPOT'] as const).map((type) => (
                  <Switch
                    key={type}
                    checked={s.execution.demoInstTypes.includes(type)}
                    onChange={(value) => {
                      const next = value ? [...new Set([...s.execution.demoInstTypes, type])] : s.execution.demoInstTypes.filter((row) => row !== type)
                      if (!next.length) {
                        toast.error('At least one market must stay enabled')
                        return
                      }
                      void save({ execution: { demoInstTypes: next } })
                    }}
                    label={type}
                  />
                ))}
              </div>
            </Field>
          </Panel>
          <Panel title="Research schedule">
            <Switch checked={s.autoResearchEnabled} onChange={(value) => void save({ autoResearchEnabled: value })} label="automatic research campaigns" />
            <Field label="Campaign interval (hours)">
              <NumberInput value={s.researchIntervalHours} onChangeValue={(value) => void save({ researchIntervalHours: value })} />
            </Field>
            <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
              Campaigns are evidence-triggered first: the dominant exit-attribution bucket picks the hypothesis, and the scheduled rotation is only the fallback.
            </p>
          </Panel>
        </TabPanel>

        {/* ------------------------------------------------------ scanner --- */}
        <TabPanel id="scanner" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="Universe">
            <Switch checked={s.scanner.enabled} onChange={(value) => void save({ scanner: { enabled: value } })} label="scanner enabled" data-testid="settings-scanner-enabled" />
            <Field label="Scanner timeframe">
              <Select value={s.scanner.timeframe} onChange={(event) => void save({ scanner: { timeframe: event.target.value } })}>
                {BARS.map((bar) => (
                  <option key={bar} value={bar}>{bar}</option>
                ))}
              </Select>
            </Field>
            <Field label="Instrument types">
              <div className="flex flex-wrap gap-3 pt-1">
                {INST_TYPES.map((type) => (
                  <Switch
                    key={type}
                    checked={s.scanner.instTypes.includes(type)}
                    onChange={(value) => {
                      const next = value ? [...new Set([...s.scanner.instTypes, type])] : s.scanner.instTypes.filter((row) => row !== type)
                      if (!next.length) {
                        toast.error('At least one instrument type must stay enabled')
                        return
                      }
                      void save({ scanner: { instTypes: next } })
                    }}
                    label={type}
                  />
                ))}
              </div>
            </Field>
            <Switch checked={s.scanner.includeEquities} onChange={(value) => void save({ scanner: { includeEquities: value } })} label="include tokenised equities" />
          </Panel>
          <Panel title="Filters">
            <Field label="Universe size" hint="top N by 24h turnover">
              <NumberInput value={s.scanner.universeSize} onChangeValue={(value) => void save({ scanner: { universeSize: value } })} data-testid="settings-universeSize" />
            </Field>
            <Field label="Minimum 24h volume (USD)">
              <NumberInput value={s.scanner.minVol24hUsd} step={1_000_000} onChangeValue={(value) => void save({ scanner: { minVol24hUsd: value } })} />
            </Field>
            <Field label="Scan interval (ms)">
              <NumberInput value={s.scanner.intervalMs} step={5000} onChangeValue={(value) => void save({ scanner: { intervalMs: value } })} />
            </Field>
            <Field label="Quote currency">
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25"
                defaultValue={s.scanner.quoteCcy}
                onBlur={(event) => event.target.value !== s.scanner.quoteCcy && void save({ scanner: { quoteCcy: event.target.value.trim().toUpperCase() } })}
              />
            </Field>
          </Panel>
        </TabPanel>

        {/* ----------------------------------------------------- telegram --- */}
        <TabPanel id="telegram" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="What the bot sends">
            <Switch checked={s.telegram.enabled} onChange={(value) => void save({ telegram: { enabled: value } })} label="telegram enabled" data-testid="settings-telegram-enabled" />
            <div className="space-y-2 pt-1">
              <Switch checked={s.telegram.signalCards} onChange={(value) => void save({ telegram: { signalCards: value } })} label="signal cards" />
              <Switch checked={s.telegram.orderCards} onChange={(value) => void save({ telegram: { orderCards: value } })} label="order placed / filled / closed" />
              <Switch checked={s.telegram.evolutionEvents} onChange={(value) => void save({ telegram: { evolutionEvents: value } })} label="generations, promotions, rollbacks" data-testid="settings-evolutionEvents" />
              <Switch checked={s.telegram.dailyDigest} onChange={(value) => void save({ telegram: { dailyDigest: value } })} label="daily digest" />
              <Switch checked={s.telegram.onlyWatchlist} onChange={(value) => void save({ telegram: { onlyWatchlist: value } })} label="watchlist instruments only" />
            </div>
          </Panel>
          <Panel title="Timing">
            <Field label="Minimum conviction for a signal card">
              <NumberInput value={s.telegram.minConviction} onChangeValue={(value) => void save({ telegram: { minConviction: value } })} />
            </Field>
            <Field label="Digest hour (UTC)">
              <NumberInput value={s.telegram.digestHourUtc} onChangeValue={(value) => void save({ telegram: { digestHourUtc: value } })} />
            </Field>
            <Field label="Heartbeat interval (hours)" hint="0 disables the uptime heartbeat">
              <NumberInput value={s.telegram.heartbeatHours} onChangeValue={(value) => void save({ telegram: { heartbeatHours: value } })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Quiet hours start (UTC)">
                <NumberInput value={s.telegram.quietHoursStart} onChangeValue={(value) => void save({ telegram: { quietHoursStart: value } })} />
              </Field>
              <Field label="Quiet hours end (UTC)">
                <NumberInput value={s.telegram.quietHoursEnd} onChangeValue={(value) => void save({ telegram: { quietHoursEnd: value } })} />
              </Field>
            </div>
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => void post('/telegram/test').then(() => toast.success('Test message sent')).catch((err) => toast.error(err instanceof Error ? err.message : 'Failed'))}
              data-testid="settings-telegram-test"
            >
              Send a test message
            </Button>
          </Panel>
        </TabPanel>

        {/* ----------------------------------------------------------- ai --- */}
        <TabPanel id="ai" className="grid gap-3 pt-3 md:grid-cols-2">
          <Panel title="Budget" subtitle="a hard application-level circuit breaker, checked before every call">
            <Field label="Monthly budget (EUR)" hint="maximum 10; the engine stops calling Gemini once the ledger reaches this">
              <NumberInput value={s.aiMonthlyBudgetEur} step={0.5} onChangeValue={(value) => void save({ aiMonthlyBudgetEur: value })} data-testid="settings-aiBudget" />
            </Field>
            <Switch checked={s.ai.enabled} onChange={(value) => void save({ ai: { enabled: value } })} label="AI narrative enabled" />
            <p className="pt-2 text-[10px] leading-relaxed text-muted-foreground">
              The LLM never sets a probability, a size or an order. It only writes the narrative and the post-mortem. Every number on this dashboard comes from deterministic maths or a calibrated local model.
            </p>
          </Panel>
          <Panel title="Model">
            <Field label="Model id">
              <input
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25"
                defaultValue={s.ai.model}
                onBlur={(event) => event.target.value !== s.ai.model && void save({ ai: { model: event.target.value.trim() } })}
              />
            </Field>
            <Field label="Ask only above conviction">
              <NumberInput value={s.ai.minConvictionToAsk} onChangeValue={(value) => void save({ ai: { minConvictionToAsk: value } })} />
            </Field>
            <Field label="Cooldown (ms)">
              <NumberInput value={s.ai.cooldownMs} step={30000} onChangeValue={(value) => void save({ ai: { cooldownMs: value } })} />
            </Field>
            <Field label="Max output tokens">
              <NumberInput value={s.ai.maxOutputTokens} step={100} onChangeValue={(value) => void save({ ai: { maxOutputTokens: value } })} />
            </Field>
          </Panel>
        </TabPanel>
      </Tabs>
    </div>
  )
}
