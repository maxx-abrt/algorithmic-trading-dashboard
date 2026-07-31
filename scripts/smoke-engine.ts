import { analyze, quickScore } from '../lib/quant/engine'
import type { Candle } from '../lib/quant/types'

function synth(n: number, drift: number, seed = 7): Candle[] {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5)
  const out: Candle[] = []
  let p = 60000
  const step = 15 * 60_000
  const t0 = Date.now() - n * step - step
  for (let i = 0; i < n; i++) {
    const o = p
    p = p * (1 + drift / n + rnd() * 0.006)
    const c = p
    const h = Math.max(o, c) * (1 + Math.abs(rnd()) * 0.003)
    const l = Math.min(o, c) * (1 - Math.abs(rnd()) * 0.003)
    out.push({ ts: t0 + i * step, open: o, high: h, low: l, close: c, volume: 900 + Math.abs(rnd()) * 800, volCcy: 0, confirmed: true })
  }
  return out
}

for (const drift of [0.35, -0.35, 0.0]) {
  const a = analyze({
    instId: 'BTC-USDT-SWAP',
    instType: 'SWAP',
    ltf: synth(400, drift),
    htf: synth(300, drift, 11),
    htf2: synth(250, drift, 23),
    derivatives: { fundingRate: 0.0001, nextFundingRate: 0.00012, fundingApr: 10.9, openInterest: 1e9, openInterestChangePct: 2.4, takerRatio: 1.2, longShortRatio: 1.1, bookImbalance: 0.12, spreadBps: 1.2, markPrice: null, indexPrice: null, basisBps: 3, score: 12 },
    spec: { instId: 'BTC-USDT-SWAP', instType: 'SWAP', ctVal: 0.01, ctValCcy: 'BTC', lotSz: 0.1, minSz: 0.1, tickSz: 0.1, maxLever: 100, baseCcy: 'BTC', quoteCcy: 'USDT', isEquity: false },
    settings: { timeframe: '15m', htfTimeframe: '1H', htf2Timeframe: '4H', equityUsd: 10000 },
  })
  console.log('--- drift', drift, '=>', a.decision, a.playbook, 'conv', a.conviction, 'comp', a.compositeScore, 'regime', a.regime)
  console.log('  factors', a.factors.length, 'vetoes', a.vetoes.map(v => v.id).join(','), 'patterns', a.indicators.patterns.length, 'divs', a.indicators.divergences.length)
  console.log('  plan', a.plan ? JSON.stringify({ e: a.plan.entry.toFixed(1), sl: a.plan.stopLoss.toFixed(1), tps: a.plan.takeProfits.map(t => t.price.toFixed(1)), rr: a.plan.expectedRr.toFixed(2), lev: a.plan.leverage, ct: a.plan.contracts, risk: a.plan.riskUsd.toFixed(1), liq: a.plan.liquidationEstimate?.toFixed(1) }) : null)
  console.log('  warnings', a.dataQuality.warnings)
  console.log('  narrative[0]', a.narrative[0])
  console.log('  compact keys', Object.keys(a.compact).length, JSON.stringify(a.compact).length, 'chars')
}
console.log('quick', JSON.stringify(quickScore(synth(300, 0.4), '15m')))
