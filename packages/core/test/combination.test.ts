import type { DnsAdapter, TunnelAdapter, TunnelCapabilities } from '@flash-tunnel/types'
import { describe, expect, it } from 'vitest'
import { FlashTunnelError, validateAdapterCombination } from '../src'

function createTunnel(capabilities: Partial<TunnelCapabilities> = {}): TunnelAdapter {
  return {
    kind: 'tunnel',
    id: 'fake-tunnel',
    apiVersion: 1,
    capabilities: {
      modes: ['named', 'quick'],
      publicHostname: 'both',
      requiresDns: false,
      concurrent: true,
      ...capabilities
    },
    preflight: async () => {},
    provision: async () => ({ provider: 'fake', tunnelId: 't', name: 'n', secrets: {} }),
    start: async () => {},
    waitReady: async () => ({ state: 'connected', connections: 1 }),
    stop: async () => {},
    deprovision: async () => {}
  }
}

function createDns(overrides: Partial<DnsAdapter['capabilities']> = {}): DnsAdapter {
  return {
    kind: 'dns',
    id: 'fake-dns',
    apiVersion: 1,
    capabilities: {
      recordTypes: ['CNAME'],
      proxied: true,
      ttl: true,
      comment: true,
      lookupByName: true,
      ...overrides
    },
    preflight: async () => {},
    ensure: async () => ({
      provider: 'fake-dns',
      zoneId: 'z',
      recordId: 'r',
      name: 'n',
      type: 'CNAME',
      content: 'c',
      proxied: true
    }),
    remove: async () => {},
    find: async () => []
  }
}

describe('validateAdapterCombination', () => {
  it('accepts a compatible pair', () => {
    const result = validateAdapterCombination({
      tunnel: createTunnel(),
      dns: createDns(),
      mode: 'named'
    })
    expect(result.warnings).toEqual([])
  })

  it('rejects an unsupported mode', () => {
    expect(() => validateAdapterCombination({
      tunnel: createTunnel({ modes: ['named'] }),
      dns: createDns(),
      mode: 'quick'
    })).toThrow(/does not support mode/)
  })

  it('requires a DNS adapter when the tunnel needs one', () => {
    expect(() => validateAdapterCombination({
      tunnel: createTunnel({ requiresDns: true }),
      mode: 'named'
    })).toThrow(/requires a DNS adapter/)
  })

  it('checks record type proxying and provider affinity', () => {
    const tunnel = createTunnel({
      dns: { type: 'CNAME', targetFrom: 'handle', proxied: true, providerAffinity: ['cloudflare'] }
    })

    expect(() => validateAdapterCombination({
      tunnel,
      dns: createDns({ recordTypes: ['A'] }),
      mode: 'named'
    })).toThrow(/CNAME records/)

    expect(() => validateAdapterCombination({
      tunnel,
      dns: createDns({ proxied: false }),
      mode: 'named'
    })).toThrow(/requires proxied DNS/)

    expect(() => validateAdapterCombination({
      tunnel,
      dns: createDns(),
      mode: 'named'
    })).toThrow(/not compatible/)

    expect(() => validateAdapterCombination({
      tunnel,
      dns: { ...createDns(), id: 'cloudflare' },
      mode: 'named'
    })).not.toThrow()
  })

  it('warns when quick mode ignores domain settings', () => {
    const result = validateAdapterCombination({
      tunnel: createTunnel(),
      dns: createDns(),
      mode: 'quick',
      requested: { zone: true, subdomain: true }
    })

    expect(result.warnings[0]).toContain('quick mode ignores domain configuration')
  })

  it('warns when an assigned hostname ignores domain settings', () => {
    const result = validateAdapterCombination({
      tunnel: createTunnel({ publicHostname: 'assigned' }),
      mode: 'named',
      requested: { hostname: true }
    })

    expect(result.warnings[0]).toContain('--hostname is ignored')
  })

  it('throws a config error for invalid combinations', () => {
    try {
      validateAdapterCombination({
        tunnel: createTunnel({ requiresDns: true }),
        mode: 'named'
      })
    }
    catch (error) {
      expect(error).toBeInstanceOf(FlashTunnelError)
      expect((error as FlashTunnelError).exitCode).toBe(2)
    }
  })
})
