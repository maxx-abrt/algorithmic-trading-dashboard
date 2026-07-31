/**
 * Loaded as the very FIRST import of the worker so every other module sees a
 * fully populated process.env at evaluation time (ESM evaluates imports in
 * source order, so this must stay at the top of index.ts).
 *
 * Precedence matches Next.js: .env.local wins over .env.
 */
import dotenv from 'dotenv'

dotenv.config({
  path: ['.env.local', '.env.development.local', '.env'],
  quiet: true,
})

export const ENV_LOADED = true
