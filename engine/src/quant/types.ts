/**
 * APEX-02 — shared quantitative types.
 * Isomorphic: consumed by the engine HTTP API AND the dashboard.
 */
import type { StatsBlock } from './stats'
import type { AdvancedVolBlock, ExtraTrendBlock } from './extras'
import type { EdgeBlock } from './edge'
import type { SessionInfo } from './sessions'

export type { StatsBlock, AdvancedVolBlock, ExtraTrendBlock, EdgeBlock, SessionInfo }

export interface Candle {
  /** open time, unix ms */
  ts: number
  open: number
  high: number
  low: number
  close: number
  /** base volume */
  volume: number
  /** quote volume (USDT) when OKX provides it */
  quoteVolume?: number
  /** true once OKX marks the bar closed */
  confirmed: boolean
}

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type Side = 'LONG' | 'SHORT'
export type Decision = 'LONG' | 'SHORT' | 'WAIT'

/** Volatility / behaviour regime — every downstream weight is regime-aware. */
export type Regime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'RANGING'
  | 'SQUEEZE'
  | 'EXPANSION'
  | 'CHOPPY'
  | 'CAPITULATION'

export type StrategyMode =
  | 'trend_momentum'
  | 'mean_reversion'
  | 'breakout'
  | 'pattern_confirm'
  | 'adaptive'

export type PlaybookId =
  | 'trend_pullback'
  | 'trend_continuation'
  | 'mean_reversion'
  | 'squeeze_breakout'
  | 'range_fade'
  | 'divergence_reversal'
  | 'pattern_reversal'
  | 'structure_break_retest'

/* -------------------------------------------------------------------------- */
/*  Indicators                                                                 */
/* -------------------------------------------------------------------------- */

export interface MovingAverages {
  ema9: number
  ema21: number
  ema50: number
  ema100: number
  ema200: number
  sma20: number
  sma50: number
  sma200: number
  /** % slope of EMA50 over the last 10 bars — trend acceleration proxy */
  ema50SlopePct: number
  ema200SlopePct: number
  /** how compressed the MA ribbon is, in ATR units (low = coiled) */
  ribbonWidthAtr: number
  stackedBull: boolean
  stackedBear: boolean
}

export interface MomentumBlock {
  rsi: number
  rsiPrev: number
  rsiSma: number
  stochRsiK: number
  stochRsiD: number
  stochK: number
  stochD: number
  macd: number
  macdSignal: number
  macdHist: number
  macdHistPrev: number
  cci: number
  williamsR: number
  roc: number
  awesome: number
  awesomePrev: number
  trix: number
  /** composite -100..100 */
  score: number
}

export interface VolatilityBlock {
  atr: number
  atrPct: number
  /** percentile rank (0-100) of current ATR inside the window */
  atrPercentile: number
  bbUpper: number
  bbMiddle: number
  bbLower: number
  bbWidthPct: number
  bbWidthPercentile: number
  /** 0..1 position of price inside the Bollinger band */
  percentB: number
  keltnerUpper: number
  keltnerMiddle: number
  keltnerLower: number
  /** BB inside Keltner => TTM squeeze */
  squeeze: boolean
  /** annualised realised volatility from log returns, % */
  realizedVolPct: number
  /** Choppiness Index 0-100 (>61.8 chop, <38.2 trend) */
  choppiness: number
  /** Kaufman efficiency ratio 0..1 (1 = perfectly directional) */
  efficiencyRatio: number
  /** normalised (0-100) ATR expansion vs its own average */
  volExpansion: number
  regime: Regime
}

export interface VolumeBlock {
  volume: number
  volumeSma: number
  /** current / average volume */
  volumeRatio: number
  obv: number
  obvSlope: number
  mfi: number
  adl: number
  forceIndex: number
  /** cumulative delta proxy from candle bodies */
  cvd: number
  cvdSlope: number
  vwap: number
  vwapUpper1: number
  vwapLower1: number
  vwapUpper2: number
  vwapLower2: number
  vwapDeviationPct: number
  /** deviation expressed in standard deviations */
  vwapZ: number
  score: number
}

export interface IchimokuBlock {
  conversion: number
  base: number
  spanA: number
  spanB: number
  cloudTop: number
  cloudBottom: number
  priceAboveCloud: boolean
  priceBelowCloud: boolean
  tkBull: boolean
  tkBear: boolean
}

export interface TrendFollowBlock {
  adx: number
  plusDI: number
  minusDI: number
  psar: number
  psarBull: boolean
  supertrend: number
  supertrendBull: boolean
  chandelierLong: number
  chandelierShort: number
  aroonUp: number
  aroonDown: number
}

export interface VolumeProfileBlock {
  poc: number
  vah: number
  val: number
  /** % of range covered by the value area */
  valueAreaPct: number
  /** high-volume nodes sorted by volume desc */
  hvn: number[]
  /** low-volume nodes (liquidity voids) */
  lvn: number[]
  /** true when price sits inside the value area */
  insideValue: boolean
}

export interface SwingPoint {
  ts: number
  index: number
  price: number
  kind: 'high' | 'low'
}

