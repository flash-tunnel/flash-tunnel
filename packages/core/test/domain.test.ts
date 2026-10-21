import { describe, expect, it } from 'vitest'
import { resolveHostname } from '../src'

describe('resolveHostname', () => {
  it('renders the default project and random template', () => {
    const hostname = resolveHostname({ cwd: 'D:/Projects/My App', zone: 'example.com' })
    expect(hostname).toMatch(/^my-app-[2-9a-z]{4}\.example\.com$/)
  })

  it('supports project branch and custom random length', () => {
    const hostname = resolveHostname({
      cwd: 'D:/Projects/My App',
      zone: 'example.com',
      subdomain: '{project}-{branch}-{rand:6}'
    })
    expect(hostname).toMatch(/^my-app-nogit-[2-9a-z]{6}\.example\.com$/)
  })

  it('honors an explicit hostname', () => {
    expect(resolveHostname({
      cwd: 'D:/Projects/My App',
      zone: 'example.com',
      hostname: 'preview.example.com'
    })).toBe('preview.example.com')
  })

  it('rejects multi-level labels', () => {
    expect(() => resolveHostname({
      cwd: 'D:/Projects/My App',
      zone: 'example.com',
      subdomain: 'a.b'
    })).toThrow(/Multi-level/)
  })
})
