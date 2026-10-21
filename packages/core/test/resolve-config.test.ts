import type { FlashTunnelConfig } from '@flash-tunnel/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FlashTunnelError, resolveConfig } from '../src'

let cwd: string
let configDir: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'flash-tunnel-resolve-'))
  configDir = join(cwd, 'apps', 'web')
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function resolve(config: FlashTunnelConfig = {}, overrides: Partial<Parameters<typeof resolveConfig>[0]> = {}) {
  return resolveConfig({
    cwd,
    config,
    env: {},
    ...overrides
  })
}

describe('resolveConfig', () => {
  it('fills documented defaults', () => {
    const resolved = resolve()

    expect(resolved.values.tunnel.mode).toBe('named')
    expect(resolved.values.tunnel.provider).toBe('cloudflare')
    expect(resolved.values.domain.provider).toBe('cloudflare')
    expect(resolved.values.server.timeout).toBe(60_000)
    expect(resolved.values.providers.cloudflare.cloudflaredPath).toBe('cloudflared')
    expect(resolved.values.tunnel.name).toMatch(/^flash-tunnel-.+-[a-z0-9]{4}$/)
    expect(resolved.sources['tunnel.mode']?.source).toBe('default')
    expect(resolved.sources['server.timeout']?.source).toBe('default')
  })

  it('prefers cli over env over config', () => {
    const resolved = resolve(
      {
        domain: { zone: 'config.example.com' },
        tunnel: { mode: 'quick' },
        server: { port: 3000, timeout: 12_000 },
        autoStopAfter: '1h'
      },
      {
        env: {
          FLASH_TUNNEL_ZONE: 'env.example.com',
          FLASH_TUNNEL_MODE: 'named',
          FLASH_TUNNEL_PORT: '4000',
          FLASH_TUNNEL_AUTO_STOP: '30m'
        },
        cli: { zone: 'cli.example.com', port: '5000', autoStop: '10m' }
      }
    )

    expect(resolved.values.domain.zone).toBe('cli.example.com')
    expect(resolved.values.server.port).toBe(5000)
    expect(resolved.values.tunnel.mode).toBe('named')
    expect(resolved.values.autoStopAfter).toBe(10 * 60_000)
    expect(resolved.sources['domain.zone']?.source).toBe('cli')
    expect(resolved.sources['server.port']?.source).toBe('cli')
    expect(resolved.sources.autoStopAfter?.source).toBe('cli')
  })

  it('renders the hostname with the subdomain template', () => {
    const resolved = resolve(
      { domain: { zone: 'example.com', subdomain: 'web-{project}' } },
      { cli: { sessionId: 'ft_test_1' } }
    )

    expect(resolved.values.domain.subdomain).toBe('web-{project}')
    expect(resolved.values.domain.hostname).toMatch(/^web-flash-tunnel-resolve-.+\.example\.com$/)
    expect(resolved.sources['domain.hostname']?.source).toBe('default')
  })

  it('uses an explicit hostname over the template', () => {
    const resolved = resolve(
      { domain: { zone: 'example.com' } },
      { env: { FLASH_TUNNEL_HOSTNAME: 'pinned.example.com' } }
    )

    expect(resolved.values.domain.hostname).toBe('pinned.example.com')
    expect(resolved.sources['domain.hostname']?.source).toBe('env')
  })

  it('resolves relative server paths against the config directory', () => {
    const resolved = resolve(
      { server: { cwd: 'apps/web', dir: 'dist' } },
      { configFile: join(cwd, 'flash-tunnel.ts') }
    )

    expect(resolved.values.server.cwd).toBe(configDir)
    expect(resolved.values.server.dir).toBe(join(cwd, 'dist'))
  })

  it('defaults server.cwd to the config directory', () => {
    const resolved = resolve({}, { configFile: join(configDir, 'flash-tunnel.ts') })
    expect(resolved.values.server.cwd).toBe(configDir)
  })

  it('supports static and attach cli modes', () => {
    const staticResolved = resolve({}, { cli: { static: 'dist' } })
    expect(staticResolved.values.server.dir).toBe(join(cwd, 'dist'))
    expect(staticResolved.sources['server.dir']?.source).toBe('cli')

    expect(() => resolve({}, { cli: { static: 'dist', url: 'http://127.0.0.1:3000' } }))
      .toThrow(/cannot be used together/)
    expect(() => resolve({}, { cli: { attach: true } })).toThrow(/--attach requires --url/)
    expect(() => resolve({ server: { command: 'pnpm dev' } }, { cli: { attach: true, url: 'http://127.0.0.1:3000' } }))
      .toThrow(/--attach cannot be used with server.command/)
  })

  it('guards multi-level subdomains behind the cli flag', () => {
    expect(() => resolve({ domain: { zone: 'example.com', subdomain: 'a.b' } }))
      .toThrow(/Multi-level subdomains/)

    const resolved = resolve(
      { domain: { zone: 'example.com', subdomain: 'a.b' } },
      { cli: { allowMultilevel: true } }
    )
    expect(resolved.values.domain.hostname).toBe('a.b.example.com')
  })

  it('records detected server values', () => {
    const resolved = resolve({}, {
      detected: { command: 'pnpm dev', port: 5173, framework: 'vite', reason: 'scripts.dev' }
    })

    expect(resolved.values.server.command).toBe('pnpm dev')
    expect(resolved.values.server.port).toBe(5173)
    expect(resolved.sources['server.command']?.source).toBe('detected')
    expect(resolved.sources['server.port']?.source).toBe('detected')
  })

  it('uses an inferred zone', () => {
    const resolved = resolve({}, { inferredZone: 'example.com' })
    expect(resolved.values.domain.zone).toBe('example.com')
    expect(resolved.sources['domain.zone']?.source).toBe('inferred')
  })

  it('warns about unknown fields', () => {
    const resolved = resolve({ mystery: true } as FlashTunnelConfig)
    expect(resolved.warnings.join('\n')).toContain('mystery')
  })

  it('rejects conflicting server modes', () => {
    expect(() => resolve({ server: { url: 'http://127.0.0.1:3000', dir: 'dist' } }))
      .toThrow(FlashTunnelError)
    expect(() => resolve({ server: { command: 'pnpm dev', dir: 'dist' } }))
      .toThrow(/cannot be used together/)
  })

  it('rejects invalid values with a config error', () => {
    expect(() => resolve({ tunnel: { mode: 'bogus' as 'named' } })).toThrow(/tunnel\.mode/)
    expect(() => resolve({ server: { port: 70_000 } })).toThrow(/server\.port/)
    expect(() => resolve({ server: { timeout: -1 } })).toThrow(/server\.timeout/)
    expect(() => resolve({ autoStopAfter: 'soon' })).toThrow(/autoStopAfter/)

    try {
      resolve({ server: { port: 70_000 } })
    }
    catch (error) {
      expect(error).toBeInstanceOf(FlashTunnelError)
      expect((error as FlashTunnelError).exitCode).toBe(2)
      expect((error as FlashTunnelError).code).toBe('CONFIG_INVALID')
    }
  })
})
