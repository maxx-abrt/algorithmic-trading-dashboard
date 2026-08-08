/**
 * Exit simulator — replays ANY execution policy over a stored price path.
 *
 * Semantics are a faithful, allocation-light copy of `paper/broker.ts`:
 *   • conservative entry fill inside the entry zone, with adverse slippage
 *   • R measured from the FILL price to the original stop price
 *   • the bar that fills the entry is also evaluated for stops and targets
 *   • stop always wins when a single bar touches both the stop and a target
 *   • partial take-profit ladder, break-even after TP1, ATR trail after TP2
 *   • taker fees on every fill, funding accrual on the remaining size
 *   • time stop in bars
 * A gate in `scripts/poc-frontier.ts` asserts it agrees with the live broker to
 * within 1e-6 R over hundreds of real recorded trades.
 *
 * The point of a second implementation is speed: the live broker clones the whole
 * trade object on every bar (correct for a long-lived object, ruinous for a few
 * million replay steps). This one mutates locals only, so a full walk-forward
 * campaign over 20 000 stored decisions runs in well under a second.
 */
import type { TapePathBar, TapeRow } from '../store/tape-store.js'

export interface ExitVariant {
  id: string
  label: string
  /** multiply the original stop distance (1 = unchanged) */
  stopMult: number
  /** take-profit ladder expressed in R multiples of the (possibly scaled) risk */
  tpR: number[]
  /** allocation per rung, normalised internally */
  allocations: number[]
  /** ATR multiple used for the trail once two rungs are filled; 0 disables */
  trailAtrMult: number
  /** 0 inherits the plan */
  maxHoldBars: number
  /** 0 inherits the plan */
  maxEntryBars: number
  /** move the stop to break-even after the first rung fills */
  breakevenAfterTp1: boolean
}

export const DEFAULT_VARIANT: ExitVariant = {
  id: 'plan',
  label: 'original plan',
  stopMult: 1,
  tpR: [],
  allocations: [],
  trailAtrMult: -1,
  maxHoldBars: 0,
  maxEntryBars: 0,
  breakevenAfterTp1: true,
}

export interface SimResult {
  filled: boolean
  netR: number
  grossR: number
  feesR: number
  fundingR: number
  mfeR: number
  maeR: number
  barsHeld: number
  barsPending: number
  exitReason: 'stop_loss' | 'breakeven_stop' | 'all_targets' | 'time_stop' | 'entry_expired' | 'unresolved'
}

const UNFILLED: SimResult = {
  filled: false,
  netR: 0,
  grossR: 0,
  feesR: 0,
  fundingR: 0,
  mfeR: 0,
  maeR: 0,
  barsHeld: 0,
  barsPending: 0,
  exitReason: 'entry_expired',
}

function barMinutes(timeframe: string): number {
  const match = timeframe.match(/^(\d+)(m|H|D)$/)
  if (!match) return 15
  const value = Number(match[1])
  return match[2] === 'm' ? value : match[2] === 'H' ? value * 60 : value * 1440
}