export interface Level {
  price: number
  /** 0..100 */
  strength: number
  kind: 'support' | 'resistance'
  touches: number
  source: 'swing' | 'poc' | 'vah' | 'val' | 'round' | 'fib' | 'htf_swing'
  distancePct: number
}

export interface StructureBlock {
  swings: SwingPoint[]
  swingHigh: number
  swingLow: number
  higherHighs: boolean
  higherLows: boolean
  lowerHighs: boolean
  lowerLows: boolean
  /** market structure verdict */
  structure: 'UPTREND' | 'DOWNTREND' | 'RANGE'
  /** break of structure on the last bars */
  bos: 'BULL' | 'BEAR' | null
  /** change of character (trend exhaustion) */
  choch: 'BULL' | 'BEAR' | null
  rangeHigh: number
  rangeLow: number
  /** 0..1 position of price inside the discovered range */
  rangePosition: number
  levels: Level[]
  nearestSupport: Level | null
  nearestResistance: Level | null
  fib: { level: number; price: number }[]
  /** unmitigated fair-value gaps (imbalances) */
  fvg: { top: number; bottom: number; ts: number; side: Side }[]
}

export interface Divergence {
  kind: 'regular' | 'hidden'
  side: Side
  source: 'rsi' | 'macd' | 'obv' | 'cvd'
  strength: number
  barsAgo: number
}

export interface PatternHit {
  name: string
  label: string
  side: Side
  /** raw reliability of the pattern family, 0..1 */
  reliability: number
  /** reliability after location / trend / volume confirmation, 0..1 */
  confirmed: number
  barsAgo: number
  ts: number
  price: number
  notes: string[]
}

export interface DerivativesBlock {
  fundingRate: number | null
  nextFundingRate: number | null
  /** annualised funding % */
  fundingApr: number | null
  /** unix ms of the next funding settlement */
  nextFundingTime: number | null
  openInterest: number | null
  openInterestUsd: number | null
  openInterestChangePct: number | null
  /** 24h price change %, used to interpret OI expansion */
  priceChangePct: number | null
  maxLeverage: number | null
  /** taker buy volume / taker sell volume (>1 = aggressive buyers) */
  takerRatio: number | null
  /** OKX long/short account ratio */
  longShortRatio: number | null
  /** best bid/ask imbalance from the order book, -1..1 */
  bookImbalance: number | null
  spreadBps: number | null
  markPrice: number | null
  indexPrice: number | null
  /** mark - index, in bps (perp premium) */
  basisBps: number | null
  /** crowd-positioning contrarian score -100..100 */
  score: number
}

export interface Indicators {
  price: number
  ma: MovingAverages
  momentum: MomentumBlock
  volatility: VolatilityBlock
  volume: VolumeBlock
  ichimoku: IchimokuBlock
  trend: TrendFollowBlock
  profile: VolumeProfileBlock
  structure: StructureBlock
  divergences: Divergence[]
  patterns: PatternHit[]
  /** statistical regime: Hurst, regression channel, z-scores */
  stats: StatsBlock
  /** advanced volatility estimators + expected move */
  xvol: AdvancedVolBlock
  /** Donchian / VWMA / Elder-Ray / KST / UO / Vortex / Heikin-Ashi */
  xtrend: ExtraTrendBlock
}

/** Verdict handed back by the LLM arbitration layer. */
export interface AiOpinion {
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
}

/* -------------------------------------------------------------------------- */
/*  Timeframe context                                                          */
/* -------------------------------------------------------------------------- */

