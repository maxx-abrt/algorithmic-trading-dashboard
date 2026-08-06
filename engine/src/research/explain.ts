/**
 * Explainability Layer — SHAP-like feature contributions.
 *
 * For every trade decision, produces a human-readable breakdown of
 * WHY the model arrived at its prediction. This is essential for:
 *   - Building trust with the operator
 *   - Debugging model behavior
 *   - Commercial viability (no one buys a black box)
 *
 * Uses a simplified SHAP (SHapley Additive exPlanations) approach:
 *   - For linear models: contribution = weight * (feature_value - mean)
 *   - For ensemble models: average contributions across base models
 *   - Groups features into categories for readability
 */

import type { CalibratedLinearModel } from './calibration.js'
import { predictCalibrated } from './calibration.js'

export interface FeatureContribution {
  featureName: string
  featureValue: number
  /** contribution to the prediction (positive = pushes toward LONG, negative = toward SHORT/WAIT) */
  contribution: number
  /** normalized importance 0..1 */
  importance: number
  /** human-readable explanation */
  explanation: string
}

export interface ExplanationResult {
  /** the model's predicted probability */
  prediction: number
  /** the base rate (mean prediction) */
  baseRate: number
  /** individual feature contributions, sorted by absolute value */
  contributions: FeatureContribution[]
  /** grouped summary for display */
  groups: { category: string; netContribution: number; items: FeatureContribution[] }[]
  /** top reasons (max 5) */
  topReasons: string[]
  /** overall summary string */
  summary: string
}

const FEATURE_CATEGORIES: Record<string, string> = {
  composite: 'Technical',
  mtf: 'Technical',
  adx: 'Technical',
  rsi: 'Technical',
  atrPct: 'Technical',
  volumeRatio: 'Technical',
  playbookScore: 'Strategy',
  fearGreed: 'Sentiment',
  sentiment: 'Sentiment',
  btcDominance: 'Market Context',
  marketCapChange: 'Market Context',
  fundingRate: 'Derivatives',
  openInterestChange: 'Derivatives',
  longShortRatio: 'Derivatives',
  takerRatio: 'Derivatives',
  // Extended features
  vix: 'Cross-Asset',
  dxyChange: 'Cross-Asset',
  spyChange: 'Cross-Asset',
  riskScore: 'Cross-Asset',
  goldChange: 'Cross-Asset',
  onChainScore: 'On-Chain',
  hashRate: 'On-Chain',
  mvrv: 'On-Chain',
  nvt: 'On-Chain',
  imbalance: 'Order Flow',
  weightedImbalance: 'Order Flow',
  spreadBps: 'Order Flow',
  microSignal: 'Order Flow',
  takerBuyRatio: 'Order Flow',
  depthConcentration: 'Order Flow',
  volForecast: 'Volatility',
  regimeId: 'Regime',
}

/**
 * Explain a linear model's prediction using SHAP-like contributions.
 * For a linear model: contribution_i = weight_i * (x_i - mean_i) / scale_i
 */
