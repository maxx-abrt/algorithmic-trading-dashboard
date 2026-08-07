/**
 * Backup / restore / disk telemetry.
 *
 * The single most expensive failure mode for a learning system is losing its
 * memory. Three defences:
 *   1. the database lives on a host bind mount, not inside the container image
 *   2. an online snapshot is taken on a schedule and kept in a rolling window
 *   3. on boot, if the database is missing but a snapshot exists, it is restored
 *      automatically before the engine opens it
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_DIR, DATA_DIR, DB_PATH, ensureDirs } from './paths.js'

export interface BackupFile {
  name: string
  path: string
  bytes: number
  at: number
}

export function listBackups(): BackupFile[] {
  ensureDirs()
  try {
    return readdirSync(BACKUP_DIR)
      .filter((name) => name.endsWith('.sqlite'))
      .map((name) => {
        const path = join(BACKUP_DIR, name)
        const stat = statSync(path)
        return { name, path, bytes: stat.size, at: stat.mtimeMs }
      })
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

/**
 * Called BEFORE the database is opened. If the volume is empty but a snapshot
 * survived, restore the newest one so a wiped container does not reset learning.
 */
export function restoreIfMissing(): { restored: boolean; from?: string; reason: string } {
  ensureDirs()
  if (existsSync(DB_PATH) && statSync(DB_PATH).size > 4096) return { restored: false, reason: 'database present' }
  const newest = listBackups()[0]
  if (!newest) return { restored: false, reason: 'no snapshot available' }
  mkdirSync(DATA_DIR, { recursive: true })
  copyFileSync(newest.path, DB_PATH)
  return { restored: true, from: newest.name, reason: `restored ${newest.name} (${(newest.bytes / 1e6).toFixed(1)} MB)` }
}

/** Keep the newest `keep` snapshots, delete the rest. */
export function pruneBackups(keep = 12) {
  const files = listBackups()
  let removed = 0
  for (const file of files.slice(keep)) {
    try {
      rmSync(file.path)
      removed++
    } catch {
      /* best effort */
    }
  }
  return removed
}

export function backupFileName() {
  return join(BACKUP_DIR, `mycroft-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
}

export interface DiskUsage {
  dataDir: string
  backupDir: string
  dbBytes: number
  backupBytes: number
  freeBytes: number | null
  totalBytes: number | null
  usedPct: number | null
}

export function diskUsage(): DiskUsage {
  const dbBytes = (() => {
    try {
      return statSync(DB_PATH).size
    } catch {
      return 0
    }
  })()
  const backupBytes = listBackups().reduce((sum, file) => sum + file.bytes, 0)
  let freeBytes: number | null = null
  let totalBytes: number | null = null
  try {
    const fs = statfsSync(DATA_DIR)
    freeBytes = Number(fs.bavail) * Number(fs.bsize)
    totalBytes = Number(fs.blocks) * Number(fs.bsize)
  } catch {
    /* statfsSync is unavailable on some platforms */
  }
  return {
    dataDir: DATA_DIR,
    backupDir: BACKUP_DIR,
    dbBytes,
    backupBytes,
    freeBytes,
    totalBytes,
    usedPct: freeBytes != null && totalBytes != null && totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : null,
  }
}
