/**
 * OKX DEMO execution adapter.
 *
 * Purpose: stop guessing whether a plan is executable. Every armed candidate is
 * mirrored as a REAL order on the OKX demo (simulated) account, with a real
 * attached bracket, and the resulting order/fill states are reconciled back into
 * the ledger. Fill ratio, entry slippage and rejection codes then become
 * measurable facts instead of assumptions.
 *
 * Hard safety boundary: this module refuses to do anything unless
 * `OKX_SIMULATED=true`. There is no code path here that can reach a funded
 * account, and the passphrase-gated credential check fails closed.
 */
import { ENV, HAS_OKX_KEYS } from '../env.js'
import { log } from '../log.js'
import { OkxError, okxRequest } from '../okx/rest.js'
import type { InstrumentSpec } from '../quant/types.js'
import type { PaperTrade } from '../paper/types.js'
import type { EvolutionStore } from '../store/evolution-store.js'

export interface DemoOrderResult {
  ok: boolean
  clOrdId: string
  ordId?: string
  reason?: string
  sz?: number
  px?: number
}

export interface DemoHealth {
  configured: boolean
  simulated: boolean
  reason: string
  equityUsd: number | null
  availableUsdt: number | null
  lastSyncAt: number
  openOrders: number
  placed: number
  filled: number
  rejected: number
  lastError: string
}

const decimalsOf = (value: number) => {
  const text = String(value)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  return text.split('.')[1]?.length ?? 0
}

const roundToStep = (value: number, step: number) => {
  if (!(step > 0)) return value
  return Number((Math.floor(value / step) * step).toFixed(Math.min(12, decimalsOf(step))))
}

export class OkxDemoBroker {
  private stats = { placed: 0, filled: 0, rejected: 0, lastError: '', lastSyncAt: 0 }
  private balance: { equityUsd: number; availableUsdt: number } | null = null

  constructor(private readonly store: EvolutionStore) {}

  get configured() {
    return HAS_OKX_KEYS && ENV.okx.simulated
  }

  get blockReason() {
    if (!ENV.okx.key) return 'OKX_API_KEY missing'
    if (!ENV.okx.secret) return 'OKX_API_SECRET missing'
    if (!ENV.okx.passphrase) return 'OKX_API_PASSPHRASE missing — OKX cannot sign requests without it'
    if (!ENV.okx.simulated) return 'OKX_SIMULATED is not true — refusing to touch a funded account'
    return ''
  }

  health(): DemoHealth {
    return {
      configured: this.configured,
      simulated: ENV.okx.simulated,
      reason: this.blockReason || 'ready',
      equityUsd: this.balance?.equityUsd ?? null,
      availableUsdt: this.balance?.availableUsdt ?? null,
      lastSyncAt: this.stats.lastSyncAt,
      openOrders: this.configured ? this.store.openOrders().length : 0,
      placed: this.stats.placed,
      filled: this.stats.filled,
      rejected: this.stats.rejected,
      lastError: this.stats.lastError,
    }
  }

