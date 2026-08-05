'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { Button, Dialog } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { Activity, BellRing, BookOpenCheck, BriefcaseBusiness, Eye, FlaskConical, LineChart, Menu, Radar, ServerCog, Settings2 } from 'lucide-react'

const LINKS = [
  { href: '/', label: 'Terminal', icon: LineChart, group: 'primary' },
  { href: '/scanner', label: 'Scanner', icon: Radar, group: 'primary' },
  { href: '/portfolio', label: 'Portfolio', icon: BriefcaseBusiness, group: 'primary' },
  { href: '/journal', label: 'Journal', icon: BookOpenCheck, group: 'primary' },
  { href: '/research', label: 'Research', icon: FlaskConical, group: 'primary' },
  { href: '/watchlist', label: 'Watchlist', icon: Eye, group: 'secondary' },
  { href: '/alerts', label: 'Alerts', icon: BellRing, group: 'secondary' },
  { href: '/operations', label: 'Operations', icon: ServerCog, group: 'secondary' },
  { href: '/settings', label: 'Settings', icon: Settings2, group: 'secondary' },
]

export function TopNav() {
  const pathname = usePathname()
  const [moreOpen, setMoreOpen] = useState(false)
  const active = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href)
  return <>
    <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-[52px] w-full max-w-[1920px] items-center gap-4 px-3 sm:px-4 lg:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" data-testid="nav-brand-link">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-info/30 bg-info/10 text-info"><Activity className="h-3.5 w-3.5" /></span>
          <span className="text-sm font-semibold tracking-tight">MYCROFT</span>
          <span className="hidden text-[10px] uppercase tracking-[0.16em] text-muted-foreground lg:inline">research operating system</span>
        </Link>
        <nav className="hidden flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] md:flex" data-testid="app-navigation">
          {LINKS.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`nav-${label.toLowerCase()}-link`} className={cn('relative flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors', active(href) ? 'bg-card-2 text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground')}><Icon className="h-3.5 w-3.5" />{label}{active(href) && <span className="absolute inset-x-2 -bottom-[11px] h-0.5 rounded bg-info" />}</Link>)}
        </nav>
        <span className="ml-auto hidden shrink-0 rounded-md border border-border px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground sm:inline">paper only</span>
        <Button variant="ghost" size="icon" className="ml-auto md:hidden" onClick={() => setMoreOpen(true)} aria-label="Open more navigation" data-testid="mobile-nav-more"><Menu className="h-4 w-4" /></Button>
      </div>
    </header>

    <nav className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t border-border bg-background/95 px-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur md:hidden" data-testid="mobile-bottom-nav">
      {LINKS.filter((link) => link.group === 'primary').map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`mobile-nav-${label.toLowerCase()}`} className={cn('flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] transition-colors', active(href) ? 'bg-info/10 text-info' : 'text-muted-foreground')}><Icon className="h-4 w-4" />{label}</Link>)}
    </nav>
    <Dialog open={moreOpen} onClose={() => setMoreOpen(false)} title="More destinations">
      <div className="grid grid-cols-2 gap-2">{LINKS.filter((link) => link.group === 'secondary').map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMoreOpen(false)} className="flex items-center gap-2 rounded-lg border border-border bg-card-2/40 p-3 text-xs" data-testid={`mobile-more-${label.toLowerCase()}`}><Icon className="h-4 w-4 text-info" />{label}</Link>)}</div>
    </Dialog>
  </>
}