export function explainPrediction(
  model: CalibratedLinearModel,
  features: number[],
  featureNames: string[],
): ExplanationResult {
  const prediction = predictCalibrated(model, features)

  // Compute base rate (prediction at mean features)
  const meanFeatures = model.means
  const baseRate = predictCalibrated(model, meanFeatures)

  // Compute per-feature contributions
  const contributions: FeatureContribution[] = []
  for (let i = 0; i < model.featureCount && i < features.length; i++) {
    const normalized = (features[i] - model.means[i]) / model.scales[i]
    const contribution = model.weights[i] * normalized * model.plattA
    const name = featureNames[i] ?? `feature_${i}`
    const importance = Math.abs(contribution)

    contributions.push({
      featureName: name,
      featureValue: features[i],
      contribution,
      importance,
      explanation: explainFeature(name, features[i], contribution),
    })
  }

  // Sort by absolute contribution
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))

  // Group by category
  const groups: Map<string, FeatureContribution[]> = new Map()
  for (const c of contributions) {
    const cat = FEATURE_CATEGORIES[c.featureName] ?? 'Other'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(c)
  }

  const groupArray = Array.from(groups.entries()).map(([category, items]) => ({
    category,
    netContribution: items.reduce((s, i) => s + i.contribution, 0),
    items: items.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
  })).sort((a, b) => Math.abs(b.netContribution) - Math.abs(a.netContribution))

  // Top 5 reasons
  const topReasons = contributions.slice(0, 5).map((c) =>
    `${c.explanation} (${c.contribution > 0 ? '+' : ''}${(c.contribution * 100).toFixed(1)}%)`
  )

  // Summary
  const direction = prediction > 0.55 ? 'LONG' : prediction < 0.45 ? 'SHORT/WAIT' : 'NEUTRAL'
  const confidence = Math.abs(prediction - 0.5) * 2
  const summary = `${direction} signal at ${(confidence * 100).toFixed(0)}% confidence. ` +
    `Key drivers: ${topReasons.slice(0, 3).join(', ')}`

  return {
    prediction,
    baseRate,
    contributions,
    groups: groupArray,
    topReasons,
    summary,
  }
}

/**
 * Generate human-readable explanation for a single feature.
 */
function explainFeature(name: string, value: number, contribution: number): string {
  const direction = contribution > 0 ? 'bullish' : 'bearish'
  const strength = Math.abs(contribution) > 0.3 ? 'strongly ' : ''

  const explanations: Record<string, (v: number, c: number) => string> = {
    adx: (v) => v > 25 ? `strong trend (ADX=${v.toFixed(0)})` : `weak trend (ADX=${v.toFixed(0)})`,
    rsi: (v) => v > 70 ? `overbought (RSI=${v.toFixed(0)})` : v < 30 ? `oversold (RSI=${v.toFixed(0)})` : `neutral momentum (RSI=${v.toFixed(0)})`,
    atrPct: (v) => v > 5 ? `high volatility (ATR=${v.toFixed(1)}%)` : `low volatility (ATR=${v.toFixed(1)}%)`,
    volumeRatio: (v) => v > 1.5 ? `volume surge (${v.toFixed(1)}x avg)` : `normal volume (${v.toFixed(1)}x avg)`,
    fearGreed: (v) => v < 25 ? `extreme fear (F&G=${v.toFixed(0)}) — contrarian bullish` : v > 75 ? `extreme greed (F&G=${v.toFixed(0)}) — contrarian bearish` : `neutral sentiment (F&G=${v.toFixed(0)})`,
    fundingRate: (v) => v < 0 ? `negative funding (${v.toFixed(4)}) — shorts paying longs` : `positive funding (${v.toFixed(4)}) — longs paying shorts`,
    longShortRatio: (v) => v > 1.2 ? `crowd long (${v.toFixed(2)}) — contrarian bearish` : v < 0.8 ? `crowd short (${v.toFixed(2)}) — contrarian bullish` : `balanced positioning (${v.toFixed(2)})`,
    takerRatio: (v) => v > 1.1 ? `aggressive buying (${v.toFixed(2)}x)` : v < 0.9 ? `aggressive selling (${v.toFixed(2)}x)` : `balanced flow (${v.toFixed(2)}x)`,
    vix: (v) => v > 25 ? `elevated VIX (${v.toFixed(0)}) — risk-off` : v < 15 ? `low VIX (${v.toFixed(0)}) — risk-on` : `normal VIX (${v.toFixed(0)})`,
    imbalance: (v) => v > 0.2 ? `bid-heavy book (+${v.toFixed(2)})` : v < -0.2 ? `ask-heavy book (${v.toFixed(2)})` : `balanced book (${v.toFixed(2)})`,
    composite: (v) => `composite score ${v.toFixed(0)}/100`,
    mtf: (v) => `multi-TF alignment ${v.toFixed(0)}/100`,
    playbookScore: (v) => `playbook match ${v.toFixed(0)}/100`,
  }

  const specific = explanations[name]?.(value, contribution) ?? `${name}=${value.toFixed(3)}`
  return `${strength}${direction}: ${specific}`
}
