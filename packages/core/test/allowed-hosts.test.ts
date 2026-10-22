import { describe, expect, it } from 'vitest'
import {
  QUICK_TUNNEL_ALLOWED_HOST,
  tunnelAllowedHost,
  VITE_ALLOWED_HOSTS_ENV,
  viteAllowedHostsEnv
} from '../src'

describe('tunnelAllowedHost', () => {
  it('uses the stable hostname of a named tunnel', () => {
    expect(tunnelAllowedHost('named', 'demo.example.com')).toBe('demo.example.com')
  })

  it('falls back to the quick tunnel domain', () => {
    expect(tunnelAllowedHost('quick')).toBe('.trycloudflare.com')
    expect(tunnelAllowedHost('quick', 'ignored.example.com')).toBe('.trycloudflare.com')
    expect(tunnelAllowedHost('named')).toBe('.trycloudflare.com')
  })
})

describe('viteAllowedHostsEnv', () => {
  it('injects the tunnel host into the dev server environment', () => {
    expect(viteAllowedHostsEnv('named', 'demo.example.com', {})).toEqual({
      [VITE_ALLOWED_HOSTS_ENV]: 'demo.example.com'
    })
    expect(viteAllowedHostsEnv('quick', undefined, {})).toEqual({
      [VITE_ALLOWED_HOSTS_ENV]: QUICK_TUNNEL_ALLOWED_HOST
    })
  })

  it('does not override a host the user already configured', () => {
    expect(viteAllowedHostsEnv('named', 'demo.example.com', {
      [VITE_ALLOWED_HOSTS_ENV]: 'custom.example.com'
    })).toEqual({})
  })
})
