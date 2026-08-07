/** Types + helpers for the evolutionary specialist population. */

export interface SpecialistMetrics {
  sample?: number
  trainRows?: number
  holdoutRows?: number
  purgedRows?: number
  brier?: number
  logLoss?: number
  accuracy?: number
  auc?: number
  baselineBrier?: number
  brierSkill?: number
  meanRAtThreshold?: number | null
  meanRAll?: number | null
  meanRLift?: number | null
  threshold?: number
  coverage?: number
  featuresUsed?: number
}

export type Lifecycle = 'shadow' | 'canary' | 'champion' | 'retired' | 'rejected'

export interface SpecialistRow {
  artifactHash: string
  shortHash: string
  nicheKey: string
  nicheLabel: string
  playbook: string
  instType: string
  timeframe: string
  generation: number
  parentHash: string | null
  displayName: string
  lifecycle: Lifecycle
  createdAt: number
  promotedAt: number | null
  retiredAt: number | null
  liveTrades: number
  liveMeanR: number | null
  liveWinRate: number | null
  liveMaxDrawdownR: number | null
  liveSumR: number | null
  rejectionReason: string | null
  trials: number
  placeboSkill: number | null
  metrics: SpecialistMetrics
}

export interface NicheCount {
  nicheKey: string
  playbook: string
  instType: string
  timeframe: string
  samples: number
  wins: number
  sumR: number
  lastAt: number
}

export interface EvolutionEvent {
  id: number
  at: number
  type: string
  niche_key: string | null
  artifact_hash: string | null
  detail: string
}

export interface AttributionBucket {
  reasonCode: string
  count: number
  meanR: number
  sumR: number
}

export interface EvolutionState {
  specialists: SpecialistRow[]
  niches: NicheCount[]
  events: EvolutionEvent[]
  attribution: AttributionBucket[]
  summary: { samples: number; specialists: number; champions: number; events: number; attributions: number; exchangeOrders: number }
  validationState: 'VALIDATED' | 'NO_VALIDATED_MODEL'
  settings: {
    enabled: boolean
    minNewSamples: number
    minNicheSamples: number
    populationSize: number
    generations: number
    minBrierSkill: number
    placebo: boolean
    canaryMinTrades: number
    rollbackWindow: number
    rollbackMaxDrawdownR: number
    intervalMinutes: number
  }
}

export interface HarvestState {
  progress: {
    running: boolean
    startedAt: number
    finishedAt: number
    samples: number
    seriesDone: number
    seriesTotal: number
    current: string
    lastError: string
    totalSamplesEver: number
  }
  last: { at: number; samples: number; series: number } | null
  niches: NicheCount[]
}

export interface ExecutionState {
  demo: {
    configured: boolean
    simulated: boolean
    reason: string
    equityUsd: number | null
    availableUsdt: number | null
    lastSyncAt: number
    openOrders: number
    placed: number
    filled: number
    rejected: number
    lastError: string
  }
  parity: {
    orders: number
    terminal: number
    filled: number
    rejected: number
    fillRate: number | null
    meanEntrySlippageBps: number | null
    worstEntrySlippageBps: number | null
  }
  orders: Record<string, string | number | null>[]
  policy: { okxDemoEnabled: boolean; maxConcurrentDemoOrders: number; demoSizeMultiplier: number; demoInstTypes: string[] }
}

export interface AttributionState {
  summary: AttributionBucket[]
  rows: {
    trade_id: string
    at: number
    inst_id: string
    playbook: string
    reason_code: string
    detail: string
    expected_r: number | null
    realised_r: number
    mfe_r: number
    mae_r: number
  }[]
  labels: Record<string, string>
}

export const LIFECYCLE_TONE: Record<Lifecycle, 'bull' | 'info' | 'warning' | 'neutral' | 'bear'> = {
  champion: 'bull',
  canary: 'info',
  shadow: 'warning',
  retired: 'neutral',
  rejected: 'bear',
}

export const fmtR = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}R`

export const fmtPctValue = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`

export const niceNiche = (key: string) => {
  const [playbook = '', instType = '', timeframe = ''] = key.split('|')
  return `${playbook.replace(/_/g, ' ')} · ${instType} · ${timeframe}`
}
