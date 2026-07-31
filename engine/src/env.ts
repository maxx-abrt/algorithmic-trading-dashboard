/**
 * Environment loading. Must be imported first by every entry point.
 * Looks for engine/.env then the repo root .env / .env.local so the same
 * secrets can be shared with the dashboard.
 */
import { config as loadEnv } from 'dotenv'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const engineRoot = resolve(here, '..')
const repoRoot = resolve(engineRoot, '..')

for (const file of [
  resolve(engineRoot, '.env'),
  resolve(repoRoot, '.env'),
  resolve(repoRoot, '.env.local'),
  resolve(repoRoot, 'frontend/.env.local'),
]) {
  if (existsSync(file)) loadEnv({ path: file, override: false, quiet: true })
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const ENV = {
  port: num(process.env.PORT, 8790),
  convexUrl: process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || '',
  workerKey: process.env.WORKER_API_KEY || '',
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  okx: {
    key: process.env.OKX_API_KEY || '',
    secret: process.env.OKX_API_SECRET || '',
    passphrase: process.env.OKX_API_PASSPHRASE || '',
    simulated: process.env.OKX_SIMULATED === 'true' || process.env.OKX_SIMULATED === '1',
  },
  defaultEquityUsd: num(process.env.DEFAULT_EQUITY_USD, 10_000),
}

export const HAS_OKX_KEYS = Boolean(ENV.okx.key && ENV.okx.secret && ENV.okx.passphrase)
export const HAS_CONVEX = Boolean(ENV.convexUrl && ENV.workerKey)
