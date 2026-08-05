# MYCROFT Rework Analysis and Implementation Plan

> Code-grounded audit and implementation handoff for turning the current OKX decision dashboard into a statistically defensible, low-resource paper-trading and continuous-evaluation platform.

**Repository audited:** `maxx-abrt/algorithmic-trading-dashboard`, local `main` at `8d23fd8`  
**Audit date:** 2026-08-03  
**Scope:** 93 tracked files across the TypeScript engine, Next.js frontend, Convex functions/schema, Python gateway, scripts, configuration, and dependency manifests. Generated Convex code and static image assets were inventoried but are not business logic.

---

## 1. Executive verdict

The repository is a well-presented **decision-support prototype**, not yet a validated trading system, paper broker, or learning system.

Its current core is:

1. fetch up to 600 recent candles per instrument/timeframe;
2. calculate many correlated technical indicators;
3. convert those indicators into hand-authored signed scores and weights;
4. derive an uncalibrated `conviction` value;
5. emit a market-entry plan immediately at the current ticker price;
6. save the plan to Convex;
7. replay later candles against theoretical SL/TP levels.

It does **not** currently:

- place or emulate an entry order;
- wait for the proposed entry zone to fill;
- maintain a durable order/fill/position state machine;
- model actual fee tiers, funding timestamps, gaps, latency, depth, or partial fills;
- train on journal outcomes;
- calibrate `conviction` as a probability;
- perform historical walk-forward or genuinely out-of-sample validation;
- promote or roll back models;
- use the LLM verdict to change the issued decision;
- enforce portfolio limits represented by `maxOpenPositions` and `maxDailyLossPct`.

The observed result near 50% cannot be diagnosed from hit rate alone. A 40% win rate can be profitable with sufficiently large net wins, while a 70% win rate can lose money with large losses. The primary objective must be **net expectancy and controlled drawdown**, not maximum win rate. However, this implementation has verified defects and methodological problems that make both its displayed hit rate and displayed expectancy unreliable.

### Bottom line

Do not add more indicators or a larger LLM. The highest-value rework is:

1. fix journal correctness first;
2. build durable point-in-time market history;
3. implement a real paper order/fill/position engine;
4. split the omni-score into a few explicit playbooks;
5. validate every playbook with leakage-safe walk-forward tests;
6. calibrate take/skip probabilities from out-of-sample predictions;
7. introduce a guarded champion/challenger feedback loop;
8. keep AI out of the numerical decision path unless an A/B test proves incremental value.

No design can guarantee a high success rate. The plan below is designed to determine honestly whether an edge exists, reject false edges, and improve safely when evidence supports a change.

---

## 2. What is already good and should be preserved

The rework should not discard the entire codebase.

| Existing strength | Evidence | Preserve as |
|---|---|---|
| Closed-bar signal math | `engine/src/quant/engine.ts:192-200,511-515` drops unconfirmed bars | Mandatory point-in-time feature rule |
| Modular pure quant functions | `engine/src/quant/*` is mostly network/database independent | Feature library, after tests and de-duplication |
| REST seed plus WS update | `engine/src/store/candles.ts`, `engine/src/okx/ws.ts` | Live ingestion adapter |
| Typed instrument metadata | `engine/src/okx/market.ts:68-90` | Contract sizing and validation input |
| Explicit data-quality warnings | `engine/src/quant/engine.ts:155-190,517-527` | Hard precondition checks |
| Session awareness for tokenized equities | `engine/src/quant/sessions.ts` | Calendar adapter, upgraded for holidays/early closes |
| Cost-aware intent | `engine/src/quant/risk.ts:280-325` | Replace estimates with execution-ledger costs |
| LLM gating and caching | `engine/src/ai/gemini.ts` | Optional explanation/reporting layer |
| Lightweight live architecture | Node engine plus Next UI; only four engine runtime dependencies | Keep live path small |
| Human-readable evidence | decision card and evidence rail | Add calibration, attribution, and execution truth |

---

## 3. Current architecture and real data flow

```text
OKX REST
  instruments / tickers / candles / funding / OI / Rubik stats / order book
        |
        v
engine/src/okx/market.ts + rest.ts
        |
        +------> CandleStore (RAM only, max 600 bars/series)
        |          ^
OKX WS -+----------+ candles + tickers
        |
        v
Runtime loops (engine/src/runtime.ts)
  focus every 4 s
  one watchlist item every 5 s
  quick scanner every configured interval
  journal grader every 20 s
        |
        v
quant/engine.ts
  indicators -> structure/patterns/stats -> heuristic factors
  -> empirical analogue scan -> vetoes -> heuristic conviction
  -> risk plan -> optional Gemini opinion
        |
        +------> HTTP /api/* -> Next.js dashboard
        |
        +------> Convex: settings, watchlist, alerts, signal rows, logs, telemetry
        |
        +------> Telegram
```

### Important behavior that is easy to miss

- The scanner only runs `quickScore`; it does not automatically run the full decision/risk pipeline on top candidates (`runtime.ts:676-710`). Scanner-scoped rules are documented in the schema, but `scopeMatches` does not implement `SCANNER` (`alerts/rules.ts:275-279`).
- Full signals are generated only by the focus loop and watchlist rotation.
- The same instrument is recomputed every few seconds even though the mathematical features use the last closed candle. Only the live ticker/derivative snapshot changes.
- Analyses, candle history, scanner output, AI cooldowns, and in-memory alert fingerprints disappear on restart.
- Convex is durable for signal rows, but candles and point-in-time feature snapshots are not durably stored.
- The Python backend contains no trading logic; it is a hosted-preview proxy.

---

## 4. Verified critical defects

### P0 — the journal can strand a trade permanently after TP1

`gradeSignal` changes an open signal from `live` to `tp1` after the first target (`engine/src/journal.ts:133-141`). The Convex query used by the journal loop selects only `status === "live"` (`frontend/convex/signals.ts:49-55`). Consequently:

1. signal reaches TP1;
2. grader writes `status: "tp1"`;
3. next journal loop no longer loads it;
4. TP2, TP3, break-even stop, time stop, and final result are never processed.

This also breaks duplicate prevention because `maybeJournal` checks the same `listLiveSignals` query. A `tp1` position can be ignored and a second signal for the same instrument/side created.

**Consequence:** the screenshot’s result distribution and aggregate statistics cannot be treated as ground truth until existing rows are repaired and regraded.

**Immediate fix:** replace status-based openness with explicit terminal state, for example `isOpen: boolean` or a query that includes `pending_entry`, `partially_filled`, `open`, and `partially_closed`. Never overload presentation status as lifecycle state.

### P0 — the journal is not a paper execution simulator

`toSignalRecord` creates a live trade immediately at `plan.entry` (`journal.ts:12-58`). The proposed `entryZone` is displayed and stored but never evaluated for a fill. There are no orders or fills. This means:

- every signal is assumed filled instantly;
- a limit/pullback plan is treated as a market fill;
- no unfilled or expired setups exist;
- no spread crossing, latency, rejected order, partial fill, or queue behavior exists;
- `breakevenTrigger`, `trailAtrMult`, and structural `invalidation` are displayed but not executed;
- the only management implemented is moving the stop to exact entry after TP1.

A journal that assumes every desired entry happened will systematically misrepresent real executability.

### P0 — displayed conviction and win probability are not calibrated probabilities

Final conviction is an arbitrary linear formula:

```text
0.55 * |composite| + 0.25 * factor agreement + 0.20 * MTF alignment
- 4 * soft-veto count + bonuses
```

(`engine/src/quant/scoring.ts:800-829`)

Risk then turns that score into a probability using another hand-authored mapping:

```text
convictionProb = 0.34 + 0.36 * conviction
```

and blends it with the analogue estimate (`risk.ts:310-321`). No calibration set, reliability curve, Brier score, log loss, or confidence interval supports this conversion.

**Consequence:** UI values labeled `win probability` and `net expectancy` (`frontend/components/terminal/decision-card.tsx:201-204`) look mathematically authoritative but are not empirical estimates. Position size also depends on the same uncalibrated score, compounding the problem.

**Immediate fix:** temporarily relabel `conviction` as `heuristic score`, hide probability/expectancy from actionable UI, and do not scale risk from it until out-of-sample calibration exists.

### P0 — empirical edge is not the “exact same trade” described by the UI

The UI says it replays the “exact stop and target” (`evidence-rail.tsx:363-366`). The implementation instead:

- uses only 600 or fewer recent LTF candles;
- fingerprints five coarsely bucketed variables;
- uses a current regime-dependent ATR multiplier, not the final selected structural/system stop;
- uses one fixed target `settings.rrRatio`, not the three-target ladder;
- does not model break-even movement, costs, funding, slippage, or entry zones;
- calls any positive time-barrier exit a win, even when the target was never hit;
- calculates `expectancyR` as if every “win” earned full `targetR` and every loss lost 1R;
- accepts six analogues as a returned result;
- sets confidence to `sample / 40`, not statistical confidence;
- shrinks every product/timeframe toward a fixed 42% prior;
- uses 42% regardless of requested R:R; for a binary +2R/-1R payoff the no-cost break-even rate is 33.3%, while for +1.2R it is 45.5%; there is no universal 42% base rate;
- computes volatility bucket edges over the full sample, leaking later distribution information into earlier analogue features;
- uses overlapping analogue windows, so observations are not independent;
- stops after the first 120 matches rather than selecting a validated nearest/recency-weighted sample.

