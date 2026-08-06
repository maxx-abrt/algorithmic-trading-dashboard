/** Shapes returned by the engine API (mirrors engine/src/quant/types.ts). */

export type Decision = 'LONG' | 'SHORT' | 'WAIT'
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface Factor {
  id: string
  label: string
  group: string
  score: number
  weight: number
  detail: string
}

export interface Veto {
  id: string
  reason: string
  severity: 'hard' | 'soft'
}

export interface PatternHit {
  name: string
  label: string
  side: 'LONG' | 'SHORT'
  reliability: number
  confirmed: number
  barsAgo: number
  ts: number
  price: number
  notes: string[]
}

export interface RiskPlan {
  side: 'LONG' | 'SHORT'
  entry: number
  entryZone: [number, number]
  stopLoss: number
  stopBasis: string
  takeProfits: { price: number; rr: number; allocationPct: number; basis: string }[]
  expectedRr: number
  riskDistance: number
  riskDistanceAtr: number
  leverage: number
  contracts: number
  notionalUsd: number
  marginUsd: number
  riskUsd: number
  liquidationEstimate: number | null
  breakevenTrigger: number
  trailAtrMult: number
  invalidation: number
  timeStopBars: number
  winProbability: number
  probabilityBasis: 'heuristic_scenario_not_calibrated' | 'empirical_shrunk_with_heuristic_prior' | 'champion_calibrated_blend'
  validationState: 'INSUFFICIENT_EVIDENCE' | 'RESEARCH_CANDIDATE'
  expectancyR: number
  kellyFraction: number
  feesUsd: number
  fundingCostUsd: number
  slippageBps: number
  netExpectancyR: number
  expectedBarsToTarget: number
  marginPctOfEquity: number
  sizingAdvice: string
  edgeWinRate: number | null
  edgeSample: number
  warnings: string[]
}

export interface TimeframeContext {
  timeframe: string
  bars: number
  price: number
  bias: Bias
  trendScore: number
  regime: string
  adx: number
  rsi: number
  atrPct: number
  ema50: number
  ema200: number
  structure: string
  bos: string | null
  choch: string | null
}

export interface Analysis {
  generatedAt: number
  instId: string
  instType: string
  timeframe: string
  htfTimeframe: string
  htf2Timeframe: string
  price: number
  decision: Decision
  playbook: string | null
  conviction: number
  compositeScore: number
  regime: string
  bias: Bias
  indicators: {
    price: number
    ma: Record<string, number | boolean>
    momentum: Record<string, number>
    volatility: Record<string, number | boolean | string>
    volume: Record<string, number>
    ichimoku: Record<string, number | boolean>
    trend: Record<string, number | boolean>
    profile: { poc: number; vah: number; val: number; valueAreaPct: number; hvn: number[]; lvn: number[]; insideValue: boolean }
    structure: {
      structure: string
      bos: string | null
      choch: string | null
      swingHigh: number
      swingLow: number
      rangeHigh: number
      rangeLow: number
      rangePosition: number
      levels: { price: number; strength: number; kind: string; touches: number; source: string; distancePct: number }[]
      nearestSupport: { price: number; strength: number; source: string; distancePct: number } | null
      nearestResistance: { price: number; strength: number; source: string; distancePct: number } | null
      fib: { level: number; price: number }[]
      fvg: { top: number; bottom: number; ts: number; side: string }[]
    }
    divergences: { kind: string; side: string; source: string; strength: number; barsAgo: number }[]
    patterns: PatternHit[]
    stats: Record<string, number>
    xvol: Record<string, number | boolean | string>
    xtrend: Record<string, number | string>
  }
  mtf: TimeframeContext[]
  mtfAlignment: number
  factors: Factor[]
  vetoes: Veto[]
  plan: RiskPlan | null
  shadowPlan: RiskPlan | null
  derivatives: {
    fundingRate: number | null
    fundingApr: number | null
    nextFundingTime: number | null
    openInterest: number | null
    openInterestUsd: number | null
    openInterestChangePct: number | null
    takerRatio: number | null
    longShortRatio: number | null
    bookImbalance: number | null
    spreadBps: number | null
    markPrice: number | null
    indexPrice: number | null
    basisBps: number | null
    score: number
  } | null
  edge: {
    sample: number
    winRate: number
    avgR: number
    expectancyR: number
    avgMfeR: number
    avgMaeR: number
    horizonBars: number
    confidence: number
    adjustedWinRate: number
    note: string
  } | null
  session: {
    session: string
    isEquity: boolean
    marketOpen: boolean
    minutesToOpen: number
    minutesToClose: number
    liquidityFactor: number
    note: string
  }
  ai: {
    decision: Decision
    confidence: number
    leverage: number
    entry: number | null
    tp: number[]
    sl: number | null
    reasoning: string
    risks: string[]
    invalidation: string
    agreesWithQuant: boolean
    model: string
    cached: boolean
    tokensIn: number
    tokensOut: number
    latencyMs: number
    at: number
  } | null
  liquidity: { volUsd24h: number | null; spreadBps: number | null }
  narrative: string[]
  compact: Record<string, unknown>
  marketContext: {
    fearGreedIndex: number | null
    fearGreedClassification: string | null
    btcDominance: number | null
    marketCapChange24h: number | null
    trendingCoins: string[]
    sentimentScore: number | null
  } | null
  dataQuality: { ltfBars: number; htfBars: number; htf2Bars: number; staleMs: number; warnings: string[] }
}

