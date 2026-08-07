/**
 * Deterministic failure/success attribution.
 *
 * A loss is not automatically a mistake and a win is not proof of a good
 * decision. Every closed trade gets a machine-readable reason code so the
 * research loop can act on WHY instead of on the sign of the P&L.
 */
import type { PaperTrade } from './types.js'

export type ReasonCode =
  | 'TARGET_COMPLETE'
  | 'PARTIAL_TARGET_THEN_BREAKEVEN'
  | 'UNFILLED_ENTRY'
  | 'ADVERSE_SELECTION'
  | 'STOP_GAP_SLIPPAGE'
  | 'NO_FOLLOW_THROUGH'
  | 'STOP_AFTER_PROGRESS'
  | 'COST_DOMINATED'
  | 'RISK_REJECTED'
  | 'TIME_EXIT_POSITIVE'
  | 'MODEL_FALSE_POSITIVE'
  | 'TAIL_EVENT'
  | 'UNCLASSIFIED'

export const REASON_LABELS: Record<ReasonCode, string> = {
  TARGET_COMPLETE: 'Full target ladder reached',
  PARTIAL_TARGET_THEN_BREAKEVEN: 'Took partial profit, stopped at break-even',
  UNFILLED_ENTRY: 'Entry zone never traded — idea untested',
  ADVERSE_SELECTION: 'Filled then immediately went against us',
  STOP_GAP_SLIPPAGE: 'Gapped through the stop — realised worse than planned',
  NO_FOLLOW_THROUGH: 'Time stop with almost no favourable excursion',
  STOP_AFTER_PROGRESS: 'Went our way, then reversed into the stop',
  COST_DOMINATED: 'Gross positive but fees and funding ate the edge',
  RISK_REJECTED: 'Blocked by a portfolio risk gate before arming',
  TIME_EXIT_POSITIVE: 'Time stop while in profit',
  MODEL_FALSE_POSITIVE: 'High confidence, clean loss — model was wrong',
  TAIL_EVENT: 'Outsized move well beyond the planned distribution',
  UNCLASSIFIED: 'No deterministic rule matched',
}

export interface Attribution {
  reasonCode: ReasonCode
  detail: string
}

/**
 * Pure function: same trade in, same reason out. No randomness, no LLM.
 */
export function attributeTrade(trade: PaperTrade, context: { winProbability?: number | null } = {}): Attribution {
  const netR = trade.netRealizedR
  const grossR = trade.grossRealizedR
  const costR = trade.feesR + trade.fundingR
  const filledTargets = trade.targets.filter((target) => target.filled).length

  if (trade.status === 'rejected') {
    return { reasonCode: 'RISK_REJECTED', detail: trade.events.find((event) => event.type === 'rejected')?.detail ?? 'risk gate' }
  }
  if (trade.status === 'expired' || trade.exitReason === 'entry_expired') {
    return { reasonCode: 'UNFILLED_ENTRY', detail: `entry zone [${trade.plan.entryZone.map((p) => p.toFixed(4)).join(', ')}] not traded within ${trade.plan.maxEntryBars} bars` }
  }
  if (trade.exitReason === 'all_targets') {
    return { reasonCode: 'TARGET_COMPLETE', detail: `${filledTargets}/${trade.targets.length} targets, +${netR.toFixed(2)}R net` }
  }

  // Realised worse than a clean stop => the stop gapped.
  const plannedLossR = -1
  if (trade.exitReason === 'stop_loss' && netR < plannedLossR - 0.25) {
    return { reasonCode: 'STOP_GAP_SLIPPAGE', detail: `planned -1.00R, realised ${netR.toFixed(2)}R (gap through stop)` }
  }
  if (Math.abs(netR) > 4) {
    return { reasonCode: 'TAIL_EVENT', detail: `${netR.toFixed(2)}R is far outside the planned distribution` }
  }
  if (grossR > 0 && netR <= 0) {
    return { reasonCode: 'COST_DOMINATED', detail: `gross +${grossR.toFixed(2)}R, costs ${costR.toFixed(2)}R, net ${netR.toFixed(2)}R` }
  }
  if (trade.exitReason === 'breakeven_stop' && filledTargets >= 1) {
    return { reasonCode: 'PARTIAL_TARGET_THEN_BREAKEVEN', detail: `${filledTargets} target(s) filled, then break-even stop, ${netR.toFixed(2)}R net` }
  }
  if (trade.exitReason === 'time_stop') {
    if (netR > 0) return { reasonCode: 'TIME_EXIT_POSITIVE', detail: `held ${trade.barsHeld} bars, +${netR.toFixed(2)}R net, MFE ${trade.mfeR.toFixed(2)}R` }
    if (trade.mfeR < 0.35) return { reasonCode: 'NO_FOLLOW_THROUGH', detail: `held ${trade.barsHeld} bars, MFE only ${trade.mfeR.toFixed(2)}R` }
    return { reasonCode: 'STOP_AFTER_PROGRESS', detail: `MFE ${trade.mfeR.toFixed(2)}R then faded to ${netR.toFixed(2)}R` }
  }
  if (trade.exitReason === 'stop_loss') {
    if (trade.mfeR < 0.2) {
      const confident = (context.winProbability ?? 0) >= 0.6
      return confident
        ? { reasonCode: 'MODEL_FALSE_POSITIVE', detail: `p=${((context.winProbability ?? 0) * 100).toFixed(0)}% but MFE ${trade.mfeR.toFixed(2)}R before the stop` }
        : { reasonCode: 'ADVERSE_SELECTION', detail: `filled then straight to the stop, MFE ${trade.mfeR.toFixed(2)}R, MAE ${trade.maeR.toFixed(2)}R` }
    }
    return { reasonCode: 'STOP_AFTER_PROGRESS', detail: `MFE ${trade.mfeR.toFixed(2)}R then stopped for ${netR.toFixed(2)}R` }
  }
  return { reasonCode: 'UNCLASSIFIED', detail: `exit=${trade.exitReason ?? 'unknown'} net=${netR.toFixed(2)}R` }
}

