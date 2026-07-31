/**
 * Single writer policy: the engine is the only process allowed to mutate state,
 * and it proves it with the shared secret. Set it once with:
 *   npx convex env set WORKER_API_KEY <value>
 */
export function assertWorker(key: string) {
  const expected = process.env.WORKER_API_KEY
  if (!expected) {
    throw new Error('WORKER_API_KEY is not configured in this Convex deployment.')
  }
  if (key !== expected) {
    throw new Error('Unauthorized: bad worker key.')
  }
}
