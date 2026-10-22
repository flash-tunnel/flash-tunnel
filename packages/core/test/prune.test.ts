import type { SessionState } from '../src'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectStateDirectory, pruneProjectState, retentionMilliseconds } from '../src'

const DAY = 86_400_000

let home: string
let project: string
let previousHome: string | undefined

function createState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId: 'ft_prune_1',
    pid: 999_999,
    projectRoot: project,
    startedAt: now,
    heartbeatAt: now,
    state: 'running',
    server: { cwd: project, startedByUs: true },
    cleanup: { required: false, attempts: 0, inProgress: false, kept: false },
    ...overrides
  }
}

beforeEach(async () => {
  previousHome = process.env.FLASH_TUNNEL_HOME
  home = await mkdtemp(join(tmpdir(), 'flash-tunnel-home-'))
  project = await mkdtemp(join(tmpdir(), 'flash-tunnel-prune-'))
  process.env.FLASH_TUNNEL_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('pruneProjectState', () => {
  it('removes old logs and empty project state', async () => {
    const directory = projectStateDirectory(project)
    const logs = join(directory, 'logs')
    await mkdir(logs, { recursive: true })

    const old = new Date(Date.now() - 8 * DAY)
    const logFile = join(logs, 'server-ft_old.log')
    await writeFile(logFile, 'old\n')
    await utimes(logFile, old, old)

    const report = await pruneProjectState()

    expect(report.logs).toContain(logFile)
    await expect(stat(logFile)).rejects.toThrow()
    await expect(stat(directory)).rejects.toThrow()
  })

  it('keeps recent logs', async () => {
    const directory = projectStateDirectory(project)
    const logs = join(directory, 'logs')
    await mkdir(logs, { recursive: true })
    const logFile = join(logs, 'server-ft_new.log')
    await writeFile(logFile, 'new\n')

    const report = await pruneProjectState()

    expect(report.logs).toEqual([])
    expect((await stat(logFile)).isFile()).toBe(true)
  })

  it('keeps a live session directory', async () => {
    const directory = projectStateDirectory(project)
    const logs = join(directory, 'logs')
    await mkdir(logs, { recursive: true })
    const state: SessionState = createState({ pid: process.pid })
    const stateFile = join(directory, 'session.json')
    await writeFile(stateFile, JSON.stringify(state))

    const old = new Date(Date.now() - 8 * DAY)
    const logFile = join(logs, 'server-ft_live.log')
    await writeFile(logFile, 'live\n')
    await utimes(logFile, old, old)

    await pruneProjectState()

    expect((await stat(stateFile)).isFile()).toBe(true)
    expect((await stat(logFile)).isFile()).toBe(true)
  })

  it('drops the state of a dead session', async () => {
    const directory = projectStateDirectory(project)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.json'), JSON.stringify(createState()))

    const report = await pruneProjectState()

    expect(report.stateFiles).toHaveLength(1)
    await expect(stat(directory)).rejects.toThrow()
  })

  it('prunes old reap logs', async () => {
    const logs = join(home, 'logs')
    await mkdir(logs, { recursive: true })
    const file = join(logs, 'reap-ft_old.log')
    await writeFile(file, 'reap\n')
    const old = new Date(Date.now() - 8 * DAY)
    await utimes(file, old, old)

    const report = await pruneProjectState()

    expect(report.reapLogs).toContain(file)
    await expect(stat(file)).rejects.toThrow()
  })

  it('reads the retention window from the environment', () => {
    expect(retentionMilliseconds({ FLASH_TUNNEL_RETENTION_DAYS: '1' })).toBe(DAY)
    expect(retentionMilliseconds({ FLASH_TUNNEL_RETENTION_DAYS: '3.5' })).toBe(Math.floor(3.5 * DAY))
    expect(retentionMilliseconds({})).toBe(7 * DAY)
    expect(retentionMilliseconds({ FLASH_TUNNEL_RETENTION_DAYS: '0' })).toBe(Number.POSITIVE_INFINITY)
  })
})