Evidence: `engine/src/quant/edge.ts:36-196`, `engine/src/quant/engine.ts:600-615`, `engine/src/quant/scoring.ts:499-518`.

A further consistency defect is possible: edge is evaluated for the first-pass side and provisional playbook. The edge factor can alter the composite and flip the final side, but the edge is not recomputed for that new side (`engine.ts:597-633`).

### P0 — there is no historical out-of-sample backtest

`scripts/decision-audit.ts` evaluates the current market snapshot across liquid instruments and counts LONG/SHORT/WAIT plus vetoes. Its stated health target is an arbitrary 10–30% action rate. It does not evaluate later outcomes, walk forward through history, compare baselines, or estimate uncertainty.

The POC script checks connectivity and one synthetic journal example. There are no test files or configured test runner. Dependency installation is also absent in the audited workspace, so `yarn typecheck` fails with `tsc: command not found`; this is an environment state, not evidence that the source has type errors.

### P1 — large indicator count creates correlated evidence, not independent confirmation

The factor model counts several transformations of the same underlying price path:

- EMA ribbon, Supertrend, PSAR, Chandelier, Ichimoku, Donchian, Vortex, regression slope;
- RSI, StochRSI, stochastic, Williams %R, CCI, ROC, MACD, Awesome Oscillator;
- ATR, Bollinger, Keltner, realized volatility and related derived values.

Their agreement is then rewarded as if it were additional confidence. Correlated indicators can all agree because they encode the same recent return, not because independent evidence exists. Hand-authored regime tilts and user weights add many researcher degrees of freedom and increase false-discovery risk.

`weightedMean` does normalize total weight, so varying total weight itself is not the defect. The defect is unvalidated feature redundancy and repeated counting of shared information.

### P1 — strategy mode does not define the signal

`strategy` only filters which playbook name may be returned (`scoring.ts:752-793`). The same universal factors choose direction and decide whether to trade before the final playbook is selected. A strategy can return `null` playbook and still produce an actionable decision and generic risk plan.

A valid architecture should reverse this relationship: an explicit playbook generates a candidate under its own prerequisites; a shared meta-layer decides whether to take that candidate.

### P1 — net-negative plans are warnings, not blockers

`buildRiskPlan` warns when its own estimated net expectancy is non-positive (`risk.ts:322-325`), but decision generation already occurred and neither `maybeJournal` nor signal alerts reject it. Even if the current expectancy were calibrated, the system can journal a plan it labels mathematically unprofitable.

### P1 — per-trade risk ignores portfolio risk

The system sizes each idea independently. It does not account for:

- existing positions or pending orders;
- total gross/net exposure;
- correlated BTC/ETH/alt or equity-beta positions;
- per-asset-family concentration;
- daily/weekly realized loss;
- drawdown state;
- simultaneous stop-loss risk;
- margin already reserved.

`autoTrade`, `paperMode`, `maxOpenPositions`, and `maxDailyLossPct` exist in `EngineSettings` defaults (`quant/types.ts:503-556`) but are absent from runtime settings/schema behavior. They are dead controls.

### P1 — candle gap repair and eviction are advertised but never called

`CandleStore.repair` and `CandleStore.evict` exist (`store/candles.ts:123-166`), but no repository call site invokes either. The README claim that gaps are repaired is therefore false in the running application. Re-seeding may incidentally fill recent history, but there is no explicit repair loop or verified continuity contract.

### P1 — restart recovery is incomplete

With only up to 600 candles in memory, a long-lived trade may exceed available replay history after restart. The grader can miss an earlier SL or TP and undercount bars held. Durable orders, fills, current stop, hit target count, and processed market-event offsets do not exist.

### P1 — intrabar outcome handling is too coarse

OHLC cannot determine ordering when a bar touches both stop and target. The current grader always chooses stop first, which is conservative but not accurate. It also computes MFE from the full bar high/low before assigning stop-first, producing path-inconsistent excursion values. A 15-minute strategy should use stored 1-minute bars or trades for execution ordering; unresolved ambiguity must be flagged, not silently converted into certainty.

### P1 — market microstructure inputs are snapshots with unstable meaning

A one-time REST order-book imbalance and latest Rubik statistics are mixed with closed-bar features. Order-book imbalance is short-lived and spoofable; without synchronized sampling, sequence integrity, persistence, and out-of-sample evidence, it should not be a directional factor. OI and taker statistics are currency-level in some OKX endpoints, not necessarily instrument-specific. Feature provenance and timestamp alignment are not retained.

### P1 — AI “arbitration” is advisory only

Gemini receives only the same computed brief, has no independent market information, and its opinion is attached after the quant decision and risk plan. It does not veto, change, or resize the journaled signal (`runtime.ts:518-550`; `journal.ts:45-48`). Calling this arbitration is misleading.

This is safer than allowing an LLM to change orders, but its incremental value is unknown because quant-only and AI-reviewed outcomes are not compared.

### Local-only deployment boundary

This installation is explicitly private and streamed only from the owner’s machine. Public-deployment hardening is outside scope. Spend implementation effort on trading correctness, experiment integrity and strict request-schema validation; malformed local requests can still corrupt settings or experiments.

### P2 — product and operational mismatches

- `SCANNER` alert scope is documented but not implemented.
- `sendScanDigest` and `digestIntervalMin` are stored but never used.
- `engineEnabled` stops analyses/scanning but leaves ingestion and journal activity semantics unclear.
- `thinkingBudget` is ignored for models outside a regex-selected family, without UI warning.
- frontend production builds explicitly ignore TypeScript errors (`frontend/next.config.mjs:9-12`).
- the Python proxy carries many unused packages; only FastAPI, Uvicorn, HTTPX, and dotenv are required by `backend/server.py`.
- Convex retention mutations collect whole tables to count rows, which is inefficient even at current small sizes.
- tokenized-equity session code has US DST logic but no exchange calendar, holidays, or early closes.

---

## 5. Why performance is near chance

The code does not prove one single cause, and the supplied hit-rate observation is not enough for causal attribution. The following mechanisms are strongly supported by the implementation.

### 5.1 There may be no stable predictive edge in the chosen features

Most technical indicators are deterministic transformations of past OHLCV. More indicators increase description, not necessarily prediction. Without a proper out-of-sample benchmark, the model cannot distinguish a real conditional edge from patterns selected by chance.

### 5.2 The system optimizes plausibility instead of a measured objective

Weights, thresholds, bonuses, veto penalties, regime boundaries, analogue distances, stop multipliers, and pattern reliabilities are hand-authored. They create an articulate narrative, but they were not learned or selected under a leakage-safe objective such as out-of-sample net log growth subject to drawdown.

### 5.3 Entry and strategy logic are mismatched

A trend pullback, range fade, and squeeze breakout require different trigger timing, order type, horizon, stop process, and target distribution. The current system first produces a universal side, then attaches a playbook label. This blurs contradictory behaviors into one score.

### 5.4 Evaluation does not match proposed execution

The “back-scan,” risk estimate, and journal each simulate different trades. None models the displayed entry zone. Training/evaluation/live parity is absent, so a good number in one layer does not predict the next layer.

### 5.5 The feedback sample is biased and corrupted

Only issued signals are recorded; rejected candidates and counterfactual baselines are not. The TP1 lifecycle bug loses outcomes. Immediate fill assumptions favor convenient entries. Changes to settings/model code are not versioned per signal. Consequently, aggregate journal statistics mix incomparable policies and cannot train a reliable learner.

### 5.6 Probability and risk are circular

Handwritten factors produce conviction; conviction produces an assumed win probability; that probability produces expectancy and position size. Positive-looking expectancy is partly created by the score itself, not independently observed.

### 5.7 Market non-stationarity is unmanaged

Regime labels can flip on one bar and have no hysteresis or probability. There is no drift monitor, model age, decay, or rollback. At the same time, the 600-bar edge window may be too short for sample size and too long for a changed regime—without validation, both choices are arbitrary.

---

## 6. Target system architecture

Use two planes: a small deterministic live plane and a scheduled research plane.

```text
                             LIVE PLANE
OKX public WS/REST ---------------------------------------------------+
  trades / 1m bars / candles / book / funding / mark / instrument     |
                                                                      v
  Data validator -> append-only event store -> bar builder -> feature snapshots
                                  |                        |
                                  |                        v
                                  |              Explicit playbook candidates
                                  |                        |
                                  |              Calibrated take/skip model
                                  |                        |
                                  |              Portfolio risk gate
                                  |                        |
                                  |              Paper broker state machine
                                  |                        |
                                  +-------------> orders / fills / positions / PnL
                                                           |
                                        UI / alerts / journal / attribution

                          SCHEDULED RESEARCH PLANE
Parquet + event DB -> point-in-time dataset -> labels -> walk-forward/CPCV
 -> baseline models -> calibration -> event-driven simulation -> robustness tests
 -> candidate model registry -> shadow run -> promotion gates -> champion or reject
```

