export interface Candle {
  /** open time, unix ms */
  ts: number
  open: number
  high: number
  low: number
  close: number
  /** base volume */
  volume: number
  /** true once OKX marks the bar confirmed */
  confirmed: boolean
}

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type Setup = 'NONE' | 'LONG_SETUP' | 'SHORT_SETUP'
export type Side = 'LONG' | 'SHORT'
export type Strategy = 'trend_momentum' | 'mean_reversion' | 'hybrid'

export interface Indicators {
  price: number
  ema200: number
  ema200Htf: number
  rsi: number
  atr: number
  atrPct: number
  vwap: number
  vwapDeviationPct: number
  poc: number
  keltnerUpper: number
  keltnerMiddle: number
  keltnerLower: number
  swingHigh: number
  swingLow: number
  htfBias: Bias
}

export interface QuantEvaluation {
  indicators: Indicators
  setup: Setup
  /** Human-readable trigger list, e.g. ["HTF bullish", "RSI 28 oversold"] */
  triggers: string[]
  /** Compact payload sent to the LLM (< ~300 tokens). */
  compact: Record<string, unknown>
  /** Pre-computed risk plan the AI can accept or reject. */
  plan: {
    side: Side
    entry: number
    stopLoss: number
    takeProfit: number
    riskDistance: number
    rr: number
  } | null
}

export interface AiDecision {
  decision: 'LONG' | 'SHORT' | 'WAIT'
  confidence: number
  leverage: number
  tp_price: number
  sl_price: number
  reasoning: string
}

export interface Settings {
  instId: string
  timeframe: string
  htfTimeframe: string
  strategy: Strategy
  riskPerTradePct: number
  leverage: number
  rrRatio: number
  minConfidence: number
  aiModel: string
  autoTrade: boolean
  paperMode: boolean
  engineEnabled: boolean
  maxOpenPositions: number
  maxDailyLossPct: number
}