export function simulateTapeRow(row: TapeRow, variant: ExitVariant = DEFAULT_VARIANT): SimResult {
  const path: readonly TapePathBar[] = row.path
  if (!path.length || !(row.entry > 0)) return UNFILLED

  const sign = row.side === 'LONG' ? 1 : -1
  const baseRisk = Math.abs(row.entry - row.stop)
  if (!(baseRisk > 0)) return UNFILLED
  const stopPrice = row.entry - sign * baseRisk * (variant.stopMult > 0 ? variant.stopMult : 1)

  const customTargets = variant.tpR.length > 0 && variant.allocations.length === variant.tpR.length
  const allocationSource = customTargets ? variant.allocations : row.targets.map((target) => target.allocation)
  const allocationSum = allocationSource.reduce((sum, value) => sum + value, 0)
  if (!(allocationSum > 0)) return UNFILLED
  const allocations = allocationSource.map((value) => value / allocationSum)
  const targetPrices = customTargets ? allocations.map(() => 0) : row.targets.map((target) => target.price)
  const targetFilled = allocations.map(() => false)

  const maxEntryBars = variant.maxEntryBars > 0 ? variant.maxEntryBars : row.maxEntryBars
  const maxHoldBars = variant.maxHoldBars > 0 ? variant.maxHoldBars : row.maxHoldBars
  const trailAtrMult = variant.trailAtrMult >= 0 ? variant.trailAtrMult : row.trailAtrMult
  const slip = row.slippageBps / 10_000
  const feeRate = row.feeBps / 10_000

  let status: 'pending' | 'open' | 'done' = 'pending'
  let currentStop = stopPrice
  let remaining = 1
  let grossR = 0
  let feesR = 0
  let fundingR = 0
  let mfeR = 0
  let maeR = 0
  let barsHeld = 0
  let barsPending = 0
  let fill = row.entry
  let risk = baseRisk
  let filledCount = 0
  let exitReason: SimResult['exitReason'] = 'unresolved'

  const rAt = (price: number) => (sign * (price - fill)) / risk
  const notionalRiskRatio = () => fill / risk

  const closeAll = (price: number, reason: SimResult['exitReason']) => {
    const exit = price * (1 - sign * slip)
    grossR += remaining * rAt(exit)
    feesR += remaining * feeRate * notionalRiskRatio()
    remaining = 0
    status = 'done'
    exitReason = reason
  }

  for (let index = 0; index < path.length && status !== 'done'; index++) {
    const bar = path[index]
    const open = row.entry * (1 + bar.o)
    const high = row.entry * (1 + bar.h)
    const low = row.entry * (1 + bar.l)
    const barClose = row.entry * (1 + bar.c)

    if (status === 'pending') {
      barsPending++
      const touched = low <= row.entryHigh && high >= row.entryLow
      if (!touched) {
        if (barsPending >= maxEntryBars) {
          status = 'done'
          exitReason = 'entry_expired'
        }
        continue
      }
      const base = Math.min(Math.max(row.entry, low), high)
      fill = base * (1 + sign * slip)
      risk = Math.max(1e-9, Math.abs(fill - stopPrice))
      feesR += feeRate * notionalRiskRatio()
      status = 'open'
      currentStop = stopPrice
      if (customTargets) {
        for (let t = 0; t < allocations.length; t++) targetPrices[t] = fill + sign * risk * (variant.tpR[t] ?? 1)
      }
    }

    /* ---- open-position logic for THIS bar, fill bar included -------------- */
    barsHeld++
    const favourable = sign === 1 ? high - fill : fill - low
    const adverse = sign === 1 ? fill - low : high - fill
    mfeR = Math.max(mfeR, favourable / risk)
    maeR = Math.max(maeR, adverse / risk)

    const stopHit = sign === 1 ? low <= currentStop : high >= currentStop
    if (stopHit) {
      const gapped = sign === 1 ? open < currentStop : open > currentStop
      closeAll(gapped ? open : currentStop, filledCount > 0 ? 'breakeven_stop' : 'stop_loss')
      break
    }

    for (let t = 0; t < allocations.length; t++) {
      if (targetFilled[t]) continue
      const price = targetPrices[t]
      if (!(price > 0)) continue
      const hit = sign === 1 ? high >= price : low <= price
      if (!hit) continue
      const allocation = Math.min(remaining, allocations[t])
      const exit = price * (1 - sign * slip)
      targetFilled[t] = true
      filledCount++
      remaining = Math.max(0, remaining - allocation)
      grossR += allocation * rAt(exit)
      feesR += allocation * feeRate * notionalRiskRatio()
      if (t === 0 && variant.breakevenAfterTp1) currentStop = fill
    }

    if (remaining <= 1e-9) {
      remaining = 0
      status = 'done'
      exitReason = 'all_targets'
      break
    }

    const elapsedHours = (barsHeld * barMinutes(row.timeframe)) / 60
    fundingR = Math.max(0, elapsedHours / 8) * Math.abs(row.fundingRate8h ?? 0) * notionalRiskRatio() * remaining

    if (filledCount >= 2 && trailAtrMult > 0 && row.atr > 0) {
      const candidate = sign === 1 ? barClose - row.atr * trailAtrMult : barClose + row.atr * trailAtrMult
      currentStop = sign === 1 ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate)
    }

    if (barsHeld >= maxHoldBars) {
      closeAll(barClose, 'time_stop')
      break
    }
  }

  if (status === 'pending') return { ...UNFILLED, barsPending }
  if (status === 'open') {
    // The stored path ran out before the trade resolved. Mark to market honestly.
    closeAll(row.entry * (1 + path[path.length - 1].c), 'time_stop')
  }

  const netR = grossR - feesR - fundingR
  return {
    filled: true,
    netR,
    grossR,
    feesR,
    fundingR,
    mfeR,
    maeR,
    barsHeld,
    barsPending,
    exitReason: exitReason === 'unresolved' ? 'time_stop' : exitReason,
  }
}

/**
 * Library of exit variants the arena competes against each other.
 * Every one of them is a genuinely different hypothesis about how to manage a
 * trade, and the arena decides which one survives on out-of-sample evidence.
 */
export const EXIT_LIBRARY: ExitVariant[] = [
  DEFAULT_VARIANT,
  { id: 'tight_1r', label: 'single 1R target', stopMult: 1, tpR: [1], allocations: [1], trailAtrMult: 0, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: false },
  { id: 'ladder_1_2_3', label: '1R/2R/3R ladder', stopMult: 1, tpR: [1, 2, 3], allocations: [0.4, 0.35, 0.25], trailAtrMult: 1.5, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true },
  { id: 'runner_2_5', label: '1R scale + 5R runner', stopMult: 1, tpR: [1, 5], allocations: [0.5, 0.5], trailAtrMult: 2, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true },
  { id: 'wide_stop', label: '1.5x stop, 2R/4R', stopMult: 1.5, tpR: [2, 4], allocations: [0.6, 0.4], trailAtrMult: 1.5, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true },
  { id: 'tight_stop', label: '0.6x stop, 1R/2R', stopMult: 0.6, tpR: [1, 2], allocations: [0.6, 0.4], trailAtrMult: 1, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true },
  { id: 'fast_exit', label: 'quick 1.5R, short hold', stopMult: 1, tpR: [1.5], allocations: [1], trailAtrMult: 0, maxHoldBars: 8, maxEntryBars: 0, breakevenAfterTp1: false },
  { id: 'patient', label: '3R target, long hold', stopMult: 1, tpR: [3], allocations: [1], trailAtrMult: 0, maxHoldBars: 60, maxEntryBars: 0, breakevenAfterTp1: false },
  { id: 'wide_runner', label: '1.5x stop, 3R runner + trail', stopMult: 1.5, tpR: [1.5, 4], allocations: [0.4, 0.6], trailAtrMult: 2.5, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: true },
  { id: 'no_breakeven', label: 'plan ladder, no break-even move', stopMult: 1, tpR: [], allocations: [], trailAtrMult: -1, maxHoldBars: 0, maxEntryBars: 0, breakevenAfterTp1: false },
]