### Recommended responsibility split

- **Node/TypeScript remains live:** OKX ingestion, feature computation, playbook evaluation, portfolio gate, paper broker, HTTP API, alerts.
- **SQLite in WAL mode becomes local transactional truth:** events, decisions, orders, fills, positions, risk snapshots, model/config versions, outbox.
- **Partitioned Parquet becomes market/research history:** compact, inspectable, cheap on disk.
- **DuckDB queries Parquet for research:** projection/filter pushdown avoids loading all data into RAM.
- **Python owns autonomous research, not live risk:** a tiny governor/queue may remain resident, but Polars, scikit-learn, LightGBM and Optuna workers start only for bounded jobs and exit afterward. Live shadow inference should use compact exported artifacts in Node when practical.
- **Convex becomes an optional UI/config mirror, not the only journal truth.** Use an outbox to sync summaries; live operation must survive a Convex outage.

---

## 7. Data foundation

### 7.1 Canonical market events

Store at least:

- `instrument_snapshot`: tick size, lot size, contract value/currency, type, state, max leverage;
- `trade`: exchange timestamp, receive timestamp, trade ID, price, size, side when available;
- `book_top`: sequence IDs, bid/ask levels, exchange/receive timestamps;
- `candle_1m`: OHLCV, quote volume, confirmed flag, source, revision;
- derived candles with parent 1m range;
- funding rate and exact funding timestamp;
- mark/index prices;
- OI/taker/long-short observations with their actual scope (`instrument`, `currency`, or `family`);
- data-quality events: gap, late message, duplicate, clock skew, reconnect, repair.

Every feature row must include `feature_time`, `latest_source_time`, and `available_at`. A feature is legal only if `available_at <= decision_time`.

### 7.2 Retention policy for an 8 GB machine

Do not store tick/order-book history for the full 1,900-instrument universe.

Suggested tiers:

- **Tier A, active/watchlist/top candidates:** trades or 1-second book snapshots for 7–30 days; 1m bars for 12–24 months.
- **Tier B, liquid scanner universe:** 1m bars for 6–12 months; 15m+ bars for 2–4 years when available.
- **Tier C, remaining universe:** ticker snapshots and 15m/1H bars only when scanned.

Partition Parquet by `data_type/date/instrument` or `data_type/instrument/year-month`; compact small files daily. Apply a disk quota and expose usage in health telemetry.

### 7.3 Data quality gates

No candidate may be actionable when:

- latest closed bar is missing or stale;
- a parent 1m sequence is incomplete;
- ticker/candle/mark divergence exceeds a validated tolerance;
- instrument metadata is absent or changed mid-position;
- book snapshot sequence is broken when execution relies on it;
- clock skew exceeds threshold.

Call and test gap repair. Never silently forward-fill OHLC or volume.

---

## 8. Strategy redesign: fewer explicit playbooks

Start with simple hypotheses that can fail independently. Do not train one universal LONG/SHORT oracle.

### 8.1 Trend pullback

- prerequisite: stable directional regime with hysteresis; HTF direction aligned;
- setup: pullback to a predefined dynamic/value zone without structure break;
- trigger: closed-bar recovery or limit entry with expiration;
- invalidation: structural swing plus volatility buffer;
- time barrier: based on empirical holding distribution;
- no entry after extension/chasing threshold.

### 8.2 Volatility breakout

- prerequisite: compression measured only from past bars;
- setup: explicit range boundary;
- trigger: close/trade through boundary with relative volume/liquidity condition;
- entry: stop/market model with breakout slippage;
- failure: return inside range or time-based no-follow-through.

### 8.3 Range fade / mean reversion

- prerequisite: low directional persistence and stable range;
- setup: statistically extreme location at a validated boundary;
- trigger: rejection, not merely an overbought/oversold oscillator;
- target: conditional mean/POC, not generic 2R if structure cannot provide it;
- block during volatility expansion or structural break.

### 8.4 Optional structure break/retest

Add only after the first three have independent OOS support. Candlestick patterns, divergences, funding, and book imbalance should begin as candidate features or explanatory tags, not standalone strategies.

### 8.5 Meta-labeling

For each playbook:

1. deterministic rules produce side, proposed entry, stop, and horizon;
2. a small model predicts whether to take/skip the candidate and, separately, fill probability;
3. probability is calibrated on untouched out-of-sample predictions;
4. trade only when expected utility after cost and portfolio risk is positive.

Begin with regularized logistic regression. It is interpretable, cheap, and hard to overfit relative to large models. Use LightGBM only as a challenger when sample size supports nonlinear interactions; constrain depth/leaves and inspect stability.

---

## 9. Labels and validation

### 9.1 Label the actual trade

Use a triple-barrier/event label aligned with each candidate:

- upper barrier: actual target or utility threshold;
- lower barrier: actual invalidation/stop;
- vertical barrier: actual strategy horizon;
- entry occurs only after simulated fill;
- partial target ladder produces realized net R, not a binary full-target fiction;
- ambiguous OHLC bars are resolved from lower-timeframe data or labeled ambiguous.

Keep separate targets:

- `p_fill` — will the order fill before expiry?
- `p_positive_net` — will filled trade finish net positive?
- `expected_net_r` or quantiles — payoff distribution;
- adverse excursion / tail-loss target for sizing.

### 9.2 Leakage-safe validation

Required sequence:

1. chronological train/validation/test split;
2. purge rows whose label horizons overlap the test interval;
3. embargo adjacent observations;
4. rolling or expanding walk-forward folds;
5. held-out instruments/families to test cross-asset generalization;
6. combinatorial purged paths for strategy-selection robustness;
7. final untouched test period used once per candidate family.

Record every attempted parameter/model trial. Correct for selection bias with Deflated Sharpe Ratio and estimate Probability of Backtest Overfitting. Do not repeatedly tune against the final test.

### 9.3 Required baselines

Every candidate must beat, net of identical costs:

- no-trade;
- random side with identical action rate/holding horizon;
- always-long or simple buy-and-hold where applicable;
- simple EMA trend rule;
- simple breakout;
- current heuristic engine frozen at a version hash.

Run label permutation and randomized-entry placebo tests. If the sophisticated model “works” similarly on shuffled labels, reject it.

### 9.4 Metrics

Primary:

- net expectancy per filled trade and lower block-bootstrap confidence bound;
- maximum drawdown and time under water;
- net profit factor;
- tail loss / expected shortfall;
- turnover and cost as fraction of gross edge;
- portfolio exposure and concentration.

Probability quality:

- Brier score;
- log loss;
- calibration curve and expected calibration error;
- precision/recall by probability decile;
- coverage/action rate.

Secondary:

- win rate;
- average win/loss;
- MFE/MAE;
- Sharpe/Sortino with uncertainty;
- results by playbook, regime, instrument family, timeframe, session, side, volatility and liquidity bucket.

---

## 10. Paper broker specification

### 10.1 State machine

```text
PROPOSED
  -> REJECTED_BY_RISK
  -> PENDING_ENTRY
       -> EXPIRED_UNFILLED
       -> CANCELED
       -> PARTIALLY_FILLED
       -> OPEN
OPEN / PARTIALLY_FILLED
  -> PARTIALLY_CLOSED
  -> STOPPED
  -> TARGET_COMPLETE
  -> TIME_EXIT
  -> INVALIDATED
  -> LIQUIDATED_SIM
  -> DATA_HALT
all terminal states -> CLOSED with immutable ledger reconciliation
```

### 10.2 Required entities

- `decision`: immutable feature snapshot, candidate and model/config/data versions;
- `order`: side, type, limit/stop price, size, TTL, reduce-only, parent linkage;
- `order_event`: submitted/accepted/rejected/amended/canceled;
- `fill`: price, size, fee, liquidity role, slippage, market timestamp;
- `position`: average entry, quantity, margin mode, current stop, realized/unrealized PnL;
- `risk_snapshot`: portfolio exposure and gate decisions;
- `market_event_offset`: recovery checkpoint;
- `outcome_attribution`: reason codes and counterfactual metrics.

Use idempotency keys and append-only events. Rebuild open state on restart and reconcile it against events before processing new market data.

### 10.3 Fill models

Implement levels of realism:

1. **Conservative bar model:** next-bar execution, gap-aware fills, lower-timeframe path, maker/taker schedule.
2. **Trade model:** fill when trades pass the order price, with participation cap.
3. **Book model:** consume recorded depth, latency and queue assumptions.
4. **OKX Demo adapter:** place actual demo orders and ingest private order/fill channels for external validation.

Use the same broker interface for historical replay, local live paper, and OKX demo. This is essential for backtest/live parity.

### 10.4 Cost model

