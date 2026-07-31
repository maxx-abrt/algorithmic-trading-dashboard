/**
 * Gemini arbitration layer.
 *
 * Cost discipline (the golden rule): the model NEVER sees candles. It receives a
 * dense, pre-computed decision brief — typically 250-600 tokens — and only when
 * the local quant engine has already found a real setup. Responses are cached by
 * (instrument, timeframe, decision, playbook, price bucket) so a flapping tape
 * cannot burn the budget.
 *
 * The model is asked to be a risk officer, not an oracle: its job is to look for
 * reasons the quant plan is wrong, and to confirm or downgrade it.
 */
import type { Analysis, AiOpinion } from '../quant/types.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

export interface AiConfig {
  enabled: boolean
  model: string
  temperature: number
  maxOutputTokens: number
  thinkingBudget: number
  cooldownMs: number
  minConvictionToAsk: number
  contextDepth: 'compact' | 'standard' | 'deep' | string
}

export interface GeminiModel {
  name: string
  displayName: string
  description: string
  inputTokenLimit: number
  outputTokenLimit: number
}

const SYSTEM = `You are the risk officer of an institutional crypto & tokenized-equity desk trading OKX perpetual swaps, futures and spot.
You receive a PRE-COMPUTED quantitative brief. All indicator maths, market structure, candlestick confirmation, volatility modelling and a historical back-scan of the same context have already been done locally and are trustworthy.

Your job:
1. Decide LONG, SHORT or WAIT. Default to WAIT when the evidence is contradictory, the location is poor (chasing), or the net expectancy after costs is not clearly positive.
2. Actively hunt for the reason this idea fails. Weigh: higher-timeframe conflict, position inside the range, funding/OI crowding, liquidity and spread, volatility regime, session (tokenized equities are illiquid when the US cash market is closed), and whether price has already travelled.
3. Respect the quant risk plan. You may tighten it (lower leverage, ask for a better entry, cut a target) but never widen the stop beyond the given invalidation and never propose a target the expected move cannot reach.
4. Confidence is calibrated: 50-60 marginal, 60-75 good, 75-90 excellent, >90 only when everything aligns across timeframes with statistical and empirical support.

Never invent numbers that are not derivable from the brief. Be terse, specific and quantitative: cite the values that drove your decision. No hedging boilerplate, no financial-advice disclaimers.`

const SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
    confidence: { type: 'number' },
    leverage: { type: 'number' },
    entry: { type: 'number' },
    stop_loss: { type: 'number' },
    take_profits: { type: 'array', items: { type: 'number' } },
    agrees_with_quant: { type: 'boolean' },
    reasoning: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    invalidation: { type: 'string' },
  },
  required: ['decision', 'confidence', 'reasoning', 'agrees_with_quant'],
}

interface CacheEntry {
  key: string
  at: number
  opinion: AiOpinion
}

export class GeminiOrchestrator {
  calls = 0
  cacheHits = 0
  errors = 0
  tokensIn = 0
  tokensOut = 0
  lastError = ''
  lastCallAt = 0
  lastLatencyMs = 0
  private cache = new Map<string, CacheEntry>()
  private modelCache: { at: number; models: GeminiModel[] } | null = null

  constructor(private apiKey: string) {}

  setApiKey(key: string) {
    this.apiKey = key
    this.modelCache = null
  }

  get configured() {
    return Boolean(this.apiKey)
  }