export interface ChartPayload {
  instId: string
  bar: string
  candles: { time: number; open: number; high: number; low: number; close: number }[]
  volume: { time: number; value: number; color: string }[]
  overlays: Record<string, { time: number; value: number }[]>
  markers: { time: number; position: 'aboveBar' | 'belowBar'; color: string; shape: string; text: string }[]
  levels: { price: number; label: string; color: string; kind: string; strength: number }[]
  zones: { top: number; bottom: number; label: string; side: string }[]
  lastPrice: number
  updatedAt: number
}

export interface UniverseRow {
  instId: string
  instType: string
  baseCcy: string
  quoteCcy: string
  isEquity: boolean
  maxLever: number
  tickSz: number
  ctVal: number
  last: number | null
  changePct24h: number | null
  volUsd24h: number | null
  spreadBps: number | null
}

export interface ScanRow {
  instId: string
  instType: string
  isEquity: boolean
  price: number
  score: number
  trendScore: number
  momentum: number
  statScore: number
  regime: string
  adx: number
  rsi: number
  atrPct: number
  atrPercentile: number
  squeeze: boolean
  volumeRatio: number
  hurst: number
  expectedMovePct: number
  climax: boolean
  structure: string
  bos: string | null
  choch: string | null
  rangePosition: number
  topPattern: { label: string; side: string; confirmed: number } | null
  patternScore: number
  divergence: { source: string; side: string; kind: string } | null
  bias: Bias
  volUsd24h: number
  changePct24h: number
  spreadBps: number
  scannedAt: number
}

export interface WatchRow {
  _id: string
  instId: string
  instType: string
  timeframe: string
  enabled: boolean
  alertsEnabled: boolean
  note?: string
  addedAt: number
  last: number | null
  changePct24h: number | null
  volUsd24h: number | null
  decision: Decision | null
  conviction: number | null
  regime: string | null
  bias: Bias | null
  composite: number | null
  mtfAlignment: number | null
  playbook: string | null
  analysedAt: number | null
  plan: { entry: number; stopLoss: number; takeProfits: number[]; expectedRr: number; netExpectancyR: number } | null
}