- fetch actual account/instrument fee rates when credentials allow;
- distinguish maker and taker;
- charge every partial exit;
- apply funding only when a position crosses an actual funding timestamp and in the correct direction;
- model bid/ask crossing per side;
- estimate market impact from order size versus depth/volume;
- model gap-through-stop fills at the first executable price;
- make all assumptions visible and versioned.

### 10.5 Portfolio risk manager

Before order submission enforce:

- risk per trade based on stop-fill stress, not leverage;
- maximum aggregate open risk;
- max gross/net notional;
- max positions and pending orders;
- daily/weekly loss and drawdown kill switches;
- per-symbol and per-family caps;
- correlation-cluster cap;
- margin reserve;
- stale-data and degraded-service halt;
- cooldown after repeated losses;
- no new orders while recovery/reconciliation is incomplete.

Leverage is an output of margin and liquidation constraints, not a source of edge.

---

## 11. Journal, failure analysis, and memory

### 11.1 Record all candidates, not only trades

For unbiased analysis, save:

- accepted and rejected candidates;
- exact reason codes for every gate;
- feature vector and raw source timestamps;
- predicted probability and calibration version;
- model/config/code/data hashes;
- proposed and actual execution;
- full event ledger and costs;
- realized outcome;
- counterfactual outcome for a small predefined set of alternatives.

Without rejected candidates, the system cannot learn whether a gate helps or only reduces activity.

### 11.2 Deterministic failure taxonomy

Classify outcomes with code first:

- `UNFILLED_ENTRY` — idea may be right but not executable at proposed location;
- `ADVERSE_SELECTION` — fill followed quickly by adverse move;
- `REGIME_BREAK` — regime changed before/after entry;
- `NO_FOLLOW_THROUGH` — time exit without target progress;
- `STOP_GAP_SLIPPAGE` — realized loss exceeded planned stop loss;
- `COST_DOMINATED` — gross positive, net non-positive;
- `HTF_CONFLICT`;
- `LIQUIDITY_DROPOUT`;
- `DATA_QUALITY`;
- `MODEL_FALSE_POSITIVE`;
- `TAIL_EVENT`;
- `MANAGEMENT_ERROR` — correct entry but TP/BE/trailing policy degraded result.

A loss is not automatically a mistake, and a win is not proof of a good decision. Compare predicted distribution with realized path and with predefined counterfactuals.

### 11.3 Attribution dashboard

Add:

- equity and drawdown curves with fees/funding/slippage decomposition;
- calibration plot: predicted decile versus realized frequency;
- outcome distribution by playbook/regime/family/timeframe/session;
- feature stability and drift;
- candidate funnel: generated -> gated -> submitted -> filled -> closed;
- fill ratio and entry slippage error;
- expected versus realized R;
- champion versus challenger shadow comparison;
- sample size and uncertainty on every metric.

Never show a percentage without denominator and date/model range.

---

## 12. Autonomous 24/7 improvement system

The machine should spend its idle capacity learning continuously, but “self-upgrading” must not mean changing the active policy after every win or loss. Financial rewards are sparse, dependent, noisy and non-stationary. An unrestricted optimizer will discover simulator defects and chance patterns faster than genuine edge. The frontier design is an **autonomous scientist with hard experimental rules**, not an unconstrained reinforcement learner.

The system should autonomously:

- collect point-in-time evidence;
- detect performance, calibration, execution and data drift;
- convert repeated failure signatures into preregistered hypotheses;
- run bounded experiments and ablations;
- reject weak or fragile ideas automatically;
- shadow-test survivors on unseen forward data;
- promote only validated paper champions;
- roll back or move to no-trade automatically when evidence deteriorates;
- preserve the complete memory of successes, failures and attempted searches.

### 12.1 Four concurrent improvement loops

#### Loop A — live prequential evaluation, every event

For every candidate prediction, store the prediction **before** the outcome is known. When the outcome closes:

1. reconcile fills and costs;
2. score the prior prediction with Brier score, log loss, realized net R and drawdown contribution;
3. update rolling calibration and outcome distributions;
4. update deterministic failure attribution;
5. update approved drift detectors;
6. evaluate rollback/kill-switch conditions;
7. append observations; never mutate historical predictions.

This is prequential evaluation: predict first, observe later, score once. It is the cleanest continuous evidence because the system cannot retroactively change the forecast.

#### Loop B — lightweight diagnostics, hourly/daily or after enough new outcomes

Cheap jobs that can run while live trading continues:

- candidate/fill/closure funnel by playbook;
- calibration by probability decile;
- Bayesian/shrunk outcome estimates by playbook, regime, side and asset family;
- feature distribution drift (PSI, KS/Wasserstein where appropriate);
- residual/performance drift with ADWIN or Page-Hinkley;
- expected versus realized fees, slippage, fill probability and holding time;
- factor redundancy and missing-value rates;
- data gaps and timestamp lag;
- champion/challenger forward-score update.

Drift detectors are alarms, not proof of a replacement model. They may trigger retraining, narrower risk, a playbook pause or no-trade mode.

#### Loop C — bounded research cycle, triggered by evidence

Run when at least one condition is true:

- a configured count of new independent labels has arrived;
- drift persists across multiple checks;
- a failure bucket has enough support to test a specific hypothesis;
- scheduled weekly research is due;
- a strategy has become stale by age;
- execution-model error exceeds tolerance.

The cycle generates only experiments from a versioned template library, applies a fixed compute budget, and preregisters search space, objective and confirmation data before running.

#### Loop D — forward shadow tournament

All research survivors make predictions in parallel on live data but cannot influence the champion. Each challenger gets:

- its own immutable virtual ledger;
- the same market events and execution simulator;
- independent costs and portfolio constraints;
- forward metrics from the moment it was registered—never backfilled;
- automatic retirement if invalid, stale, dominated or too expensive.

Dozens of small linear/tree challengers can shadow cheaply because feature vectors are computed once and shared. This makes better use of the Ryzen CPU without multiplying OKX/API traffic.

### 12.2 Autonomous hypothesis generator

The default generator must be deterministic and evidence-driven; no LLM is needed. It maps diagnostics to a small family of falsifiable experiments.

| Observed signature | Allowed generated hypothesis | Experiment |
|---|---|---|
| Many signals expire unfilled but would later win | Entry too passive | Compare fixed entry/TTL variants with identical future confirmation set |
| Fill rate high but immediate MAE is excessive | Adverse selection | Require trigger confirmation, delay, spread/liquidity gate or different order type |
| Stop-outs frequently reach target later | Stop/trigger mismatch | Test trigger quality first; then bounded stop multipliers with identical risk budget |
| Gross edge positive, net edge negative | Costs dominate | Maker-first policy, turnover reduction, liquidity floor, larger timeframe |
| Time stops dominate with low MFE | No follow-through | Shorter horizon, stricter momentum trigger or retire segment |
| One regime profitable, another negative | Regime interaction | Specialist model or explicit regime block |
| Probability deciles are monotonic but miscalibrated | Calibration drift | Refit Platt/beta/isotonic calibrator without changing ranking model |
| Probability ranking itself deteriorates | Model drift | Retrain baseline and constrained challengers |
| One asset family dominates losses | Poor transfer | Family-specific intercept/model or family exclusion challenger |
| Strong backtest but weak shadow | Simulator mismatch | Estimate execution residuals; do not tune signal features first |
| Feature ablation improves OOS | Correlated/noisy feature | Remove feature family and simplify model |
| Model is unstable across seeds/folds | Variance/overfit | More regularization, fewer features, or reject family |

Each hypothesis must state:

- the observed evidence and minimum sample;
- one primary metric;
- risk constraints;
- exact variables allowed to change;
- data partitions and embargo;
- maximum trials and compute;
- acceptance/rejection rules;
- expiry date if forward evidence does not arrive.

An optional tiny local LLM may summarize the experiment in natural language, but it may not invent the search space, select the winner, alter gates or read the hidden confirmation result before preregistration.

### 12.3 Allowed experiment classes

Run the cheapest, clearest tests first.

1. **Data/simulator correction:** timestamp alignment, fill ordering, costs and contract semantics. A bad simulator invalidates downstream optimization.
2. **Ablation:** remove one feature family, veto or management rule. Simplification is an improvement when OOS behavior is equal or better.
3. **Calibration-only:** keep rankings fixed and refit Platt, beta or isotonic calibration on valid OOF data.
4. **Threshold robustness:** test broad neighborhoods, not one optimum; seek stable plateaus.
5. **Playbook parameters:** trigger, entry TTL, stop, target ladder and horizon within bounded economically meaningful ranges.
6. **Segment specialization:** shared versus family/timeframe/regime-specific intercepts or models.
7. **Feature proposal:** add one causally available feature family at a time with an ablation requirement.
8. **Execution policy:** maker-first versus taker, participation limits, spread/depth gates and latency assumptions.
9. **Model family:** regularized logistic first, then shallow LightGBM challenger.
10. **Portfolio allocation:** only after each component has independent edge; optimize risk subject to drawdown and concentration.

Never let the daemon write arbitrary source code into the live engine. Strategy/model templates expose typed, bounded parameters. New feature code enters through reviewed/versioned modules and automated tests; autonomous search operates inside that approved surface.

