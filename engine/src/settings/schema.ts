/**
 * Runtime settings — ONE schema, ONE source of truth, validated on every write.
 *
 * Why this file exists: the previous build kept settings in Convex AND SQLite and
 * re-read the cloud copy every 10 seconds. The cloud validator silently rejected
 * any field it did not know about, so every user edit was reverted within 10s.
 * Settings are now local, typed, and validated before they can be persisted.
 */
import { z } from 'zod'
import { ENV } from '../env.js'

const bar = z.enum(['1m', '3m', '5m', '15m', '30m', '1H', '2H', '4H', '6H', '12H', '1D'])

export const WeightsSchema = z
  .object({
    trend: z.number().min(0).max(3),
    momentum: z.number().min(0).max(3),
    volatility: z.number().min(0).max(3),
    volume: z.number().min(0).max(3),
    structure: z.number().min(0).max(3),
    pattern: z.number().min(0).max(3),
    derivatives: z.number().min(0).max(3),
    mtf: z.number().min(0).max(3),
    stats: z.number().min(0).max(3),
    edge: z.number().min(0).max(3),
  })
  .strict()

export const AiSchema = z
  .object({
    enabled: z.boolean(),
    model: z.string().min(1).max(80),
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().min(64).max(8192),
    thinkingBudget: z.number().int().min(0).max(24576),
    cooldownMs: z.number().int().min(0).max(24 * 60 * 60_000),
    minConvictionToAsk: z.number().min(0).max(100),
    contextDepth: z.enum(['minimal', 'standard', 'deep']),
    /** hourly batched news + macro-event digest on the cheapest capable model */
    newsEnabled: z.boolean(),
    cheapModel: z.string().min(1).max(80),
    /** nightly what-worked / what-failed report */
    postMortemEnabled: z.boolean(),
    /** block new entries when the news risk score exceeds this */
    newsRiskVeto: z.number().min(0).max(1),
  })
  .strict()

export const ScannerSchema = z
  .object({
    enabled: z.boolean(),
    timeframe: bar,
    instTypes: z.array(z.enum(['SPOT', 'SWAP', 'FUTURES'])).min(1).max(3),
    quoteCcy: z.string().max(10),
    minVol24hUsd: z.number().min(0).max(1e12),
    universeSize: z.number().int().min(5).max(300),
    intervalMs: z.number().int().min(15_000).max(60 * 60_000),
    includeEquities: z.boolean(),
    /** tokenized equities and stable/stable pairs are excluded by default */
    includeStables: z.boolean(),
    /** how many of the strongest scanner rows get the FULL analysis pipeline */
    deepScanTop: z.number().int().min(1).max(40),
    /** minimum |quick score| a row needs before it is worth a deep analysis */
    deepScanMinScore: z.number().min(0).max(100),
  })
  .strict()

export const TelegramSchema = z
  .object({
    enabled: z.boolean(),
    minConviction: z.number().min(0).max(100),
    onlyWatchlist: z.boolean(),
    quietHoursStart: z.number().int().min(0).max(23),
    quietHoursEnd: z.number().int().min(0).max(23),
    signalCards: z.boolean(),
    orderCards: z.boolean(),
    evolutionEvents: z.boolean(),
    dailyDigest: z.boolean(),
    digestHourUtc: z.number().int().min(0).max(23),
    heartbeatHours: z.number().int().min(0).max(48),
  })
  .strict()

export const EvolutionSchema = z
  .object({
    enabled: z.boolean(),
    /** new labelled outcomes in a niche before it is worth re-evolving */
    minNewSamples: z.number().int().min(5).max(500),
    minNicheSamples: z.number().int().min(40).max(5000),
    populationSize: z.number().int().min(4).max(16),
    generations: z.number().int().min(1).max(6),
    /** minimum out-of-sample Brier skill for a specialist to be born */
    minBrierSkill: z.number().min(-0.2).max(0.5),
    /** require the winner to beat its own shuffled-label placebo */
    placebo: z.boolean(),
    /** closed real trades a canary needs before it can take the crown */
    canaryMinTrades: z.number().int().min(5).max(200),
    /** rolling window used for automatic rollback */
    rollbackWindow: z.number().int().min(10).max(300),
    rollbackMaxDrawdownR: z.number().min(2).max(50),
    intervalMinutes: z.number().int().min(5).max(1440),
    /** fraction of armed trades reserved for deliberate exploration probes */
    explorationRate: z.number().min(0).max(0.8),
    /** size multiplier applied to an exploration probe */
    probeSizeMultiplier: z.number().min(0.05).max(1),
    /** minimum recorded decisions a niche needs before breeding is attempted */
    minTapeRows: z.number().int().min(120).max(20000),
    /** target rows per niche for the coverage scheduler */
    targetTapeRows: z.number().int().min(200).max(60000),
  })
  .strict()

