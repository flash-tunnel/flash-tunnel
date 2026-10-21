import type { SessionState } from '../src'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireProjectLock,
  isSessionStale,
  listSessionStates,
  ProjectLockedError,
  readGlobalSessionState,
  readSessionState,
  releaseProjectLock,
  removeSessionState,
  writeSessionState
} from '../src'

let home: string
let project: string
let previousHome: string | undefined

function createState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId: 'ft_test_1',
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
  project = await mkdtemp(join(tmpdir(), 'flash-tunnel-project-'))
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

describe('session state store', () => {
  it('writes reads lists and removes a session', async () => {
    const state = createState()
    await writeSessionState(state)

    expect(await readSessionState(project)).toMatchObject({ sessionId: 'ft_test_1' })
    expect(await readGlobalSessionState('ft_test_1')).toMatchObject({ sessionId: 'ft_test_1' })
    expect(await listSessionStates()).toHaveLength(1)

    await removeSessionState(state)
    expect(await readSessionState(project)).toBeUndefined()
    expect(await listSessionStates()).toHaveLength(0)
  })

  it('does not recreate a project directory that no longer exists', async () => {
    const missing = join(home, 'missing-project')
    await writeSessionState(createState({ projectRoot: missing }))

    await expect(access(missing)).rejects.toThrow()
    expect(await readSessionState(missing)).toBeUndefined()
    expect(await listSessionStates()).toHaveLength(1)
  })

  it('treats dead pids and old heartbeats as stale', () => {
    expect(isSessionStale(createState())).toBe(true)
    expect(isSessionStale(createState({
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - 120_000).toISOString()
    }))).toBe(true)
    expect(isSessionStale(createState({
      pid: process.pid,
      heartbeatAt: new Date().toISOString()
    }))).toBe(false)
  })

  it('locks a project and rejects a second live session', async () => {
    await acquireProjectLock(project, 'ft_one')
    await expect(acquireProjectLock(project, 'ft_two')).rejects.toBeInstanceOf(ProjectLockedError)

    await releaseProjectLock(project, 'ft_one')
    await expect(acquireProjectLock(project, 'ft_two')).resolves.toBeUndefined()
    await releaseProjectLock(project, 'ft_two')
  })

  it('reclaims a stale lock', async () => {
    await mkdir(join(project, '.flash-tunnel'), { recursive: true })
    await writeFile(join(project, '.flash-tunnel', 'lock.json'), JSON.stringify({
      sessionId: 'ft_old',
      pid: 999_999
    }))

    await expect(acquireProjectLock(project, 'ft_new')).resolves.toBeUndefined()
    await releaseProjectLock(project, 'ft_new')
  })
})
