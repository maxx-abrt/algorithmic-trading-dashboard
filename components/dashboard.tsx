'use client'

import { useQuery } from 'convex/react'
import { ControlPanel } from '@/components/control-panel'
import { LogTerminal } from '@/components/log-terminal'
import { MarketPanel } from '@/components/market-panel'
import { PositionsPanel } from '@/components/positions-panel'
import { StatusBar } from '@/components/status-bar'
import { api } from '@/convex/_generated/api'

export function Dashboard({ envOk }: { envOk: { gemini: boolean; okx: boolean } }) {
  const settings = useQuery(api.settings.get)
  const instId = settings?.instId ?? 'BTC-USDT-SWAP'
  const timeframe = settings?.timeframe ?? '15m'

  const market = useQuery(api.telemetry.marketState, { instId, timeframe })
  const markPrice = market?.price ?? 0

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <StatusBar envOk={envOk} />

      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
        <MarketPanel instId={instId} timeframe={timeframe} />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
          <div className="flex min-w-0 flex-col gap-4">
            <PositionsPanel />
            <LogTerminal />
          </div>
          <ControlPanel markPrice={markPrice} />
        </div>
      </main>

      <footer className="mt-auto border-t border-border px-4 py-3">
        <p className="text-center font-mono text-[10px] leading-relaxed text-muted-foreground">
          APEX-01 · not financial advice · leveraged derivatives can liquidate your entire balance
        </p>
      </footer>
    </div>
  )
}
