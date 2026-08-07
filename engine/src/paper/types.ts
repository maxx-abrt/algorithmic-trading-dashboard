import type { Candle, Side } from '../quant/types.js'

export type PaperStatus = 'pending' | 'open' | 'closed' | 'expired' | 'rejected'
export type PaperExitReason = 'stop_loss' | 'breakeven_stop' | 'all_targets' | 'time_stop' | 'entry_expired' | 'risk_rejected'

export interface PaperTarget {
  price: number
  allocation: number
  filled: boolean
  filledAt?: number
  fillPrice?: number
}

export interface PaperPlan {
  id: string
  instId: string
  timeframe: string
  side: Side
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
  fundingRate8h?: number
  atrAtEntry: number
  trailAtrMult: number
  /** SPOT | SWAP | FUTURES — part of the specialist niche key */
  instType?: string
  /**
   * THE point-in-time feature snapshot, frozen at decision time.
   * Recomputing features when the trade closes leaks the future into the label and
   * is the single defect that makes a learning loop produce noise. Never recompute.
   */
  features?: number[]
  featureSchema?: string
  /** committee verdict recorded at decision time, for forward attribution */
  committee?: {
    probability: number
    confidence: number
    consensus: string
    agreement: number
    totalMembers: number
    sizeMultiplier: number
    votes: { id: string; displayName: string; generation: number; probability: number; weight: number }[]
  } | null
}

export interface PaperEvent {
  at: number
  type: 'submitted' | 'filled' | 'target' | 'stop_moved' | 'trailed' | 'closed' | 'expired' | 'rejected'
  price?: number
  allocation?: number
  detail: string
}

export interface PaperTrade {
  id: string
  plan: PaperPlan
  status: PaperStatus
  submittedAt: number
  filledAt?: number
  closedAt?: number
  fillPrice?: number
  exitPrice?: number
  exitReason?: PaperExitReason
  currentStop: number
  targets: PaperTarget[]
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
}

export interface BrokerResult {
  trade: PaperTrade
  changed: boolean
  events: PaperEvent[]
}

export interface PaperPortfolioSnapshot {
  equityUsd: number
  openRiskUsd: number
  openNotionalUsd: number
  realizedDailyR: number
  openTrades: PaperTrade[]
}

export type ConfirmedCandle = Candle & { confirmed: true }
