# ROADMAP — from working system to frontier-grade tool

Written as a handoff. Everything below is scoped against the code that exists today:
`engine/` (Node 22 + TS), `brain/` (Python DL/RL sidecar), `frontend/` (Next.js),
one SQLite file as the single source of truth.

**Current state (verified live):** 44,109 recorded decisions across all 24 niches;
19 specialists bred to generation 2; 16 with a proven out-of-sample arena edge
(best +0.78R lift over baseline, 230 OOS trades, 4/4 folds positive, Sharpe 0.62,
held-out symbol +0.26R); LightGBM + PyTorch MLP + PPO exit agent training on the same
evidence; internal execution simulator measuring fills; `NO_VALIDATED_MODEL` →
`ARENA_VALIDATED_PENDING_FORWARD`.

---

## 0. HANDOFF — state, gotchas, unfinished edges

**Solved in this build (do not regress):**
- `candleStore.ensure` hydrates from SQLite before REST and races every seed against a
  wall-clock budget. Before this, a slow exchange link wedged the focus/watch/scanner
  loops permanently: the engine reported itself healthy while performing **zero**
  evaluations. This is the deepest cause of "ran for hours, no trades".
- Scanner passes have a deadline and seed only N new series per cycle, so research and
  live decisions no longer fight over the OKX REST budget.
- `breedSpecialist` and the tape builder yield to the event loop between units of work,
  so training can never stall the HTTP API or the WebSocket feed.
- Feature schema v3: 106 columns, **identical in replay and live**, with availability
  flags for live-only blocks. The old build filled 14 of 32 slots historically and all
  32 live — the models were learning a distribution that did not exist at inference.
- Exit simulator agrees with the live paper broker to **1e-6 R** over hundreds of real
  recorded trades (gate in `engine/scripts/poc-frontier.ts`). Never change one without
  re-running that gate.
- `backend/server.py` is a preview-only proxy; keep-alive is disabled and one retry is
  transparent (dropped sockets surfaced as intermittent 500s).

**Known open edges:**
1. **OKX demo key returns `50119`.** Fill quality is modelled, not measured, until a
   real *Demo Trading* key exists. Diagnosis is surfaced in the UI verbatim.
2. **Live arming is rare on quiet markets.** The deterministic playbooks (`trend_pullback`,
   `volatility_breakout`, `range_fade`) require all prerequisites; exploration probes may
   use a shadow plan or a one-condition near-miss. On a squeezing BTC with Fear 30 this
   can still yield nothing for tens of minutes. Tune `evolution.explorationRate`,
   `probeSizeMultiplier`, `scanner.deepScanTop` and `deepScanMinScore` — or add playbooks
   (§2).
3. **Legacy v2 population** (`specialists`, `training_samples`) is still in the DB and
   still readable. It drives nothing. Delete only after a backup.
4. `engine/src/research/{lab,harvester,evolution-service}.ts` are legacy; the orchestrator
   replaced them. `/api/harvest` and `/api/research` still work for reference.

**Golden rules for whoever continues:**
- Never promote on in-sample numbers. Arena → canary, forward evidence → champion.
- Never widen a gate to make the dashboard look better. A rejection is a result.
- Every new feature must be computable point-in-time in **both** replay and live, or it
  goes in the live-only tail with an availability flag.

---

## 1. Data foundation — the largest single lever

Model quality is capped by evidence quality. In rough order of value per hour of work:

| # | Work | Why it pays | How |
|---|---|---|---|
| 1.1 | **Deep history** | Purged walk-forward needs many independent regimes. 1k bars/symbol is thin; 20k is a different class of confidence | Backfill via OKX `history-candles` in a background job with a REST allowance, 40+ symbols × 15m/30m/1H/4H. Target ≥ 500k tape rows |
| 1.2 | **True L2 / trade tape** | Order-flow features are currently live-only and masked in replay, so no model can learn microstructure | Record OKX `books50-l2-tbt` + `trades` to a compact rolling store keyed by bar; then order-flow becomes replayable and the mask turns on historically |
| 1.3 | **Funding / OI / basis history** | The strongest crypto-specific edges are positioning edges | OKX publishes funding-rate and OI history; backfill per symbol and join by bar timestamp into the tape |
| 1.4 | **Liquidation + heatmap proxy** | Stop-hunt structure explains a lot of "stopped then reversed" | Subscribe to `liquidation-orders`, aggregate per bar |
| 1.5 | **Data-quality contract** | One corrupt series poisons a niche | Per-series scorecard (gap ratio, dead-bar ratio, timestamp monotonicity, price sanity vs index) + refuse rows below threshold. `tradingContinuity()` is the seed of this |
| 1.6 | **Point-in-time macro** | Macro features are live-only, so replay cannot use them | Store an append-only log of every macro/news snapshot with its observation time; replay reads the value known at that bar |

