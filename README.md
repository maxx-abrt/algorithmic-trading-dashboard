# MYCROFT · APEX-02 — OKX decision terminal

An institutional-grade **decision companion** for OKX: it ingests real market data, runs a
full quantitative stack locally, has an LLM argue against its own conclusions, and tells you
**what to do, where the stop goes, where the targets are and how much to commit**.

It never places an order. There is deliberately no trade endpoint anywhere in the codebase.


```
            ┌──────────────────────────────────────────────────────────────┐
  OKX v5 ──▶│  engine/  (Node · TypeScript · 24/7)                         │
  REST+WS   │  universe · candle memory · 60+ indicators · candlestick      │
            │  confirmation · volatility models · statistics · empirical    │
            │  edge · vetoes · risk plan · Gemini arbitration · alerts      │
            └───────┬───────────────────────────────┬──────────────────────┘
                    │ HTTP /api/*                   │ writes
            ┌───────▼──────────┐           ┌────────▼─────────┐
            │ frontend/ (Next) │◀──────────│  Convex (cloud)  │
            │  terminal · chart│  reactive │ settings · alerts│
            │  scanner · alerts│  useQuery │ journal · logs   │
            └──────────────────┘           └──────────────────┘
                    │                               ▲
                    │                               │
              your browser                   Telegram bot (24/7)
```

## What it actually does

**Universe.** All ~1,900 live OKX instruments: perpetual swaps, dated futures, spot and the
tokenized US-equity swaps (`NVDA-USDT-SWAP`, `TSLA-USDT-SWAP`, `MSTR-USDT-SWAP`…). Searchable,
scannable, analysable on demand.

**Memory.** Up to 600 bars per instrument and timeframe in RAM, seeded over REST, kept hot by two
WebSocket families, gap-audited and repaired from `history-candles`. The forming bar is dropped
before any maths runs, so a signal can never repaint.

**Brain (all local, zero token cost).**

| Layer | What is computed |
|---|---|
| Trend | EMA 9/21/50/100/200 ribbon + slopes + stacking, SMA 20/50/200, Supertrend, PSAR, Aroon, Chandelier, ADX/DI, full Ichimoku, Donchian, VWMA, Vortex, Heikin-Ashi runs |
| Momentum | RSI (+SMA), StochRSI, Stochastic, MACD histogram acceleration, CCI, Williams %R, ROC, Awesome, TRIX, KST, Ultimate Oscillator, MFI |
| Volatility | ATR + percentile, Bollinger + %B + width percentile, Keltner, TTM squeeze, Choppiness, Kaufman efficiency, realised vol, **Parkinson**, **Garman-Klass**, **EWMA(0.94) forecast**, vol-of-vol, expected move over the holding horizon, hour-of-day vol profile, climax detection |
| Flow | OBV, ADL, MFI, Force Index, CVD proxy + slope, anchored VWAP + σ bands + z-score, volume profile (POC/VAH/VAL/HVN/LVN), relative volume |
| Structure | fractal swings, HH/HL/LH/LL, BOS, CHoCH, fair-value gaps, confluence S/R clustering with HTF swings, Fibonacci, range position, measured moves |
| Patterns | **34 candlestick formations** from `technicalindicators`, each re-scored by context: location vs level/band, body vs ATR, volume confirmation, prior leg, follow-through, freshness |
| Statistics | **Hurst exponent**, log-price regression channel with R² and slope t-stat, z-score, lag-1 autocorrelation, skew, kurtosis |
| Divergence | RSI / MACD / OBV, regular and hidden, multi-pivot |
| Derivatives | funding + next settlement, open interest and its change, taker buy/sell ratio, long/short account ratio, depth-weighted book imbalance, mark/index basis, spread |
| **Empirical edge** | fingerprints the current context and replays every historical analogue with the *same* stop and target → real hit rate, average R, MFE/MAE, sample-shrunk expectancy |

All of it collapses into a weighted, regime-adaptive factor model (~30 factors), a veto layer
(hard blockers vs soft penalties), a playbook selector (8 playbooks) and a risk plan:
structure/ATR/trailing-system stop, three-target ladder with allocations, blended R:R, leverage
capped by volatility *and* conviction *and* session, position size, liquidation distance, and
expectancy **net of fees, funding and spread slippage**.

