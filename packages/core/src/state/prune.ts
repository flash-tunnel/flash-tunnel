import type { SessionState } from './store'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { isProcessAlive } from '../process'
import { homeDirectory, isSessionStale } from './store'

export const DEFAULT_RETENTION_DAYS = 7

const DAY_MS = 86_400_000

/**
 * How long inactive project state (logs, stale session files) is kept.
 * `FLASH_TUNNEL_RETENTION_DAYS=0` disables pruning entirely.
 */
export function retentionMilliseconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FLASH_TUNNEL_RETENTION_DAYS?.trim()
  if (raw) {
    const days = Number(raw)
    if (Number.isFinite(days) && days === 0) {
      return Number.POSITIVE_INFINITY
    }
    if (Number.isFinite(days) && days > 0) {
      return Math.floor(days * DAY_MS)
    }
  }
  return DEFAULT_RETENTION_DAYS * DAY_MS
}

export interface PruneProjectStateReport {
  projects: number
  logs: string[]
  stateFiles: string[]
  reapLogs: string[]
}

async function readProjectState(directory: string): Promise<SessionState | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) as SessionState
  }
  catch {
    return undefined
  }
}

async function removeIfOlderThan(
  path: string,
  cutoff: number,
  removed: string[]
): Promise<void> {
  try {
    const info = await stat(path)
    if (info.mtimeMs >= cutoff) {
      return
    }
    await rm(path, { force: true })
    removed.push(path)
  }
  catch {
    // Already gone or inaccessible; nothing to prune.
  }
}

async function pruneProjectDirectory(
  directory: string,
  now: number,
  cutoff: number,
  report: PruneProjectStateReport
): Promise<void> {
  const state = await readProjectState(directory)
  const alive = state ? isProcessAlive(state.pid) : false

  // A dead process never writes this state again, so drop the stale pointer.
  // A live process keeps it even if its heartbeat is old (hung or just waking).
  if (state && !alive) {
    const file = join(directory, 'session.json')
    await rm(file, { force: true })
    report.stateFiles.push(file)
    await rm(join(directory, 'lock.json'), { force: true })
  }
  else if (!state) {
    // No session ever started (or it was cleaned): an old lock is just debris.
    await removeIfOlderThan(join(directory, 'lock.json'), cutoff, [])
  }

  // Keep the active session's own log files even when they look old.
  const active = state !== undefined && !isSessionStale(state, now)
  const logsDirectory = join(directory, 'logs')
  let logs: string[] = []
  try {
    logs = await readdir(logsDirectory)
  }
  catch {
    logs = []
  }

  for (const file of logs) {
    if (!/^(?:server|tunnel)-.+\.log$/.test(file)) {
      continue
    }
    if (active) {
      continue
    }
    await removeIfOlderThan(join(logsDirectory, file), cutoff, report.logs)
  }

  let remaining: string[] = []
  try {
    remaining = await readdir(directory)
  }
  catch {
    return
  }

  if (remaining.length === 0) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    report.projects += 1
    return
  }

  if (remaining.length === 1 && remaining[0] === 'logs') {
    const leftover = await readdir(logsDirectory).catch(() => ['keep'])
    if (leftover.length === 0) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      report.projects += 1
    }
  }
}

/**
 * Remove project state and logs older than the retention window. Active
 * sessions are left alone; stale entries are dropped so the directory can go
 * away on a later sweep.
 */
export async function pruneProjectState(
  options: { now?: number, retentionMs?: number } = {}
): Promise<PruneProjectStateReport> {
  const report: PruneProjectStateReport = { projects: 0, logs: [], stateFiles: [], reapLogs: [] }
  const retention = options.retentionMs ?? retentionMilliseconds()
  if (!Number.isFinite(retention)) {
    return report
  }

  const now = options.now ?? Date.now()
  const cutoff = now - retention

  const projectsDirectory = join(homeDirectory(), 'projects')
  let entries: string[] = []
  try {
    entries = await readdir(projectsDirectory)
  }
  catch {
    entries = []
  }

  for (const entry of entries) {
    await pruneProjectDirectory(join(projectsDirectory, entry), now, cutoff, report)
  }

  const reapDirectory = join(homeDirectory(), 'logs')
  let reapLogs: string[] = []
  try {
    reapLogs = (await readdir(reapDirectory)).filter(file => /^reap-.+\.log$/.test(file))
  }
  catch {
    reapLogs = []
  }
  for (const file of reapLogs) {
    await removeIfOlderThan(join(reapDirectory, file), cutoff, report.reapLogs)
  }

  return report
}
