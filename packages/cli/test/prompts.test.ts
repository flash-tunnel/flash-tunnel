import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { canPrompt } from '../src/ui/prompts'

const previousCi = process.env.CI

afterEach(() => {
  if (previousCi === undefined) {
    delete process.env.CI
  }
  else {
    process.env.CI = previousCi
  }
})

describe('canPrompt', () => {
  it('never prompts without a TTY', () => {
    delete process.env.CI
    expect(canPrompt()).toBe(false)
    expect(canPrompt({ yes: true })).toBe(false)
    expect(canPrompt({ json: true })).toBe(false)
  })

  it('never prompts in CI even with mocked terminals', () => {
    process.env.CI = '1'
    expect(canPrompt()).toBe(false)
  })
})
