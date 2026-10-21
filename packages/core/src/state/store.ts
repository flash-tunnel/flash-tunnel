import type { TunnelMode } from '@flash-tunnel/types'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

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
}

export interface SessionDnsState {
  provider: string
  zoneId: string
  recordId: string
  hostname: string
}

export interface SessionState {
  version: 1
  sessionId: string
  pid: number
  projectRoot: string
  startedAt: string
  heartbeatAt: string
  state: string
  configSource?: string
  server: SessionServerState
  tunnel?: SessionTunnelState
  dns?: SessionDnsState
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

export function projectStateDirectory(projectRoot: string): string {
  return join(projectRoot, '.flash-tunnel')
}

function globalSessionsDirectory(): string {
  return join(homeDirectory(), 'sessions')
}

function sessionFile(projectRoot: string): string {
  return join(projectStateDirectory(projectRoot), 'session.json')
}

function globalSessionFile(sessionId: string): string {
  return join(globalSessionsDirectory(), `${sessionId}.json`)
}

function lockFile(projectRoot: string): string {
  return join(projectStateDirectory(projectRoot), 'lock.json')
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

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isSessionStale(state: SessionState, now: number = Date.now()): boolean {
  if (!isProcessAlive(state.pid)) {
    return true
  }
  return now - Date.parse(state.heartbeatAt) > 90_000
}

export async function writeSessionState(state: SessionState): Promise<void> {
  await ensurePrivateDirectory(projectStateDirectory(state.projectRoot))
  await ensurePrivateDirectory(globalSessionsDirectory())
  await writeJson(sessionFile(state.projectRoot), state)
  await writeJson(globalSessionFile(state.sessionId), state)
}

export async function readSessionState(projectRoot: string): Promise<SessionState | undefined> {
  try {
    return JSON.parse(await readFile(sessionFile(projectRoot), 'utf8')) as SessionState
  }
  catch {
    return undefined
  }
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
      // Ignore corrupt state files; doctor can report them later.
    }
  }
  return states.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export async function removeSessionState(state: SessionState): Promise<void> {
  await rm(sessionFile(state.projectRoot), { force: true })
  await rm(globalSessionFile(state.sessionId), { force: true })
}

export async function acquireProjectLock(projectRoot: string, sessionId: string): Promise<void> {
  await ensurePrivateDirectory(projectStateDirectory(projectRoot))
  const path = lockFile(projectRoot)

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

  await writeJson(path, {
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
