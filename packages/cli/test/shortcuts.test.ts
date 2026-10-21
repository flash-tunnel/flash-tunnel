import { describe, expect, it } from 'vitest'
import { installShortcuts } from '../src/ui/shortcuts'

describe('installShortcuts', () => {
  it('is a no-op without a TTY', () => {
    const dispose = installShortcuts({
      onQuit: () => {
        throw new Error('should not be called')
      }
    })

    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
  })
})
