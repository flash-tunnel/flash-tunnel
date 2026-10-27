import type { DnsAdapter, DnsRecordRef, TunnelAdapter } from '@flash-tunnel/types'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { AdapterError } from '@flash-tunnel/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CleanupError, detectServer, readSessionState, sessionLogPath, startPreviewSession } from '../src'

const directories: string[] = []
const sessions: Array<{ stop: () => Promise<void> }> = []
let home: string
let previousHome: string | undefined

beforeEach(async () => {
  previousHome = process.env.FLASH_TUNNEL_HOME
  home = await mkdtemp(join(tmpdir(), 'flash-tunnel-home-'))
  process.env.FLASH_TUNNEL_HOME = home
})

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-session-'))
  directories.push(directory)

  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }

  return directory
}

function createFakeTunnel(): TunnelAdapter {
  let localUrl = ''

  return {
    kind: 'tunnel',
    id: 'fake',
    apiVersion: 1,
    capabilities: {
      modes: ['quick'],
      publicHostname: 'assigned',
      requiresDns: false,
      concurrent: true
    },
    preflight: async () => {},
    provision: async (_ctx, spec) => {
      localUrl = spec.localUrl
      return {
        provider: 'fake',
        tunnelId: 'fake',
        name: spec.name,
        secrets: {}
      }
    },
    start: async () => {},
    waitReady: async () => ({ state: 'connected', connections: 1, publicUrl: localUrl }),
    stop: async () => {},
    deprovision: async () => {}
  }
}

function createFakeDns(sequence: string[]): DnsAdapter {
  return {
    kind: 'dns',
    id: 'fake-dns',
    apiVersion: 1,
    capabilities: {
      recordTypes: ['CNAME'],
      proxied: true,
      ttl: true,
      comment: true,
      lookupByName: true
    },
    preflight: async () => {
      sequence.push('dns:preflight')
    },
    ensure: async (_ctx, spec) => {
      sequence.push('dns:ensure')
      const ref: DnsRecordRef = {
        provider: 'fake-dns',
        zoneId: 'zone-1',
        recordId: 'record-1',
        name: spec.name,
        type: spec.type,
        content: spec.content,
        proxied: spec.proxied ?? true
      }
      return ref
    },
    remove: async () => {
      sequence.push('dns:remove')
    },
    find: async () => []
  }
}

function createFakeTunnelWithDns(sequence: string[]): TunnelAdapter {
  let localUrl = ''

  return {
    kind: 'tunnel',
    id: 'fake-tunnel',
    apiVersion: 1,
    capabilities: {
      modes: ['named'],
      publicHostname: 'custom',
      requiresDns: false,
      concurrent: true
    },
    preflight: async () => {
      sequence.push('tunnel:preflight')
    },
    provision: async (_ctx, spec) => {
      sequence.push('tunnel:provision')
      localUrl = spec.localUrl
      return {
        provider: 'fake-tunnel',
        tunnelId: 'tunnel-1',
        name: spec.name,
        publicUrl: localUrl,
        dns: {
          type: 'CNAME',
          target: 'tunnel-1.cfargotunnel.com',
          proxied: true
        },
        secrets: {},
        meta: { localUrl }
      }
    },
    start: async () => {
      sequence.push('tunnel:start')
    },
    waitReady: async () => ({ state: 'connected', connections: 1, publicUrl: localUrl }),
    stop: async () => {
      sequence.push('tunnel:stop')
    },
    deprovision: async () => {
      sequence.push('tunnel:deprovision')
    }
  }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.stop().catch(() => {})))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
})

