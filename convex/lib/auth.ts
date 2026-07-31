/**
 * Shared-secret guard.
 * Every write comes either from the worker or from the Next.js server (server
 * actions). Both hold WORKER_API_KEY; the browser never does.
 * Set it with:  npx convex env set WORKER_API_KEY <secret>
 */
export function assertKey(key: string) {
  const expected = process.env.WORKER_API_KEY
  if (!expected) {
    throw new Error(
      'WORKER_API_KEY is not configured on the Convex deployment. Run: npx convex env set WORKER_API_KEY <secret>',
    )
  }
  // Constant-time-ish comparison
  if (key.length !== expected.length) throw new Error('Unauthorized')
  let diff = 0
  for (let i = 0; i < key.length; i++) {
    diff |= key.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  if (diff !== 0) throw new Error('Unauthorized')
}
