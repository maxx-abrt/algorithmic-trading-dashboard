# COOLIFY DEPLOYMENT

Three containers, one persistent directory, zero manual steps after the first deploy.

```
  engine    :8790   market truth, decisions, arena, orchestrator, SQLite
  brain     :8791   LightGBM + PyTorch MLP + PPO exit agent (reads the same SQLite)
  frontend  :3000   dashboard  (this is the only service that needs the domain)
```

---

## 1. On the host, once

SSH into the machine that runs Coolify and create the persistent directories. Both
containers mount the same `data` directory: the engine writes the database, the
brain writes its model artifacts into `data/brain`. One backup of this directory is
a complete backup of everything the system has ever learned.

```bash
sudo mkdir -p /opt/mycroft/data /opt/mycroft/backups
sudo chmod -R 777 /opt/mycroft          # containers run as non-root in some images
```

If you are migrating from an older single-container deployment, copy the existing
database in before the first deploy:

```bash
sudo cp /path/to/old/mycroft.sqlite /opt/mycroft/data/mycroft.sqlite
```

---

## 2. In Coolify

1. **New Resource → Docker Compose**, point it at this repository, branch `main`,
   compose file `docker-compose.yml`. Coolify reads all three services from it, so
   you do not create them one by one.
2. **Domain**: attach your domain to the **frontend** service, port **3000**.
   Do not expose `engine` or `brain` publicly — the frontend proxies `/api/*` to the
   engine internally, and the brain is only reachable from the engine.
3. **Environment variables** (Coolify → the resource → Environment). Copy exactly:

```env
# ── engine ────────────────────────────────────────────────────────────────────
DEFAULT_EQUITY_USD=10000
RESEARCH_MAX_RSS_MB=1400
RESEARCH_MAX_LOAD=6

# ── Google Gemini (news digest + nightly post-mortem) ─────────────────────────
GEMINI_API_KEY=<your AI Studio key>
GEMINI_MODEL=gemini-2.5-flash
GEMINI_CHEAP_MODEL=gemini-3.1-flash-lite

# ── Telegram companion (optional) ─────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=<botfather token>
TELEGRAM_CHAT_ID=<your chat id>

# ── OKX (public data needs NO keys; DEMO keys only measure fill quality) ───────
OKX_API_KEY=<demo trading key>
OKX_API_SECRET=<demo trading secret>
OKX_API_PASSPHRASE=<demo trading passphrase>
OKX_SIMULATED=true

# ── brain sidecar sizing for an 8 GB / 4-core box ─────────────────────────────
BRAIN_MAX_RSS_MB=2200
BRAIN_THREADS=3
BRAIN_WORKERS=1

# ── optional Convex mirror (leave empty to keep SQLite as the only truth) ─────
CONVEX_URL=
CONVEX_MIRROR=
WORKER_API_KEY=
```

4. **Deploy.** First build takes ~8–12 minutes (the brain image installs CPU PyTorch
   and LightGBM). Later deploys are cached and take about a minute.
5. **Nothing else.** No volumes to click, no extra services, no cron. The compose
   file declares the bind mounts, the healthchecks and the pre-deploy backup.

---

## 3. What to expect after the first deploy

| minute | what happens |
|--------|--------------|
| 0–2    | universe + tickers load, WebSocket feeds connect, scanner starts |
| 2–20   | the orchestrator records the decision tape: real bars replayed through the live pipeline for every playbook × market × timeframe |
| 20–40  | first breeding runs: policies are evolved and tested in the arena with purged walk-forward folds. Specialists that beat the baseline become canaries |
| 40–90  | the brain trains LightGBM + MLP + ensemble, then a PPO exit agent, on the same recorded decisions |
| hours  | live probe trades accumulate forward evidence; canaries with positive forward R become champions; decayed champions are re-verified and rolled back |

Watch **Autopilot** in the dashboard: it shows the intent queue (what the system has
decided to do next and why), the job history with results, execution quality, and the
news signal.

---

## 4. Resource budget on an 8 GB / 4-core ThinkCentre

| container | limit | typical |
|-----------|-------|---------|
| engine    | 2.0 GB | 300–600 MB |
| brain     | 2.5 GB | 350 MB idle, 1.2–2.0 GB while training |
| frontend  | 768 MB | 120 MB |
| host / OS | —      | ~800 MB |

Total ceiling ≈ 5.3 GB, leaving headroom for the page cache that SQLite depends on.
Both the engine and the brain refuse to start heavy work when free RAM drops below
~400 MB or the 1-minute load average exceeds `RESEARCH_MAX_LOAD`, so training always
yields to the live decision loop.

CPU: training is deliberately allowed to use most of the box (`BRAIN_THREADS=3` on a
4-core machine) because every heavy loop yields to the event loop between units of
work. If you ever see the dashboard lag, drop `BRAIN_THREADS` to 2.

---

## 5. Backups and restore

* The engine writes an online SQLite snapshot to `/opt/mycroft/backups` every hour and
  keeps the newest 12.
* `pre-deploy-backup` copies the database before every deploy.
* If `/opt/mycroft/data` is ever empty on boot, the engine automatically restores from
  the newest snapshot and says so in the log and on the Ops page.

Restore by hand:

```bash
sudo systemctl stop docker   # or stop the resource in Coolify
sudo cp /opt/mycroft/backups/<snapshot>.sqlite /opt/mycroft/data/mycroft.sqlite
```

---

## 6. OKX demo keys — the one thing that needs care

Demo (simulated) trading keys are **not** the same as live API keys and are created on
a different page:

> OKX → **Demo Trading** → Personal Center → **Demo Trading API** → create key

A live key, a deleted key, or a key from another account all fail with
`50119 API key doesn't exist`. The dashboard shows that diagnosis verbatim on the
Advisor and Autopilot pages.

**This never blocks learning.** With no working key the engine uses its internal
execution simulator, which models spread, depth consumption, partial fills, queue risk
and latency from the live order book, and every fill statistic it produces is shown in
Autopilot → Execution quality. A valid demo key simply adds real venue fills next to
the modelled ones so the two can be compared.

---

## 7. Health checks

```bash
curl -s https://<your-domain>/api/health | jq '{population, orchestrator, execution: .execution.mode, brain: .brain.reachable}'
curl -s https://<your-domain>/api/orchestrator | jq '.state.lastTask'
curl -s https://<your-domain>/api/arena | jq '.runs[0]'
```

The system is healthy when `orchestrator.cycles` keeps rising, `population.tapeRows`
keeps growing, and `arena` gains new runs. `NO_VALIDATED_MODEL` is a legitimate
state: it means nothing has cleared every gate yet, which is the honest answer until
it does.
