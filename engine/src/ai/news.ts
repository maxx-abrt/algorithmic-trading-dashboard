/**
 * News & macro-event edge — the cheapest useful use of an LLM in this system.
 *
 * The quant stack cannot read "US CPI in 40 minutes" out of a candle. That is the
 * one thing a language model is genuinely better at, so it is the only thing it is
 * asked to do here:
 *
 *   1. pull public RSS headlines (no API key, no quota, no cost)
 *   2. hash the headline set; if that exact set was already classified, reuse the
 *      stored answer and spend nothing
 *   3. otherwise send ONE batched request to the cheapest capable Gemini model and
 *      demand strict JSON
 *   4. store the result, expose it as three real features (news risk, direction,
 *      event proximity) and as a hard risk veto around imminent high-impact events
 *
 * Cost control is structural, not hopeful: one call per interval at most, a content
 * hash cache, a hard monthly budget check before every call, and a model choice
 * (flash-lite) whose per-call cost is measured in hundredths of a cent.
 */
import { createHash } from 'node:crypto'
import { log } from '../log.js'
import type { PopulationStore } from '../store/population-store.js'

const FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml',
  'https://cointelegraph.com/rss',
  'https://cryptoslate.com/feed/',
  'https://www.theblock.co/rss.xml',
  'https://decrypt.co/feed',
]

export interface NewsHeadline {
  title: string
  source: string
  at: number
}

export interface NewsSignal {
  at: number
  riskScore: number
  direction: number
  eventProximity: number
  summary: string
  headlines: { title: string; assets: string[]; impact: 'low' | 'medium' | 'high'; direction: number }[]
  model: string
  cached: boolean
  costEur: number
}

const stripTags = (value: string) =>
  value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

/** Minimal, dependency-free RSS title extraction. Robust enough for these feeds. */
export function parseRssTitles(xml: string, source: string, limit = 12): NewsHeadline[] {
  const out: NewsHeadline[] = []
  const items = xml.split(/<item[\s>]/i).slice(1)
  for (const item of items.slice(0, limit)) {
    const titleMatch = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!titleMatch) continue
    const title = stripTags(titleMatch[1])
    if (title.length < 12) continue
    const dateMatch = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)
    const parsed = dateMatch ? Date.parse(stripTags(dateMatch[1])) : Number.NaN
    out.push({ title, source, at: Number.isFinite(parsed) ? parsed : Date.now() })
  }
  return out
}

export async function fetchHeadlines(maxPerFeed = 8): Promise<NewsHeadline[]> {
  const results = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const response = await fetch(feed, { signal: AbortSignal.timeout(9_000), headers: { 'User-Agent': 'mycroft/2 (+research)' } })
        if (!response.ok) return []
        return parseRssTitles(await response.text(), new URL(feed).hostname.replace('www.', ''), maxPerFeed)
      } catch {
        return []
      }
    }),
  )
  const seen = new Set<string>()
  return results
    .flat()
    .filter((headline) => {
      const key = headline.title.toLowerCase().slice(0, 80)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, 34)
}

const SYSTEM_PROMPT = [
  'You are a crypto trading risk classifier. Reply with STRICT JSON only, no prose, no markdown.',
  'Schema:',
  '{"riskScore":number 0..1,"direction":number -1..1,"eventProximity":number 0..1,',
  ' "headlines":[{"title":string,"assets":[string],"impact":"low"|"medium"|"high","direction":-1|0|1}],',
  ' "summary":string}',
  'Definitions:',
  '- riskScore: 0 = calm, safe to take normal risk. 1 = do not open new positions now.',
  '- direction: aggregate directional tilt implied by the flow for the crypto majors.',
  '- eventProximity: 1 when a scheduled high-impact macro or crypto event is imminent (< ~2h), else lower.',
  '- assets: uppercase tickers only (BTC, ETH, SOL...), empty array when generic.',
  'Be conservative: unclear or low-signal headlines get impact "low" and direction 0.',
].join('\n')

export interface NewsOptions {
  apiKey: string
  model?: string
  /** hard monthly budget in EUR; the call is skipped when the spend would exceed it */
  budgetEur: number
  spentEur: number
}

/**
 * Classify the current headline flow. Returns the cached digest when the exact same
 * headline set was already classified, so a restart or a fast interval costs zero.
 */
