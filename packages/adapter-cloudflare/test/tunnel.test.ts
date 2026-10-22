import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudflareTunnel } from '../src'
import { cleanupFixtures, createContext, createFakeCloudflared } from './helpers'

afterEach(async () => {
  await cleanupFixtures()
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

  it('rejects a tunnel target that carries a path', async () => {
    const { directory, binary } = await createFakeCloudflared()
    const adapter = createCloudflareTunnel({ cloudflaredPath: binary })
    const ctx = createContext(directory)

    await expect(adapter.provision(ctx, {
      name: 'bad-target',
      localUrl: 'http://127.0.0.1:3030/__mcp'
    })).rejects.toMatchObject({
      code: 'INVALID_LOCAL_URL'
    })
  })

  it('requires a token for named mode', async () => {
    const { directory, binary } = await createFakeCloudflared()
    const adapter = createCloudflareTunnel({ cloudflaredPath: binary })
    const ctx = createContext(directory)

    await expect(adapter.preflight(ctx, { mode: 'named' })).rejects.toMatchObject({
      code: 'AUTH_INVALID'
    })
  })
})
