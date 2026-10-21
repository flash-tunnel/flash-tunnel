import type { FetchCall } from './helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudflareDns } from '../src'
import { cleanupFixtures, createContext, createFetcher, jsonResponse } from './helpers'

const zone = { id: 'zone-1', name: 'example.com', status: 'active' }

afterEach(async () => {
  await cleanupFixtures()
})

function createApiFetcher(options: {
  records?: Array<Record<string, unknown>>
  calls?: FetchCall[]
} = {}): typeof fetch {
  let records = options.records ?? []
  const calls = options.calls ?? []

  return createFetcher(({ url, method, body }) => {
    const path = url.pathname

    if (path.endsWith('/user/tokens/verify')) {
      return jsonResponse({ status: 'active' })
    }
    if (path.endsWith('/zones')) {
      return jsonResponse([zone])
    }
    if (method === 'GET' && path.endsWith('/dns_records')) {
      return jsonResponse(records)
    }
    if (method === 'POST' && path.endsWith('/dns_records')) {
      const input = JSON.parse(body ?? '{}')
      const record = {
        id: 'record-1',
        name: input.name,
        type: input.type,
        content: input.content,
        proxied: input.proxied,
        comment: input.comment
      }
      records = [record]
      return jsonResponse(record)
    }
    if (method === 'DELETE' && path.includes('/dns_records/')) {
      records = []
      return jsonResponse({})
    }

    return new Response(`unexpected ${method} ${path}`, { status: 404 })
  }, calls)
}

describe('cloudflareDns', () => {
  it('creates and removes a record', async () => {
    const calls: FetchCall[] = []
    const adapter = createCloudflareDns({
      apiToken: 'token',
      fetcher: createApiFetcher({ calls })
    })
    const ctx = createContext('D:/Projects/app')

    await adapter.preflight(ctx, {
      zone: 'example.com',
      name: 'demo.example.com',
      type: 'CNAME'
    })

    const ref = await adapter.ensure(ctx, {
      zone: 'example.com',
      name: 'demo.example.com',
      type: 'CNAME',
      content: 'tunnel.cfargotunnel.com',
      proxied: true,
      ttl: 1,
      comment: 'flash-tunnel:ft_test'
    })

    expect(ref).toMatchObject({
      provider: 'cloudflare',
      zoneId: 'zone-1',
      recordId: 'record-1',
      name: 'demo.example.com',
      type: 'CNAME',
      proxied: true
    })

    const createCall = calls.find(call => call.method === 'POST')
    expect(JSON.parse(createCall?.body ?? '{}')).toMatchObject({
      type: 'CNAME',
      name: 'demo.example.com',
      content: 'tunnel.cfargotunnel.com',
      proxied: true,
      ttl: 1,
      comment: 'flash-tunnel:ft_test'
    })

    await adapter.remove(ctx, ref)
    await adapter.remove(ctx, ref)
  })

  it('rejects a conflicting record from another tool', async () => {
    const adapter = createCloudflareDns({
      apiToken: 'token',
      fetcher: createApiFetcher({
        records: [{
          id: 'other',
          name: 'demo.example.com',
          type: 'CNAME',
          content: 'other.example.com',
          proxied: false
        }]
      })
    })
    const ctx = createContext('D:/Projects/app')

    await expect(adapter.preflight(ctx, {
      zone: 'example.com',
      name: 'demo.example.com',
      type: 'CNAME'
    })).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })
  })

  it('reclaims records carrying the flash-tunnel marker', async () => {
    const calls: FetchCall[] = []
    const adapter = createCloudflareDns({
      apiToken: 'token',
      fetcher: createApiFetcher({
        calls,
        records: [{
          id: 'old',
          name: 'demo.example.com',
          type: 'CNAME',
          content: 'old.cfargotunnel.com',
          proxied: true,
          comment: 'flash-tunnel:ft_old'
        }]
      })
    })
    const ctx = createContext('D:/Projects/app')

    await adapter.preflight(ctx, {
      zone: 'example.com',
      name: 'demo.example.com',
      type: 'CNAME'
    })
    await adapter.ensure(ctx, {
      zone: 'example.com',
      name: 'demo.example.com',
      type: 'CNAME',
      content: 'new.cfargotunnel.com',
      proxied: true,
      comment: 'flash-tunnel:ft_new'
    })

    const deleteCall = calls.find(call => call.method === 'DELETE')
    const createCall = calls.find(call => call.method === 'POST')
    expect(deleteCall?.url.pathname).toContain('/dns_records/old')
    expect(createCall).toBeDefined()
  })
})
