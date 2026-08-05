import type { Candle, RiskPlan } from '../quant/types.js'
import type { BrokerResult, PaperEvent, PaperPlan, PaperTrade } from './types.js'

const EPS = 1e-9
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const sideSign = (side: PaperPlan['side']) => (side === 'LONG' ? 1 : -1)

function addEvent(trade: PaperTrade, event: PaperEvent, fresh: PaperEvent[]) {
  trade.events.push(event)
  fresh.push(event)
}

function riskDistance(trade: PaperTrade) {
  return Math.max(EPS, Math.abs((trade.fillPrice ?? trade.plan.entry) - trade.plan.stopLoss))
}

function rAt(trade: PaperTrade, price: number) {
  return ((price - (trade.fillPrice ?? trade.plan.entry)) * sideSign(trade.plan.side)) / riskDistance(trade)
}

function adversePrice(price: number, side: PaperPlan['side'], bps: number, action: 'entry' | 'exit') {
  const sign = sideSign(side)
  const direction = action === 'entry' ? sign : -sign
  return price * (1 + direction * bps / 10_000)
}

export function createPaperPlan(input: {
  id: string
  instId: string
  timeframe: string
  signalAt: number
  playbook: string
  policyVersion: string
  modelVersion?: string
  plan: RiskPlan
  feeBps?: number
  slippageBps?: number
  maxEntryBars?: number
  quantity?: number
  atrAtEntry: number
  fundingRate8h?: number
}): PaperPlan {
  return {
    id: input.id,
    instId: input.instId,
    timeframe: input.timeframe,
    side: input.plan.side,
    signalAt: input.signalAt,
    policyVersion: input.policyVersion,
    modelVersion: input.modelVersion ?? 'heuristic-baseline',
    playbook: input.playbook,
    entry: input.plan.entry,
    entryZone: [Math.min(...input.plan.entryZone), Math.max(...input.plan.entryZone)],
    stopLoss: input.plan.stopLoss,
    targets: input.plan.takeProfits.map((target) => ({
      price: target.price,
      allocation: target.allocationPct / 100,
    })),
    quantity: input.quantity ?? Math.max(input.plan.contracts, 1),
    riskUsd: input.plan.riskUsd,
    maxEntryBars: input.maxEntryBars ?? 3,
    maxHoldBars: input.plan.timeStopBars,
    feeBps: input.feeBps ?? 5,
    slippageBps: input.slippageBps ?? Math.max(0, input.plan.slippageBps),
    fundingRate8h: input.fundingRate8h,
    atrAtEntry: input.atrAtEntry,
    trailAtrMult: input.plan.trailAtrMult,
  }
}

export function submitPaperPlan(plan: PaperPlan): PaperTrade {
  const allocations = plan.targets.reduce((sum, target) => sum + target.allocation, 0)
  if (!(plan.entry > 0) || !(plan.stopLoss > 0) || !(plan.riskUsd > 0)) {
    throw new Error('paper plan has invalid entry, stop, or risk')
  }
  if (plan.side === 'LONG' ? plan.stopLoss >= plan.entry : plan.stopLoss <= plan.entry) {
    throw new Error('paper plan stop is on the wrong side of entry')
  }
  if (Math.abs(allocations - 1) > 0.02) throw new Error('paper target allocations must sum to 1')

  return {
    id: plan.id,
    plan,
    status: 'pending',
    submittedAt: plan.signalAt,
    currentStop: plan.stopLoss,
    targets: plan.targets.map((target) => ({ ...target, filled: false })),
    remaining: 1,
    barsPending: 0,
    barsHeld: 0,
    grossRealizedR: 0,
    netRealizedR: 0,
    feesR: 0,
    fundingR: 0,
    mfeR: 0,
    maeR: 0,
    lastProcessedTs: 0,
    events: [{ at: plan.signalAt, type: 'submitted', detail: 'paper plan submitted; no exchange order created' }],
  }
}

