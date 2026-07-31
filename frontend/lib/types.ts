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
  }
  telegram: { configured: boolean; username: string; sent: number; failed: number; received: number; chats: number; muted: number; lastError: string }
  convex: { configured: boolean; status: string; lastError: string; writes: number; reads: number }
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
