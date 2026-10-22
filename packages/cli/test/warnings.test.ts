import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installWarningFilter } from '../src/warnings'

const defaultListeners = process.listeners('warning')

afterEach(() => {
  process.removeAllListeners('warning')
  for (const listener of defaultListeners) {
    process.on('warning', listener)
  }
  vi.restoreAllMocks()
})

function captureStderr(): string[] {
  const output: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    output.push(String(chunk))
    return true
  })
  return output
}

/** process.emitWarning() delivers on next tick. */
function nextWarningTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
}

describe('installWarningFilter', () => {
  it('drops deprecation warnings raised by dependencies', async () => {
    const output = captureStderr()
    installWarningFilter()

    process.emitWarning('old api', 'DeprecationWarning', 'DEP9999')
    await nextWarningTick()

    expect(output).toEqual([])
  })

  it('keeps other process warnings visible', async () => {
    const output = captureStderr()
    installWarningFilter()

    process.emitWarning('listener leak', 'MaxListenersExceededWarning')
    await nextWarningTick()

    expect(output.join('')).toContain('MaxListenersExceededWarning: listener leak')
  })

  it('stays out of the way when deprecations are traced deliberately', () => {
    const previous = process.traceDeprecation
    process.traceDeprecation = true

    try {
      installWarningFilter()
      expect(process.listeners('warning')).toEqual(defaultListeners)
    }
    finally {
      process.traceDeprecation = previous
    }
  })
})
