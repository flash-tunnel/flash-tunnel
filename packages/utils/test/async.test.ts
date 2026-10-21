import { describe, expect, it } from 'vitest'
import { sleep, stripAnsi } from '../src'

describe('stripAnsi', () => {
  it('removes color sequences', () => {
    expect(stripAnsi('\u001B[32mLocal:\u001B[39m http://localhost:5173/')).toBe('Local: http://localhost:5173/')
  })
})

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
  })

  it('rejects on abort', async () => {
    const controller = new AbortController()
    const promise = sleep(10_000, controller.signal)
    controller.abort(new Error('stop'))
    await expect(promise).rejects.toThrow('stop')
  })
})