### 12.4 Model ladder and lightweight frontier techniques

Promote complexity only when every simpler rung is beaten out of sample:

1. base-rate/no-trade and simple-rule baselines with empirical segment priors;
2. regularized logistic regression;
3. logistic model with a small set of validated interactions;
4. shallow LightGBM (`num_leaves`, depth, feature fraction and minimum leaf samples tightly bounded);
5. optional hierarchical/Bayesian partial pooling offline for low-sample instrument families;
6. approved ensemble of independently validated playbooks.

Do not use neural networks merely to consume CPU. With tabular OHLCV-derived features and limited independent trades, a small model is usually the stronger frontier choice.

Useful frontier-but-lightweight additions:

- **Bayesian beta-binomial posteriors** for segment hit rates and uncertainty, with explicit payoff statistics alongside them;
- **empirical-Bayes/hierarchical shrinkage** so BTC, ETH, alt swaps and tokenized equities can share strength without pretending they are identical;
- **split/rolling conformal intervals** for payoff uncertainty, used as a no-trade gate when intervals are too wide;
- **dynamic ensemble weighting** only among approved playbooks, using slowly updated OOS evidence, decay of stale evidence, and shrinkage toward equal weight;
- **ADWIN/Page-Hinkley** for alarms on calibration error, residuals and execution slippage;
- **contextual bandit allocation only in paper mode** after each arm is independently profitable: Thompson sampling may allocate a small exploration-risk budget among approved playbooks, never invent trade direction or bypass portfolio limits;
- **cross-sectional opportunity ranking:** rank liquid tradable instruments at the same point in time, retaining historical delisted instruments; use ranking for candidate allocation, not as proof of direction;
- **execution residual learning:** predict fill probability and slippage separately from direction using spread, depth, size/depth ratio, volatility, session and trade intensity.

### 12.5 Search design and anti-overfitting controls

Every autonomous search creates researcher degrees of freedom. Enforce:

- nested walk-forward validation: inner folds tune, outer folds estimate;
- purge/embargo based on each label’s actual event horizon;
- grouped holdouts by instrument/family;
- one untouched confirmation window per research campaign;
- permanent forward shadow evidence after campaign completion;
- complete trial count, including crashed, manually inspected and rejected runs;
- block bootstrap respecting temporal dependence;
- DSR/PBO after counting every tried configuration;
- label permutation and randomized-entry placebo;
- 1.5× and 2× fee/slippage stress;
- delayed-entry and missed-fill stress;
- parameter-neighborhood test: adjacent settings must not collapse;
- subgroup test: gains must not be one instrument/week/outlier;
- complexity penalty and “simpler wins ties” rule.

Do not optimize a single Sharpe ratio. Use constrained multi-objective selection:

```text
maximize: conservative net expectancy, calibrated log score, robustness
subject to: drawdown, expected shortfall, turnover, cost, concentration, latency
```

Maintain a Pareto set, then select the simplest candidate satisfying all constraints. A candidate that wins only through a tiny threshold change is rejected as brittle.

### 12.6 Experiment memory: the system must remember what it tried

Add durable tables/files.

#### `research_campaigns`

- campaign ID and parent campaign;
- triggering evidence IDs;
- preregistered hypothesis and experiment class;
- allowed search space and maximum trials;
- train/validation/confirmation/embargo boundaries;
- primary metric and constraints;
- code, feature, data, simulator and cost-model hashes;
- resource budget;
- start/end/status;
- final decision and machine-readable rejection reasons.

#### `experiment_trials`

- campaign/trial IDs and exact parameters;
- random seed;
- fold-level predictions and metrics;
- resource use and runtime status;
- failure/timeout reason;
- artifact hash;
- whether the trial was viewed or used in selection.

#### `model_registry`

- artifact and schema versions;
- required feature list/order;
- training manifest;
- OOF calibration artifact;
- supported playbook/market segments;
- OOS robustness report;
- lifecycle: `candidate`, `shadow`, `paper_champion`, `retired`, `rolled_back`, `invalid`;
- promotion/rollback event IDs.

#### `knowledge_findings`

Store structured findings, not free-text memory alone:

- statement such as `range_fade/EXPANSION is cost-negative`;
- support/opposition counts and date range;
- confidence/uncertainty;
- source campaigns;
- expiration/revalidation rule;
- current action (`block`, `downweight`, `monitor`, `none`).

A future experiment queries this memory to avoid repeating a rejected search on the same data. A previously failed idea may be retried only with materially new data, corrected simulator, or explicit changed assumption.

#### Concrete research database split and minimum schema

Keep high-frequency live state and experiment traffic isolated:

- `data/live.sqlite`: Node-owned orders, fills, positions, decisions, event offsets and outbox;
- `data/research.sqlite`: Python-governor-owned campaigns, trials, findings, artifacts, queue and leases;
- Parquet: immutable/batched market features, fold predictions and large metric arrays;
- model artifacts: content-addressed directories written to a temporary path and atomically renamed after checksum validation.

Both SQLite files use WAL, `busy_timeout`, foreign keys and explicit schema migrations. The live engine never waits for a research write lock.

Minimum research schema:

```sql
CREATE TABLE research_campaigns (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES research_campaigns(id),
  trigger_type TEXT NOT NULL,
  trigger_evidence_json TEXT NOT NULL,
  hypothesis_template TEXT NOT NULL,
  preregistration_json TEXT NOT NULL,
  data_snapshot_hash TEXT NOT NULL,
  feature_schema_hash TEXT NOT NULL,
  simulator_hash TEXT NOT NULL,
  cost_model_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  confirmation_vault_id TEXT,
  max_trials INTEGER NOT NULL,
  max_wall_seconds INTEGER NOT NULL,
  max_memory_mb INTEGER NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  decision_json TEXT
);

CREATE TABLE experiment_trials (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES research_campaigns(id),
  ordinal INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL,
  fold_metrics_uri TEXT,
  predictions_uri TEXT,
  artifact_hash TEXT,
  cpu_seconds REAL,
  peak_rss_mb REAL,
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(campaign_id, ordinal)
);

CREATE TABLE model_registry (
  artifact_hash TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES research_campaigns(id),
  model_type TEXT NOT NULL,
  playbook TEXT NOT NULL,
  segment_json TEXT NOT NULL,
  feature_schema_hash TEXT NOT NULL,
  calibration_hash TEXT,
  manifest_uri TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  allocation_fraction REAL NOT NULL DEFAULT 0,
  promoted_at INTEGER,
  retired_at INTEGER,
  parent_champion_hash TEXT
);

CREATE TABLE knowledge_findings (
  id TEXT PRIMARY KEY,
  finding_key TEXT NOT NULL,
  statement_json TEXT NOT NULL,
  support_json TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence REAL,
  valid_from INTEGER NOT NULL,
  expires_at INTEGER,
  source_campaign_id TEXT NOT NULL REFERENCES research_campaigns(id),
  superseded_by TEXT REFERENCES knowledge_findings(id)
);

CREATE TABLE campaign_queue (
  campaign_id TEXT PRIMARY KEY REFERENCES research_campaigns(id),
  priority INTEGER NOT NULL,
  not_before INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
```

Large OOF predictions do not belong in SQLite blobs; store Parquet paths plus checksums. Queue claim is one short `BEGIN IMMEDIATE` transaction that sets owner and lease expiry. A dead worker’s lease can be reclaimed. Trial completion and checkpoint URI are committed at every fold/trial boundary.

Preregistration is an immutable canonical JSON document containing search space, splits, vault ID, primary metric, constraints, gates and budget. Hash it before the first trial. Any change creates a child campaign rather than editing the running campaign.

### 12.7 Two data vaults prevent the autonomous loop from teaching to the test

1. **Exploration vault:** rolling history available to experiment generation and nested CV.
2. **Confirmation vault:** unseen chronological data released once to a preregistered campaign.
3. After release, that interval permanently joins explored data and can never confirm a descendant campaign.
4. **Forward shadow stream:** the strongest evidence; predictions are timestamped before outcomes and cannot be recomputed.

If insufficient fresh confirmation data exists, the candidate waits in shadow. The system must prefer waiting over repeatedly mining the same history.

### 12.8 Champion/challenger promotion state machine

```text
DRAFT
 -> REJECTED_SANITY
 -> VALIDATED_OFFLINE
 -> REJECTED_ROBUSTNESS
 -> SHADOW
 -> REJECTED_FORWARD
 -> PAPER_CANARY
 -> PAPER_CHAMPION
 -> DEGRADED
 -> ROLLED_BACK / RETIRED
```

1. Freeze current champion artifact and policy.
2. Train constrained challengers from a preregistered campaign.
3. Produce out-of-fold predictions and calibrate from OOF/validation only.
4. Replay with the production broker and portfolio risk logic.
5. Run anti-overfit and stress gates.
6. Shadow survivors with no decision influence.
7. Promote a survivor to a small **paper canary ledger** after forward gates.
8. Increase paper allocation in stages only while sequential evidence remains valid.
9. Promote to paper champion; archive previous champion for immediate rollback.
10. Any rollback trigger reduces allocation or selects no-trade without waiting for a research cycle.