export interface EngineSettings {
  instId: string
  timeframe: string
  htfTimeframe: string
  htf2Timeframe: string
  strategy: string
  minConfidence: number
  minCompositeScore: number
  requireMtfAlignment: boolean
  usePatterns: boolean
  useDerivatives: boolean
  useEmpiricalEdge: boolean
  maxAtrPct: number
  minAdx: number
  weights: Record<string, number>
  riskPerTradePct: number
  leverage: number
  rrRatio: number
  equityUsd: number
  useAccountBalance: boolean
  takerFeeBps: number
  maxOpenPositions: number
  maxDailyLossPct: number
  maxOpenRiskPct: number
  maxGrossExposurePct: number
  aiMonthlyBudgetEur: number
  autoResearchEnabled: boolean
  researchIntervalHours: number
  ai: {
    enabled: boolean
    model: string
    temperature: number
    maxOutputTokens: number
    thinkingBudget: number
    cooldownMs: number
    minConvictionToAsk: number
    contextDepth: string
  }
  scanner: {
    enabled: boolean
    timeframe: string
    instTypes: string[]
    quoteCcy: string
    minVol24hUsd: number
    universeSize: number
    intervalMs: number
    includeEquities: boolean
  }
  telegram: {
    enabled: boolean
    minConviction: number
    onlyWatchlist: boolean
    quietHoursStart: number
    quietHoursEnd: number
    sendScanDigest: boolean
    digestIntervalMin: number
  }
  engineEnabled: boolean
}

export interface Health {
  ok: boolean
  startedAt: number
  uptimeSec: number
  engineEnabled: boolean
  focus: { instId: string; timeframe: string }
  universe: { instruments: number; tickers: number; loadedAt: number }
  memory: { series: number; bars: number; gaps: number }
  ws: {
    public: { healthy: boolean; subs: number; messages: number }
    business: { healthy: boolean; subs: number; messages: number }
  }
  rest: { calls: number; errors: number; retries: number; avgLatencyMs: number; lastError: string }
  ai: {
    configured: boolean
    calls: number
    cacheHits: number
    errors: number
    tokensIn: number
    tokensOut: number
    lastError: string
    lastCallAt: number
    cacheSize: number
    monthlySpendEur: number
    monthlyBudgetEur: number
    budgetBlocked: boolean
  }
  telegram: { configured: boolean; username: string; sent: number; failed: number; received: number; chats: number; muted: number; lastError: string }
  convex: { configured: boolean; status: string; lastError: string; writes: number; reads: number }
  localStore: Record<string, number>
  paper: { total: number; closed: number; open: number; active: number; winRate: number | null; avgR: number | null; sumR: number; killSwitch: boolean }
  research: { validationState: string; governor: { allowed: boolean; reasons: string[]; rssMb: number; load1: number; running: boolean }; champion: unknown }
  resources: { rssMb: number; freeMemoryMb: number; totalMemoryMb: number; load1: number }
  counters: { evaluations: number; alerts: number; signals: number; errors: number; wsMessages: number }
  scanner: { at: number; scanned: number; running: boolean }
  account: { totalEquityUsd: number; availableUsdt: number; currencies: { ccy: string; eq: number; availBal: number }[] } | null
  okxKeys: boolean
  analyses: number
}

export interface AlertRule {
  _id: string
  name: string
  scope: string
  type: string
  timeframe: string
  params: { threshold?: number; direction?: string; value?: number; text?: string }
  cooldownMs: number
  telegram: boolean
  enabled: boolean
  lastFiredAt: number
  firedCount: number
  createdAt: number
}

export interface AlertEvent {
  _id: string
  ruleName: string
  type: string
  severity: string
  instId: string
  timeframe: string
  title: string
  message: string
  decision?: string
  conviction?: number
  price: number
  telegramDelivered: boolean
  ts: number
}

export interface SignalRow {
  _id: string
  instId: string
  timeframe: string
  decision: string
  playbook?: string
  regime: string
  conviction: number
  composite: number
  entry: number
  stopLoss: number
  takeProfits: number[]
  expectedRr: number
  leverage: number
  riskUsd: number
  status: string
  mfeR: number
  maeR: number
  realizedR?: number
  barsHeld: number
  timeStopBars: number
  lastPrice: number
  createdAt: number
  closedAt?: number
  exitReason?: string
  aiDecision?: string
  aiConfidence?: number
  edgeWinRate?: number
  edgeSample?: number
}