describe('startPreviewSession', () => {
  it('executes the supplied plan without detecting the server again', async () => {
    const cwd = await createDirectory({ 'public/index.html': '<h1>planned-server</h1>' })
    const serverPlan = detectServer(cwd, { dir: 'public', port: 0 })

    const session = await startPreviewSession({
      cwd,
      config: {},
      serverPlan,
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick'
    })
    sessions.push(session)

    expect(session.server.plan).toBe(serverPlan)
    expect(await (await fetch(session.localUrl)).text()).toContain('planned-server')
  })

  it('does not allocate session state when fallback detection fails', async () => {
    const cwd = await createDirectory({})
    await expect(startPreviewSession({
      cwd,
      config: {},
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick'
    })).rejects.toThrow(/No runnable script/)

    expect(await readSessionState(cwd)).toBeUndefined()
    // A second attempt must report detection failure rather than a leaked project lock.
    await expect(startPreviewSession({
      cwd,
      config: {},
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick'
    })).rejects.toThrow(/No runnable script/)
  })

  it('starts the server, provisions the tunnel and stops both', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('session-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const session = await startPreviewSession({
      cwd,
      config: {
        server: {
          command: 'node server.mjs',
          port: 0
        }
      },
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick',
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    expect(session.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(session.publicUrl).toBe(session.localUrl)

    const state = await readSessionState(cwd)
    expect(state).toMatchObject({
      sessionId: session.sessionId,
      state: 'running'
    })
    expect(state?.tunnel?.provider).toBe('fake')

    const serverLog = await readFile(sessionLogPath(cwd, session.sessionId, 'server'), 'utf8')
    expect(serverLog).toContain('Local: http://127.0.0.1')

    const response = await fetch(session.publicUrl)
    expect(await response.text()).toBe('session-ok')

    await session.stop()
    expect(await readSessionState(cwd)).toBeUndefined()
    await expect(fetch(session.localUrl)).rejects.toThrow()
  })

  it('lets the dev server accept the quick tunnel hostname', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const allowed = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? 'missing'
        const server = createServer((request, response) => response.end(allowed))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const session = await startPreviewSession({
      cwd,
      config: {
        server: {
          command: 'node server.mjs',
          port: 0
        }
      },
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick',
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    expect(await (await fetch(session.publicUrl)).text()).toBe('.trycloudflare.com')
  })

  it('fails clearly when the dev server blocks the tunnel hostname', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => {
          response.writeHead(403, { 'Content-Type': 'text/plain' })
          response.end('Blocked request. This host ("ft-test.trycloudflare.com") is not allowed.')
        })
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    await expect(startPreviewSession({
      cwd,
      config: {
        server: {
          command: 'node server.mjs',
          port: 0
        }
      },
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick',
      verifyTimeoutMs: 10_000
    })).rejects.toMatchObject({
      code: 'PUBLIC_HOST_BLOCKED',
      hint: expect.stringContaining('Vite 6.1 or newer')
    })
  })

  it('creates the dns record before start and removes it before deprovision', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('dns-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })
    const sequence: string[] = []

    const session = await startPreviewSession({
      cwd,
      config: {
        server: {
          command: 'node server.mjs',
          port: 0
        }
      },
      adapters: {
        tunnel: createFakeTunnelWithDns(sequence),
        dns: createFakeDns(sequence)
      },
      mode: 'named',
      hostname: 'demo.example.com',
      zone: 'example.com',
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    expect(session.hostname).toBe('demo.example.com')
    expect(session.dns).toMatchObject({
      name: 'demo.example.com',
      type: 'CNAME',
      content: 'tunnel-1.cfargotunnel.com'
    })
    expect(sequence).toEqual([
      'tunnel:preflight',
      'tunnel:provision',
      'dns:preflight',
      'dns:ensure',
      'tunnel:start'
    ])

    const state = await readSessionState(cwd)
    expect(state?.dns?.comment).toBe(`flash-tunnel:${session.sessionId}`)

    await session.stop()

    expect(sequence.indexOf('dns:remove')).toBeGreaterThan(sequence.indexOf('tunnel:stop'))
    expect(sequence.indexOf('tunnel:deprovision')).toBeGreaterThan(sequence.indexOf('dns:remove'))
  })

  it('retries a retriable dns removal before giving up', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('retry-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })
    const sequence: string[] = []
    const dns = createFakeDns(sequence)
    let attempts = 0
    const remove = dns.remove
    dns.remove = async (ctx, ref) => {
      attempts += 1
      if (attempts < 3) {
        throw new AdapterError('temporary dns failure', { code: 'DNS_REMOVE_FAILED', retriable: true })
      }
      await remove(ctx, ref)
    }

    const session = await startPreviewSession({
      cwd,
      config: { server: { command: 'node server.mjs', port: 0 } },
      adapters: { tunnel: createFakeTunnelWithDns(sequence), dns },
      mode: 'named',
      hostname: 'retry.example.com',
      zone: 'example.com',
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    await session.stop()

    expect(attempts).toBe(3)
    expect(sequence).toContain('dns:remove')
    expect(await readSessionState(cwd)).toBeUndefined()
  })

  it('keeps dns and tunnel when --keep is set', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('keep-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })
    const sequence: string[] = []

    const session = await startPreviewSession({
      cwd,
      config: { server: { command: 'node server.mjs', port: 0 } },
      adapters: { tunnel: createFakeTunnelWithDns(sequence), dns: createFakeDns(sequence) },
      mode: 'named',
      hostname: 'keep.example.com',
      zone: 'example.com',
      keep: true,
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    await session.stop()

    expect(sequence).not.toContain('dns:remove')
    expect(sequence).not.toContain('tunnel:deprovision')

    const state = await readSessionState(cwd)
    expect(state?.state).toBe('kept')
    expect(state?.cleanup.kept).toBe(true)
    expect(state?.cleanup.inProgress).toBe(false)
  })

  it('persists expiresAt and emits cleanup events', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('events-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })
    const states: string[] = []
    const cleanup: string[] = []

    const session = await startPreviewSession({
      cwd,
      config: { server: { command: 'node server.mjs', port: 0 } },
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick',
      autoStopAfterMs: 60_000,
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    session.events.on('state', payload => states.push(`${payload.from}->${payload.to}`))
    session.events.on('cleanup:done', payload => cleanup.push(payload.ok ? 'ok' : 'failed'))

    const state = await readSessionState(cwd)
    expect(state?.expiresAt).toBeDefined()
    expect(Date.parse(state?.expiresAt ?? '')).toBeGreaterThan(Date.now())

    await session.stop()
    await session.stop()

    expect(states).toContain('running->tearing-down')
    expect(cleanup).toEqual(['ok'])
  })

  it('auto stops and cleans up after autoStopAfterMs', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('auto-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const session = await startPreviewSession({
      cwd,
      config: { server: { command: 'node server.mjs', port: 0 } },
      adapters: { tunnel: createFakeTunnel() },
      mode: 'quick',
      autoStopAfterMs: 1_200,
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    await session.autoStopped

    expect(session.stopping).toBe(true)
    expect(await readSessionState(cwd)).toBeUndefined()
  })

  it('keeps retryable state when a cleanup step exceeds the budget', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('timeout-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })
    const sequence: string[] = []
    const dns = createFakeDns(sequence)
    dns.remove = async () => new Promise<void>(() => {})

    const session = await startPreviewSession({
      cwd,
      config: { server: { command: 'node server.mjs', port: 0 } },
      adapters: { tunnel: createFakeTunnelWithDns(sequence), dns },
      mode: 'named',
      hostname: 'timeout.example.com',
      zone: 'example.com',
      cleanupBudgetMs: 800,
      verifyTimeoutMs: 10_000
    })
    sessions.push(session)

    let failure: unknown
    try {
      await session.stop()
    }
    catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(CleanupError)
    expect((failure as CleanupError).failures.some(item => item.step === 'dns.remove')).toBe(true)

    const state = await readSessionState(cwd)
    expect(state?.cleanup.required).toBe(true)
    expect(state?.cleanup.attempts).toBe(1)

    await session.server.stop()
  })
})