**Definition of done:** every feature column has an availability flag that is `1` in
replay for at least 80% of rows.

---

## 2. Signal generation — more shots on goal, same quality bar

The system can only select from what the playbooks propose. Three playbooks is the real
ceiling today.

- **2.1 Add 5–7 playbooks** with the same explicit contract (prerequisites, triggers,
  invalidation, rejection reasons): failed breakout / liquidity sweep reversal, VWAP
  reversion, opening-range breakout by session, funding-squeeze mean reversion,
  cross-sectional relative-strength pairs, volatility-expansion continuation,
  news-catalyst momentum. Each becomes 8 new niches automatically.
- **2.2 Playbook auto-discovery.** Let the breeder mutate *entry rules*, not just feature
  masks: a small grammar over indicator predicates (`adx > x AND rangePos < y AND
  volumeZ > z`), scored by the same arena. This is the step that makes the system
  genuinely inventive rather than a selector over three human ideas.
- **2.3 Cross-sectional ranking.** Score the whole universe at once and trade the top/
  bottom decile. Cross-sectional edges survive market-wide moves far better than
  per-symbol ones.
- **2.4 Multi-timeframe agreement as a first-class gate**, learned rather than fixed.

---

## 3. Learning stack — real depth, honestly measured

- **3.1 Sequence models.** A GRU/TCN over the last 128 bars (OHLCV + a few derived
  channels) beats tabular snapshots when microstructure matters. Add
  `POST /train/sequence` in `brain/`; the artifact format and registry already support it.
- **3.2 Meta-labelling (López de Prado).** Keep the playbook as the primary signal and
  train a second model purely on "should I take this one". This is usually the single
  biggest jump in precision, and the decision tape is already the perfect input.
- **3.3 Conformal prediction** for calibrated confidence intervals on win probability →
  size by *certainty*, not by point estimate.
- **3.4 Position-sizing RL** next to the exit agent: actions over risk fraction, reward =
  risk-adjusted equity change with a drawdown penalty. Reuse `VecExitEnv`.
- **3.5 Offline-RL discipline.** PPO on replayed paths is on-policy learning from
  off-policy data. Add behaviour-cloning warm start + a KL constraint to the plan policy,
  or move to CQL/IQL. Without it, the agent can look great and generalise badly.
- **3.6 Ensembling across model families and seeds**, weighted by out-of-sample lift.
  Already scaffolded in `tabular.py`; extend to sequence + RL value heads.
- **3.7 Continual learning without forgetting.** Rolling-window refits plus a
  regime-stratified replay buffer, so a quiet quarter does not erase what the system
  learned about crises.

---

## 4. Validation — where credibility lives

- **4.1 Combinatorial purged cross-validation (CPCV)** instead of a single walk-forward
  path: many train/test path combinations → a *distribution* of Sharpe, not one number.
  `engine/src/research/cpcv.ts` is a starting point.
- **4.2 Probability of Backtest Overfitting (PBO)** reported per specialist.
- **4.3 Multiple-testing control** across the whole population, not per niche. With 24
  niches × 8 genomes × N generations, the family-wise error rate is the real risk.
- **4.4 Regime-stratified acceptance:** a specialist must not lose money in any regime it
  claims as a skill, not merely be positive on average.
- **4.5 Live-vs-arena drift monitor:** track forward R against arena-predicted R per
  specialist and auto-retire on divergence. Partly implemented via re-verification.
