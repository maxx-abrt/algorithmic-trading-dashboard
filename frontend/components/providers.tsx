'use client'

import { ConvexProvider, ConvexReactClient } from 'convex/react'
import { useMemo, type ReactNode } from 'react'

/**
 * Convex holds configuration + history and pushes it to the UI reactively
 * (logs, alert history, journal, telemetry). Live market state comes from the
 * engine's REST API instead, which keeps database usage tiny.
 */
export function ConvexClientProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL
    if (!url) return null
    return new ConvexReactClient(url)
  }, [])

  if (!client) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-warning/30 bg-warning/10 p-5 text-sm">
          <p className="font-medium text-warning">NEXT_PUBLIC_CONVEX_URL is not set</p>
          <p className="mt-2 text-muted-foreground">
            Add it to <code className="num">frontend/.env.local</code> and restart the dashboard.
            <br />
            Run <code className="num">npx convex dev</code> once to create a deployment.
          </p>
        </div>
      </div>
    )
  }

  return <ConvexProvider client={client}>{children}</ConvexProvider>
}
