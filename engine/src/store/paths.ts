/**
 * Filesystem layout. Everything the brain learns lives under ONE directory so a
 * single bind mount (or a single tarball) is a complete backup.
 *
 *   <DATA_DIR>/mycroft.sqlite        transactional truth
 *   <DATA_DIR>/specialists/<hash>/   model artifacts
 *   <BACKUP_DIR>/                    rolling online snapshots
 *
 * On Coolify the compose file bind-mounts /srv/mycroft/data and /srv/mycroft/backups,
 * so a redeploy, image rebuild or app recreation cannot touch them.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DB_PATH = process.env.MYCROFT_DB_PATH || resolve(process.cwd(), 'data/mycroft.sqlite')
export const DATA_DIR = dirname(DB_PATH)
export const BACKUP_DIR = process.env.MYCROFT_BACKUP_PATH || resolve(DATA_DIR, '..', 'backups')
export const SPECIALIST_DIR = join(DATA_DIR, 'specialists')

export function ensureDirs() {
  for (const dir of [DATA_DIR, BACKUP_DIR, SPECIALIST_DIR]) mkdirSync(dir, { recursive: true })
}

export const specialistPath = (artifactHash: string) => join(SPECIALIST_DIR, artifactHash, 'model.json')
