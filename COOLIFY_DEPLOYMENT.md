# Coolify deployment

MYCROFT runs as two services from `docker-compose.yml`:

- `engine`: OKX public-data collector, quantitative analysis, paper broker, SQLite truth store, and bounded research worker
- `frontend`: Next.js dashboard; `/api/*` is rewritten internally to `engine:8790`

There is no trade service and no OKX private credential requirement.

## Coolify setup

1. Create a Docker Compose application from this repository and the `main` branch. The provided `Dockerfile`s now use Node 22, so no extra build configuration is needed.
2. Route the public domain to `frontend` port `3000`. Do not expose engine port `8790` publicly.
3. Keep the named volumes `mycroft-data` and `mycroft-backups` persistent.
4. Set optional secrets in Coolify, never in Git:
   - `GEMINI_API_KEY` for budget-capped summaries/risk critique only
   - `GEMINI_MODEL` (default `gemini-2.5-flash`)
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` only if notifications are wanted
5. Leave all `OKX_API_*` variables unset. Public market data needs no credentials and the codebase has no order endpoint.
6. If you deploy the services as individual Nixpacks applications instead of Docker Compose, the `package.json` `engines.node` and `.nvmrc` files are set to `22`, so Nixpacks will use Node 22 and the build will no longer fall back to EOL Node 18.
7. Deploy, then verify:
   - `/api/health` returns `ok: true`
   - `ws.public.healthy` and `ws.business.healthy` are true after warm-up
   - `research.validationState` may honestly remain `NO_VALIDATED_MODEL`
   - Operations shows the SQLite database and backup status

## Resource and budget controls

Defaults are sized for an 8 GB host:

- Engine container limit: 2 GB
- Frontend container limit: 768 MB
- Research governor ceiling: 1.4 GB RSS and load 6
- Research campaigns: at most 80 evaluations per symbol and three symbols
- AI monthly budget: €10 hard application circuit breaker; set lower in Settings if desired

Coolify/Docker, database volumes, and OS caches still consume host memory. Keep at least 2 GB headroom.

## Backup and restore

The Operations page creates online SQLite snapshots in the persistent backups volume. For restore:

1. Stop the engine service.
2. Copy the chosen backup to the `mycroft-data` volume as `mycroft.sqlite`.
3. Preserve the previous database until `/api/health` and journal counts are verified.
4. Start the engine; SQLite migrations are idempotent.

## Updating

Pull `main` and redeploy both services. The engine schema migrates in place and uses WAL checkpoints. Never delete the persistent volumes during an ordinary update.