function closeTrade(trade: PaperTrade, at: number, price: number, reason: PaperTrade['exitReason'], fresh: PaperEvent[]) {
  const exit = adversePrice(price, trade.plan.side, trade.plan.slippageBps, 'exit')
  trade.grossRealizedR += trade.remaining * rAt(trade, exit)
  const notionalRiskRatio = (trade.fillPrice ?? trade.plan.entry) / riskDistance(trade)
  trade.feesR += trade.remaining * (trade.plan.feeBps / 10_000) * notionalRiskRatio
  trade.remaining = 0
  trade.status = reason === 'entry_expired' ? 'expired' : 'closed'
  trade.closedAt = at
  trade.exitPrice = exit
  trade.exitReason = reason
  trade.netRealizedR = trade.grossRealizedR - trade.feesR - trade.fundingR
  addEvent(trade, { at, type: reason === 'entry_expired' ? 'expired' : 'closed', price: exit, detail: reason ?? 'closed' }, fresh)
}

function entryTouched(plan: PaperPlan, candle: Candle) {
  return candle.low <= plan.entryZone[1] && candle.high >= plan.entryZone[0]
}

function fillPending(trade: PaperTrade, candle: Candle, fresh: PaperEvent[]) {
  trade.barsPending++
  if (!entryTouched(trade.plan, candle)) {
    if (trade.barsPending >= trade.plan.maxEntryBars) closeTrade(trade, candle.ts, trade.plan.entry, 'entry_expired', fresh)
    return
  }
  const base = clamp(trade.plan.entry, candle.low, candle.high)
  const fill = adversePrice(base, trade.plan.side, trade.plan.slippageBps, 'entry')
  trade.fillPrice = fill
  trade.filledAt = candle.ts
  trade.status = 'open'
  const notionalRiskRatio = fill / riskDistance(trade)
  trade.feesR += (trade.plan.feeBps / 10_000) * notionalRiskRatio
  addEvent(trade, { at: candle.ts, type: 'filled', price: fill, detail: 'entry zone touched; conservative paper fill applied' }, fresh)
}

function updateExcursions(trade: PaperTrade, candle: Candle) {
  const fill = trade.fillPrice ?? trade.plan.entry
  const risk = riskDistance(trade)
  const favorable = trade.plan.side === 'LONG' ? candle.high - fill : fill - candle.low
  const adverse = trade.plan.side === 'LONG' ? fill - candle.low : candle.high - fill
  trade.mfeR = Math.max(trade.mfeR, favorable / risk)
  trade.maeR = Math.max(trade.maeR, adverse / risk)
}

function stopTouched(trade: PaperTrade, candle: Candle) {
  return trade.plan.side === 'LONG' ? candle.low <= trade.currentStop : candle.high >= trade.currentStop
}

function stopFill(trade: PaperTrade, candle: Candle) {
  if (trade.plan.side === 'LONG' && candle.open < trade.currentStop) return candle.open
  if (trade.plan.side === 'SHORT' && candle.open > trade.currentStop) return candle.open
  return trade.currentStop
}

function targetTouched(trade: PaperTrade, target: PaperTrade['targets'][number], candle: Candle) {
  return trade.plan.side === 'LONG' ? candle.high >= target.price : candle.low <= target.price
}

