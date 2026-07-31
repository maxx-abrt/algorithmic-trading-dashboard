/**
 * Render a Telegram card in the terminal without sending it.
 *   yarn tsx scripts/preview-card.ts BTC-USDT-SWAP 15m
 * Handy when tuning the card layout: what you see here is what lands on the phone
 * (HTML tags stripped, monospace blocks preserved).
 */
import '../src/env.js'
import { fetchCandles, fetchDerivatives, fetchInstruments, fetchTicker } from '../src/okx/market.js'
import { analyze } from '../src/quant/engine.js'
import { signalCard } from '../src/telegram/cards.js'

const instId = (process.argv[2] ?? 'BTC-USDT-SWAP').toUpperCase()
const bar = process.argv[3] ?? '15m'

const specs = await fetchInstruments(instId.split('-').length > 2 ? 'SWAP' : 'SPOT')
const spec = specs.find((s) => s.instId === instId) ?? null
const [ltf, htf, htf2, ticker, deriv] = await Promise.all([
  fetchCandles(instId, bar, 400),
  fetchCandles(instId, '1H', 300),
  fetchCandles(instId, '4H', 200),
  fetchTicker(instId),
  fetchDerivatives(instId, spec?.instType ?? 'SWAP', null),
])

const analysis = analyze({
  instId,
  spec,
  ltf,
  htf,
  htf2,
  derivatives: deriv,
  livePrice: ticker?.last ?? null,
  volUsd24h: ticker?.volUsd24h ?? null,
  settings: { timeframe: bar, htfTimeframe: '1H', htf2Timeframe: '4H' },
})

const html = signalCard(analysis)
const plain = html
  .replace(/<\/?(b|i|u|pre|code)>/g, '')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')

console.log(plain)
console.log(`\n[${html.length} chars of HTML — Telegram limit is 4096]`)
