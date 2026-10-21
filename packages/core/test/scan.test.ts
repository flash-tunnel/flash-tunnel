import type { SessionState } from '../src'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findStaleSessions, isSessionStale, writeSessionState } from '../src'

let home: string
let project: string
let otherProject: string
let previousHome: string | undefined

function createState(overrides: Partial<SessionState>): SessionState {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId: 'ft_scan_1',
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
  otherProject = await mkdtemp(join(tmpdir(), 'flash-tunnel-other-'))
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
  await rm(otherProject, { recursive: true, force: true })
})

describe('findStaleSessions', () => {
  it('splits stale sessions into the current project and others', async () => {
    await writeSessionState(createState({ sessionId: 'ft_current', projectRoot: project }))
    await writeSessionState(createState({ sessionId: 'ft_other', projectRoot: otherProject }))

    const result = await findStaleSessions(project)

    expect(result.project.map(state => state.sessionId)).toEqual(['ft_current'])
    expect(result.others.map(state => state.sessionId)).toEqual(['ft_other'])
  })

  it('ignores a live session with a fresh heartbeat', async () => {
    await writeSessionState(createState({
      sessionId: 'ft_live',
      pid: process.pid,
      heartbeatAt: new Date().toISOString()
    }))

    const result = await findStaleSessions(project)
    expect(result.project).toHaveLength(0)
    expect(result.others).toHaveLength(0)
    expect(isSessionStale(createState({ pid: process.pid }))).toBe(false)
  })
})