**AI arbitration.** Gemini is called *only* when the local stack already found a setup, with a
pre-computed brief (~300 tokens compact, ~2.5k standard) and a response cache. Its job is to
attack the idea, not to invent numbers.

**Alerts + Telegram.** 13 rule types (signal, conviction, price cross, % move, RSI level, squeeze
fire, funding extreme, OI spike, pattern, regime change, level break, vol spike, divergence) with
scope, cooldown and de-duplication. Cards land on Telegram with an unambiguous ACTION block.
Commands: `/status /analyze BTC 15m /watch NVDA 1H /unwatch /list /scan /settings /mute /help`.

**Journal.** Every issued idea is stored and then replayed against real candles: targets fill in
order, the stop moves to break-even after TP1, and MFE/MAE/realised R are graded automatically.

## Quick start

```bash
git clone https://github.com/maxx-abrt/algorithmic-trading-dashboard.git
cd algorithmic-trading-dashboard

# 1. Convex (system of record + realtime)
cd frontend && npx convex dev          # writes NEXT_PUBLIC_CONVEX_URL, then Ctrl-C
npx convex env set WORKER_API_KEY "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"

# 2. Secrets
cd .. && cp .env.example engine/.env    # fill CONVEX_URL, WORKER_API_KEY, GEMINI_API_KEY, TELEGRAM_BOT_TOKEN

# 3. Install + run (two terminals)
cd engine   && yarn install && yarn start   # decision engine on :8790
cd frontend && yarn install && yarn dev     # dashboard on :3000
```

Open <http://localhost:3000>, then send `/start` to your BotFather bot to register for alerts.

**No OKX API key is required** — every market endpoint used here is public. Adding *read-only*
keys unlocks balance-aware position sizing only.

## Repository layout

```
engine/                 the brain (runs 24/7, owns all live state)
  src/okx/              v5 REST client (rate-limited, HMAC signing), WS transport, market layer
  src/store/            rolling candle memory with gap repair
  src/quant/            indicators · extras · stats · sessions · structure · patterns ·
                        edge · scoring · risk · engine (orchestrator)
  src/ai/gemini.ts      trigger-gated arbitration, strict JSON schema, cache, cost counters
  src/telegram/         transport + card renderer
  src/alerts/rules.ts   13 rule evaluators (pure functions)
  src/journal.ts        outcome grading
  src/runtime.ts        loops: settings, tickers, focus, watchlist, scanner, journal, telemetry
  src/server.ts         HTTP API consumed by the dashboard
  scripts/poc.ts        end-to-end live proof (Convex, OKX, WS, quant, Gemini, Telegram)
  scripts/decision-audit.ts  gate calibration report over the liquid universe
  scripts/preview-card.ts    render a Telegram card in the terminal
frontend/               Next.js 16 dashboard (terminal, scanner, watchlist, alerts, journal, settings)
  convex/               schema + queries/mutations (single writer: the engine)
backend/server.py       thin /api gateway, only needed on hosts that reserve :8001 for the API
```

## Useful scripts

```bash
cd engine
yarn poc                                   # 50-check live proof of the whole core
yarn tsx scripts/decision-audit.ts 14 15m 1H   # verdict distribution + veto histogram
yarn tsx scripts/preview-card.ts NVDA-USDT-SWAP 1H   # see the Telegram card as text
yarn typecheck
```

## Operating notes

- **WAIT is a valid answer.** The gate stack is intentionally strict; a healthy configuration
  produces roughly 10–30% actionable setups. `scripts/decision-audit.ts` tells you where you are,
  and every WAIT still shows the *shadow plan* — where the trade would live if it confirmed.
- **Tokenized equities are session-aware.** Outside US regular hours conviction is damped,
  leverage is halved and the weekend is a hard blocker: the underlying cannot hedge.
- **Convex usage is deliberately tiny** (a few thousand writes a day): live market state is served
  from the engine over HTTP, only configuration and history live in the database.
- **Nothing is mocked.** Every number on screen comes from OKX, computed locally.

Not financial advice. Leveraged derivatives can liquidate your entire balance.
