'use client'

import { useState } from 'react'
import type { Analysis } from '@/lib/types'
import { Badge, Panel, Row, SignedBar, Tab, TabList, TabPanel, Tabs } from '@/components/ui/kit'
import { cn } from '@/lib/utils'
import { fmtNum, fmtPct, fmtPrice, fmtR, fmtUsd, titleCase } from '@/lib/format'

const GROUP_LABEL: Record<string, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  volume: 'Volume & flow',
  structure: 'Structure',
  pattern: 'Candlesticks',
  derivatives: 'Derivatives',
  mtf: 'Multi-timeframe',
  stats: 'Statistics',
  edge: 'Empirical edge',
}

export function EvidenceRail({ analysis }: { analysis: Analysis | null }) {
  const [tab, setTab] = useState('factors')
  if (!analysis) {
    return (
      <Panel title="Evidence">
        <div className="skeleton h-64 rounded" />
      </Panel>
    )
  }
  const a = analysis
  const i = a.indicators
  const num = (v: unknown, dp = 2) => (typeof v === 'number' ? fmtNum(v, dp) : '—')

  const grouped = Object.entries(
    a.factors.reduce<Record<string, typeof a.factors>>((acc, f) => {
      ;(acc[f.group] ??= []).push(f)
      return acc
    }, {}),
  ).sort(
    (x, y) =>
      y[1].reduce((s, f) => s + Math.abs(f.score * f.weight), 0) -
      x[1].reduce((s, f) => s + Math.abs(f.score * f.weight), 0),
  )

  return (
    <Panel title="Evidence" subtitle={`${a.factors.length} factors · ${a.vetoes.length} blockers`} bodyClassName="p-0">
      {a.vetoes.length > 0 && (
        <div data-testid="evidence-veto-list" className="space-y-1 border-b border-border p-2.5">
          {a.vetoes.map((v, idx) => (
            <div
              key={`${v.id}-${idx}`}
              className={cn(
                'flex items-start gap-2 rounded border px-2 py-1.5',
                v.severity === 'hard' ? 'border-veto/40 bg-veto/10' : 'border-warning/30 bg-warning/8',
              )}
            >
              <Badge tone={v.severity === 'hard' ? 'veto' : 'warning'}>{v.severity}</Badge>
              <span className="text-[11px] leading-snug">{v.reason}</span>
            </div>
          ))}
        </div>
      )}

      <Tabs value={tab} onChange={setTab}>
        <TabList>
          <Tab id="factors" count={a.factors.length}>
            Factors
          </Tab>
          <Tab id="mtf" count={a.mtf.length}>
            MTF
          </Tab>
          <Tab id="patterns" count={i.patterns.length}>
            Candles
          </Tab>
          <Tab id="vol">Volatility</Tab>
          <Tab id="flow">Flow</Tab>
          <Tab id="struct">Structure</Tab>
          <Tab id="stats">Stats</Tab>
          <Tab id="edge">Edge</Tab>
          <Tab id="ai">AI</Tab>
        </TabList>

        <div className="max-h-[560px] overflow-y-auto p-2.5">
          <TabPanel id="factors">
            <div data-testid="evidence-factor-breakdown" className="space-y-3">
              {grouped.map(([group, factors]) => (
                <div key={group}>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {GROUP_LABEL[group] ?? group}
                  </p>
                  <div className="space-y-1.5">
                    {factors
                      .slice()
                      .sort((x, y) => Math.abs(y.score * y.weight) - Math.abs(x.score * x.weight))
                      .map((f) => (
                        <div key={f.id} className="rounded border border-border/60 bg-card-2/40 px-2 py-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[11px]">{f.label}</span>
                            <span
                              className={cn(
                                'num shrink-0 text-[11px] font-medium',
                                f.score > 0 ? 'text-bull' : f.score < 0 ? 'text-bear' : 'text-muted-foreground',
                              )}
                            >
                              {f.score > 0 ? '+' : ''}
                              {f.score.toFixed(0)}
                              <span className="ml-1 text-[10px] text-muted-foreground">×{f.weight.toFixed(2)}</span>
                            </span>
                          </div>
                          <SignedBar value={f.score} className="my-1" />
                          <p className="text-[10px] leading-snug text-muted-foreground">{f.detail}</p>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </TabPanel>

          <TabPanel id="mtf">
            <div className="space-y-2">
              <Row label="alignment" value={`${a.mtfAlignment.toFixed(0)}%`} />
              {a.mtf.map((t) => (
                <div key={t.timeframe} className="rounded border border-border/60 bg-card-2/40 p-2">
                  <div className="flex items-center justify-between">
                    <span className="num text-xs font-medium">{t.timeframe}</span>
                    <Badge tone={t.bias === 'BULLISH' ? 'bull' : t.bias === 'BEARISH' ? 'bear' : 'neutral'}>
                      {t.bias}
                    </Badge>
                  </div>
                  <SignedBar value={t.trendScore} className="my-1.5" />
                  <div className="grid grid-cols-2 gap-x-4">
                    <Row label="trend score" value={`${t.trendScore > 0 ? '+' : ''}${t.trendScore.toFixed(0)}`} />
                    <Row label="regime" value={titleCase(t.regime)} mono={false} />
                    <Row label="ADX" value={t.adx.toFixed(1)} />
                    <Row label="RSI" value={t.rsi.toFixed(1)} />
                    <Row label="ATR" value={`${t.atrPct.toFixed(2)}%`} />
                    <Row label="structure" value={`${t.structure}${t.bos ? ` · ${t.bos} BOS` : ''}`} mono={false} />
                    <Row label="EMA50" value={fmtPrice(t.ema50)} />
                    <Row label="EMA200" value={fmtPrice(t.ema200)} />
                  </div>
                </div>
              ))}
            </div>
          </TabPanel>

          <TabPanel id="patterns">
            {i.patterns.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No candlestick formation in the last 12 bars.
              </p>
            )}
            <div className="space-y-1.5">
              {i.patterns.map((p) => (
                <div key={p.name} className="rounded border border-border/60 bg-card-2/40 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-medium">{p.label}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone={p.side === 'LONG' ? 'bull' : 'bear'}>{p.side}</Badge>
                      <span className="num text-[11px]">{(p.confirmed * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className={cn('h-full', p.side === 'LONG' ? 'bg-bull' : 'bg-bear')}
                        style={{ width: `${Math.min(100, p.confirmed * 100)}%` }}
                      />
                    </div>
                    <span className="num text-[10px] text-muted-foreground">
                      raw {(p.reliability * 100).toFixed(0)}% · {p.barsAgo}b ago
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-snug text-muted-foreground">{p.notes.join(' · ')}</p>
                </div>
              ))}
            </div>
            {i.divergences.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  divergences
                </p>
                {i.divergences.map((d, idx) => (
                  <Row
                    key={idx}
                    label={`${d.source.toUpperCase()} ${d.kind}`}
                    value={`${d.side} · strength ${d.strength.toFixed(0)} · ${d.barsAgo}b`}
                    tone={d.side === 'LONG' ? 'bull' : 'bear'}
                  />
                ))}
              </div>
            )}
          </TabPanel>

          <TabPanel id="vol">
            <div className="grid gap-x-5 sm:grid-cols-2">
              <Row label="regime" value={titleCase(String(i.volatility.regime))} mono={false} />
              <Row label="ATR" value={`${num(i.volatility.atr, 4)}`} hint={`${num(i.volatility.atrPct)}%`} />
              <Row label="ATR percentile" value={`${num(i.volatility.atrPercentile, 0)}th`} />
              <Row label="realised vol (ann.)" value={`${num(i.volatility.realizedVolPct, 0)}%`} />
              <Row label="Parkinson (ann.)" value={`${num(i.xvol.parkinsonVolPct, 0)}%`} />
              <Row label="Garman-Klass (ann.)" value={`${num(i.xvol.garmanKlassVolPct, 0)}%`} />
              <Row label="EWMA λ=0.94 (ann.)" value={`${num(i.xvol.ewmaVolPct, 0)}%`} />
              <Row label="1-bar σ forecast" value={`${num(i.xvol.forecastBarSigmaPct)}%`} />
              <Row
                label={`expected move (${num(i.xvol.horizonBars, 0)} bars)`}
                value={`±${num(i.xvol.expectedMovePct)}%`}
              />
              <Row label="vol of vol" value={num(i.xvol.volOfVol, 3)} />
              <Row label="ATR expansion" value={`${num(i.xvol.atrExpansion)}×`} />
              <Row label="vol trend" value={String(i.xvol.volTrend)} mono={false} />
              <Row label="climax bar" value={i.xvol.climax ? 'yes' : 'no'} tone={i.xvol.climax ? 'warning' : undefined} />
              <Row label="hour-of-day vol rank" value={`${num(i.xvol.hourVolRank, 0)}th`} />
              <Row label="choppiness" value={num(i.volatility.choppiness, 0)} />
              <Row label="efficiency ratio" value={num(i.volatility.efficiencyRatio)} />
              <Row label="BB width" value={`${num(i.volatility.bbWidthPct)}%`} hint={`${num(i.volatility.bbWidthPercentile, 0)}th`} />
              <Row label="%B" value={num(i.volatility.percentB)} />
              <Row label="squeeze" value={i.volatility.squeeze ? 'ON' : 'off'} tone={i.volatility.squeeze ? 'warning' : undefined} />
              <Row label="Keltner" value={`${num(i.volatility.keltnerLower)} / ${num(i.volatility.keltnerUpper)}`} />
            </div>
          </TabPanel>

          <TabPanel id="flow">
            <div className="grid gap-x-5 sm:grid-cols-2">
              <Row label="volume vs 20-bar avg" value={`${num(i.volume.volumeRatio)}×`} />
              <Row label="OBV slope" value={`${num(i.volume.obvSlope)}%`} tone={Number(i.volume.obvSlope) > 0 ? 'bull' : 'bear'} />
              <Row label="CVD slope" value={`${num(i.volume.cvdSlope)}%`} tone={Number(i.volume.cvdSlope) > 0 ? 'bull' : 'bear'} />
              <Row label="MFI" value={num(i.volume.mfi, 0)} />
              <Row label="force index" value={num(i.volume.forceIndex, 0)} />
              <Row label="VWAP" value={fmtPrice(Number(i.volume.vwap))} />
              <Row label="VWAP deviation" value={`${num(i.volume.vwapDeviationPct)}%`} hint={`z ${num(i.volume.vwapZ)}`} />
              <Row label="VWAP bands ±1σ" value={`${num(i.volume.vwapLower1)} / ${num(i.volume.vwapUpper1)}`} />
              <Row label="Donchian position" value={`${(Number(i.xtrend.donchianPos) * 100).toFixed(0)}%`} />
              <Row label="VWMA spread" value={`${num(i.xtrend.vwmaSpreadPct)}%`} />
              <Row label="Ultimate oscillator" value={num(i.xtrend.ultimateOsc, 0)} />
              <Row label="Vortex +/-" value={`${num(i.xtrend.vortexPlus)} / ${num(i.xtrend.vortexMinus)}`} />
              <Row label="Elder bull / bear" value={`${num(i.xtrend.elderBull)} / ${num(i.xtrend.elderBear)}`} />
              <Row label="Heikin-Ashi" value={`${String(i.xtrend.heikinTrend)} ×${num(i.xtrend.heikinRun, 0)}`} mono={false} />
              <Row label="KST" value={`${num(i.xtrend.kst)} / ${num(i.xtrend.kstSignal)}`} />
            </div>
            {a.derivatives && (
              <div className="mt-3 border-t border-border pt-2">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  derivatives
                </p>
                <div className="grid gap-x-5 sm:grid-cols-2">
                  <Row
                    label="funding"
                    value={a.derivatives.fundingRate != null ? `${(a.derivatives.fundingRate * 100).toFixed(4)}%` : '—'}
                    hint={a.derivatives.fundingApr != null ? `${a.derivatives.fundingApr.toFixed(1)}% APR` : ''}
                    tone={(a.derivatives.fundingApr ?? 0) > 30 ? 'warning' : undefined}
                  />
                  <Row
                    label="next funding"
                    value={
                      a.derivatives.nextFundingTime
                        ? `${Math.max(0, Math.round((a.derivatives.nextFundingTime - Date.now()) / 60000))}m`
                        : '—'
                    }
                  />
                  <Row label="open interest" value={fmtUsd(a.derivatives.openInterestUsd)} />
                  <Row
                    label="OI change (4h)"
                    value={fmtPct(a.derivatives.openInterestChangePct, 2)}
                    tone={(a.derivatives.openInterestChangePct ?? 0) > 0 ? 'bull' : 'bear'}
                  />
                  <Row label="long/short accounts" value={num(a.derivatives.longShortRatio)} />
                  <Row label="taker buy/sell" value={num(a.derivatives.takerRatio)} />
                  <Row
                    label="book imbalance"
                    value={a.derivatives.bookImbalance != null ? `${(a.derivatives.bookImbalance * 100).toFixed(1)}%` : '—'}
                    tone={(a.derivatives.bookImbalance ?? 0) > 0 ? 'bull' : 'bear'}
                  />
                  <Row label="spread" value={a.derivatives.spreadBps != null ? `${a.derivatives.spreadBps.toFixed(2)}bps` : '—'} />
                  <Row label="mark / index" value={`${fmtPrice(a.derivatives.markPrice)} / ${fmtPrice(a.derivatives.indexPrice)}`} />
                  <Row label="basis" value={a.derivatives.basisBps != null ? `${a.derivatives.basisBps.toFixed(1)}bps` : '—'} />
                  <Row label="positioning score" value={num(a.derivatives.score, 0)} />
                </div>
              </div>
            )}
          </TabPanel>

          <TabPanel id="struct">
            <div className="grid gap-x-5 sm:grid-cols-2">
              <Row label="structure" value={i.structure.structure} mono={false} />
              <Row label="BOS / CHoCH" value={`${i.structure.bos ?? '—'} / ${i.structure.choch ?? '—'}`} mono={false} />
              <Row label="range" value={`${fmtPrice(i.structure.rangeLow)} – ${fmtPrice(i.structure.rangeHigh)}`} />
              <Row label="position in range" value={`${(i.structure.rangePosition * 100).toFixed(0)}%`} />
              <Row label="swing high / low" value={`${fmtPrice(i.structure.swingHigh)} / ${fmtPrice(i.structure.swingLow)}`} />
              <Row label="POC" value={fmtPrice(i.profile.poc)} />
              <Row label="value area" value={`${fmtPrice(i.profile.val)} – ${fmtPrice(i.profile.vah)}`} hint={i.profile.insideValue ? 'inside' : 'outside'} />
              <Row label="HVN / LVN" value={`${i.profile.hvn.length} / ${i.profile.lvn.length}`} />
            </div>
            <p className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              confluence levels
            </p>
            <div className="space-y-0.5">
              {i.structure.levels.slice(0, 10).map((l, idx) => (
                <div key={idx} className="flex items-center gap-2 text-[11px]">
                  <Badge tone={l.kind === 'support' ? 'bull' : 'bear'}>{l.kind === 'support' ? 'S' : 'R'}</Badge>
                  <span className="num w-[92px]">{fmtPrice(l.price)}</span>
                  <span className="num w-[62px] text-muted-foreground">{fmtPct(l.distancePct, 2)}</span>
                  <span className="text-muted-foreground">{l.source}</span>
                  <div className="ml-auto h-1 w-16 overflow-hidden rounded bg-muted">
                    <div className="h-full bg-foreground/50" style={{ width: `${l.strength}%` }} />
                  </div>
                </div>
              ))}
            </div>
            {i.structure.fvg.length > 0 && (
              <>
                <p className="mb-1 mt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  unmitigated imbalances
                </p>
                {i.structure.fvg.map((g, idx) => (
                  <Row
                    key={idx}
                    label={`${g.side} FVG`}
                    value={`${fmtPrice(g.bottom)} – ${fmtPrice(g.top)}`}
                    tone={g.side === 'LONG' ? 'bull' : 'bear'}
                  />
                ))}
              </>
            )}
          </TabPanel>

          <TabPanel id="stats">
            <div className="grid gap-x-5 sm:grid-cols-2">
              <Row
                label="Hurst exponent"
                value={num(i.stats.hurst)}
                hint={Number(i.stats.hurst) > 0.55 ? 'persistent' : Number(i.stats.hurst) < 0.45 ? 'reverting' : 'random'}
              />
              <Row label="mean-reversion score" value={num(i.stats.meanReversion, 0)} />
              <Row label="trend persistence" value={num(i.stats.trendPersistence, 0)} />
              <Row label="regression slope" value={`${num(i.stats.regSlopePct, 3)}%/bar`} />
              <Row label="regression R²" value={num(i.stats.regR2)} />
              <Row label="slope t-stat" value={num(i.stats.regTstat, 1)} hint={Math.abs(Number(i.stats.regTstat)) > 2 ? 'significant' : 'noise'} />
              <Row label="channel" value={`${fmtPrice(Number(i.stats.regLower))} – ${fmtPrice(Number(i.stats.regUpper))}`} />
              <Row label="channel position" value={`${(Number(i.stats.regPos) * 100).toFixed(0)}%`} />
              <Row label="z-score (20)" value={num(i.stats.zScore20)} />
              <Row label="lag-1 autocorrelation" value={num(i.stats.autocorr1)} />
              <Row label="return skew" value={num(i.stats.skew)} />
              <Row label="return kurtosis" value={num(i.stats.kurtosis)} />
            </div>
          </TabPanel>

          <TabPanel id="edge">
            {a.edge && a.edge.sample > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] leading-relaxed text-muted-foreground">{a.edge.note}</p>
                <div className="grid gap-x-5 sm:grid-cols-2">
                  <Row label="analogues found" value={a.edge.sample.toString()} />
                  <Row label="raw hit rate" value={`${a.edge.winRate.toFixed(0)}%`} tone={a.edge.winRate > 45 ? 'bull' : 'bear'} />
                  <Row label="shrunk hit rate" value={`${a.edge.adjustedWinRate.toFixed(0)}%`} />
                  <Row label="average outcome" value={fmtR(a.edge.avgR)} tone={a.edge.avgR > 0 ? 'bull' : 'bear'} />
                  <Row label="expectancy" value={fmtR(a.edge.expectancyR)} />
                  <Row label="avg MFE / MAE" value={`${a.edge.avgMfeR.toFixed(2)}R / ${a.edge.avgMaeR.toFixed(2)}R`} />
                  <Row label="horizon" value={`${a.edge.horizonBars} bars`} />
                  <Row label="sample confidence" value={`${(a.edge.confidence * 100).toFixed(0)}%`} />
                </div>
                <p className="rounded border border-border bg-card-2/40 p-2 text-[10px] leading-relaxed text-muted-foreground">
                  The engine fingerprints the current context (trend state, RSI bucket, volatility bucket, volume
                  bucket, position in range) then replays every historical bar with the same fingerprint using this
                  exact stop and target. It is a reality check on the indicators, not a promise.
                </p>
              </div>
            ) : (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {a.edge?.note ?? 'Empirical edge layer disabled in settings.'}
              </p>
            )}
          </TabPanel>

          <TabPanel id="ai">
            {a.ai ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={a.ai.decision === 'LONG' ? 'bull' : a.ai.decision === 'SHORT' ? 'bear' : 'neutral'}>
                    {a.ai.decision}
                  </Badge>
                  <Badge tone="plain">{a.ai.confidence.toFixed(0)}% confidence</Badge>
                  <Badge tone={a.ai.agreesWithQuant ? 'bull' : 'warning'}>
                    {a.ai.agreesWithQuant ? 'agrees with quant' : 'disagrees'}
                  </Badge>
                  <Badge tone="neutral">{a.ai.model}</Badge>
                  {a.ai.cached && <Badge tone="neutral">cached</Badge>}
                </div>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/90">{a.ai.reasoning}</p>
                {a.ai.risks.length > 0 && (
                  <div>
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">risks</p>
                    <ul className="space-y-0.5">
                      {a.ai.risks.map((r, idx) => (
                        <li key={idx} className="text-[11px] leading-snug text-warning">
                          · {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {a.ai.invalidation && <Row label="invalidation" value={a.ai.invalidation} mono={false} />}
                <div className="grid grid-cols-2 gap-x-5 border-t border-border pt-2">
                  <Row label="tokens in / out" value={`${a.ai.tokensIn} / ${a.ai.tokensOut}`} />
                  <Row label="latency" value={`${a.ai.latencyMs}ms`} />
                  <Row label="suggested leverage" value={`${a.ai.leverage}×`} />
                  <Row label="suggested stop" value={fmtPrice(a.ai.sl)} />
                </div>
              </div>
            ) : (
              <p className="py-6 text-center text-xs leading-relaxed text-muted-foreground">
                The AI risk officer is only consulted when the local quant stack finds a real setup — that is what keeps
                the token bill near zero. Press <span className="text-foreground">Ask AI</span> to force a review now.
              </p>
            )}
          </TabPanel>
        </div>
      </Tabs>
    </Panel>
  )
}