export const ExecutionSchema = z
  .object({
    /** mirror armed paper candidates as real OKX DEMO orders */
    okxDemoEnabled: z.boolean(),
    /** hard cap on simultaneous demo orders */
    maxConcurrentDemoOrders: z.number().int().min(1).max(20),
    /** contracts / base size multiplier applied to demo orders */
    demoSizeMultiplier: z.number().min(0.01).max(10),
    /** never send demo orders for instruments outside this list of types */
    demoInstTypes: z.array(z.enum(['SPOT', 'SWAP'])).min(1).max(2),
    /** model fills locally from the live book when the exchange is unavailable */
    simulatorEnabled: z.boolean(),
  })
  .strict()

export const SettingsSchema = z
  .object({
    instId: z.string().min(3).max(40),
    timeframe: bar,
    htfTimeframe: z.union([bar, z.literal('auto')]),
    htf2Timeframe: z.union([bar, z.literal('auto')]),
    strategy: z.enum(['adaptive', 'trend', 'meanReversion', 'breakout', 'scalp', 'swing']),
    minConfidence: z.number().min(0).max(100),
    minCompositeScore: z.number().min(0).max(100),
    requireMtfAlignment: z.boolean(),
    usePatterns: z.boolean(),
    useDerivatives: z.boolean(),
    useEmpiricalEdge: z.boolean(),
    maxAtrPct: z.number().min(0.5).max(50),
    minAdx: z.number().min(0).max(60),
    weights: WeightsSchema,
    riskPerTradePct: z.number().min(0.05).max(10),
    leverage: z.number().min(1).max(50),
    rrRatio: z.number().min(0.5).max(10),
    equityUsd: z.number().min(100).max(1e9),
    useAccountBalance: z.boolean(),
    takerFeeBps: z.number().min(0).max(50),
    maxOpenPositions: z.number().int().min(1).max(50),
    maxDailyLossPct: z.number().min(0.5).max(50),
    maxOpenRiskPct: z.number().min(0.1).max(50),
    maxGrossExposurePct: z.number().min(10).max(1000),
    aiMonthlyBudgetEur: z.number().min(0).max(10),
    autoResearchEnabled: z.boolean(),
    researchIntervalHours: z.number().min(1).max(168),
    ai: AiSchema,
    scanner: ScannerSchema,
    telegram: TelegramSchema,
    evolution: EvolutionSchema,
    execution: ExecutionSchema,
    engineEnabled: z.boolean(),
    /** the self-driving improvement scheduler */
    orchestratorEnabled: z.boolean(),
    /** how often the orchestrator picks its next action, in seconds */
    orchestratorIntervalSec: z.number().int().min(10).max(3600),
  })
  .strict()

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_RUNTIME_SETTINGS: Settings = {
  instId: 'BTC-USDT-SWAP',
  timeframe: '15m',
  htfTimeframe: '1H',
  htf2Timeframe: '4H',
  strategy: 'adaptive',
  // Deliberately permissive at the start: the system must be allowed to trade and
  // generate evidence. Gates tighten automatically once specialists are validated.
  minConfidence: 48,
  minCompositeScore: 12,
  requireMtfAlignment: false,
  usePatterns: true,
  useDerivatives: true,
  useEmpiricalEdge: true,
  maxAtrPct: 10,
  minAdx: 12,
  weights: { trend: 1, momentum: 1, volatility: 1, volume: 1, structure: 1, pattern: 1, derivatives: 1, mtf: 1, stats: 1, edge: 1 },
  riskPerTradePct: 1,
  leverage: 5,
  rrRatio: 2,
  equityUsd: ENV.defaultEquityUsd,
  useAccountBalance: true,
  takerFeeBps: 5,
  maxOpenPositions: 6,
  maxDailyLossPct: 6,
  maxOpenRiskPct: 4,
  maxGrossExposurePct: 200,
  aiMonthlyBudgetEur: 8,
  autoResearchEnabled: true,
  researchIntervalHours: 12,
  ai: {
    enabled: true,
    model: ENV.gemini.model,
    temperature: 0.15,
    maxOutputTokens: 1200,
    thinkingBudget: 0,
    cooldownMs: 300_000,
    minConvictionToAsk: 60,
    contextDepth: 'standard',
    newsEnabled: true,
    cheapModel: process.env.GEMINI_CHEAP_MODEL || 'gemini-3.1-flash-lite',
    postMortemEnabled: true,
    newsRiskVeto: 0.82,
  },
  scanner: {
    enabled: true,
    timeframe: '15m',
    instTypes: ['SWAP', 'SPOT'],
    quoteCcy: 'USDT',
    minVol24hUsd: 3_000_000,
    universeSize: 110,
    intervalMs: 60_000,
    includeEquities: false,
    includeStables: false,
    deepScanTop: 12,
    deepScanMinScore: 18,
  },
  telegram: {
    enabled: true,
    minConviction: 60,
    onlyWatchlist: false,
    quietHoursStart: 0,
    quietHoursEnd: 0,
    signalCards: true,
    orderCards: true,
    evolutionEvents: true,
    dailyDigest: true,
    digestHourUtc: 7,
    heartbeatHours: 6,
  },
  evolution: {
    enabled: true,
    minNewSamples: 15,
    minNicheSamples: 60,
    populationSize: 8,
    generations: 3,
    minBrierSkill: 0.01,
    placebo: true,
    canaryMinTrades: 15,
    rollbackWindow: 30,
    rollbackMaxDrawdownR: 8,
    intervalMinutes: 30,
    explorationRate: 0.3,
    probeSizeMultiplier: 0.35,
    minTapeRows: 260,
    targetTapeRows: 4000,
  },
  execution: {
    okxDemoEnabled: true,
    maxConcurrentDemoOrders: 6,
    demoSizeMultiplier: 1,
    demoInstTypes: ['SWAP', 'SPOT'],
    simulatorEnabled: true,
  },
  engineEnabled: true,
  orchestratorEnabled: true,
  orchestratorIntervalSec: 30,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge that never lets a patch introduce unknown keys. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T))
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value
  }
  return out as T
}