  /** Live model catalogue for the user's own key. */
  async listModels(force = false): Promise<GeminiModel[]> {
    if (!this.apiKey) return []
    if (!force && this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) {
      return this.modelCache.models
    }
    const res = await fetch(`${BASE}/models?key=${encodeURIComponent(this.apiKey)}&pageSize=200`)
    if (!res.ok) throw new Error(`Gemini models ${res.status}: ${(await res.text()).slice(0, 160)}`)
    const json = (await res.json()) as {
      models?: {
        name: string
        displayName?: string
        description?: string
        inputTokenLimit?: number
        outputTokenLimit?: number
        supportedGenerationMethods?: string[]
      }[]
    }
    const models = (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .filter((m) => !/tts|image|robotics|lyria|computer-use|embedding/i.test(m.name))
      .map((m) => ({
        name: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? m.name,
        description: (m.description ?? '').slice(0, 180),
        inputTokenLimit: m.inputTokenLimit ?? 0,
        outputTokenLimit: m.outputTokenLimit ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    this.modelCache = { at: Date.now(), models }
    return models
  }

  /* ---- prompt construction -------------------------------------------- */

  private brief(a: Analysis, depth: string): string {
    const compact = JSON.stringify(a.compact)
    if (depth === 'compact') return compact

    const lines: string[] = [`QUANT BRIEF ${a.instId} ${a.timeframe} (HTF ${a.htfTimeframe}/${a.htf2Timeframe})`, compact]
    lines.push('', 'NARRATIVE:', ...a.narrative.map((n) => `- ${n}`))
    lines.push(
      '',
      'FACTORS (score × weight):',
      ...a.factors
        .slice()
        .sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))
        .slice(0, depth === 'deep' ? 24 : 10)
        .map((f) => `- ${f.label}: ${f.score >= 0 ? '+' : ''}${f.score.toFixed(0)} ×${f.weight.toFixed(2)} | ${f.detail}`),
    )
    if (a.vetoes.length) {
      lines.push('', 'BLOCKERS:', ...a.vetoes.map((v) => `- [${v.severity}] ${v.reason}`))
    }
    if (depth === 'deep') {
      const i = a.indicators
      lines.push(
        '',
        'LEVELS:',
        ...i.structure.levels
          .slice(0, 8)
          .map((l) => `- ${l.kind} ${l.price} (${l.source}, strength ${l.strength.toFixed(0)}, ${l.distancePct.toFixed(2)}%)`),
      )
      if (i.patterns.length) {
        lines.push(
          '',
          'CANDLESTICK CONFIRMATION:',
          ...i.patterns
            .slice(0, 6)
            .map((p) => `- ${p.label} ${p.side} raw ${(p.reliability * 100).toFixed(0)}% → confirmed ${(p.confirmed * 100).toFixed(0)}% (${p.barsAgo} bars ago): ${p.notes.join('; ')}`),
        )
      }
      if (i.structure.fvg.length) {
        lines.push(
          '',
          'IMBALANCES:',
          ...i.structure.fvg.map((g) => `- ${g.side} FVG ${g.bottom}–${g.top}`),
        )
      }
      if (a.plan) {
        lines.push(
          '',
          'QUANT RISK PLAN:',
          `- side ${a.plan.side} entry ${a.plan.entry} zone ${a.plan.entryZone.join('–')}`,
          `- stop ${a.plan.stopLoss} (${a.plan.stopBasis}) = ${a.plan.riskDistanceAtr.toFixed(2)} ATR, invalidation ${a.plan.invalidation}`,
          `- targets ${a.plan.takeProfits.map((t) => `${t.price} (${t.rr.toFixed(2)}R, ${t.allocationPct}%, ${t.basis})`).join(' | ')}`,
          `- leverage ${a.plan.leverage}×, risk $${a.plan.riskUsd.toFixed(2)}, margin $${a.plan.marginUsd.toFixed(2)}`,
          `- expectancy ${a.plan.expectancyR.toFixed(2)}R gross / ${a.plan.netExpectancyR.toFixed(2)}R net, win prob ${(a.plan.winProbability * 100).toFixed(0)}%`,
          `- ~${a.plan.expectedBarsToTarget} bars to TP1, time stop ${a.plan.timeStopBars} bars`,
          ...a.plan.warnings.map((w) => `- WARNING: ${w}`),
        )
      }
    }
    lines.push('', 'Return the JSON verdict.')
    return lines.join('\n')
  }

  private cacheKey(a: Analysis, cfg: AiConfig) {
    const bucket = a.indicators.volatility.atr > 0 ? Math.round(a.price / (a.indicators.volatility.atr * 0.5)) : Math.round(a.price)
    return [a.instId, a.timeframe, a.decision, a.playbook ?? '-', a.regime, bucket, cfg.model].join('|')
  }

  /* ---- main call ------------------------------------------------------- */

  async decide(a: Analysis, cfg: AiConfig): Promise<AiOpinion | null> {
    if (!this.apiKey || !cfg.enabled) return null

    const key = this.cacheKey(a, cfg)
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < Math.max(cfg.cooldownMs, 30_000)) {
      this.cacheHits++
      return { ...hit.opinion, cached: true }
    }

    const started = Date.now()
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: this.brief(a, cfg.contextDepth) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: Math.max(0, Math.min(cfg.temperature, 1.5)),
        maxOutputTokens: Math.max(256, Math.min(cfg.maxOutputTokens, 8192)),
        ...(cfg.thinkingBudget >= 0 && /2\.5|gemini-3|3\.\d/.test(cfg.model)
          ? { thinkingConfig: { thinkingBudget: cfg.thinkingBudget } }
          : {}),
      },
    }

