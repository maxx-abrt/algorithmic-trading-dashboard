# MYCROFT — self-improving OKX research OS

A local-first, 24/7 quantitative research and decision-support system for OKX. It
records real market decisions, tests trading policies out of sample, evolves and
trains models that beat their own baseline, and produces a ranked advisor feed:
what to trade, which direction, entry, stop, take-profit ladder, size and expiry.

**MYCROFT never places, amends or cancels a real order.** Every plan is advisory and
is automatically evaluated as a paper hypothesis with modelled execution costs.

## The improvement loop

```
 OKX public REST + WebSocket
            |
            v
 engine (Node 22 + TypeScript, :8790)
   ingest -> indicators -> playbooks -> risk plan
        -> DECISION TAPE   every decision + the price path that followed
        -> ARENA           purged walk-forward tests of complete policies
        -> BREEDER         evolution whose fitness IS the out-of-sample equity curve
        -> COMMITTEE       skill-gated mixture of experts
        -> PAPER BROKER    + internal execution simulator (spread, depth, latency)
        -> ORCHESTRATOR    decides the single most valuable next action, forever
            |                     |
            | /api/*              | HTTP
            v                     v
 frontend (Next.js, :3000)   brain (Python, :8791)
   Advisor / Arena / Brain     LightGBM + PyTorch MLP + ensemble
   Evolution / Autopilot       PPO exit agent on real recorded paths
```

## What makes it actually improve

* **The decision tape.** Every historical and live decision is stored with its frozen
  point-in-time feature vector *and* the price path that followed, as a compact
  Float32 blob. Any exit policy, stop, take-profit ladder or RL agent can therefore be
  re-simulated in microseconds without touching a candle again.
* **The arena.** Fitness is not Brier score. A candidate is a complete policy
  (feature mask, regularisation, exit variant, probability threshold) and it is scored
  by replaying it through purged walk-forward folds: threshold and exit chosen on the
  training slice only, measured on the test slice, compared against take-everything,
  with a held-out symbol and a deflated Sharpe.
* **Two-track promotion.** Arena evidence makes a specialist a canary. Only positive
  FORWARD evidence from real closed trades makes it a champion. Either can demote it.
* **Real DL and RL.** A Python sidecar trains LightGBM, a PyTorch MLP and their
  calibrated ensemble with the same purged folds, and a PPO agent that manages open
  positions bar by bar (hold / scale out / break-even / trail / close) on real paths,
  judged against the plan's own exit on a held-out slice.
* **Deliberate exploration.** A fixed share of arming slots is reserved for probe
  trades in the niches with the least evidence, at reduced size. Without it the system
  deadlocks: no trades -> no forward evidence -> no champion -> no trades.
* **One feature schema.** 106 columns, identical in replay and live, with availability
  flags for everything that only exists live (order book, macro, news). This removes
  the train/serve distribution shift that made the previous build learn noise.
* **Honest rejection.** `NO_VALIDATED_MODEL`, a failed placebo test and a negative
  arena verdict are all normal, recorded outcomes.

## Local start

Requirements: Node 22, Yarn 1.x, Python 3.11.

```bash
cd engine && yarn install && yarn typecheck && yarn test && yarn poc:frontier
yarn start                      # engine on :8790

cd ../brain && pip install -r requirements.txt
python -m uvicorn app:app --port 8791

cd ../frontend && yarn install && yarn build && yarn serve   # dashboard on :3000
```

`yarn poc:frontier` is the proof-of-core script: it builds a tape from real OKX bars,
asserts the exit simulator agrees with the live broker to 1e-6 R, asserts live/replay
feature parity, runs a walk-forward arena campaign, trains LightGBM + MLP + PPO through
the brain, and checks the Gemini news digest and the OKX credential state.

## Deployment

`docker-compose.yml` brings up engine + brain + frontend with one persistent
directory. See [COOLIFY_DEPLOYMENT.md](./COOLIFY_DEPLOYMENT.md) for the exact,
minimal Coolify configuration, and [USAGE.md](./USAGE.md) for what runs by itself,
what you can trigger by hand, and how to read the evidence.

## Interpretation limits

- Scenario win estimates from the legacy heuristic layer are labeled unvalidated unless backed by an empirical sample.
- Backtests and paper fills cannot guarantee live execution quality or future returns.
- The model registry begins in `NO_VALIDATED_MODEL` and stays there until every statistical, risk, and held-out gate passes.
- AI output cannot authorize a signal, change paper-broker truth, or create an order.
- Public OKX data use remains subject to OKX terms and redistribution limits.

Not financial advice. Leveraged derivatives can cause rapid and total loss.