export interface TimeframeContext {
  timeframe: string
  bars: number
  price: number
  bias: Bias
  /** -100..100 */
  trendScore: number
  regime: Regime
  adx: number
  rsi: number
  atrPct: number
  ema50: number
  ema200: number
  structure: StructureBlock['structure']
  bos: StructureBlock['bos']
  choch: StructureBlock['choch']
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                    */
/* -------------------------------------------------------------------------- */

export interface Factor {
  id: string
  label: string
  group:
    | 'trend'
    | 'momentum'
    | 'volatility'
    | 'volume'
    | 'structure'
    | 'pattern'
    | 'derivatives'
    | 'mtf'
    | 'stats'
    | 'edge'
  /** -100 (max bearish) .. +100 (max bullish) */
  score: number
  /** relative importance after regime adaptation */
  weight: number
  detail: string
}

export interface Veto {
  id: string
  reason: string
  severity: 'hard' | 'soft'
}

export interface RiskPlan {
  side: Side
  entry: number
  /** limit entry zone for pullback playbooks */
  entryZone: [number, number]
  stopLoss: number
  stopBasis: string
  takeProfits: { price: number; rr: number; allocationPct: number; basis: string }[]
  /** blended R:R across the ladder */
  expectedRr: number
  riskDistance: number
  riskDistanceAtr: number
  leverage: number
  /** contracts (0 when instrument specs unknown) */
  contracts: number
  notionalUsd: number
  marginUsd: number
  riskUsd: number
  liquidationEstimate: number | null
  breakevenTrigger: number
  trailAtrMult: number
  /** price that invalidates the whole idea (structural) */
  invalidation: number
  timeStopBars: number
  /** win-prob estimate implied by conviction, 0..1 */
  winProbability: number
  expectancyR: number
  kellyFraction: number
  /** round-trip taker fees in USD at the suggested size */
  feesUsd: number
  /** funding paid (negative = earned) over the expected hold, USD */
  fundingCostUsd: number
  /** estimated entry slippage from the live book, bps */
  slippageBps: number
  /** expectancy after fees + funding + slippage */
  netExpectancyR: number
  /** bars expected to reach TP1 at the current volatility */
  expectedBarsToTarget: number
  /** margin as a % of account equity */
  marginPctOfEquity: number
  /** balance-aware, plain-english sizing instruction */
  sizingAdvice: string
  /** empirical hit rate of this exact context (null when unproven) */
  edgeWinRate: number | null
  edgeSample: number
  warnings: string[]
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
  playbook: PlaybookId | null
  /** 0..100 */
  conviction: number
  /** signed composite -100..100 */
  compositeScore: number
  regime: Regime
  bias: Bias
  indicators: Indicators
  mtf: TimeframeContext[]
  mtfAlignment: number
  factors: Factor[]
  vetoes: Veto[]
  plan: RiskPlan | null
  /** the plan that WOULD be issued if the gates cleared (present on WAIT) */
  shadowPlan: RiskPlan | null
  /** derivatives context (perp/futures only) */
  derivatives: DerivativesBlock | null
  /** historical analogue statistics for this exact context */
  edge: EdgeBlock | null
  /** trading-session awareness (matters for tokenized equities) */
  session: SessionInfo
  /** LLM arbitration, only present when a setup passed the local gates */
  ai: AiOpinion | null
  /** live liquidity snapshot */
  liquidity: { volUsd24h: number | null; spreadBps: number | null }
  narrative: string[]
  /** ultra-dense payload for the LLM (<300 tokens) */
  compact: Record<string, unknown>
  dataQuality: {
    ltfBars: number
    htfBars: number
    htf2Bars: number
    staleMs: number
    warnings: string[]
  }
}

/* -------------------------------------------------------------------------- */
/*  Settings                                                                   */
/* -------------------------------------------------------------------------- */

export interface EngineSettings {
  instId: string
  timeframe: string
  htfTimeframe: string
  htf2Timeframe: string
  strategy: StrategyMode
  riskPerTradePct: number
  leverage: number
  rrRatio: number
  minConfidence: number
  /** minimum |composite| required before a trade is considered */
  minCompositeScore: number
  requireMtfAlignment: boolean
  usePatterns: boolean
  useDerivatives: boolean
  /** run the historical-analogue back-scan and let it calibrate conviction */
  useEmpiricalEdge: boolean
  /** OKX taker fee in basis points (0.05% = 5bps for swaps by default) */
  takerFeeBps: number
  /** use the real OKX balance for sizing when read-only keys are present */
  useAccountBalance: boolean
  maxAtrPct: number
  minAdx: number
  aiModel: string
  autoTrade: boolean
  paperMode: boolean
  engineEnabled: boolean
  maxOpenPositions: number
  maxDailyLossPct: number
  /** per-group weight multipliers, all default 1 */
  weights: Partial<Record<Factor['group'], number>>
  equityUsd: number
}

export interface InstrumentSpec {
  instId: string
  instType: 'SWAP' | 'SPOT' | 'FUTURES'
  ctVal: number
  ctValCcy: string
  lotSz: number
  minSz: number
  tickSz: number
  maxLever: number
  baseCcy: string
  quoteCcy: string
  /** tokenized equity futures (NVDA-USDT-SWAP …) */
  isEquity: boolean
}

/* -------------------------------------------------------------------------- */
/*  Defaults                                                                   */
/* -------------------------------------------------------------------------- */

export const DEFAULT_SETTINGS: EngineSettings = {
  instId: 'BTC-USDT-SWAP',
  timeframe: '15m',
  htfTimeframe: '1H',
  htf2Timeframe: '4H',
  strategy: 'adaptive',
  riskPerTradePct: 1,
  leverage: 5,
  rrRatio: 2,
  minConfidence: 58,
  minCompositeScore: 20,
  requireMtfAlignment: true,
  usePatterns: true,
  useDerivatives: true,
  useEmpiricalEdge: true,
  takerFeeBps: 5,
  useAccountBalance: false,
  maxAtrPct: 8,
  minAdx: 16,
  aiModel: 'gemini-2.5-flash',
  autoTrade: false,
  paperMode: true,
  engineEnabled: true,
  maxOpenPositions: 3,
  maxDailyLossPct: 4,
  weights: {
    trend: 1,
    momentum: 1,
    volatility: 1,
    volume: 1,
    structure: 1,
    pattern: 1,
    derivatives: 1,
    mtf: 1,
    stats: 1,
    edge: 1,
  },
  equityUsd: 10_000,
}

/** Timeframes exposed in the UI. */
export const UI_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1H', '4H', '1D'] as const
