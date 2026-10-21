import { AdapterError } from '@flash-tunnel/types'
import { describe, expect, it } from 'vitest'
import { adapterExitCode, errorExitCode, errorHint, FlashTunnelError, ProjectLockedError } from '../src'

describe('error mapping', () => {
  it('maps adapter error codes to exit codes', () => {
    expect(adapterExitCode('AUTH_INVALID')).toBe(4)
    expect(adapterExitCode('ACCOUNT_NOT_FOUND')).toBe(4)
    expect(adapterExitCode('TUNNEL_NOT_CONNECTED')).toBe(5)
    expect(adapterExitCode('DNS_RECORD_CREATE_FAILED')).toBe(6)
    expect(adapterExitCode('ZONE_NOT_ACTIVE')).toBe(6)
    expect(adapterExitCode('PUBLIC_VERIFY_FAILED')).toBe(7)
    expect(adapterExitCode('CLOUDFLARE_API_ERROR')).toBe(1)
  })

  it('prefers the explicit FlashTunnel exit code', () => {
    const error = new FlashTunnelError('bad config', { code: 'CONFIG_INVALID', exitCode: 2, hint: 'fix it' })
    expect(errorExitCode(error)).toBe(2)
    expect(errorHint(error)).toBe('fix it')
  })

  it('maps adapter, lock and unknown errors', () => {
    expect(errorExitCode(new AdapterError('nope', { code: 'TUNNEL_CREATE_FAILED' }))).toBe(5)
    expect(errorExitCode(new ProjectLockedError('session-1'))).toBe(2)
    expect(errorExitCode(new Error('boom'))).toBe(1)
  })

  it('returns adapter hints', () => {
    expect(errorHint(new AdapterError('nope', { code: 'AUTH_INVALID', hint: 'set a token' }))).toBe('set a token')
    expect(errorHint(new Error('boom'))).toBeUndefined()
  })
})
