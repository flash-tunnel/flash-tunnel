import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDnsAdapter, loadTunnelAdapter } from '../src'

let directory: string

function tunnelSource(apiVersion = 1) {
  return `
export default {
  kind: 'tunnel',
  id: 'fake',
  apiVersion: ${apiVersion},
  capabilities: { modes: ['quick'], publicHostname: 'assigned', requiresDns: false, concurrent: true },
  preflight: async () => {},
  provision: async () => ({ provider: 'fake', tunnelId: 't', name: 'n', secrets: {} }),
  start: async () => {},
  waitReady: async () => ({ state: 'connected', connections: 1 }),
  stop: async () => {},
  deprovision: async () => {}
}
`
}

const dnsSource = `
export default {
  kind: 'dns',
  id: 'fake-dns',
  apiVersion: 1,
  capabilities: { recordTypes: ['CNAME'], proxied: true, ttl: true, comment: true, lookupByName: true },
  preflight: async () => {},
  ensure: async () => ({ provider: 'fake-dns', zoneId: 'z', recordId: 'r', name: 'n', type: 'CNAME', content: 'c', proxied: true }),
  remove: async () => {},
  find: async () => []
}
`

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-adapter-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('adapter loader', () => {
  it('loads a local tunnel adapter module', async () => {
    await writeFile(join(directory, 'tunnel.mjs'), tunnelSource())
    const adapter = await loadTunnelAdapter('file:./tunnel.mjs', directory)

    expect(adapter.id).toBe('fake')
    expect(adapter.capabilities.modes).toEqual(['quick'])
  })

  it('loads a local dns adapter module', async () => {
    await writeFile(join(directory, 'dns.mjs'), dnsSource)
    const adapter = await loadDnsAdapter('file:./dns.mjs', directory)

    expect(adapter.id).toBe('fake-dns')
  })

  it('rejects an incompatible api version', async () => {
    await writeFile(join(directory, 'old.mjs'), tunnelSource(2))

    await expect(loadTunnelAdapter('file:./old.mjs', directory))
      .rejects
      .toThrow(/API version 2/)
  })

  it('rejects a module without an adapter export', async () => {
    await writeFile(join(directory, 'empty.mjs'), 'export const other = 1\n')

    await expect(loadTunnelAdapter('file:./empty.mjs', directory))
      .rejects
      .toThrow(/does not export a valid tunnel adapter/)
  })

  it('reports missing modules with a hint', async () => {
    await expect(loadTunnelAdapter('file:./missing.mjs', directory))
      .rejects
      .toMatchObject({ code: 'ADAPTER_LOAD_FAILED' })
  })
})
