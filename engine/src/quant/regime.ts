/**
 * Market Regime Detection — Gaussian Mixture Model.
 *
 * Classifies the current market state into one of N regimes based on
 * volatility, trend strength, and momentum. Different models, playbooks,
 * and position sizing rules can be applied per regime.
 *
 * Regimes:
 *   0 = calm_trending    (low vol, strong ADX) → trend-following works
 *   1 = calm_ranging     (low vol, weak ADX)   → mean reversion works
 *   2 = volatile_trending (high vol, strong ADX) → trend with wider stops
 *   3 = volatile_ranging  (high vol, weak ADX)  → reduce exposure
 *   4 = crisis            (extreme vol + adverse momentum) → minimal exposure
 *
 * Uses a simple online Gaussian Mixture with EM fitting.
 */

export interface RegimeFeatures {
  /** ATR as % of price (annualized) */
  atrPct: number
  /** ADX (trend strength 0-100) */
  adx: number
  /** RSI (momentum 0-100) */
  rsi: number
  /** 20-bar return (momentum direction) */
  return20: number
  /** volume ratio vs average */
  volumeRatio: number
  /** Hurst exponent (0 = mean-reverting, 0.5 = random, 1 = trending) */
  hurst: number
}

export type RegimeId = 0 | 1 | 2 | 3 | 4

export interface RegimeInfo {
  id: RegimeId
  label: string
  /** confidence 0..1 that this is the correct regime */
  confidence: number
  /** recommended position size multiplier for this regime */
  sizeMultiplier: number
  /** recommended playbook emphasis */
  playbookHint: 'trend' | 'reversion' | 'breakout' | 'reduce' | 'defensive'
}

interface GaussianComponent {
  mean: number[]
  cov: number[][]
  weight: number
}

const REGIME_LABELS: Record<RegimeId, string> = {
  0: 'calm_trending',
  1: 'calm_ranging',
  2: 'volatile_trending',
  3: 'volatile_ranging',
  4: 'crisis',
}

const REGIME_SIZE_MULTIPLIERS: Record<RegimeId, number> = {
  0: 1.0,
  1: 0.7,
  2: 0.8,
  3: 0.4,
  4: 0.15,
}

const REGIME_PLAYBOOK_HINTS: Record<RegimeId, RegimeInfo['playbookHint']> = {
  0: 'trend',
  1: 'reversion',
  2: 'trend',
  3: 'reduce',
  4: 'defensive',
}

export class RegimeDetector {
  private components: GaussianComponent[] = []
  private fitted = false
  private history: RegimeFeatures[] = []
  private readonly maxHistory = 500

  /**
   * Feed historical data to fit the GMM.
   * Call this on boot with all available historical bars.
   */
  fit(history: RegimeFeatures[]): void {
    if (history.length < 50) return
    this.history = history.slice(-this.maxHistory)

    const features = history.map((h) => this.toVector(h))
    const k = 5 // number of regimes

    // Initialize with k-means++ seeding
    this.components = this.kMeansInit(features, k)

    // Run EM for a fixed number of iterations
    for (let iter = 0; iter < 30; iter++) {
      this.emStep(features)
    }

    // Sort components by volatility so regime IDs are stable
    this.components.sort((a, b) => {
      const volA = Math.sqrt(a.cov[0][0])
      const volB = Math.sqrt(b.cov[0][0])
      return volA - volB
    })

    // Reassign IDs based on trend strength within vol buckets
    // Low vol (0,1): split by ADX → 0=trending, 1=ranging
    // High vol (2,3): split by ADX → 2=trending, 3=ranging
    // Highest vol (4): crisis
    this.reorderByIdentity()

    this.fitted = true
  }