/**
 * Map an attribution histogram to the next research hypothesis.
 * Deterministic evidence -> experiment, no LLM required.
 */
export function hypothesisFromAttribution(
  summary: readonly { reasonCode: string; count: number; meanR: number }[],
): { reasonCode: string; hypothesis: string; campaignType: string } | null {
  const total = summary.reduce((sum, row) => sum + row.count, 0)
  if (total < 20) return null
  const share = (code: string) => (summary.find((row) => row.reasonCode === code)?.count ?? 0) / total

  if (share('UNFILLED_ENTRY') > 0.3) {
    return { reasonCode: 'UNFILLED_ENTRY', hypothesis: 'Entries are too passive: most ideas expire unfilled. Test a wider entry zone and a longer TTL against the same confirmation set.', campaignType: 'low_conviction' }
  }
  if (share('ADVERSE_SELECTION') > 0.25) {
    return { reasonCode: 'ADVERSE_SELECTION', hypothesis: 'Fills are immediately adverse: require closed-bar trigger confirmation and a liquidity/spread gate before arming.', campaignType: 'high_conviction' }
  }
  if (share('NO_FOLLOW_THROUGH') > 0.25) {
    return { reasonCode: 'NO_FOLLOW_THROUGH', hypothesis: 'Time stops dominate with tiny MFE: shorten the horizon or demand a stronger momentum trigger.', campaignType: 'regime_aware' }
  }
  if (share('COST_DOMINATED') > 0.15) {
    return { reasonCode: 'COST_DOMINATED', hypothesis: 'Costs eat the gross edge: reduce turnover, prefer larger timeframes and higher-liquidity instruments.', campaignType: 'high_conviction' }
  }
  if (share('STOP_AFTER_PROGRESS') > 0.3) {
    return { reasonCode: 'STOP_AFTER_PROGRESS', hypothesis: 'Trades reach meaningful MFE then reverse: test earlier partial profit and break-even management.', campaignType: 'triple_barrier' }
  }
  if (share('MODEL_FALSE_POSITIVE') > 0.2) {
    return { reasonCode: 'MODEL_FALSE_POSITIVE', hypothesis: 'High-probability predictions are failing: the ranking model has drifted, retrain and recalibrate.', campaignType: 'feature_rich' }
  }
  return null
}
