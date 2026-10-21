import type { FetchCall } from './helpers'
import { afterEach, describe, expect, it } from 'vitest'
import { createCloudflareTunnel } from '../src'
import { cleanupFixtures, createContext, createFakeCloudflared, createFetcher, jsonResponse } from './helpers'

afterEach(async () => {
  await cleanupFixtures()
})

describe('cloudflareTunnel (named mode)', () => {
  it('provisions ingress, waits for a healthy tunnel and deletes it', async () => {
    const { directory, binary } = await createFakeCloudflared()
    const calls: FetchCall[] = []

    const fetcher = createFetcher(({ url, method, body }) => {
      const path = url.pathname

      if (path.endsWith('/user/tokens/verify')) {
        return jsonResponse({ status: 'active' })
      }
      if (path.endsWith('/accounts')) {
        return jsonResponse([{ id: 'acc-1', name: 'Example' }])
      }
      if (method === 'POST' && path.endsWith('/cfd_tunnel')) {
        return jsonResponse({ id: 'tunnel-1', name: 'flash-tunnel-demo', status: 'inactive', token: 'secret-token' })
      }
      if (method === 'PUT' && path.endsWith('/configurations')) {
        return jsonResponse({})
      }
      if (method === 'GET' && path.endsWith('/cfd_tunnel/tunnel-1')) {
        return jsonResponse({ id: 'tunnel-1', name: 'flash-tunnel-demo', status: 'healthy', connections: [{ id: 'conn-1' }] })
      }
      if (method === 'DELETE' && path.endsWith('/cfd_tunnel/tunnel-1/connections')) {
        return jsonResponse({})
      }
      if (method === 'DELETE' && path.endsWith('/cfd_tunnel/tunnel-1')) {
        return jsonResponse({})
      }

      return new Response(`unexpected ${method} ${path} ${body ?? ''}`, { status: 404 })
    }, calls)

    const adapter = createCloudflareTunnel({
      cloudflaredPath: binary,
      apiToken: 'token',
      fetcher
    })
    const ctx = createContext(directory)

    await adapter.preflight(ctx, { mode: 'named' })
    const handle = await adapter.provision(ctx, {
      name: 'flash-tunnel-demo',
      hostname: 'demo.example.com',
      localUrl: 'http://127.0.0.1:4321'
    })

    expect(handle.dns).toEqual({
      type: 'CNAME',
      target: 'tunnel-1.cfargotunnel.com',
      proxied: true
    })
    expect(handle.secrets.token).toBe('secret-token')

    const createCall = calls.find(call => call.method === 'POST' && call.url.pathname.endsWith('/cfd_tunnel'))
    expect(JSON.parse(createCall?.body ?? '{}')).toMatchObject({
      name: 'flash-tunnel-demo',
      config_src: 'cloudflare'
    })

    const ingressCall = calls.find(call => call.method === 'PUT')
    const ingress = JSON.parse(ingressCall?.body ?? '{}')
    expect(ingress.config.ingress[0]).toMatchObject({
      hostname: 'demo.example.com',
      service: 'http://127.0.0.1:4321'
    })
    expect(ingress.config.ingress.at(-1)).toEqual({ service: 'http_status:404' })

    await adapter.start(ctx, handle, {})
    const status = await adapter.waitReady(ctx, handle, 5000)
    expect(status).toMatchObject({
      state: 'connected',
      connections: 1,
      publicUrl: 'https://demo.example.com'
    })

    await adapter.stop(ctx, handle)
    await adapter.deprovision(ctx, handle)

    expect(calls.some(call => call.method === 'DELETE' && call.url.pathname.endsWith('/connections'))).toBe(true)
    expect(calls.some(call => call.method === 'DELETE' && call.url.pathname.endsWith('/cfd_tunnel/tunnel-1'))).toBe(true)
  })
})