  /**
   * Classify the current market regime.
   */
  classify(features: RegimeFeatures): RegimeInfo {
    if (!this.fitted || this.components.length === 0) {
      // Fallback: rule-based classification
      return this.ruleBasedClassify(features)
    }

    const vec = this.toVector(features)
    const probs = this.componentProbabilities(vec)
    let bestId = 0 as RegimeId
    let bestProb = 0

    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > bestProb) {
        bestProb = probs[i]
        bestId = i as RegimeId
      }
    }

    return {
      id: bestId,
      label: REGIME_LABELS[bestId],
      confidence: bestProb,
      sizeMultiplier: REGIME_SIZE_MULTIPLIERS[bestId],
      playbookHint: REGIME_PLAYBOOK_HINTS[bestId],
    }
  }

  /**
   * Update the model with a new observation (online learning).
   */
  update(features: RegimeFeatures): void {
    this.history.push(features)
    if (this.history.length > this.maxHistory) {
      this.history.shift()
    }
    // Refit every 50 new observations
    if (this.history.length % 50 === 0 && this.history.length >= 50) {
      this.fit(this.history)
    }
  }

  get regimeCount(): number {
    return this.components.length || 5
  }

  // --- Internal methods ---

  private toVector(f: RegimeFeatures): number[] {
    return [
      f.atrPct / 10,     // normalize to ~0..1
      f.adx / 50,        // normalize to ~0..1
      (f.rsi - 50) / 50, // normalize to -1..1
      f.return20 / 10,   // normalize to ~-1..1
      f.volumeRatio / 3, // normalize to ~0..1
      (f.hurst - 0.5) * 2, // normalize to -1..1
    ]
  }

  private ruleBasedClassify(f: RegimeFeatures): RegimeInfo {
    const highVol = f.atrPct > 5
    const strongTrend = f.adx > 25
    const crisis = f.atrPct > 10 && f.return20 < -5

    let id: RegimeId
    if (crisis) id = 4
    else if (highVol && strongTrend) id = 2
    else if (highVol && !strongTrend) id = 3
    else if (!highVol && strongTrend) id = 0
    else id = 1

    return {
      id,
      label: REGIME_LABELS[id],
      confidence: 0.6,
      sizeMultiplier: REGIME_SIZE_MULTIPLIERS[id],
      playbookHint: REGIME_PLAYBOOK_HINTS[id],
    }
  }

  private kMeansInit(data: number[][], k: number): GaussianComponent[] {
    const dim = data[0].length
    // K-means++ seeding
    const centers: number[][] = []
    centers.push(data[Math.floor(Math.random() * data.length)])

    for (let c = 1; c < k; c++) {
      const dists = data.map((d) => Math.min(...centers.map((c) => this.dist2(d, c))))
      const total = dists.reduce((a, b) => a + b, 0)
      const r = Math.random() * total
      let acc = 0
      for (let i = 0; i < data.length; i++) {
        acc += dists[i]
        if (acc >= r) {
          centers.push(data[i])
          break
        }
      }
    }

    // Assign points and compute initial parameters
    const assignments = data.map((d) => {
      let best = 0, bestDist = Infinity
      for (let i = 0; i < k; i++) {
        const dd = this.dist2(d, centers[i])
        if (dd < bestDist) { bestDist = dd; best = i }
      }
      return best
    })

    return Array.from({ length: k }, (_, i) => {
      const points = data.filter((_, j) => assignments[j] === i)
      const n = points.length || 1
      const mean = Array.from({ length: dim }, (_, d) => points.reduce((s, p) => s + p[d], 0) / n)
      const cov = Array.from({ length: dim }, (_, d1) =>
        Array.from({ length: dim }, (_, d2) => {
          const v = points.reduce((s, p) => s + (p[d1] - mean[d1]) * (p[d2] - mean[d2]), 0) / n
          return d1 === d2 ? Math.max(v, 1e-6) : v
        })
      )
      return { mean, cov, weight: points.length / data.length }
    })
  }

  private emStep(data: number[][]): void {
    const k = this.components.length
    const dim = data[0].length
    const responsibilities: number[][] = []

    // E-step
    for (const d of data) {
      const probs = this.componentProbabilities(d)
      const total = probs.reduce((a, b) => a + b, 0) || 1e-10
      responsibilities.push(probs.map((p) => p / total))
    }

    // M-step
    for (let c = 0; c < k; c++) {
      const resp = responsibilities.map((r) => r[c])
      const n = resp.reduce((a, b) => a + b, 0) || 1e-10

      // Update mean
      this.components[c].mean = Array.from({ length: dim }, (_, d) =>
        data.reduce((s, row, i) => s + resp[i] * row[d], 0) / n
      )

      // Update covariance
      this.components[c].cov = Array.from({ length: dim }, (_, d1) =>
        Array.from({ length: dim }, (_, d2) => {
          const v = data.reduce((s, row, i) =>
            s + resp[i] * (row[d1] - this.components[c].mean[d1]) * (row[d2] - this.components[c].mean[d2]), 0) / n
          return d1 === d2 ? Math.max(v, 1e-6) : v
        })
      )

      // Update weight
      this.components[c].weight = n / data.length
    }
  }

  private componentProbabilities(x: number[]): number[] {
    return this.components.map((comp) => {
      const logProb = this.logGaussianPdf(x, comp.mean, comp.cov)
      return Math.exp(Math.log(comp.weight) + logProb)
    })
  }

  private logGaussianPdf(x: number[], mean: number[], cov: number[][]): number {
    const dim = x.length
    const diff = x.map((xi, i) => xi - mean[i])

    // Compute log det and inverse via Cholesky-like approach
    // For diagonal-dominant cov, use simplified computation
    let logDet = 0
    const invDiag: number[] = []

    for (let i = 0; i < dim; i++) {
      const diag = Math.max(cov[i][i], 1e-8)
      logDet += Math.log(diag)
      invDiag.push(1 / diag)
    }

    // Mahalanobis distance (diagonal approximation for stability)
    let mahala = 0
    for (let i = 0; i < dim; i++) {
      mahala += diff[i] * diff[i] * invDiag[i]
    }

    return -0.5 * (dim * Math.log(2 * Math.PI) + logDet + mahala)
  }

  private dist2(a: number[], b: number[]): number {
    return a.reduce((s, ai, i) => s + (ai - b[i]) ** 2, 0)
  }

  private reorderByIdentity(): void {
    // After sorting by volatility, reassign based on ADX (index 1)
    // Components 0,1 = low vol; 2,3 = high vol; 4 = crisis
    if (this.components.length !== 5) return

    const lowVol = this.components.slice(0, 2)
    const highVol = this.components.slice(2, 4)
    const crisis = this.components[4]

    // Sort each pair by ADX (descending = trending first)
    lowVol.sort((a, b) => b.mean[1] - a.mean[1])
    highVol.sort((a, b) => b.mean[1] - a.mean[1])

    this.components = [...lowVol, ...highVol, crisis]
  }
}

/**
 * Build RegimeFeatures from indicators.
 */
export function buildRegimeFeatures(input: {
  atrPct: number
  adx: number
  rsi: number
  return20: number
  volumeRatio: number
  hurst: number
}): RegimeFeatures {
  return {
    atrPct: input.atrPct,
    adx: input.adx,
    rsi: input.rsi,
    return20: input.return20,
    volumeRatio: input.volumeRatio,
    hurst: input.hurst,
  }
}