export interface PaperEvent {
  at: number
  type: string
  price?: number
  allocation?: number
  detail: string
}

export interface PaperTrade {
  id: string
  status: 'pending' | 'open' | 'closed' | 'expired' | 'rejected'
  submittedAt: number
  filledAt?: number
  closedAt?: number
  fillPrice?: number
  exitPrice?: number
  exitReason?: string
  currentStop: number
  remaining: number
  barsPending: number
  barsHeld: number
  grossRealizedR: number
  netRealizedR: number
  feesR: number
  fundingR: number
  mfeR: number
  maeR: number
  lastProcessedTs: number
  events: PaperEvent[]
  targets: { price: number; allocation: number; filled: boolean; filledAt?: number; fillPrice?: number }[]
  plan: {
    id: string
    instId: string
    timeframe: string
    side: 'LONG' | 'SHORT'
    signalAt: number
    policyVersion: string
    modelVersion: string
    playbook: string
    entry: number
    entryZone: [number, number]
    stopLoss: number
    targets: { price: number; allocation: number }[]
    quantity: number
    riskUsd: number
    maxEntryBars: number
    maxHoldBars: number
    feeBps: number
    slippageBps: number
  }
}

export interface PaperState {
  trades: PaperTrade[]
  stats: { total: number; closed: number; open: number; winRate: number | null; avgR: number | null; sumR: number; bestR: number | null; worstR: number | null }
  killSwitch: boolean
  lastRiskDecision: { allowed: boolean; reasons: string[]; snapshot: Record<string, number> } | null
  policy: { maxOpenPositions: number; maxDailyLossPct: number; maxOpenRiskPct: number; maxGrossExposurePct: number }
}

export interface StrategyCandidateRow {
  id: string
  observed_at: number
  inst_id: string
  timeframe: string
  playbook: string
  side: 'LONG' | 'SHORT'
  eligible: boolean
  reasons: string[]
  policy_version: string
  payload: {
    score: number
    prerequisites: string[]
    triggers: string[]
    rejectionReasons: string[]
    invalidation: string
  }
}

export interface ChampionState {
  modelId: string | null
  version: string | null
  artifact: unknown
  artifactPath: string | null
}

export interface ChampionHealth {
  meanR: number
  winRate: number
  trades: number
  maxDrawdownR: number
  shouldRollback: boolean
  reason: string | null
}

export interface ChampionResponse {
  champion: Record<string, unknown> | null
  championModel: ChampionState
  canary: Record<string, unknown> | null
  health: ChampionHealth
  canaryTrades: number
  trainingRows: number
}

export interface ResearchState {
  validationState: string
  champion: Record<string, unknown> | null
  canary: Record<string, unknown> | null
  governor: { allowed: boolean; reasons: string[]; rssMb: number; load1: number; maxRssMb: number; maxLoad: number; running: boolean }
  schedule: { enabled: boolean; intervalHours: number }
  campaigns: Record<string, unknown>[]
  trials: { id: string; campaign_id: string; created_at: number; status: string; config_hash: string; metrics_json: Record<string, number | null | number[]> }[]
  models: { id: string; created_at: number; state: string; strategy: string; version: string; metrics_json: Record<string, unknown>; rollback_reason?: string; canary_status?: string; live_mean_r?: number; live_win_rate?: number; live_trades_count?: number; live_max_drawdown_r?: number }[]
}

export interface OperationsState {
  health: Health
  qualityEvents: { id: number; observed_at: number; inst_id: string; timeframe: string; kind: string; severity: string; detail: string; repaired_at?: number }[]
  lastBackup: { destination: string; at: number; pages: number } | null
  lastParquetExport: { destination: string; at: number; rows: number; instId?: string; timeframe?: string } | null
  database: { path: string; bytes: number }
  aiUsage: { spend: number; tokensIn: number; tokensOut: number; calls: number }
}

export interface LogEntry {
  _id?: string
  ts: number
  level: string
  scope: string
  message: string
  instId?: string
  timeframe?: string
  meta?: string
}