Because this system is paper-only, promotion can be fully autonomous. If real-money execution is ever added, require a separate manually enabled adapter and approval boundary not covered by this plan.

### 12.9 Initial promotion gates

These are governance defaults, not promises of profitability. Thresholds must be declared before each campaign and may become stricter with experience.

- no leakage, determinism, data-quality or replay/live parity failure;
- positive outer-fold net expectancy with lower 95% block-bootstrap bound above zero;
- probability calibration better than the relevant base-rate model;
- monotonic predicted-probability deciles or explicit explanation for non-monotonicity;
- DSR probability above 0.95 after all campaign trials are counted;
- estimated PBO below 0.20;
- drawdown and expected shortfall inside the champion’s declared risk envelope;
- no critical subgroup with strong negative expectancy unless the model explicitly abstains there;
- result survives 1.5× costs for admission and 2× costs as a reported stress case;
- performance does not depend on one symbol, one week, one fold or a few tail wins;
- adjacent parameter settings retain most of the effect;
- shadow paper behavior remains inside the offline prediction interval;
- candidate improves a preregistered primary metric without materially degrading calibration, drawdown or turnover;
- compute/inference cost stays within the live latency and RAM budget.

### 12.10 Automatic rollback and no-trade logic

Rollback is as important as promotion. Trigger staged defensive action when:

- point-in-time feature schema/hash mismatch occurs;
- live feature distribution leaves the validated support region;
- rolling calibration error breaches its control limit;
- realized execution costs exceed model assumptions persistently;
- sequential lower confidence bound on net expectancy becomes negative;
- paper drawdown exceeds model-specific or portfolio budget;
- market-data lag/gaps make outcomes untrustworthy;
- challenger/champion artifact cannot be reproduced or loaded;
- model age exceeds policy and retraining cannot validate a replacement.

Actions in order:

1. stop new entries for affected segment;
2. continue safe management of existing positions;
3. fall back to prior valid champion if its support/gates remain valid;
4. otherwise enter explicit `NO_VALIDATED_MODEL` state;
5. launch diagnostic/research campaign when resources permit.

### 12.11 Resource-aware autonomous scheduler for the 8 GB Ryzen

The live engine always has priority. Add a `ResearchGovernor` process/service that measures:

- available system RAM and swap activity;
- engine RSS/heap and event-loop lag;
- OKX event backlog and candle-close latency;
- database write latency;
- current CPU load and logical core count;
- disk free space/compaction queue;
- running research job RSS/CPU/wall budget.

Default guardrails:

- one research process at a time;
- reserve at least two logical threads or 40% CPU for live/UI/OS, whichever is larger;
- start with two training threads and benchmark; never infer the Ryzen model/core count;
- research memory soft limit 2.5 GB and hard limit about 3 GB;
- pause/kill research when available RAM falls below 2 GB, swap thrashes, engine event lag exceeds its SLO, or market backlog grows;
- no Ollama resident during training/compaction;
- DuckDB/Polars streaming, projection pushdown and bounded batches;
- Optuna SQLite journal with hard trial/wall budgets and pruning;
- checkpoint fold/trial boundaries so an interrupted job resumes safely;
- lower OS priority (`nice`/systemd CPUWeight) for research workers;
- compact Parquet only when no training job is active;
- never pause live risk management to finish an experiment.

Suggested unattended cadence, trigger-driven rather than rigid:

| Cadence | Work | Typical cap |
|---|---|---|
| Continuous | prequential scoring, drift, shadow inference | milliseconds/event |
| Hourly | flush/compact small state, execution residuals | a few minutes, one thread |
| Daily low-load window | diagnostics, calibration refresh, linear baselines, ablations | 20–40 pruned trials, 1–2 threads |
| Weekly or evidence trigger | nested walk-forward campaign, constrained LightGBM, execution policies | bounded campaign, resumable |
| Monthly or sufficient fresh data | CPCV/PBO/DSR and confirmation-vault release | only shortlisted campaigns |

Do not retrain merely because a clock fired. Skip the cycle when too few independent labels arrived. Conversely, a strong drift/data-integrity event can immediately pause a segment without training a replacement.

#### Governor interface and concrete measurements

Use local SQLite heartbeats/leases rather than a network service:

```ts
interface ResearchCapacitySnapshot {
  at: number
  logicalCores: number
  cpuUsedPct1m: number
  availableRamMb: number
  swapInMbPerMin: number
  swapOutMbPerMin: number
  diskFreeMb: number
  diskFreePct: number
  engineRssMb: number
  engineHeapMb: number
  eventLoopP99Ms: number
  marketBacklog: number
  latestClosedBarLagMs: number
  liveDbP95WriteMs: number
  activeJob?: { campaignId: string; pid: number; rssMb: number; cpuPct: number; wallSec: number }
}

type GovernorDecision =
  | { action: 'START'; campaignId: string; threads: number }
  | { action: 'CONTINUE' }
  | { action: 'PAUSE'; reason: string }
  | { action: 'KILL_AND_REQUEUE'; reason: string }
  | { action: 'IDLE'; reason: string }
```

Implementation sources:

- Node: `process.memoryUsage()` for RSS/heap;
- Node: `perf_hooks.monitorEventLoopDelay()` for p99 loop delay;
- engine counters: received-versus-processed sequence/backlog and last confirmed-candle lag;
- Python: `psutil.virtual_memory()`, `psutil.cpu_percent()`, `psutil.swap_memory()`, `psutil.disk_usage()` and child `Process.memory_info()`;
- swap thrash: sample cumulative `sin/sout` deltas, not current swap occupancy alone;
- SQLite: measure commit latency in the repository wrapper;
- worker: report heartbeat, fold/trial checkpoint and peak RSS every 10–30 seconds.

Initial conservative thresholds to benchmark, then version as machine policy:

```text
START only if:
  available RAM >= 3500 MB
  CPU used over 1 minute <= 50%
  event-loop p99 <= 100 ms
  market backlog == 0
  latest closed-bar processing lag <= 2 s
  disk free >= max(10 GB, 15%)

PAUSE/stop launching trials if any persists for 3 samples:
  available RAM < 2500 MB
  CPU used > 80%
  event-loop p99 > 200 ms
  market backlog > 0
  live DB p95 write > 100 ms

KILL_AND_REQUEUE immediately or after graceful checkpoint timeout if:
  available RAM < 2000 MB
  job RSS > 3072 MB
  swap in/out delta > 64 MB/min for 2 samples
  closed-bar processing lag > 10 s
  disk free < 5 GB or < 8%
  campaign wall/trial budget exceeded
```

These are safety bootstrap values, not performance truths. Record every governor decision and refine only from observed live SLOs. A paused sklearn/LightGBM process is often unsafe to suspend indefinitely while holding RAM; prefer finishing the current fold within a short grace period, checkpointing, terminating and requeueing.

Linux launch example for the deployment host:

```text
nice -n 10 systemd-run --user --scope \
  -p MemoryHigh=2560M -p MemoryMax=3072M \
  -p CPUWeight=25 -p TasksMax=64 \
  python -m mycroft_research.worker --campaign <id> --threads 2
```