  async refreshBalance() {
    if (!this.configured) return null
    try {
      const rows = await okxRequest<{ totalEq: string; details: { ccy: string; eq: string; availBal: string }[] }>('/api/v5/account/balance', { signed: true })
      const row = rows[0]
      if (!row) return null
      const usdt = row.details?.find((detail) => detail.ccy === 'USDT')
      this.balance = { equityUsd: Number(row.totalEq) || 0, availableUsdt: Number(usdt?.availBal ?? 0) || 0 }
      return this.balance
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  /**
   * Size an order from the plan's monetary risk and the instrument contract spec.
   * SWAP `sz` is CONTRACTS, SPOT `sz` is BASE currency — getting this wrong is the
   * single most common cause of 51121 / 51008.
   */
  sizeFor(trade: PaperTrade, spec: InstrumentSpec, multiplier: number): { sz: number; reason: string } {
    const stopDistance = Math.abs(trade.plan.entry - trade.plan.stopLoss)
    if (!(stopDistance > 0)) return { sz: 0, reason: 'zero stop distance' }
    const riskUsd = Math.max(1, trade.plan.riskUsd) * multiplier

    let raw: number
    if (spec.instType === 'SWAP' || spec.instType === 'FUTURES') {
      const ctVal = spec.ctVal > 0 ? spec.ctVal : 1
      raw = riskUsd / (stopDistance * ctVal)
    } else {
      raw = riskUsd / stopDistance
    }

    // Never let a demo order exceed a sane fraction of the demo balance.
    const available = this.balance?.availableUsdt ?? 0
    if (available > 0) {
      const maxNotional = available * 2
      const notionalPerUnit = spec.instType === 'SPOT' ? trade.plan.entry : trade.plan.entry * (spec.ctVal > 0 ? spec.ctVal : 1)
      if (notionalPerUnit > 0) raw = Math.min(raw, maxNotional / notionalPerUnit)
    }

    const stepped = roundToStep(raw, spec.lotSz > 0 ? spec.lotSz : 1)
    if (stepped < spec.minSz) {
      const minimum = roundToStep(spec.minSz, spec.lotSz > 0 ? spec.lotSz : 1)
      return { sz: minimum, reason: `raised to instrument minSz ${spec.minSz}` }
    }
    return { sz: stepped, reason: `risk $${riskUsd.toFixed(2)} / stop ${stopDistance.toFixed(6)}` }
  }

  /** Mirror one armed paper trade as a real demo order with an attached bracket. */
  async placeBracket(trade: PaperTrade, spec: InstrumentSpec, multiplier = 1): Promise<DemoOrderResult> {
    const clOrdId = `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 32)
    if (!this.configured) return { ok: false, clOrdId, reason: this.blockReason }

    const { sz, reason: sizeReason } = this.sizeFor(trade, spec, multiplier)
    if (!(sz > 0)) return { ok: false, clOrdId, reason: `sizing failed: ${sizeReason}` }

    const tickDecimals = Math.min(10, decimalsOf(spec.tickSz > 0 ? spec.tickSz : 0.1))
    const price = (value: number) => roundToStep(value, spec.tickSz > 0 ? spec.tickSz : 0.1).toFixed(tickDecimals)
    const side = trade.plan.side === 'LONG' ? 'buy' : 'sell'
    const tdMode = spec.instType === 'SPOT' ? 'cash' : 'cross'
    const firstTarget = trade.plan.targets[0]?.price

    const body: Record<string, unknown> = {
      instId: trade.plan.instId,
      tdMode,
      side,
      ordType: 'limit',
      px: price(trade.plan.entry),
      sz: String(sz),
      clOrdId,
    }
    // SPOT cash accounts cannot short and do not accept the same attached bracket,
    // so the bracket is only attached where OKX supports it.
    if (spec.instType !== 'SPOT' && firstTarget) {
      body.attachAlgoOrds = [
        {
          tpTriggerPx: price(firstTarget),
          tpOrdPx: '-1',
          slTriggerPx: price(trade.plan.stopLoss),
          slOrdPx: '-1',
          tpTriggerPxType: 'last',
          slTriggerPxType: 'last',
        },
      ]
    }

    try {
      const rows = await okxRequest<{ ordId: string; clOrdId: string; sCode: string; sMsg: string }>('/api/v5/trade/order', {
        method: 'POST',
        signed: true,
        body,
      })
      const row = rows[0]
      if (!row?.ordId || (row.sCode && row.sCode !== '0')) {
        this.stats.rejected++
        this.stats.lastError = `${row?.sCode ?? '?'} ${row?.sMsg ?? 'no ordId'}`
        this.store.recordOrder({ clOrdId, tradeId: trade.id, instId: trade.plan.instId, instType: spec.instType, side, ordType: 'limit', px: trade.plan.entry, sz, state: 'rejected', raw: row })
        return { ok: false, clOrdId, reason: this.stats.lastError }
      }
      this.stats.placed++
      this.store.recordOrder({ clOrdId, tradeId: trade.id, ordId: row.ordId, instId: trade.plan.instId, instType: spec.instType, side, ordType: 'limit', px: trade.plan.entry, sz, state: 'live', raw: row })
      log.signal('okx-demo', `placed ${side} ${sz} ${trade.plan.instId} @ ${body.px} (${sizeReason}) ordId ${row.ordId}`, { instId: trade.plan.instId, timeframe: trade.plan.timeframe })
      return { ok: true, clOrdId, ordId: row.ordId, sz, px: Number(body.px) }
    } catch (error) {
      const message = error instanceof OkxError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
      this.stats.rejected++
      this.stats.lastError = message
      this.store.recordOrder({ clOrdId, tradeId: trade.id, instId: trade.plan.instId, instType: spec.instType, side, ordType: 'limit', px: trade.plan.entry, sz, state: 'rejected', raw: { error: message } })
      log.error('okx-demo', `order rejected for ${trade.plan.instId}: ${message}`)
      return { ok: false, clOrdId, reason: message }
    }
  }

  /** Poll every tracked order and reconcile its state into the ledger. */
  async sync(): Promise<{ updated: number; filled: number }> {
    if (!this.configured) return { updated: 0, filled: 0 }
    const open = this.store.openOrders()
    let updated = 0
    let filled = 0
    for (const row of open) {
      const instId = String(row.inst_id)
      const ordId = row.ord_id ? String(row.ord_id) : null
      if (!ordId) continue
      try {
        const rows = await okxRequest<{ state: string; accFillSz: string; avgPx: string; fee: string; sz: string }>('/api/v5/trade/order', {
          signed: true,
          params: { instId, ordId },
        })
        const order = rows[0]
        if (!order) continue
        this.store.recordOrder({
          clOrdId: String(row.cl_ord_id),
          tradeId: String(row.trade_id),
          ordId,
          instId,
          instType: String(row.inst_type),
          side: String(row.side),
          ordType: String(row.ord_type),
          px: row.px == null ? null : Number(row.px),
          sz: Number(row.sz),
          state: order.state,
          filledSz: Number(order.accFillSz ?? 0),
          avgPx: order.avgPx ? Number(order.avgPx) : null,
          fee: order.fee ? Number(order.fee) : null,
          purpose: String(row.purpose ?? 'entry'),
          raw: order,
        })
        updated++
        if (order.state === 'filled') {
          filled++
          this.stats.filled++
          log.signal('okx-demo', `filled ${instId} ${order.accFillSz} @ ${order.avgPx}`, { instId })
        }
      } catch (error) {
        this.stats.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    this.stats.lastSyncAt = Date.now()
    return { updated, filled }
  }

  /** Cancel every order attached to a trade (used when the paper plan expires). */
  async cancelForTrade(tradeId: string) {
    if (!this.configured) return 0
    let cancelled = 0
    for (const row of this.store.ordersForTrade(tradeId)) {
      const state = String(row.state)
      if (state !== 'live' && state !== 'partially_filled') continue
      const ordId = row.ord_id ? String(row.ord_id) : null
      if (!ordId) continue
      try {
        await okxRequest('/api/v5/trade/cancel-order', { method: 'POST', signed: true, body: { instId: String(row.inst_id), ordId } })
        this.store.recordOrder({
          clOrdId: String(row.cl_ord_id),
          tradeId,
          ordId,
          instId: String(row.inst_id),
          instType: String(row.inst_type),
          side: String(row.side),
          ordType: String(row.ord_type),
          px: row.px == null ? null : Number(row.px),
          sz: Number(row.sz),
          state: 'canceled',
          filledSz: Number(row.filled_sz ?? 0),
        })
        cancelled++
      } catch (error) {
        this.stats.lastError = error instanceof Error ? error.message : String(error)
      }
    }
    return cancelled
  }

  async positions() {
    if (!this.configured) return []
    try {
      return await okxRequest<Record<string, string>>('/api/v5/account/positions', { signed: true })
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error)
      return []
    }
  }

  /**
   * Fill-quality report: the difference between what the paper broker assumed and
   * what the exchange actually did. This is the number that tells us whether the
   * simulator can be trusted.
   */
  parityReport() {
    const orders = this.store.listOrders(500)
    const terminal = orders.filter((row) => ['filled', 'canceled', 'rejected'].includes(String(row.state)))
    const filledOrders = orders.filter((row) => String(row.state) === 'filled' && row.avg_px != null && row.px != null)
    const slippageBps = filledOrders.map((row) => {
      const intended = Number(row.px)
      const actual = Number(row.avg_px)
      const sign = String(row.side) === 'buy' ? 1 : -1
      return ((actual - intended) / intended) * 10_000 * sign
    })
    return {
      orders: orders.length,
      terminal: terminal.length,
      filled: filledOrders.length,
      rejected: orders.filter((row) => String(row.state) === 'rejected').length,
      fillRate: terminal.length ? filledOrders.length / terminal.length : null,
      meanEntrySlippageBps: slippageBps.length ? slippageBps.reduce((sum, value) => sum + value, 0) / slippageBps.length : null,
      worstEntrySlippageBps: slippageBps.length ? Math.max(...slippageBps) : null,
    }
  }
}
