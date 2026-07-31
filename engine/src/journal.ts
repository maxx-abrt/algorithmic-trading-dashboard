/**
 * Signal journal + automatic outcome grading.
 *
 * Every actionable idea is written down with its full plan, then replayed
 * against real candles: MFE/MAE in R, partial take-profits with the stop moved
 * to break-even after TP1, stop-outs and time stops. That produces an honest,
 * self-updating track record instead of a wall of forgotten alerts.
 */
import type { Analysis, Candle } from './quant/types.js'
import type { SignalRow } from './convex/client.js'

export function toSignalRecord(a: Analysis): Record<string, unknown> | null {
  if (!a.plan || a.decision === 'WAIT') return null
  const p = a.plan
  return {
    instId: a.instId,
    instType: a.instType,
    timeframe: a.timeframe,
    decision: a.decision,
    playbook: a.playbook ?? undefined,
    regime: a.regime,
    conviction: a.conviction,
    composite: a.compositeScore,
    mtfAlignment: a.mtfAlignment,

    entry: p.entry,
    entryZone: p.entryZone,
    stopLoss: p.stopLoss,
    takeProfits: p.takeProfits.map((t) => t.price),
    tpAllocations: p.takeProfits.map((t) => t.allocationPct),
    expectedRr: p.expectedRr,
    riskDistance: p.riskDistance,
    leverage: p.leverage,
    contracts: p.contracts,
    notionalUsd: p.notionalUsd,
    marginUsd: p.marginUsd,
    riskUsd: p.riskUsd,
    liquidation: p.liquidationEstimate ?? undefined,
    timeStopBars: p.timeStopBars,

    edgeWinRate: p.edgeWinRate ?? undefined,
    edgeSample: p.edgeSample,
    expectancyR: p.netExpectancyR,

    aiDecision: a.ai?.decision,
    aiConfidence: a.ai?.confidence,
    aiReasoning: a.ai?.reasoning,
    aiModel: a.ai?.model,

    narrative: a.narrative.slice(0, 14),
    compact: JSON.stringify(a.compact),

    status: 'live',
    mfeR: 0,
    maeR: 0,
    barsHeld: 0,
    lastPrice: a.price,
  }
}

export interface GradeOutcome {
  patch: Record<string, unknown>
  closed: boolean
  headline: string
}

/**
 * Replay a live signal against the candles printed since it was issued.
 * Conservative on ambiguity: when a single bar touches both the stop and a
 * target, the stop is assumed to have filled first.
 */
export function gradeSignal(signal: SignalRow, candles: readonly Candle[], lastPrice: number): GradeOutcome | null {
  const dir = signal.decision === 'LONG' ? 1 : -1
  const risk = signal.riskDistance
  if (!(risk > 0)) return null

  const bars = candles.filter((c) => c.ts >= signal.createdAt)
  const allocations = (signal as unknown as { tpAllocations?: number[] }).tpAllocations ?? [40, 35, 25]
  const targets = signal.takeProfits ?? []

  let mfeR = signal.mfeR ?? 0
  let maeR = signal.maeR ?? 0
  let realized = 0
  let hitCount = 0
  let stop = signal.stopLoss
  let closed = false
  let exitPrice: number | null = null
  let exitReason = ''

  for (const c of bars) {
    const fav = dir > 0 ? c.high - signal.entry : signal.entry - c.low
    const adv = dir > 0 ? signal.entry - c.low : c.high - signal.entry
    mfeR = Math.max(mfeR, fav / risk)
    maeR = Math.max(maeR, adv / risk)

    const stopHit = dir > 0 ? c.low <= stop : c.high >= stop
    if (stopHit) {
      const remaining = 1 - allocations.slice(0, hitCount).reduce((s, v) => s + v / 100, 0)
      const stopR = ((stop - signal.entry) * dir) / risk
      realized += remaining * stopR
      exitPrice = stop
      exitReason = hitCount > 0 ? 'breakeven_stop' : 'stop_loss'
      closed = true
      break
    }

    while (hitCount < targets.length) {
      const t = targets[hitCount]
      const reached = dir > 0 ? c.high >= t : c.low <= t
      if (!reached) break
      realized += (allocations[hitCount] ?? 0) / 100 * (((t - signal.entry) * dir) / risk)
      hitCount++
      // Classic management: protect the trade once the first target pays.
      if (hitCount === 1) stop = signal.entry
    }
    if (hitCount >= targets.length && targets.length) {
      exitPrice = targets[targets.length - 1]
      exitReason = 'all_targets'
      closed = true
      break
    }
  }

  const barsHeld = bars.length
  if (!closed && barsHeld >= signal.timeStopBars) {
    const remaining = 1 - allocations.slice(0, hitCount).reduce((s, v) => s + v / 100, 0)
    realized += remaining * (((lastPrice - signal.entry) * dir) / risk)
    exitPrice = lastPrice
    exitReason = 'time_stop'
    closed = true
  }

  const status = closed
    ? realized > 0.05
      ? 'win'
      : realized < -0.05
        ? 'loss'
        : 'breakeven'
    : hitCount > 0
      ? 'tp1'
      : 'live'

  const patch: Record<string, unknown> = {
    mfeR,
    maeR,
    barsHeld,
    lastPrice,
    status,
  }
  if (closed) {
    patch.realizedR = realized
    patch.exitPrice = exitPrice ?? lastPrice
    patch.exitReason = exitReason
    patch.closedAt = Date.now()
  }

  const headline = closed
    ? `${signal.instId} ${signal.decision} closed ${exitReason.replace(/_/g, ' ')} at ${realized >= 0 ? '+' : ''}${realized.toFixed(2)}R (MFE ${mfeR.toFixed(2)}R / MAE ${maeR.toFixed(2)}R)`
    : `${signal.instId} ${signal.decision} running ${(((lastPrice - signal.entry) * dir) / risk).toFixed(2)}R (MFE ${mfeR.toFixed(2)}R)`

  // Nothing meaningful changed — skip the write.
  const unchanged =
    !closed &&
    status === signal.status &&
    Math.abs((signal.mfeR ?? 0) - mfeR) < 0.05 &&
    Math.abs((signal.maeR ?? 0) - maeR) < 0.05 &&
    barsHeld === signal.barsHeld
  if (unchanged) return null

  return { patch, closed, headline }
}