If user-scoped systemd is unavailable, use `nice`, explicit library thread variables (`OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `MKL_NUM_THREADS`, LightGBM `num_threads`) and an RSS watchdog that terminates the process group. The worker writes Parquet/checkpoints under `data/research/checkpoints/<campaign>/<trial>/`; completed artifacts are checksum-verified then atomically moved into `data/models/<sha256>/`.

Communication contract:

1. Node writes one health snapshot row every 10 seconds to a tiny `health.json` via atomic rename or a dedicated metrics table in `live.sqlite`.
2. Governor reads health plus `psutil`, claims queue leases in `research.sqlite`, and launches workers.
3. Worker never writes `live.sqlite`; it reads immutable snapshots/Parquet and writes only `research.sqlite` plus artifact files.
4. Node reads only `model_registry` artifacts in promotable states and validates schema/checksum before shadow load.
5. Promotion writes an immutable request; Node atomically swaps active artifact at a candle boundary and records success/failure.

### 12.12 Autonomous research daemon pseudocode

```text
on outcome_closed(outcome):
    reconcile_and_score_prequential(outcome)
    update_failure_taxonomy(outcome)
    update_drift_monitors(outcome)
    evaluate_rollback_gates()
    maybe_enqueue_campaign_trigger()

research_daemon:
    while true:
        if !governor.has_safe_capacity(): sleep
        trigger = campaign_queue.next_eligible()
        if !trigger: run_cheap_diagnostics_or_sleep()

        hypothesis = templates.generate(trigger, knowledge_findings)
        campaign = preregister(hypothesis, data_boundaries, budget, gates)
        if sanity_checks_fail(campaign): reject_and_remember()

        trials = run_nested_walk_forward_with_pruning(campaign)
        finalists = pareto_filter_then_prefer_simple(trials)
        for candidate in finalists:
            run_placebo_stress_pbo_dsr(candidate)
            if all_offline_gates_pass(candidate): register_shadow(candidate)
            else: reject_and_remember(candidate)

shadow_daemon:
    score_all_shadow_models_from_shared_features()
    close_virtual_ledgers_with_same_broker()
    retire_dominated_or_expired_models()
    if forward_gates_pass(): promote_to_paper_canary()
    if canary_gates_pass(): promote_to_paper_champion()
    if rollback_gate_fires(): rollback_or_no_trade()
```

### 12.13 What “learning from every trade” should mean

A single trade updates evidence and diagnostics; it does not rewrite the model. Immediate safe adaptations are limited to:

- portfolio equity and available risk;
- order/position state;
- drift/calibration statistics;
- Bayesian/shrunk monitoring distributions;
- kill-switch state.

Model, feature, threshold, stop, target and playbook changes occur only through campaigns. This separation is what permits full autonomy without uncontrolled self-modification.

Store rejected experiments and trial count forever; otherwise selection-bias corrections and system memory are meaningless.

---

## 13. AI policy and monthly budget

### Recommendation

Use no LLM in signal generation, probability estimation, sizing, or order management. Deterministic statistics and small supervised models are cheaper, reproducible, and testable.

Use AI only for:

- summarizing deterministic failure attribution;
- weekly/monthly portfolio review;
- translating reason codes into user-facing language;
- querying the journal in natural language;
- drafting research hypotheses that still require offline validation.

### Local option

Ollama lists Qwen3 0.6B Q4 at a 523 MB model file and Qwen3 1.7B Q4 at 1.4 GB. File size is not total runtime RAM; KV cache and process overhead add memory. On an 8 GB machine:

- default to no resident model;
- load `qwen3:0.6b-q4_K_M` on demand for summaries;
- cap context around 4k and unload after inactivity;
- consider 1.7B only after measuring total RSS while the full app runs;
- never use a tiny local LLM as a numerical market oracle.

### Paid option

Keep Gemini as an opt-in report generator. Add:

- token and estimated-cost ledger per request;
- configurable pricing table and currency conversion;
- hard monthly stop at €8, leaving safety under the €10 budget;
- daily/request caps;
- batch/flex use for non-urgent reports when available;
- cache by immutable report inputs;
- zero automatic retry storms.

Current Gemini counters track tokens but do not enforce a monetary budget. Model prices change, so read them from configuration and update from the official pricing page rather than hard-coding this document’s snapshot.

---

## 14. Recommended libraries

Add dependencies only when the implementation phase begins and pin vetted versions at least seven days old.

| Purpose | Recommendation | Reason |
|---|---|---|
| Transactional event store | SQLite WAL (`better-sqlite3` or a small service boundary) | Durable, local, low RAM, easy backup |
| Historical format | Apache Parquet | Columnar compression and portability |
| Research query | DuckDB | Queries Parquet directly with projection/filter pushdown |
| Dataframes | Polars lazy/streaming | Batch execution lowers memory pressure |
| Baseline ML | scikit-learn | Logistic regression, calibration, metrics, pipelines |
| Nonlinear challenger | LightGBM | Histogram training is fast and memory efficient; constrain complexity |
| Optimization | Optuna, tightly bounded | Efficient search/pruning; trial ledger required for bias correction |
| Drift monitor | River ADWIN/Page-Hinkley | Lightweight streaming alarms; never direct auto-promotion |
| Statistical tests | SciPy/statsmodels plus custom block bootstrap | Confidence intervals and diagnostics |
| Testing TS | Vitest + fast-check | Unit and property tests for math/state machines |
| Testing Python | pytest + Hypothesis | Dataset, label and simulator invariants |
| Local narrative | Ollama Qwen3 0.6B Q4, optional | Fits resource constraint for text summaries |

Do not begin with a heavyweight trading framework or deep-learning stack. The key requirement is one consistent execution model, not library count.

---

## 15. Implementation plan by phase

### Phase 0 — freeze, measure, and repair truth

**Goal:** obtain a trustworthy baseline before changing strategy behavior.

1. Tag/freeze the current heuristic policy with code/config hash.
2. Back up Convex signals.
3. Fix open-state query to include `tp1`; add migration and regrade recoverable rows.
4. Mark irrecoverable rows where required candle history is unavailable; do not fabricate outcomes.
5. Add test runner and fixtures.
6. Add unit tests around `gradeSignal` covering TP1 -> TP2/TP3, TP1 -> BE, time exit, restart, duplicate calls, ambiguous bars, gaps, and partial allocations.
7. Remove or relabel uncalibrated `win probability` and `expectancy` UI.
8. Make frontend TypeScript errors fail builds.
9. Document current baseline outcome metrics with sample sizes.

**Files first touched:**

- `frontend/convex/signals.ts`
- `frontend/convex/schema.ts`
- `engine/src/journal.ts`
- `engine/src/runtime.ts`
- `frontend/app/journal/page.tsx`
- `frontend/components/terminal/decision-card.tsx`
- both `package.json` files and test configs

**Exit gate:** deterministic journal tests pass and all non-terminal positions continue grading.

### Phase 1 — durable data and event schema

1. Add local SQLite migrations and repositories.
2. Add Parquet writer/compactor and disk quota.
3. Persist confirmed 1m bars, relevant market snapshots, metadata revisions and quality events.
4. Invoke and test gap repair; add sequence/clock checks.
5. Add explicit event timestamps and availability timestamps.
6. Persist immutable decisions and feature snapshots.
7. Migrate Convex in four explicit steps: (a) dual-write local events plus current Convex rows, (b) backfill/check counts and checksums, (c) switch journal/UI reads to engine APIs backed by local truth, (d) keep only optional summary/config outbox sync.
8. During dual-write, a Convex failure remains queued in the outbox and never rolls back a valid local event.
9. Add restart/replay integration test.

**New modules:**

```text
engine/src/db/
engine/src/data/archive.ts
engine/src/data/quality.ts
engine/src/data/bar-builder.ts
engine/src/outbox/
```

**Exit gate:** kill/restart does not lose open state or duplicate market/decision events; point-in-time history is queryable.

### Phase 2 — paper execution and portfolio risk

1. Define broker interfaces and state machine.
2. Implement conservative bar fill model first.
3. Implement pending entries, TTL, partial fills, bracket exits, BE/trailing/time exits.
4. Implement fee/funding/slippage/gap accounting.
5. Implement portfolio limits and kill switches.
6. Replace journal grader with broker-derived immutable fills and reconciliation.
7. Add OKX Demo adapter only after local broker invariants pass.
8. Add execution UI: pending orders, fills, positions, exposure, realized/unrealized PnL and data halt.

**New modules:**

```text
engine/src/execution/types.ts
engine/src/execution/paper-broker.ts
engine/src/execution/fill-model.ts
engine/src/execution/portfolio-risk.ts
engine/src/execution/okx-demo.ts
engine/src/execution/reconcile.ts
```

**Exit gate:** historical replay and live paper produce identical state transitions for the same ordered market events.

### Phase 3 — explicit strategy registry

1. Preserve current indicators only as a feature library.
2. Add playbook interface with prerequisites/setup/trigger/order/invalidation/horizon.
3. Implement three initial playbooks separately.
4. Add regime hysteresis and explicit unknown state.
5. Store every candidate and rejection.
6. Run full analysis only on top scanner candidates, not only manually watched symbols.
7. Implement scanner alert scope or remove it from the schema/UI.

**New modules:**

```text
engine/src/strategy/types.ts
engine/src/strategy/registry.ts
engine/src/strategy/trend-pullback.ts
engine/src/strategy/volatility-breakout.ts
engine/src/strategy/range-fade.ts
engine/src/regime/
```

**Exit gate:** each issued candidate belongs to exactly one versioned playbook and has an executable order specification.

### Phase 4 — research and honest validation

1. Build point-in-time datasets from Parquet/events.
2. Implement actual-trade labels and lower-timeframe ambiguity handling.
3. Implement event-driven historical runner using the same broker semantics.
4. Add purged walk-forward and held-out-symbol evaluation.
5. Add baselines, placebo tests, block bootstrap, DSR and PBO.
6. Reproduce the frozen current heuristic as a baseline.
7. Produce machine-readable evaluation manifests.

**New tree:**

```text
research/
  pyproject.toml
  mycroft_research/
    dataset.py
    features.py
    labels.py
    replay.py
    validation.py
    metrics.py
    baselines.py
    reports.py
  tests/
```

**Exit gate:** no candidate is called an edge without untouched net OOS results and uncertainty.

### Phase 5 — autonomous research, calibrated models and promotion

1. Train per-playbook regularized logistic baselines and calibrate only from OOF/validation predictions.
2. Add constrained LightGBM challengers only after linear baselines and sample gates.
3. Implement `ResearchGovernor`, campaign queue, resource limits, resumable workers and process telemetry.
4. Implement deterministic evidence-to-hypothesis templates and preregistration manifests.
5. Add exploration/confirmation vault boundaries and prevent confirmation reuse by descendants.
6. Add durable campaign, trial, finding, artifact and promotion registries.
7. Add all-trial DSR/PBO accounting, placebos, cost stress, neighborhood stability and paired comparisons.
8. Add shared-feature shadow inference and independent virtual ledgers.
9. Implement `DRAFT -> VALIDATED -> SHADOW -> PAPER_CANARY -> PAPER_CHAMPION` transitions.
10. Implement automatic rejection, retirement, staged paper allocation, rollback and `NO_VALIDATED_MODEL`.
11. Add daily/weekly trigger-driven jobs; skip campaigns when fresh independent evidence is insufficient.
12. Compare AI-reviewed versus quant-only signals; disable paid AI automatically if it adds no measured forward value.

**New modules/services:**

```text
research/mycroft_research/campaigns.py
research/mycroft_research/hypotheses.py
research/mycroft_research/optimizer.py
research/mycroft_research/calibration.py
research/mycroft_research/robustness.py
research/mycroft_research/registry.py
research/mycroft_research/governor.py
research/mycroft_research/worker.py
engine/src/models/artifact-loader.ts
engine/src/models/shadow-runner.ts
engine/src/models/promotion.ts
engine/src/monitoring/prequential.ts
engine/src/monitoring/drift.ts
```

**Exit gate:** an unattended synthetic campaign can trigger, preregister, train, reject/promote to shadow, accumulate forward outcomes, canary-promote, roll back and reproduce every decision from immutable manifests while the live engine stays within latency/RAM limits.

### Phase 6 — local operations and product hardening

1. Keep the engine local/private and add no public-deployment work.
2. Validate every request and configuration patch against typed bounds before persistence.
3. For this private-machine deployment, remove the hosted-preview Python proxy after confirming the streaming route reaches Next/engine directly; if that host-specific path must remain, isolate it from the research environment and retain only FastAPI/Uvicorn/HTTPX/dotenv.
4. Add readiness/liveness/degraded health checks.
5. Expose RSS/heap, event lag, data gaps, queue depth, DB latency, disk quota, experiment load and API/AI spend.
6. Add automatic backups, retention checks and a tested restore drill.
7. Add end-to-end browser tests for decisions, orders, positions, journal filters, model versions and kill switch.
8. Replace “institutional-grade” claims with measured capability/status.

---

## 16. Test matrix

### Quant/data

- indicator outputs against known fixtures/library references;
- no feature changes when post-decision candles are appended;
- no unconfirmed candle enters a decision snapshot;
- multi-timeframe bars use only completed parent intervals;
- synthetic trend/range/random-walk tests;
- missing, duplicate, malformed and out-of-order candles;
- feature invariance across replay/live path.

### Execution

- gap through entry/stop/TP;
- stop and target in same parent bar resolved with 1m path;
- maker/taker and every partial fee;
- exact funding boundary;
- partial entry then stop;
- TP1 then BE, TP2 then trail, full target;
- order expiry and cancellation race;
- restart after every state transition;
- duplicate event/idempotency;
- portfolio limits under simultaneous signals;
- stale data halts entries but manages existing risk.

### Research

- purging removes overlapping labels;
- embargo boundaries;
- shuffled labels return baseline performance;
- trial counts flow into DSR/PBO;
- calibration uses no test labels;
- simulator/live parity golden files;
- deterministic seeded runs;
- no survivorship from today’s universe membership.

### Autonomous improvement

- campaign cannot read a confirmation vault before preregistering boundaries and gates;
- released confirmation data cannot confirm a descendant campaign;
- every attempted, failed and pruned trial is counted;
- one failed promotion gate prevents state transition;
- shadow predictions cannot be backfilled or edited;
- canary allocation increases only at declared evidence checkpoints;
- rollback restores the exact prior artifact/config atomically;
- no valid fallback enters `NO_VALIDATED_MODEL` and emits no new entries;
- repeated rejected hypothesis is suppressed until new evidence/assumption qualifies it;
- research worker is paused/killed under simulated RAM, CPU, event-lag and disk pressure;
- killed campaign resumes at a checkpoint without duplicating trials;
- live event processing remains inside its latency SLO during maximum research load.

### API/UI/local operations

- invalid settings and experiment mutations rejected by schema validation;
- secrets absent from responses/logs;
- Convex unavailable but local operation continues;
- dashboard displays source/model/config age and denominators;
- kill switch is visible and auditable;
- local backup can restore orders, positions, model registry and experiment history.

---

## 17. Resource and operating budget

Target steady-state on the 8 GB ThinkCentre:

| Process | Target behavior |
|---|---|
| Node live engine | under ~500 MB RSS under normal configured universe |
| Next.js production server | under ~350 MB RSS; do not run dev mode 24/7 |
| SQLite + research governor | separate `live.sqlite`/`research.sqlite`; bounded caches; governor kept lightweight |
| Python research worker | one bounded job, start at 2 threads, 2.5 GB soft/~3 GB hard memory, then exits |
| Shadow inference | shared feature vectors; cap active challengers and retire dominated models |
| Ollama | not resident; 0.6B on demand; unload after idle; disabled during research jobs |
| Total during normal live operation | target application RSS ~1–1.5 GB before browser/OS; measure rather than assume |
| Total during training | live app + OS + one <=3 GB worker; governor must preserve >=2 GB available RAM |

An 8 GB host does not have room for the 3 GB research worker and a resident 1–3 GB LLM simultaneously. Training, Ollama and heavy compaction are mutually exclusive resource classes. Start jobs only with at least 3.5 GB available, then terminate/requeue before available memory falls below 2 GB. RSS targets are acceptance budgets to profile on the actual Ryzen machine, not claims about current measured usage.

Operational rules:

- scanner concurrency configurable; profile before reducing blindly;
- compute closed-bar features once per new bar, not every four seconds;
- update only microstructure/live PnL between bars;
- cache feature snapshots by candle-close ID;
- do not run full deep analysis over the entire universe every minute;
- batch database and Convex writes;
- compact Parquet off-peak;
- hard disk and AI spending quotas;
- hard campaign limits for trials, wall time, memory and artifact count;
- expire dominated shadow models so autonomy does not become unbounded process growth;
- reserve a fixed paper exploration budget; research can never borrow from portfolio safety reserves.

---

## 18. What not to do

- Do not optimize for win rate alone.
- Do not add more indicators before validating the existing feature families.
- Do not train on six, twelve, or fifteen trades and call it learning.
- Do not use random train/test splits on overlapping financial labels.
- Do not let an LLM invent prices, probabilities, or change orders.
- Do not use reinforcement learning against the current unrealistic simulator.
- Do not auto-promote directly to real-money trading.
- Do not tune all assets/timeframes with one parameter set and report only the best.
- Do not silently discard failed experiments or irrecoverable journal rows.
- Do not claim “exact replay,” “probability,” or “institutional grade” unless the implementation and evidence support those terms.

---

## 19. External basis and useful references

Primary/official references used to shape this plan:

1. **OKX API v5 documentation** — demo trading, order channels, order endpoints, public market data and candle/history behavior: <https://app.okx.com/docs-v5/en/>
2. **Bailey, Borwein, López de Prado & Zhu — Probability of Backtest Overfitting**: <https://doi.org/10.21314/jcf.2016.322>
3. **Bailey & López de Prado — Deflated Sharpe Ratio**: <https://doi.org/10.3905/jpm.2014.40.5.094>
4. **DuckDB direct Parquet querying**: <https://duckdb.org/docs/current/guides/file_formats/query_parquet>
5. **Polars streaming execution**: <https://docs.pola.rs/user-guide/concepts/streaming/>
6. **LightGBM memory/speed design and small-data overfit warning**: <https://lightgbm.readthedocs.io/en/latest/Features.html>
7. **Optuna samplers and pruning**: <https://optuna.readthedocs.io/en/stable/tutorial/10_key_features/003_efficient_optimization_algorithms.html>
8. **River ADWIN drift detection**: <https://riverml.xyz/dev/api/drift/ADWIN/>
9. **Ollama Qwen3 model sizes**: <https://ollama.com/library/qwen3/tags>
10. **Gemini Developer API pricing**: <https://ai.google.dev/gemini-api/docs/pricing>

---

## 20. Definition of success

The rework is successful when:

- every suggested plan becomes a traceable pending order, fill, position, or unfilled expiry;
- historical replay and live paper share execution semantics;
- journal results reconcile from immutable fills and costs;
- probabilities are demonstrably calibrated out of sample;
- strategy changes are generated, tested, shadowed, promoted, retired and rolled back autonomously under predefined statistical/risk gates;
- every experiment—including failures—has a reproducible manifest and becomes structured system memory;
- every signal identifies its data, feature, strategy, model and config version;
- the system survives restart and cloud outage without corrupting positions;
- resource and AI budgets are enforced automatically;
- the dashboard communicates uncertainty and sample size;
- the system can conclude “no validated edge” and remain out of the market.

That last capability is essential. The best possible tool is not the one that produces the most confident trades; it is the one that refuses to invent confidence, executes its paper plans faithfully, learns only from trustworthy evidence, and stops itself when the evidence degrades.
