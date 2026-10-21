import type { AdapterContext } from '@flash-tunnel/types'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudflareTunnel } from '../src'

const directories: string[] = []

function createContext(cwd: string): AdapterContext {
  return {
    sessionId: 'ft_test',
    cwd,
    signal: new AbortController().signal,
    now: Date.now,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  }
}

async function createFakeCloudflared(): Promise<{ directory: string, binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-cloudflared-'))
  directories.push(directory)

  await writeFile(join(directory, 'fake-cloudflared.mjs'), `
    if (process.argv.includes('--version')) {
      console.log('cloudflared version 2026.1.0')
      process.exit(0)
    }
    console.error('INF |  https://fake-preview.trycloudflare.com  |')
    setInterval(() => {}, 1000)
  `)

  if (process.platform === 'win32') {
    const binary = join(directory, 'cloudflared.cmd')
    await writeFile(binary, '@echo off\r\nnode "%~dp0fake-cloudflared.mjs" %*\r\n')
    return { directory, binary }
  }

  const binary = join(directory, 'cloudflared')
  await writeFile(binary, '#!/bin/sh\nexec node "$(dirname "$0")/fake-cloudflared.mjs" "$@"\n')
  await chmod(binary, 0o755)
  return { directory, binary }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('cloudflareTunnel (quick mode)', () => {
  it('parses the trycloudflare url and stops the process', async () => {
    const { directory, binary } = await createFakeCloudflared()
    const adapter = createCloudflareTunnel({ cloudflaredPath: binary })
    const ctx = createContext(directory)

    await adapter.preflight(ctx, { mode: 'quick' })
    const handle = await adapter.provision(ctx, {
      name: 'smoke',
      localUrl: 'http://127.0.0.1:4321'
    })
    await adapter.start(ctx, handle, {})
    const status = await adapter.waitReady(ctx, handle, 5000)

    expect(status.publicUrl).toBe('https://fake-preview.trycloudflare.com')
    await adapter.stop(ctx, handle)
    await expect(adapter.stop(ctx, handle)).resolves.toBeUndefined()
  })

  it('reports a missing binary', async () => {
    const adapter = createCloudflareTunnel({ cloudflaredPath: join(tmpdir(), 'does-not-exist-cloudflared') })
    const ctx = createContext(tmpdir())

    await expect(adapter.preflight(ctx, { mode: 'quick' })).rejects.toMatchObject({
      code: 'PROCESS_SPAWN_FAILED'
    })
  })

  it('requires a token for named mode and reports it as not implemented', async () => {
    const adapter = createCloudflareTunnel({ cloudflaredPath: 'cloudflared' })
    const ctx = createContext(tmpdir())

    await expect(adapter.preflight(ctx, { mode: 'named' })).rejects.toMatchObject({
      code: 'AUTH_INVALID'
    })

    const withToken = createCloudflareTunnel({ cloudflaredPath: 'cloudflared', apiToken: 'token' })
    await expect(withToken.preflight(ctx, { mode: 'named' })).rejects.toMatchObject({
      code: 'TUNNEL_CREATE_FAILED'
    })
  })
})