export interface SettingsApplyResult {
  ok: boolean
  settings: Settings
  errors: string[]
  changed: string[]
}

/**
 * Merge a patch into the current settings and validate the RESULT.
 * A rejected patch leaves the previous settings completely untouched.
 */
export function applySettingsPatch(current: Settings, patch: unknown): SettingsApplyResult {
  const merged = deepMerge(current, patch)
  const parsed = SettingsSchema.safeParse(merged)
  if (!parsed.success) {
    return {
      ok: false,
      settings: current,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
      changed: [],
    }
  }
  const changed = isPlainObject(patch) ? Object.keys(patch) : []
  return { ok: true, settings: parsed.data, errors: [], changed }
}

/** Coerce whatever is on disk into a valid settings object, healing missing fields. */
export function hydrateSettings(stored: unknown): Settings {
  const merged = deepMerge(DEFAULT_RUNTIME_SETTINGS, stored)
  const parsed = SettingsSchema.safeParse(merged)
  if (parsed.success) return parsed.data
  // Field-by-field healing: keep every value that validates, reset only the broken ones.
  const healed: Record<string, unknown> = { ...DEFAULT_RUNTIME_SETTINGS }
  if (isPlainObject(merged)) {
    for (const key of Object.keys(DEFAULT_RUNTIME_SETTINGS)) {
      const candidate = { ...healed, [key]: (merged as Record<string, unknown>)[key] }
      if (SettingsSchema.safeParse(candidate).success) healed[key] = (merged as Record<string, unknown>)[key]
    }
  }
  return SettingsSchema.parse(healed)
}
