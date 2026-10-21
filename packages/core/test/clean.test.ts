import type { SessionCleaner, SessionState } from '../src'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanSessions,
  listSessionStates,
  writeSessionState
} from '../src'

let home: string
let project: string
let previousHome: string | undefined

function createState(overrides: Partial<SessionState> = {}): SessionState {
  const now = new Date().toISOString()
  return {
    version: 1,
    sessionId: 'ft_clean_1',
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

describe('cleanSessions', () => {
  it('removes dns and tunnel for a stale session', async () => {
    await writeSessionState(createState())
    const actions: string[] = []
    const cleaner: SessionCleaner = {
      removeDns: async () => {
        actions.push('dns')
      },
      removeTunnel: async () => {
        actions.push('tunnel')
      }
    }

    const results = await cleanSessions({ sessionId: 'ft_clean_1', cleaner })
    expect(results[0]?.status).toBe('removed')
    expect(actions).toEqual(['dns', 'tunnel'])
    expect(await listSessionStates()).toHaveLength(0)
  })

  it('supports dry run without a cleaner', async () => {
    await writeSessionState(createState())

    const results = await cleanSessions({ sessionId: 'ft_clean_1', dryRun: true })
    expect(results[0]?.status).toBe('would-remove')
    expect(results[0]?.actions).toEqual([
      'delete dns record record-1 (demo.example.com)',
      'delete tunnel tunnel-1 (flash-tunnel-demo)'
    ])
    expect(await listSessionStates()).toHaveLength(1)
  })

  it('skips a live session', async () => {
    await writeSessionState(createState({ pid: process.pid }))

    const results = await cleanSessions({ sessionId: 'ft_clean_1' })
    expect(results[0]?.status).toBe('skipped')
    expect(results[0]?.reasons[0]).toContain('still running')
    expect(await listSessionStates()).toHaveLength(1)
  })

  it('fails when remote resources cannot be cleaned', async () => {
    await writeSessionState(createState())

    const results = await cleanSessions({ sessionId: 'ft_clean_1' })
    expect(results[0]?.status).toBe('failed')
    expect(results[0]?.reasons[0]).toContain('No DNS cleaner configured')
    expect(await listSessionStates()).toHaveLength(1)
  })
})
