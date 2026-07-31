'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Activity, BellRing, Eye, LineChart, Radar, Settings2, NotebookPen } from 'lucide-react'

const LINKS = [
  { href: '/', label: 'Terminal', icon: LineChart },
  { href: '/scanner', label: 'Scanner', icon: Radar },
  { href: '/watchlist', label: 'Watchlist', icon: Eye },
  { href: '/alerts', label: 'Alerts', icon: BellRing },
  { href: '/journal', label: 'Journal', icon: NotebookPen },
  { href: '/settings', label: 'Settings', icon: Settings2 },
]

export function TopNav() {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-[52px] w-full max-w-[1920px] items-center gap-4 px-3 sm:px-4 lg:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-bull/15 text-bull">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight">MYCROFT</span>
          <span className="hidden text-[10px] uppercase tracking-widest text-muted-foreground sm:inline">
            okx decision engine
          </span>
        </Link>

        <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          {LINKS.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                data-testid={`nav-${label.toLowerCase()}`}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-card-2 text-foreground'
                    : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            )
          })}
        </nav>

        <span className="hidden shrink-0 rounded border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground md:inline">
          decisions only · no auto-trading
        </span>
      </div>
    </header>
  )
}
