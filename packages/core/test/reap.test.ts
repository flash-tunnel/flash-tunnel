import type { ChildProcess } from 'node:child_process'
import type { SessionCleaner, SessionState } from '../src'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanSession,
  cleanSessions,
  isProcessAlive,
  listSessionStates,
  readSessionState,
  reapSession,
  writeSessionState
} from '../src'

let home: string
let project: string
let previousHome: string | undefined
const children: ChildProcess[] = []

function spawnLongRunning(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  children.push(child)
  return child
}

async function waitForPid(child: ChildProcess): Promise<number> {
  if (!child.pid) {
    await once(child, 'spawn')
  }
  return child.pid as number
}

function createState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId: 'ft_reap_1',
    pid: 999_999,
    projectRoot: project,
    startedAt: now,
    heartbeatAt: now,
    state: 'running',
    server: { cwd: project, startedByUs: true },
    dns: {
      provider: 'cloudflare',
      zoneId: 'zone-1',
      recordId: 'record-1',
      hostname: 'demo.example.com'
    },
    tunnel: {
      provider: 'cloudflare',
      tunnelId: 'tunnel-1',
      name: 'flash-tunnel-demo',
      mode: 'named',
      accountId: 'acc-1'
    },
    cleanup: { required: false, attempts: 0, inProgress: false, kept: false },
    ...overrides
  }
}

function createCleaner(log: string[] = []): SessionCleaner {
  return {
    removeDns: async () => {
      log.push('dns')
    },
    removeTunnel: async () => {
      log.push('tunnel')
    }
  }
}

beforeEach(async () => {
  previousHome = process.env.FLASH_TUNNEL_HOME
  home = await mkdtemp(join(tmpdir(), 'flash-tunnel-home-'))
  project = await mkdtemp(join(tmpdir(), 'flash-tunnel-project-'))
  process.env.FLASH_TUNNEL_HOME = home
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('cleanSession', () => {
  it('stops recorded processes then removes dns and tunnel', async () => {
    const cloudflared = spawnLongRunning()
    const server = spawnLongRunning()
    const cloudflaredPid = await waitForPid(cloudflared)
    const serverPid = await waitForPid(server)

    const state = createState({
      processes: [{ kind: 'cloudflared', pid: cloudflaredPid }],
      server: { cwd: project, startedByUs: true, pid: serverPid }
    })
    await writeSessionState(state)

    const log: string[] = []
    const result = await cleanSession(state, { cleaner: createCleaner(log) })

    expect(result.status).toBe('removed')
    expect(log).toEqual(['dns', 'tunnel'])
    expect(result.actions).toEqual([
      `stop process ${cloudflaredPid} (cloudflared)`,
      'delete dns record record-1 (demo.example.com)',
      'delete tunnel tunnel-1 (flash-tunnel-demo)',
      `stop process ${serverPid} (server)`
    ])
    expect(isProcessAlive(cloudflaredPid)).toBe(false)
    expect(isProcessAlive(serverPid)).toBe(false)
    expect(await listSessionStates()).toHaveLength(0)
  })

  it('does not kill processes during a dry run', async () => {
    const child = spawnLongRunning()
    const pid = await waitForPid(child)
    await writeSessionState(createState({
      processes: [{ kind: 'cloudflared', pid }]
    }))

    const result = await cleanSessions({ sessionId: 'ft_reap_1', dryRun: true })

    expect(result[0]?.status).toBe('would-remove')
    expect(isProcessAlive(pid)).toBe(true)
  })

  it('keeps the state file and records the attempt when cleanup fails', async () => {
    await writeSessionState(createState())
    const cleaner: SessionCleaner = {
      removeDns: async () => {
        throw new Error('api down')
      },
      removeTunnel: async () => {}
    }

    const result = await cleanSession(createState(), { cleaner })

    expect(result.status).toBe('failed')
    expect(result.reasons[0]).toContain('api down')

    const state = await readSessionState(project)
    expect(state?.cleanup.required).toBe(true)
    expect(state?.cleanup.attempts).toBe(1)
    expect(state?.state).toBe('failed')
  })

  it('skips a live session unless forced and is idempotent on repeat', async () => {
    const state = createState({ pid: process.pid })
    await writeSessionState(state)

    const skipped = await cleanSessions({ sessionId: 'ft_reap_1' })
    expect(skipped[0]?.status).toBe('skipped')

    const forced = await cleanSessions({ sessionId: 'ft_reap_1', force: true, cleaner: createCleaner() })
    expect(forced[0]?.status).toBe('removed')

    const again = await cleanSessions({ sessionId: 'ft_reap_1', force: true, cleaner: createCleaner() })
    expect(again).toHaveLength(0)
  })
})

describe('reapSession', () => {
  it('reaps a dead session by id', async () => {
    await writeSessionState(createState())

    const result = await reapSession('ft_reap_1', { cleaner: createCleaner() })

    expect(result.status).toBe('removed')
    expect(await listSessionStates()).toHaveLength(0)
  })

  it('reports missing sessions without throwing', async () => {
    const result = await reapSession('ft_missing', { cleaner: createCleaner() })
    expect(result.status).toBe('not-found')
  })

  it('skips a live session unless forced', async () => {
    await writeSessionState(createState({ pid: process.pid }))

    const skipped = await reapSession('ft_reap_1', { cleaner: createCleaner() })
    expect(skipped.status).toBe('skipped')

    const forced = await reapSession('ft_reap_1', { cleaner: createCleaner(), force: true })
    expect(forced.status).toBe('removed')
  })
})
