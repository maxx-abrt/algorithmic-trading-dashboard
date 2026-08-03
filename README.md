# MYCROFT — OKX Research OS

A local-first decision-support and quantitative research system for OKX. It collects real public market data, explains explicit strategy candidates, simulates them with a stateful paper broker, and rejects models that fail leakage-aware validation.

**MYCROFT never places, amends, or cancels an order.** There is no trade endpoint in the codebase. Every LONG/SHORT plan is advisory and is automatically evaluated as a paper hypothesis.

## What is implemented

- **Real OKX data:** public REST + WebSocket instruments, tickers, candles, funding, open interest, basis, order-book imbalance, taker flow, and positioning statistics
- **Core horizons:** 5m, 15m, and 1H; BTC/ETH perpetual focus, liquid swap scanner, and a default spot basket covering BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, and LINK
- **Closed-bar analysis:** forming candles are excluded from decisions; gaps and repairs are explicit data-quality events
- **Explicit playbooks:** trend pullback, volatility breakout, and range fade expose prerequisites, triggers, invalidation, and rejection reasons
- **Paper broker:** pending entry zones, conservative fills, stop-first intrabar ambiguity, TP ladder, break-even after TP1, ATR trailing after TP2, time stops, gaps, fees, slippage, and funding
- **Portfolio gates:** open-position, daily-loss, instrument-risk, portfolio-risk, gross-exposure, duplicate-exposure, and paper kill-switch controls
- **Durable truth:** SQLite WAL stores candles, decisions, candidates, paper events, risk state, research campaigns, trials, models, quality events, and optional outbox data
- **Honest research:** point-in-time slicing, purged chronological folds, embargoes, held-out ETH checks, bootstrap confidence bounds, deflated-Sharpe penalty, and explicit rejection gates
- **Governed improvement:** bounded campaigns, resource governor, immutable manifests, model registry, shadow-only promotion state, and `NO_VALIDATED_MODEL` as a normal outcome
- **Operations:** feed health, RAM/load, data quality, AI budget circuit breaker, online SQLite backup, and Coolify deployment files
- **Optional Gemini:** adversarial summary/risk critique only. Local quant remains authoritative. Calls are cached, counted, and blocked at the configured monthly budget (maximum €10 in the UI)

## Architecture

```text
OKX public REST + WebSocket
            |
            v
engine/  Node + TypeScript
  live analysis | paper broker | SQLite WAL | bounded research
            |
          /api/*
            |
frontend/ Next.js + React
  terminal | scanner | portfolio | journal | research | operations
```

Convex remains supported as an optional mirror for existing installations, but it is not required. SQLite is the local source of truth.

## Local start

Requirements: Node 20+, Yarn 1.x.

```bash
cd engine
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn core:poc       # live OKX public-data proof; creates only temporary state
yarn start          # engine on :8790
```

In a second terminal:

```bash
cd frontend
yarn install --frozen-lockfile
yarn build
yarn dev            # dashboard on :3000; /api rewrites to :8790
```

No OKX API key is required or recommended for this paper-only build.

## Verification

```bash
cd engine

yarn typecheck
yarn test
yarn core:poc

cd ../frontend
yarn build
```

The core POC uses confirmed real BTC-USDT-SWAP candles and verifies OKX contracts, SQLite recovery, candidate/rejection persistence, the paper state machine, and purged walk-forward splits. A negative result is valid: the objective is to reject false edge, not force a profitable-looking report.

## Coolify

Use `docker-compose.yml` and route the public domain to the frontend service on port 3000. Keep the data and backup volumes persistent. Full instructions are in [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md).

Optional secrets belong in Coolify environment variables, never Git:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Interpretation limits

- Scenario win estimates from the legacy heuristic layer are labeled unvalidated unless backed by an empirical sample.
- Backtests and paper fills cannot guarantee live execution quality or future returns.
- The model registry begins in `NO_VALIDATED_MODEL` and stays there until every statistical, risk, and held-out gate passes.
- AI output cannot authorize a signal, change paper-broker truth, or create an order.
- Public OKX data use remains subject to OKX terms and redistribution limits.

Not financial advice. Leveraged derivatives can cause rapid and total loss.
