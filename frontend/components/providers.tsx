'use client'

import type { ReactNode } from 'react'

/**
 * SQLite in the engine is the local system of record. Convex is now an optional
 * outbox mirror, so the dashboard must remain fully usable without a cloud account.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return children
}
