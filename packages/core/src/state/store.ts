import type { TunnelMode } from '@flash-tunnel/types'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { slugify } from '@flash-tunnel/utils'
import { isProcessAlive } from '../process'

export type SessionPhase
  = | 'starting'
    | 'server-ready'
    | 'provisioning-tunnel'
    | 'tunnel-provisioned'
    | 'dns-created'
    | 'running'
    | 'tearing-down'
    | 'kept'
    | 'failed'

export interface SessionProcessState {
  kind: 'cloudflared' | 'server'
  pid: number
}

export interface SessionServerState {
  url?: string
  command?: string
  cwd: string
  pid?: number
  startedByUs: boolean
}

export interface SessionTunnelState {
  provider: string
  tunnelId: string
  name: string
  publicUrl?: string
  mode: TunnelMode
  accountId?: string
  configured?: boolean
}

export interface SessionDnsState {
  provider: string
  zoneId: string
  recordId: string
  hostname: string
  comment?: string
}

export interface SessionState {
  version: 1
  sessionId: string
  pid: number
  projectRoot: string
  startedAt: string
  heartbeatAt: string
  state: SessionPhase
  configSource?: string
  server: SessionServerState
  processes?: SessionProcessState[]
  tunnel?: SessionTunnelState
  dns?: SessionDnsState
  expiresAt?: string
  cleanup: {
    required: boolean
    attempts: number
    inProgress: boolean
    kept: boolean
  }
}

export class ProjectLockedError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`Another flash-tunnel session is running for this project (${sessionId})`)
    this.name = 'ProjectLockedError'
    this.sessionId = sessionId
  }
}

export function homeDirectory(): string {
  return process.env.FLASH_TUNNEL_HOME ?? join(homedir(), '.flash-tunnel')
}

/**
 * Stable, filesystem-safe key for a project. Real paths are used so symlinked
 * checkouts of the same project share one state directory; Windows paths are
 * lowercased because the filesystem is case-insensitive.
 */
export function projectKey(projectRoot: string): string {
  let normalized = resolve(projectRoot)
  try {
    normalized = realpathSync(normalized)
  }
  catch {
    // The project may already be gone; fall back to the resolved path.
  }
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase()
  }

  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return `${slugify(basename(normalized), 32) || 'project'}-${hash}`
}

/**
 * Runtime state and logs live outside the project so flash-tunnel never leaves
 * files in the user's checkout.
 */
export function projectStateDirectory(projectRoot: string): string {
  return join(homeDirectory(), 'projects', projectKey(projectRoot))
}

/** Pre-0.2 location, read-only compatibility for existing installs. */
export function legacyProjectStateDirectory(projectRoot: string): string {
  return join(resolve(projectRoot), '.flash-tunnel')
}

function globalSessionsDirectory(): string {
  return join(homeDirectory(), 'sessions')
}

function sessionFile(projectRoot: string): string {
  return join(projectStateDirectory(projectRoot), 'session.json')
}

function legacySessionFile(projectRoot: string): string {
  return join(legacyProjectStateDirectory(projectRoot), 'session.json')
}

function globalSessionFile(sessionId: string): string {
  return join(globalSessionsDirectory(), `${sessionId}.json`)
}

function lockFile(projectRoot: string): string {
  return join(projectStateDirectory(projectRoot), 'lock.json')
}

function legacyLockFile(projectRoot: string): string {
  return join(legacyProjectStateDirectory(projectRoot), 'lock.json')
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700).catch(() => {})
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => {})
}

export function reapLogFile(sessionId: string): string {
  return join(homeDirectory(), 'logs', `reap-${sessionId}.log`)
}

export async function appendReapLog(sessionId: string, message: string): Promise<void> {
  const file = reapLogFile(sessionId)
  try {
    await ensurePrivateDirectory(dirname(file))
    await appendFile(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
  }
  catch {
    // Logging must never break cleanup.
  }
}

export function isSessionStale(state: SessionState, now: number = Date.now()): boolean {
  if (!isProcessAlive(state.pid)) {
    return true
  }
  return now - Date.parse(state.heartbeatAt) > 90_000
}

export async function writeSessionState(state: SessionState): Promise<void> {
  // Do not recreate a project directory that has been removed since the session started.
  if (existsSync(state.projectRoot)) {
    await ensurePrivateDirectory(projectStateDirectory(state.projectRoot))
    await writeJson(sessionFile(state.projectRoot), state)
  }
  await ensurePrivateDirectory(globalSessionsDirectory())
  await writeJson(globalSessionFile(state.sessionId), state)
}

export async function readSessionState(projectRoot: string): Promise<SessionState | undefined> {
  for (const file of [sessionFile(projectRoot), legacySessionFile(projectRoot)]) {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as SessionState
    }
    catch {
      // Try the next location.
    }
  }
  return undefined
}

export async function readGlobalSessionState(sessionId: string): Promise<SessionState | undefined> {
  try {
    return JSON.parse(await readFile(globalSessionFile(sessionId), 'utf8')) as SessionState
  }
  catch {
    return undefined
  }
}

export async function listSessionStates(): Promise<SessionState[]> {
  const directory = globalSessionsDirectory()
  let files: string[]
  try {
    files = await readdir(directory)
  }
  catch {
    return []
  }

  const states: SessionState[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) {
      continue
    }
    try {
      states.push(JSON.parse(await readFile(join(directory, file), 'utf8')) as SessionState)
    }
    catch {
      // Keep corrupt files out of the active index so they cannot break clean.
      const corruptDirectory = join(directory, '.corrupt')
      await mkdir(corruptDirectory, { recursive: true, mode: 0o700 }).catch(() => {})
      await rename(
        join(directory, file),
        join(corruptDirectory, `${Date.now()}-${file}`)
      ).catch(() => {})
    }
  }
  return states.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export async function removeSessionState(state: SessionState): Promise<void> {
  await rm(sessionFile(state.projectRoot), { force: true })
  await rm(legacySessionFile(state.projectRoot), { force: true })
  await rm(globalSessionFile(state.sessionId), { force: true })
}

export async function acquireProjectLock(projectRoot: string, sessionId: string): Promise<void> {
  await ensurePrivateDirectory(projectStateDirectory(projectRoot))

  // The legacy project-local lock may still belong to a session started by an
  // older flash-tunnel; respect it while that process is alive.
  for (const path of [lockFile(projectRoot), legacyLockFile(projectRoot)]) {
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as { sessionId?: string, pid?: number }
      if (existing.pid && existing.sessionId && existing.sessionId !== sessionId && isProcessAlive(existing.pid)) {
        throw new ProjectLockedError(existing.sessionId)
      }
    }
    catch (error) {
      if (error instanceof ProjectLockedError) {
        throw error
      }
    }
  }

  await writeJson(lockFile(projectRoot), {
    sessionId,
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  })
}

export async function releaseProjectLock(projectRoot: string, sessionId: string): Promise<void> {
  const path = lockFile(projectRoot)
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as { sessionId?: string }
    if (existing.sessionId === sessionId) {
      await rm(path, { force: true })
    }
  }
  catch {
    // Missing lock is fine.
  }
}
