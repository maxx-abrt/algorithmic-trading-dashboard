import type { PaperPlan, PaperPortfolioSnapshot } from './types.js'

export interface RiskPolicy {
  maxOpenPositions: number
  maxDailyLossR: number
  maxOpenRiskPct: number
  maxInstrumentRiskPct: number
  maxGrossExposurePct: number
}

export interface RiskDecision {
  allowed: boolean
  reasons: string[]
  snapshot: {
    openPositions: number
    openRiskPct: number
    grossExposurePct: number
    realizedDailyR: number
  }
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  maxOpenPositions: 3,
  maxDailyLossR: 4,
  maxOpenRiskPct: 3,
  maxInstrumentRiskPct: 1,
  maxGrossExposurePct: 150,
}

export function assessPaperRisk(plan: PaperPlan, portfolio: PaperPortfolioSnapshot, policy: RiskPolicy = DEFAULT_RISK_POLICY): RiskDecision {
  const reasons: string[] = []
  const equity = Math.max(portfolio.equityUsd, 1)
  const active = portfolio.openTrades.filter((trade) => trade.status === 'pending' || trade.status === 'open')
  const openRiskPct = ((portfolio.openRiskUsd + plan.riskUsd) / equity) * 100
  const planRiskPct = (plan.riskUsd / equity) * 100
  const planNotional = plan.quantity * plan.entry
  const grossExposurePct = ((portfolio.openNotionalUsd + planNotional) / equity) * 100

  if (active.length >= policy.maxOpenPositions) reasons.push('max_open_positions')
  if (portfolio.realizedDailyR <= -Math.abs(policy.maxDailyLossR)) reasons.push('daily_loss_kill_switch')
  if (openRiskPct > policy.maxOpenRiskPct) reasons.push('portfolio_open_risk')
  if (planRiskPct > policy.maxInstrumentRiskPct) reasons.push('instrument_risk')
  if (grossExposurePct > policy.maxGrossExposurePct) reasons.push('gross_exposure')
  if (active.some((trade) => trade.plan.instId === plan.instId)) reasons.push('duplicate_instrument_exposure')

  return {
    allowed: reasons.length === 0,
    reasons,
    snapshot: { openPositions: active.length, openRiskPct, grossExposurePct, realizedDailyR: portfolio.realizedDailyR },
  }
}
