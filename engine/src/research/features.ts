/**
 * Shared feature vector definition — used by training, prediction, and risk blending.
 * The feature order MUST be identical everywhere a feature vector is constructed
 * or consumed, otherwise the model will silently produce wrong predictions.
 *
 * Features are normalized to roughly [0, 1] or [-1, 1] ranges.
 * Null-safe defaults ensure we don't crash when external APIs are unavailable.
 *
 * V2: Expanded from 15 to 32 features with cross-asset, on-chain,
 * order flow, volatility forecast, and regime features.
 */

import type { Indicators, DerivativesBlock } from '../quant/types.js'
import type { MarketContext } from '../quant/market-context.js'
import type { CrossAssetData } from '../quant/cross-asset.js'
import type { OnChainData } from '../quant/onchain.js'
import type { OrderBookSnapshot } from '../quant/orderbook.js'
import type { VolForecast } from '../quant/vol-forecast.js'
import type { RegimeInfo } from '../quant/regime.js'

export const FEATURE_ORDER = [
  // Technical (0-6)
  'composite',
  'mtf',
  'adx',
  'rsi',
  'atrPct',
  'volumeRatio',
  'playbookScore',
  // Market context (7-10)
  'fearGreed',
  'sentiment',
  'btcDominance',
  'marketCapChange',
  // Derivatives (11-14)
  'fundingRate',
  'openInterestChange',
  'longShortRatio',
  'takerRatio',
  // Cross-asset (15-19)
  'vix',
  'dxyChange',
  'spyChange',
  'riskScore',
  'goldChange',
  // On-chain (20-23)
  'onChainScore',
  'hashRate',
  'mvrv',
  'nvt',
  // Order flow (24-29)
  'bookImbalance',
  'weightedImbalance',
  'spreadBps',
  'microSignal',
  'takerBuyRatio',
  'depthConcentration',
  // Volatility & regime (30-31)
  'volForecast',
  'regimeId',
] as const

export const FEATURE_COUNT = FEATURE_ORDER.length

export interface FeatureInput {
  compositeScore: number
  mtfAlignment: number
  indicators: Indicators
  playbookScore: number
  marketContext?: { fearGreedIndex: number | null; sentimentScore: number | null; btcDominance: number | null; marketCapChange24h: number | null } | null
  derivatives?: DerivativesBlock | null
  crossAsset?: CrossAssetData | null
  onChain?: OnChainData | null
  orderBook?: OrderBookSnapshot | null
  volForecast?: VolForecast | null
  regime?: RegimeInfo | null
}

/** Build the canonical feature vector from all available data sources. */
export function buildFeatureVector(input: FeatureInput): number[] {
  const i = input.indicators
  const mc = input.marketContext
  const dv = input.derivatives
  const ca = input.crossAsset
  const oc = input.onChain
  const ob = input.orderBook
  const vf = input.volForecast
  const rg = input.regime

  return [
    // Technical features (0-6)
    clamp01(input.compositeScore / 100),
    clamp01(input.mtfAlignment / 100),
    clamp01(i.trend.adx / 50),
    clamp01(i.momentum.rsi / 100),
    clamp01(i.volatility.atrPct / 10),
    clamp01(i.volume.volumeRatio / 3),
    clamp01(input.playbookScore / 100),
    // Market context features (7-10) — null-safe defaults
    mc?.fearGreedIndex != null ? clamp01(mc.fearGreedIndex / 100) : 0.5,
    mc?.sentimentScore != null ? clamp(mc.sentimentScore / 100, -1, 1) : 0,
    mc?.btcDominance != null ? clamp01(mc.btcDominance / 100) : 0.5,
    mc?.marketCapChange24h != null ? clamp(mc.marketCapChange24h / 10, -1, 1) : 0,
    // Derivatives features (11-14) — null-safe defaults
    dv?.fundingRate != null ? clamp(dv.fundingRate / 0.001, -1, 1) : 0,
    dv?.openInterestChangePct != null ? clamp(dv.openInterestChangePct / 10, -1, 1) : 0,
    dv?.longShortRatio != null ? clamp(dv.longShortRatio - 1, -1, 1) : 0,
    dv?.takerRatio != null ? clamp(dv.takerRatio - 1, -1, 1) : 0,
    // Cross-asset features (15-19) — null-safe defaults
    ca?.vix != null ? clamp01(ca.vix / 50) : 0.5,
    ca?.dxyChange != null ? clamp(ca.dxyChange / 2, -1, 1) : 0,
    ca?.spyChange != null ? clamp(ca.spyChange / 3, -1, 1) : 0,
    ca?.riskScore != null ? clamp(ca.riskScore, -1, 1) : 0,
    ca?.goldChange != null ? clamp(ca.goldChange / 3, -1, 1) : 0,
    // On-chain features (20-23) — null-safe defaults
    oc?.onChainScore != null ? clamp(oc.onChainScore, -1, 1) : 0,
    oc?.hashRate != null ? clamp01(oc.hashRate / 600_000_000_000) : 0.5,
    oc?.mvrvRatio != null ? clamp01(oc.mvrvRatio / 5) : 0.5,
    oc?.nvtRatio != null ? clamp01(oc.nvtRatio / 100) : 0.5,
    // Order flow features (24-29) — null-safe defaults
    ob?.imbalance != null ? clamp(ob.imbalance, -1, 1) : 0,
    ob?.weightedImbalance != null ? clamp(ob.weightedImbalance, -1, 1) : 0,
    ob?.spreadBps != null ? clamp01(ob.spreadBps / 50) : 0,
    ob?.microSignal != null ? clamp(ob.microSignal, -1, 1) : 0,
    ob?.takerBuyRatio != null ? clamp01(ob.takerBuyRatio) : 0.5,
    ob?.depthConcentration != null ? clamp01(ob.depthConcentration) : 0.5,
    // Volatility & regime (30-31)
    vf?.normalized != null ? clamp01(vf.normalized) : 0.5,
    rg?.id != null ? clamp01(rg.id / 4) : 0.5,
  ]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
