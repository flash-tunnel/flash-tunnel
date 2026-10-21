import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createTheme } from '../src/ui/theme'

const previousNoColor = process.env.NO_COLOR
const previousForceColor = process.env.FORCE_COLOR

afterEach(() => {
  if (previousNoColor === undefined) {
    delete process.env.NO_COLOR
  }
  else {
    process.env.NO_COLOR = previousNoColor
  }
  if (previousForceColor === undefined) {
    delete process.env.FORCE_COLOR
  }
  else {
    process.env.FORCE_COLOR = previousForceColor
  }
})

describe('theme', () => {
  it('respects NO_COLOR', () => {
    process.env.NO_COLOR = '1'
    delete process.env.FORCE_COLOR

    const theme = createTheme(process.stdout)
    expect(theme.ok('ok')).toBe('ok')
    expect(theme.err('bad')).toBe('bad')
  })

  it('emits ANSI when FORCE_COLOR is set', () => {
    delete process.env.NO_COLOR
    process.env.FORCE_COLOR = '1'

    const theme = createTheme(process.stdout)
    expect(theme.ok('ok')).toContain('\u001B[')
  })
})