export async function buildNewsSignal(store: PopulationStore, options: NewsOptions): Promise<NewsSignal | null> {
  const headlines = await fetchHeadlines()
  if (headlines.length < 4) return null
  const contentHash = createHash('sha1').update(headlines.map((headline) => headline.title).join('|')).digest('hex')

  const cached = store.digestByHash(contentHash)
  if (cached) {
    return {
      at: cached.at,
      riskScore: cached.riskScore,
      direction: cached.direction,
      eventProximity: cached.eventProximity,
      summary: cached.summary,
      headlines: (cached.payload.headlines as NewsSignal['headlines']) ?? [],
      model: cached.model,
      cached: true,
      costEur: 0,
    }
  }

  if (!options.apiKey) return null
  if (options.spentEur >= options.budgetEur) {
    log.info('news', `skipped: monthly AI budget reached (€${options.spentEur.toFixed(3)} of €${options.budgetEur})`)
    return null
  }

  const model = options.model || process.env.GEMINI_CHEAP_MODEL || 'gemini-3.1-flash-lite'
  const prompt = `${SYSTEM_PROMPT}\n\nUTC now: ${new Date().toISOString()}\nHeadlines:\n${headlines.map((headline) => `- [${headline.source}] ${headline.title}`).join('\n')}`

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1400 },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`gemini HTTP ${response.status}`)
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
    const parsed = JSON.parse(text) as Partial<NewsSignal> & { headlines?: NewsSignal['headlines'] }
    const tokensIn = json.usageMetadata?.promptTokenCount ?? 0
    const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0
    // flash-lite pricing, kept deliberately pessimistic
    const costEur = (tokensIn * 0.1 + tokensOut * 0.4) / 1_000_000

    const signal: NewsSignal = {
      at: Date.now(),
      riskScore: clamp01(Number(parsed.riskScore ?? 0)),
      direction: clamp(Number(parsed.direction ?? 0), -1, 1),
      eventProximity: clamp01(Number(parsed.eventProximity ?? 0)),
      summary: String(parsed.summary ?? '').slice(0, 700),
      headlines: (parsed.headlines ?? []).slice(0, 20),
      model,
      cached: false,
      costEur,
    }
    store.saveDigest({
      contentHash,
      model,
      riskScore: signal.riskScore,
      direction: signal.direction,
      eventProximity: signal.eventProximity,
      summary: signal.summary,
      payload: { headlines: signal.headlines, sources: [...new Set(headlines.map((headline) => headline.source))] },
      tokensIn,
      tokensOut,
      costEur,
    })
    log.info('news', `digest: risk ${signal.riskScore.toFixed(2)} · direction ${signal.direction.toFixed(2)} · event ${signal.eventProximity.toFixed(2)} · ${signal.headlines.length} classified · €${costEur.toFixed(6)}`)
    return signal
  } catch (error) {
    log.error('news', error instanceof Error ? error.message : String(error))
    return null
  }
}

/**
 * Nightly post-mortem: the one place a bigger model earns its cost, because it is
 * reading structured evidence and writing something a human will act on.
 */
export async function buildPostMortem(input: {
  apiKey: string
  model?: string
  budgetEur: number
  spentEur: number
  payload: Record<string, unknown>
}): Promise<{ text: string; model: string; costEur: number } | null> {
  if (!input.apiKey || input.spentEur >= input.budgetEur) return null
  const model = input.model || 'gemini-2.5-flash'
  const prompt = [
    'You are the head of research for an automated crypto trading system.',
    'Below is a JSON snapshot of the last 24 hours: closed trades, failure attribution, arena results, specialist promotions, coverage gaps.',
    'Write a tight report (max 260 words, plain text, no markdown headers) with exactly these sections on their own lines:',
    'WHAT WORKED: ',
    'WHAT FAILED: ',
    'ROOT CAUSE: ',
    'NEXT EXPERIMENT: ',
    'Be specific and quantitative. Never invent numbers that are not in the JSON. If evidence is insufficient, say so.',
    '',
    JSON.stringify(input.payload).slice(0, 24_000),
  ].join('\n')
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 900 } }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new Error(`gemini HTTP ${response.status}`)
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
    const tokensIn = json.usageMetadata?.promptTokenCount ?? 0
    const tokensOut = json.usageMetadata?.candidatesTokenCount ?? 0
    const costEur = (tokensIn * 0.3 + tokensOut * 2.5) / 1_000_000
    return text.trim() ? { text: text.trim(), model, costEur } : null
  } catch (error) {
    log.error('postmortem', error instanceof Error ? error.message : String(error))
    return null
  }
}

const clamp = (value: number, low: number, high: number) => (Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : 0)
const clamp01 = (value: number) => clamp(value, 0, 1)
