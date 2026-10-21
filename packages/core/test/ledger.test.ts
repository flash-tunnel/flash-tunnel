import { describe, expect, it } from 'vitest'
import { ResourceLedger } from '../src'

const origin = { sessionId: 'ft_1', createdAt: Date.now(), version: '0.0.0' }

describe('resourceLedger', () => {
  it('disposes entries in reverse order', async () => {
    const ledger = new ResourceLedger()
    const calls: string[] = []

    for (const kind of ['server', 'tunnel', 'dns'] as const) {
      ledger.add({
        kind,
        provider: 'fake',
        ref: {},
        origin,
        owned: true,
        dispose: async () => {
          calls.push(kind)
        }
      })
    }

    for (const entry of ledger.reversed()) {
      await entry.dispose()
    }

    expect(calls).toEqual(['dns', 'tunnel', 'server'])
    expect(ledger.size).toBe(3)
  })

  it('keeps entries that are not owned for the caller to skip', () => {
    const ledger = new ResourceLedger()
    ledger.add({ kind: 'server', provider: 'local', ref: {}, origin, owned: false, dispose: async () => {} })

    expect(ledger.snapshot()[0]?.owned).toBe(false)
    expect(ledger.size).toBe(1)

    ledger.clear()
    expect(ledger.snapshot()).toEqual([])
  })
})