- **4.6 Cost-stress tests:** re-run every accepted policy at 2× fees, 2× slippage and
  100 ms extra latency. Anything that dies is not an edge, it is a rebate.

---

## 5. Execution — where paper profit is lost

- **5.1 A working OKX demo key**, then continuously compare modelled vs measured fills and
  auto-calibrate the simulator's impact curve to the observed slippage distribution.
- **5.2 Maker-first entries with a taker fallback** — on crypto majors the fee difference
  alone is often the whole edge.
- **5.3 Child-order slicing** for anything above a fraction of top-of-book depth.
- **5.4 Latency budget** measured end to end (bar close → decision → order) and charged to
  the backtest as a fixed cost.
- **5.5 Portfolio-level risk:** correlation-aware exposure caps, per-cluster limits, and a
  volatility-targeted global scalar. Trading 12 alts long is one trade, not twelve.

---

## 6. Product — what makes it feel like a $50k tool

- **6.1 Trade cards with a full audit trail:** the exact feature vector, which experts
  voted, which skills matched, the arena run behind them, and the counterfactual ("what
  the system would have done at 2× stop").
- **6.2 Counterfactual journal.** Log rejected candidates and what they would have paid.
  This is the fastest way for a human to trust or distrust the gates.
- **6.3 What-if console:** replay any historical window with any policy and any cost
  assumption, from the UI. The arena already does the maths; it needs a form.
- **6.4 Alert quality over quantity:** one Telegram card per genuinely actionable call,
  with expiry and invalidation, plus a daily "here is what I learned" digest.
- **6.5 Explainability that a human can argue with:** per-decision top contributing
  features in plain language (the `explain.ts` scaffold), not a SHAP plot.
- **6.6 Paper-to-live handoff checklist** the system itself signs off on: N champions,
  M forward trades, drawdown inside budget, fill parity within tolerance.

---

## 7. Autonomy and reliability

- **7.1 Watchdog on loop liveness.** Every loop publishes a heartbeat; the orchestrator
  restarts a stalled subsystem and reports it. This class of bug (§0) must be impossible
  to hide again.
- **7.2 Circuit breakers:** data-quality breaker, model-drift breaker, loss breaker,
  news-risk breaker. Two of the four exist.
- **7.3 Hypothesis backlog with lineage.** Every experiment records what it tested, what
  it found, and what it suggests next, so the search does not revisit dead ends.
- **7.4 Cost governor for the LLM** with per-task budgets and automatic downgrade to the
  cheapest capable model. Partly implemented.
- **7.5 Two-node option:** one box for ingestion and live decisions, one for training,
  sharing the volume over the network. The compose file is already service-separated.

---

## 8. Suggested sequence

| Phase | Focus | Outcome |
|---|---|---|
| **A** (days) | 1.1 deep history · 1.5 quality contract · 7.1 watchdog | Evidence base 10× larger and trustworthy; stalls impossible |
| **B** (1–2 weeks) | 2.1 new playbooks · 3.2 meta-labelling · 4.1 CPCV | More shots on goal with a credibility bar that scales |
| **C** (2–3 weeks) | 1.2 L2 tape · 3.1 sequence models · 5.1/5.2 execution | Microstructure edges become learnable and keepable |
| **D** (ongoing) | 3.4 sizing RL · 4.2/4.3 overfitting control · 5.5 portfolio risk | Compounding rather than one-shot performance |
| **E** (product) | 6.1–6.6 | The difference between a research toy and a tool someone pays for |

---

## 9. How to know it is actually working

Track these weekly. Everything else is decoration.

1. **Champions with forward evidence** — count, and their live mean R.
2. **Arena-to-live drift** — |forward meanR − arena meanR| per champion, trending to 0.
3. **Generation improvement** — best out-of-sample lift per niche per generation, rising.
4. **Coverage** — niches at target rows, and independent symbols per niche.
5. **Rejection rate** — healthy is 40–70%. Near 0% means the gates are broken.
6. **Cost of being wrong** — max drawdown in R versus the configured budget.
7. **Fill parity** — modelled vs measured slippage, once a demo key exists.

A system that reports `NO_VALIDATED_MODEL` honestly for a week is worth more than one
that reports a champion it invented.
