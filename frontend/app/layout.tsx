import type { Metadata, Viewport } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { ConvexClientProvider } from '@/components/providers'
import { TopNav } from '@/components/shell/top-nav'
import { StatusBar } from '@/components/shell/status-bar'
import { Toaster } from 'sonner'
import './globals.css'

export const metadata: Metadata = {
  title: 'MYCROFT · OKX Research OS',
  description:
    'Real-data OKX research, paper simulation and leakage-aware validation. Advisory only; no order execution.',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0b0d',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-background text-foreground">
        <ConvexClientProvider>
          <div className="flex min-h-screen flex-col">
            <TopNav />
            <StatusBar />
            <main className="mx-auto w-full max-w-[1920px] flex-1 px-3 pb-24 pt-3 sm:px-4 md:pb-10 lg:px-6">{children}</main>
            <footer className="border-t border-border px-4 py-3">
              <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
               Real OKX market data · Paper research only · No order execution · Unvalidated edges are labeled
              </p>
            </footer>
          </div>
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: 'oklch(0.195 0.005 285)',
                border: '1px solid oklch(0.28 0.006 285)',
                color: 'oklch(0.96 0.002 285)',
              },
            }}
          />
        </ConvexClientProvider>
      </body>
    </html>
  )
}
