# USING MYCROFT

A short, accurate guide: what runs by itself, what you may want to run by hand, how to
read the numbers, and where extra quality comes from.

---

## 1. The one-minute mental model

The system is a loop, and every step of it is visible in the dashboard:

```
record evidence  ->  breed & test policies  ->  train deep models  ->  promote on
proof  ->  place probe/paper trades  ->  learn from the outcome  ->  repeat
   (Autopilot)          (Arena)              (Brain)          (Evolution)   (Advisor/Journal)
```

Nothing needs to be started by hand. The **orchestrator** picks the single most
valuable next action every 30 seconds and shows you what it chose and why.

---

## 2. What runs automatically, 24/7

| Cadence | What happens |
|---|---|
| 6 s | tickers refresh; 1900+ instruments tracked |
| 4 s / 5 s | focus instrument + watchlist rotation analysed |
| 15 s | scanner scores the liquid universe, then runs the FULL pipeline on the strongest rows across 15m/30m/1H/4H |
| 10 s | paper broker advances every open position bar by bar |
| 10 s | order-book snapshots (used for real spread/depth and the execution simulator) |
| 30 s | **orchestrator tick**: coverage, breeding, arena re-verification, brain training, promotion, news |
| 20 s | advisor feed rebuilt and ranked |
| 30 s / 60 s | regime detection, volatility forecast |
| 15–30 min | market context, cross-asset, on-chain |
| 45 min | news + macro digest (one cached Gemini call) |
| 1 h | online SQLite snapshot, newest 12 kept |
| ~20 h | nightly post-mortem report |

---

## 3. What you may want to run manually

All of these are buttons in the UI; none of them are required.

| Where | Button | When to use it |
|---|---|---|
| **Autopilot** | `run next action` | You want to see the next improvement step immediately instead of waiting for the tick |
| **Autopilot** | `refresh news` | Something big just happened and you want the risk signal updated now |
| **Autopilot** | `post-mortem` | You want the written what-worked / what-failed report on demand |
| **Evolution** | `record evidence` | A niche is starved (shown in *Coverage gaps*) and you want tape for it now |
| **Evolution** | `evolve now` | Force a breeding + arena campaign on the selected niche |
| **Evolution** | `promote / demote` | Run the lifecycle pass immediately |
| **Evolution** | `promote` / `retire` on a card | Manual override of one specialist. Use sparingly: it bypasses the evidence gates |
| **Arena** | `test all exits` | Compare all 10 exit policies over the recorded decisions of a niche |
| **Arena** | click any campaign row | Full equity curve, per-fold consistency, per-regime and per-symbol breakdown |
| **Brain** | `train GBM + MLP` | Force a supervised campaign on a niche |
| **Brain** | `train PPO exit agent` | Force reinforcement learning on that niche's recorded price paths |
| **Settings** | anything | Every knob is validated before it is saved; a rejected patch changes nothing |

Command line equivalents (useful for cron or a smoke test):

```bash
curl -X POST https://<domain>/api/orchestrator/run -d '{"kind":"tick"}'          -H 'Content-Type: application/json'
curl -X POST https://<domain>/api/orchestrator/run -d '{"kind":"tape_build"}'    -H 'Content-Type: application/json'
curl -X POST https://<domain>/api/orchestrator/run -d '{"kind":"breed","playbook":"trend_pullback","instType":"SWAP","timeframe":"30m"}' -H 'Content-Type: application/json'
curl -X POST https://<domain>/api/brain/train      -d '{"kind":"rl","playbook":"range_fade","instType":"SWAP","timeframe":"1H"}'         -H 'Content-Type: application/json'
```

---

## 4. How to read the numbers (the only ones that matter)

* **lift** — mean net R of the trades the model took minus the mean net R of taking
  every candidate, out of sample. This is the single number that proves selection adds
  value. Anything at or below 0 means the model is decoration.
* **OOS trades** — how many out-of-sample trades the verdict rests on. Under ~30, treat
  the result as noise no matter how good it looks.
