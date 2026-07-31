import crypto from 'node:crypto'
import type { AiDecision, QuantEvaluation, Settings } from './types.js'

const GEMINI_BASE =
  process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'

const SYSTEM_PROMPT = `You are the risk-approval layer of an institutional crypto/equity-futures trading system.
The quant engine has ALREADY computed every indicator and a candidate trade plan. Your only job is to APPROVE, ADJUST or REJECT it.

Rules:
- Reply with ONE JSON object. No prose, no markdown fences.
- Schema: {"decision":"LONG"|"SHORT"|"WAIT","confidence":0-100,"leverage":number,"tp_price":number,"sl_price":number,"reasoning":string}
- "decision" MUST match proposed.side, or be "WAIT" to veto.
- Keep sl_price on the risk side of entry and preserve reward:risk >= proposed.rr. You may widen the stop slightly for volatility (atr_pct) but never tighten it below 0.15% of entry.
- leverage <= max_lev. Lower it when atr_pct is high.
- Veto (WAIT) when: bias conflicts with proposed.side, RSI already mean-reverted past the target, or atr_pct indicates the stop would be noise.
- reasoning: max 240 characters, cite the numbers you used.`

/* -------------------------------------------------------------------------- */
/*  Response cache — identical market context must not be paid for twice.      */
/* -------------------------------------------------------------------------- */

const decisionCache = new Map<string, { at: number; value: AiDecision }>()
const CACHE_TTL_MS = 60_000

function cacheKey(model: string, payload: unknown) {
  // Quantise the payload so micro price noise still hits the cache.
  return crypto
    .createHash('sha1')
    .update(model + JSON.stringify(payload))
    .digest('hex')
}

function quantise(compact: Record<string, unknown>) {
  const q = { ...compact }
  // Round volatile fields to a coarser grid for cache purposes only.
  if (typeof q.px === 'number') q.px = Number((q.px as number).toPrecision(5))
  if (typeof q.rsi === 'number') q.rsi = Math.round(q.rsi as number)
  if (typeof q.vwap_dev_pct === 'number')
    q.vwap_dev_pct = Math.round((q.vwap_dev_pct as number) * 4) / 4
  delete q.triggers
  return q
}

/* -------------------------------------------------------------------------- */
/*  Gemini call                                                                */
/* -------------------------------------------------------------------------- */

export interface AiResult {
  decision: AiDecision
  cached: boolean
  tokensIn: number
  tokensOut: number
  latencyMs: number
}

export class AiOrchestrator {
  calls = 0
  cacheHits = 0
  tokensIn = 0
  tokensOut = 0

  get configured() {
    return Boolean(process.env.GEMINI_API_KEY)
  }

  /**
   * Ask the LLM to validate the quant plan.
   * Returns null when no API key is configured (the caller then falls back to
   * the deterministic quant plan, so the bot still trades).
   */
  async decide(evaluation: QuantEvaluation, settings: Settings): Promise<AiResult | null> {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey || !evaluation.plan) return null

    const model = settings.aiModel || 'gemini-2.5-flash'
    const key = cacheKey(model, quantise(evaluation.compact))
    const hit = decisionCache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      this.cacheHits++
      return { decision: hit.value, cached: true, tokensIn: 0, tokensOut: 0, latencyMs: 0 }
    }

    const started = Date.now()
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(evaluation.compact) }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            decision: { type: 'STRING', enum: ['LONG', 'SHORT', 'WAIT'] },
            confidence: { type: 'NUMBER' },
            leverage: { type: 'NUMBER' },
            tp_price: { type: 'NUMBER' },
            sl_price: { type: 'NUMBER' },
            reasoning: { type: 'STRING' },
          },
          required: [
            'decision',
            'confidence',
            'leverage',
            'tp_price',
            'sl_price',
            'reasoning',
          ],
        },
        // Flash "thinking" burns tokens for no benefit on a schema'd verdict.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }

    const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20_000)
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (!res.ok) {
          const text = await res.text()
          if (res.status === 429 || res.status >= 500) throw new Error(`Gemini ${res.status}`)
          throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`)
        }

        const json = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
        }
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        const decision = this.parseAndClamp(text, evaluation, settings)

        const tokensIn = json.usageMetadata?.promptTokenCount ?? 0
        const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0
        this.calls++
        this.tokensIn += tokensIn
        this.tokensOut += tokensOut
        decisionCache.set(key, { at: Date.now(), value: decision })
        if (decisionCache.size > 200) {
          decisionCache.delete(decisionCache.keys().next().value as string)
        }

        return {
          decision,
          cached: false,
          tokensIn,
          tokensOut,
          latencyMs: Date.now() - started,
        }
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /**
   * Never trust the model with money: re-validate every field and repair
   * anything unsafe using the deterministic quant plan.
   */
  private parseAndClamp(
    raw: string,
    evaluation: QuantEvaluation,
    settings: Settings,
  ): AiDecision {
    const plan = evaluation.plan!
    let parsed: Partial<AiDecision> = {}
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim())
    } catch {
      const m = raw.match(/\{[\s\S]*\}/)
      if (m) {
        try {
          parsed = JSON.parse(m[0])
        } catch {
          /* fall through */
        }
      }
    }

    const decision =
      parsed.decision === 'LONG' || parsed.decision === 'SHORT'
        ? parsed.decision
        : 'WAIT'

    // A direction that contradicts the quant setup is a veto, not a trade.
    if (decision !== 'WAIT' && decision !== plan.side) {
      return {
        decision: 'WAIT',
        confidence: 0,
        leverage: settings.leverage,
        tp_price: plan.takeProfit,
        sl_price: plan.stopLoss,
        reasoning: `Model direction (${decision}) contradicted quant setup (${plan.side}) — vetoed.`,
      }
    }

    const confidence = clamp(Number(parsed.confidence ?? 0), 0, 100)
    const leverage = Math.round(clamp(Number(parsed.leverage ?? settings.leverage), 1, settings.leverage))

    // Stop must stay on the losing side and no tighter than the quant minimum.
    let sl = Number(parsed.sl_price)
    if (!Number.isFinite(sl)) sl = plan.stopLoss
    if (plan.side === 'LONG') sl = Math.min(sl, plan.entry - plan.entry * 0.0015)
    else sl = Math.max(sl, plan.entry + plan.entry * 0.0015)

    // Take profit must preserve the minimum R:R against the (possibly moved) SL.
    const risk = Math.abs(plan.entry - sl)
    let tp = Number(parsed.tp_price)
    const minTp =
      plan.side === 'LONG' ? plan.entry + plan.rr * risk : plan.entry - plan.rr * risk
    if (!Number.isFinite(tp)) tp = minTp
    if (plan.side === 'LONG') tp = Math.max(tp, minTp)
    else tp = Math.min(tp, minTp)

    return {
      decision,
      confidence,
      leverage,
      tp_price: tp,
      sl_price: sl,
      reasoning: String(parsed.reasoning ?? '').slice(0, 400) || 'No reasoning returned.',
    }
  }
}

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}