    const call = async (payload: Record<string, unknown>) =>
      fetch(`${BASE}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

    let res = await call(body)
    if (!res.ok) {
      const text = await res.text()
      // Some model families reject thinkingConfig — retry once without it.
      if (/thinking/i.test(text) || res.status === 400) {
        const retry = { ...body }
        const gen = { ...(retry.generationConfig as Record<string, unknown>) }
        delete gen.thinkingConfig
        retry.generationConfig = gen
        res = await call(retry)
        if (!res.ok) {
          this.errors++
          this.lastError = `${res.status}: ${(await res.text()).slice(0, 200)}`
          throw new Error(this.lastError)
        }
      } else {
        this.errors++
        this.lastError = `${res.status}: ${text.slice(0, 200)}`
        throw new Error(this.lastError)
      }
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
      promptFeedback?: { blockReason?: string }
    }

    this.calls++
    this.lastCallAt = Date.now()
    this.lastLatencyMs = Date.now() - started
    const tokensIn = json.usageMetadata?.promptTokenCount ?? 0
    const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0
    this.tokensIn += tokensIn
    this.tokensOut += tokensOut

    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    if (!text.trim()) {
      this.errors++
      this.lastError = `empty response (${json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason ?? 'unknown'})`
      throw new Error(this.lastError)
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text)
    } catch {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) {
        this.errors++
        this.lastError = 'model did not return JSON'
        throw new Error(this.lastError)
      }
      parsed = JSON.parse(match[0])
    }

    const numOr = (v: unknown, fallback: number | null) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }

    const decision = String(parsed.decision ?? 'WAIT').toUpperCase()
    const opinion: AiOpinion = {
      decision: decision === 'LONG' || decision === 'SHORT' ? decision : 'WAIT',
      confidence: Math.max(0, Math.min(100, numOr(parsed.confidence, 0) ?? 0)),
      leverage: Math.max(1, Math.min(50, numOr(parsed.leverage, a.plan?.leverage ?? 1) ?? 1)),
      entry: numOr(parsed.entry, a.plan?.entry ?? null),
      sl: numOr(parsed.stop_loss, a.plan?.stopLoss ?? null),
      tp: Array.isArray(parsed.take_profits)
        ? (parsed.take_profits as unknown[]).map((v) => Number(v)).filter((v) => Number.isFinite(v))
        : (a.plan?.takeProfits.map((t) => t.price) ?? []),
      reasoning: String(parsed.reasoning ?? '').slice(0, 1600),
      risks: Array.isArray(parsed.risks) ? (parsed.risks as unknown[]).map((r) => String(r).slice(0, 220)).slice(0, 5) : [],
      invalidation: String(parsed.invalidation ?? '').slice(0, 300),
      agreesWithQuant: Boolean(parsed.agrees_with_quant),
      model: cfg.model,
      cached: false,
      tokensIn,
      tokensOut,
      latencyMs: this.lastLatencyMs,
      at: Date.now(),
    }

    this.cache.set(key, { key, at: Date.now(), opinion })
    if (this.cache.size > 200) {
      const oldest = [...this.cache.values()].sort((x, y) => x.at - y.at)[0]
      if (oldest) this.cache.delete(oldest.key)
    }
    return opinion
  }

  stats() {
    return {
      configured: this.configured,
      calls: this.calls,
      cacheHits: this.cacheHits,
      errors: this.errors,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      lastError: this.lastError,
      lastCallAt: this.lastCallAt,
      lastLatencyMs: this.lastLatencyMs,
      cacheSize: this.cache.size,
    }
  }
}