* **folds** — e.g. `4/4 folds` means the edge appeared in every walk-forward window, not
  just one lucky month. `2/4` is a warning.
* **placebo** — the fitness the identical search achieved on shuffled features. If the
  real result is not clearly above it, the search found noise and the birth is rejected.
* **held-out symbol** — the result on an instrument excluded from every fold. Positive
  here is the strongest evidence the model generalises.
* **forward** — real closed paper/simulated trades attributed to that exact artifact.
  `no trades yet` on a fresh canary is normal; it needs live time.
* **p** — probability the mean R is a coincidence. Below 0.1 is the gate.
* **skill badges** — the regimes, sessions and symbols where that specialist measurably
  makes money. The committee amplifies a specialist when the live context matches one of
  its skills and cuts it when the context is one it loses in.

**Validation states**

| State | Meaning |
|---|---|
| `NO_VALIDATED_MODEL` | Nothing has cleared any gate. Honest, not a bug |
| `ARENA_VALIDATED_PENDING_FORWARD` | At least one specialist proved an out-of-sample edge and is now collecting live evidence |
| `VALIDATED` | At least one champion: arena edge **and** positive forward evidence |

---

## 5. Where more quality comes from

Ordered by how much they matter, highest first.

1. **Let it run.** Everything compounds: more recorded decisions -> better folds ->
   fewer false positives -> more real champions. The first 24 hours are mostly
   evidence collection.
2. **A working OKX demo key.** Not needed for learning, but it turns modelled fills
   into measured ones. Create it on **OKX -> Demo Trading -> Personal Center -> Demo
   Trading API** (a live key gives `50119`).
3. **Disk, not RAM.** Keep the candle history growing; two years of bars are kept by
   default. The whole arena runs off local data, so history is free performance.
4. **Widen the universe carefully.** `Settings -> scanner -> universeSize` and
   `deepScanTop` control how many instruments get the full pipeline. More instruments
   means more independent evidence, which is worth more than more history on one
   symbol. Keep `includeEquities` and `includeStables` off: tokenized equities gap over
   weekends and stable/stable pairs make every volatility feature meaningless.
5. **Exploration rate.** `Settings -> evolution -> explorationRate` (default 0.30) is
   how much of the arming budget buys information rather than chasing the best-looking
   setup. If a niche never gets forward evidence, raise it. If you want fewer, better
   trades once champions exist, lower it.
6. **Give the brain more epochs.** On a quiet box, `epochs` on the PPO agent and the
   number of folds can go up. The governor will still pause training if RAM or load
   spikes.
7. **Don't touch `minLift`.** Lowering the birth gate is the fastest way to fill the
   population with noise.

---

## 6. Things that are deliberately NOT automated

* **No real orders.** There is no live-trading code path. The advisor tells you what to
  do; you decide.
* **No auto-tuning of risk.** Position sizing, daily loss limits and gross exposure are
  yours to set in Settings.
* **No promotion without forward evidence.** An arena edge alone never makes a
  champion, however good it looks.

---

## 7. Cost control

* Gemini is used for exactly two things: the hourly batched news/macro digest on the
  cheapest capable model, and the nightly post-mortem. Digests are cached by the hash of
  the headline set, so a restart or a fast interval costs nothing.
* The hard monthly budget lives in `Settings -> aiMonthlyBudgetEur` (max €10). Every
  call checks the running spend first and simply does not fire when the cap is reached.
* Expect roughly €0.50–3 per month at the default cadence.

---

## 8. Health check in 10 seconds

Open **Autopilot**. The system is healthy when:

* the intent queue is non-empty and `cycles` keeps rising,
* recent actions show `tape_build` and `breed` results (including honest rejections),
* engine RSS stays under ~1.4 GB and free RAM stays above ~400 MB,
* **Evolution** shows the born count and top generation increasing over days,
* **Arena** gains new campaigns,
* **Journal** starts filling with closed paper trades.

If the queue says *waiting for resources*, that is the governor protecting the live
loop. It resumes on its own.
