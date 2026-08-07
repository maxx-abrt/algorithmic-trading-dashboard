# Coolify deployment

MYCROFT runs as two services from `docker-compose.yml`:

- `engine`: OKX public-data collector, quantitative analysis, paper broker, SQLite truth store, and bounded research worker
- `frontend`: Next.js dashboard; `/api/*` is rewritten internally to `engine:8790`

There is no trade service and no OKX private credential requirement.

## CRITICAL: Use Docker Compose, not Nixpacks

**Always deploy as a Docker Compose application in Coolify.** Do not deploy the engine and frontend as separate Nixpacks applications.

Nixpacks builds have ephemeral filesystems — every redeploy starts with an empty container. This means the SQLite database, all candles, trades, models, and research are **wiped on every deploy**. The `nixpacks.toml` files exist only as a fallback for environments that cannot run Docker Compose.

If you previously deployed as separate Nixpacks apps:
1. Delete both Nixpacks applications in Coolify.
2. Create a new Docker Compose application from this repository.
3. The named volumes `mycroft-data` and `mycroft-backups` will be created automatically and persist across redeploys.

## Coolify setup

1. Create a **Docker Compose** application from this repository and the `main` branch. The provided `Dockerfile`s now use Node 22, so no extra build configuration is needed.
2. Route the public domain to `frontend` port `3000`. Do not expose engine port `8790` publicly.
3. **Verify persistent volumes exist after the first deploy.** In Coolify, check that the volumes `mycroft-data` and `mycroft-backups` are listed in the application's Storage/Volumes section. The compose file uses explicit `name:` properties so these volumes survive app recreation.
4. Set optional secrets in Coolify, never in Git:
   - `GEMINI_API_KEY` for budget-capped summaries/risk critique only
   - `GEMINI_MODEL` (default `gemini-2.5-flash`)
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` only if notifications are wanted
5. Leave all `OKX_API_*` variables unset. Public market data needs no credentials and the codebase has no order endpoint.
6. If you deploy the services as individual Nixpacks applications instead of Docker Compose:
   - **WARNING: Data will be wiped on every redeploy.** Nixpacks has no persistent volumes.
   - If you must use Nixpacks, add persistent storage mounts in Coolify's application settings:
     - Engine app: mount `/app/engine/data` and `/app/engine/backups` as persistent volumes
   - `engine/nixpacks.toml` and `frontend/nixpacks.toml` pin the nixpkgs archive that ships Node 22.13.1, which also satisfies `vite@7.3.6`'s `>=22.12.0` requirement.
   - `engine/nixpacks.toml` pins the nixpkgs archive for Node 22.13.1. No apt packages are installed — `better-sqlite3@11.10.0` ships prebuilt binaries for Node 22 linux-x64, so native compilation tooling is unnecessary.
   - `package.json` `engines.node` and `.nvmrc` are set to `>=22.0.0` / `22` respectively as a fallback; you can additionally set the Coolify environment variable `NIXPACKS_NODE_VERSION=22` if your Coolify/Nixpacks version ignores those signals.
7. Deploy, then verify:
   - `/api/health` returns `ok: true`
   - `dataFreshness.likelyWiped` is `false` — if `true`, the database was wiped and volumes are not persisting
   - `dataFreshness.restoredFromBackup` is `false` on a healthy deploy — if `true`, the volume was empty but a backup saved you
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

Pull `main` and redeploy both services. The engine schema migrates in place and uses WAL checkpoints. **Never delete the persistent volumes during an ordinary update.**

After redeploying, verify data persisted:
1. Check `/api/health` — `dataFreshness.likelyWiped` must be `false`.
2. Check the Operations page — table counts (candles, decisions, paper trades) should be non-zero and match or exceed pre-deploy values.
3. If `dataFreshness.restoredFromBackup` is `true`, the volume was empty but the engine recovered from a backup snapshot. This means volumes are not persisting — see the troubleshooting section below.

## Troubleshooting data loss

If data is wiped after every redeploy:

1. **Check deployment type**: Confirm you are using Docker Compose, not Nixpacks. Nixpacks has no persistent volumes.
2. **Check volume names**: Run `docker volume ls | grep mycroft` on the host. You should see `mycroft-data` and `mycroft-backups`. If not, volumes are not being created.
3. **Check Coolify settings**: In the Coolify application settings, ensure "Delete volumes" or "Cleanup volumes" is NOT enabled.
4. **Manual backup before redeploy**: If volumes are unreliable, SSH to the host and copy the DB before redeploying:
   ```bash
   docker cp $(docker ps -qf "name=engine"):/app/engine/data/mycroft.sqlite ./mycroft-backup.sqlite
   ```
5. **Manual restore after data loss**: Copy the backup back into the volume:
   ```bash
   docker cp ./mycroft-backup.sqlite $(docker ps -qf "name=engine"):/app/engine/data/mycroft.sqlite
   ```
   Then restart the engine container.