function processOpen(trade: PaperTrade, candle: Candle, fresh: PaperEvent[]) {
  trade.barsHeld++
  updateExcursions(trade, candle)

  // Conservative ambiguity rule: a stop always wins when the same OHLC bar also reaches a target.
  if (stopTouched(trade, candle)) {
    closeTrade(trade, candle.ts, stopFill(trade, candle), trade.targets.some((t) => t.filled) ? 'breakeven_stop' : 'stop_loss', fresh)
    return
  }

  for (let index = 0; index < trade.targets.length; index++) {
    const target = trade.targets[index]
    if (target.filled || !targetTouched(trade, target, candle)) continue
    const allocation = Math.min(trade.remaining, target.allocation)
    const exit = adversePrice(target.price, trade.plan.side, trade.plan.slippageBps, 'exit')
    target.filled = true
    target.filledAt = candle.ts
    target.fillPrice = exit
    trade.remaining = Math.max(0, trade.remaining - allocation)
    trade.grossRealizedR += allocation * rAt(trade, exit)
    trade.feesR += allocation * (trade.plan.feeBps / 10_000) * ((trade.fillPrice ?? trade.plan.entry) / riskDistance(trade))
    addEvent(trade, { at: candle.ts, type: 'target', price: exit, allocation, detail: `target ${index + 1} filled` }, fresh)

    if (index === 0) {
      trade.currentStop = trade.fillPrice ?? trade.plan.entry
      addEvent(trade, { at: candle.ts, type: 'stop_moved', price: trade.currentStop, detail: 'TP1 filled; stop moved to gross break-even' }, fresh)
    }
  }

  if (trade.remaining <= EPS) {
    trade.remaining = 0
    trade.status = 'closed'
    trade.closedAt = candle.ts
    trade.exitPrice = trade.targets.at(-1)?.fillPrice
    trade.exitReason = 'all_targets'
    trade.netRealizedR = trade.grossRealizedR - trade.feesR - trade.fundingR
    addEvent(trade, { at: candle.ts, type: 'closed', price: trade.exitPrice, detail: 'all targets filled' }, fresh)
    return
  }

  const elapsedHours = (trade.barsHeld * timeframeMs(trade.plan.timeframe)) / 3_600_000
  trade.fundingR = Math.max(0, elapsedHours / 8) * Math.abs(trade.plan.fundingRate8h ?? 0) * ((trade.fillPrice ?? trade.plan.entry) / riskDistance(trade)) * trade.remaining

  if (trade.targets.filter((target) => target.filled).length >= 2) {
    const candidate = trade.plan.side === 'LONG'
      ? candle.close - trade.plan.atrAtEntry * trade.plan.trailAtrMult
      : candle.close + trade.plan.atrAtEntry * trade.plan.trailAtrMult
    const tighter = trade.plan.side === 'LONG' ? Math.max(trade.currentStop, candidate) : Math.min(trade.currentStop, candidate)
    if (Math.abs(tighter - trade.currentStop) > EPS) {
      trade.currentStop = tighter
      addEvent(trade, { at: candle.ts, type: 'trailed', price: tighter, detail: 'ATR trail tightened after TP2' }, fresh)
    }
  }

  if (trade.barsHeld >= trade.plan.maxHoldBars) closeTrade(trade, candle.ts, candle.close, 'time_stop', fresh)
}

export function processPaperBar(input: PaperTrade, candle: Candle): BrokerResult {
  const trade = structuredClone(input)
  const fresh: PaperEvent[] = []
  if (!candle.confirmed || candle.ts <= trade.plan.signalAt || candle.ts <= trade.lastProcessedTs) {
    return { trade, changed: false, events: fresh }
  }
  if (trade.status !== 'pending' && trade.status !== 'open') return { trade, changed: false, events: fresh }
  if (trade.status === 'pending') fillPending(trade, candle, fresh)
  if (trade.status === 'open') processOpen(trade, candle, fresh)
  trade.lastProcessedTs = candle.ts
  if (trade.status === 'open') trade.netRealizedR = trade.grossRealizedR - trade.feesR - trade.fundingR
  return { trade, changed: true, events: fresh }
}

export function runPaperPlan(plan: PaperPlan, candles: readonly Candle[]): PaperTrade {
  let trade = submitPaperPlan(plan)
  for (const candle of [...candles].sort((a, b) => a.ts - b.ts)) {
    trade = processPaperBar(trade, candle).trade
    if (trade.status === 'closed' || trade.status === 'expired' || trade.status === 'rejected') break
  }
  return trade
}

function timeframeMs(timeframe: string) {
  const match = timeframe.match(/^(\d+)(m|H|D)$/)
  if (!match) return 15 * 60_000
  const value = Number(match[1])
  return value * (match[2] === 'm' ? 60_000 : match[2] === 'H' ? 3_600_000 : 86_400_000)
}
