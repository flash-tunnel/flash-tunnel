import { describe, expect, it } from 'vitest'
import { CORE_API_VERSION, createSessionId } from '../src'

describe('createSessionId', () => {
  it('uses the ft_<time>_<random> format', () => {
    expect(createSessionId(1_700_000_000_000)).toMatch(/^ft_[0-9a-z]+_[2-9a-z]{4}$/)
  })

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createSessionId()))
    expect(ids.size).toBe(20)
  })

  it('exposes a core api version', () => {
    expect(CORE_API_VERSION).toBe(1)
  })
})
