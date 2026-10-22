import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration, randomId, redact, shellInvocation, slugify } from '../src'

describe('slugify', () => {
  it('normalizes project names', () => {
    expect(slugify('My Vite App')).toBe('my-vite-app')
    expect(slugify('  feat/login  ')).toBe('feat-login')
    expect(slugify('a---b')).toBe('a-b')
  })

  it('truncates and falls back', () => {
    expect(slugify('a'.repeat(40))).toHaveLength(24)
    expect(slugify('你好')).toBe('app')
  })
})

describe('randomId', () => {
  it('returns the requested length with safe characters', () => {
    const id = randomId(8)
    expect(id).toHaveLength(8)
    expect(id).toMatch(/^[2-9a-z]+$/)
  })

  it('rejects invalid lengths', () => {
    expect(() => randomId(0)).toThrow(RangeError)
  })
})

describe('redact', () => {
  it('removes bearer tokens and token assignments', () => {
    expect(redact('Authorization: Bearer abc.def-123')).toContain('Bearer [REDACTED]')
    expect(redact('TUNNEL_TOKEN=super-secret-value')).toBe('TUNNEL_TOKEN=[REDACTED]')
    expect(redact('api_token: "abcdefgh12345678"')).toContain('[REDACTED]')
    expect(redact('plain log line')).toBe('plain log line')
  })
})

describe('formatDuration', () => {
  it('formats milliseconds, seconds and minutes', () => {
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(2000)).toBe('2s')
    expect(formatDuration(63_000)).toBe('1m 3s')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(5_400_000)).toBe('1h 30m')
  })
})

describe('parseDuration', () => {
  it('parses supported units', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration(5000)).toBe(5000)
  })

  it('rejects invalid or too short values', () => {
    expect(() => parseDuration('1d')).toThrow(RangeError)
    expect(() => parseDuration('500ms')).toThrow(RangeError)
    expect(() => parseDuration(10)).toThrow(RangeError)
  })
})

describe('shellInvocation', () => {
  it('keeps command and args separate outside Windows', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(shellInvocation('cloudflared', ['--version'])).toEqual({
      command: 'cloudflared',
      args: ['--version'],
      shell: false
    })
  })

  it('joins and escapes a single shell command on Windows', () => {
    if (process.platform !== 'win32') {
      return
    }

    expect(shellInvocation('pnpm', ['run', 'build'])).toEqual({
      command: 'pnpm run build',
      args: [],
      shell: true
    })
    expect(shellInvocation('C:\\Program Files\\cloudflared.exe', ['--version']).command)
      .toBe('"C:\\Program Files\\cloudflared.exe" --version')
  })
})
