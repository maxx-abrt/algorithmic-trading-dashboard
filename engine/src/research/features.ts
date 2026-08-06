/**
 * Shared feature vector definition — used by training, prediction, and risk blending.
 * The feature order MUST be identical everywhere a feature vector is constructed
 * or consumed, otherwise the model will silently produce wrong predictions.
 *
 * Features are normalized to roughly [0, 1] or [-1, 1] ranges.
 * Null-safe defaults ensure we don't crash when external APIs are unavailable.
 */

import type { Indicators, DerivativesBlock } from '../quant/types.js'
import type { MarketContext } from '../quant/market-context.js'

export const FEATURE_ORDER = [
  'composite',
  'mtf',
  'adx',
  'rsi',
  'atrPct',
  'volumeRatio',
  'playbookScore',
  'fearGreed',
  'sentiment',
  'btcDominance',
  'marketCapChange',
  'fundingRate',
  'openInterestChange',
  'longShortRatio',
  'takerRatio',
] as const

export const FEATURE_COUNT = FEATURE_ORDER.length

export interface FeatureInput {
  compositeScore: number
  mtfAlignment: number
  indicators: Indicators
  playbookScore: number
  marketContext?: { fearGreedIndex: number | null; sentimentScore: number | null; btcDominance: number | null; marketCapChange24h: number | null } | null
  derivatives?: DerivativesBlock | null
}

/** Build the canonical 15-element feature vector from analysis inputs. */
export function buildFeatureVector(input: FeatureInput): number[] {
  const i = input.indicators
  const mc = input.marketContext
  const dv = input.derivatives

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
  ]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
