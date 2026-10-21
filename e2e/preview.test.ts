import type { TunnelAdapter } from '@flash-tunnel/types'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { cloudflareTunnel, createCloudflareTunnel } from '@flash-tunnel/adapter-cloudflare'
import { readSessionState, startPreviewSession } from '@flash-tunnel/core'
import { describe, expect, it } from 'vitest'

const enabled = process.env.FLASH_TUNNEL_E2E === '1'
const hasCloudflared = Boolean(process.env.FLASH_TUNNEL_CLOUDFLARED)

describe.skipIf(!enabled || !hasCloudflared)('real Cloudflare preview', () => {
  it('creates a quick tunnel, verifies it and cleans everything up', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-e2e-'))
    const adapter: TunnelAdapter = process.env.FLASH_TUNNEL_CLOUDFLARED
      ? createCloudflareTunnel({ cloudflaredPath: process.env.FLASH_TUNNEL_CLOUDFLARED })
      : cloudflareTunnel

    try {
      await writeFile(join(directory, 'index.html'), '<h1>e2e</h1>')

      const session = await startPreviewSession({
        cwd: directory,
        config: {
          server: { dir: '.' },
          tunnel: { mode: 'quick' }
        },
        adapters: { tunnel: adapter },
        mode: 'quick',
        verifyTimeoutMs: 120_000
      })

      expect(session.publicUrl).toMatch(/^https:\/\/.+\.trycloudflare\.com$/)
      const response = await fetch(session.publicUrl)
      expect(response.status).toBeLessThan(500)
      expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain('e2e')

      await session.stop()
      expect(await readSessionState(directory)).toBeUndefined()
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
