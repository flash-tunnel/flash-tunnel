import type { TunnelAdapter } from '@flash-tunnel/types'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startPreviewSession } from '../src'

const directories: string[] = []
const sessions: Array<{ stop: () => Promise<void> }> = []

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

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.stop().catch(() => {})))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('startPreviewSession', () => {
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

    const response = await fetch(session.publicUrl)
    expect(await response.text()).toBe('session-ok')

    await session.stop()
    await expect(fetch(session.localUrl)).rejects.toThrow()
  })
})
