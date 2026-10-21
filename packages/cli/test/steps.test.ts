import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Reporter } from '../src/ui/reporter'
import { StepUi } from '../src/ui/steps'

let out: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  out = []
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stdoutSpy.mockRestore()
})

describe('stepUi', () => {
  it('prints a single line per completed step without a TTY', () => {
    const steps = new StepUi(new Reporter(), { enabled: false })

    steps.handle({ id: 'server', status: 'start' })
    expect(out).toEqual([])

    steps.handle({ id: 'server', status: 'ok', detail: 'http://127.0.0.1:5173', durationMs: 850 })
    expect(out.join('')).toContain('local server')
    expect(out.join('')).toContain('850ms')
  })

  it('prints an error line for failed steps', () => {
    const steps = new StepUi(new Reporter(), { enabled: false })
    steps.handle({ id: 'verify', status: 'start' })
    steps.handle({ id: 'verify', status: 'fail', detail: 'HTTP 502', durationMs: 1200 })

    expect(out.join('')).toContain('verify')
    expect(out.join('')).toContain('HTTP 502')
  })

  it('emits NDJSON instead of human lines in JSON mode', () => {
    const steps = new StepUi(new Reporter({ json: true }), { enabled: false })
    steps.handle({ id: 'tunnel', status: 'start' })
    steps.handle({ id: 'tunnel', status: 'ok', detail: 'flash-tunnel-app', durationMs: 42 })

    const events = out.map(line => JSON.parse(line))
    expect(events[0]).toMatchObject({ type: 'step', id: 'tunnel', status: 'start' })
    expect(events[1]).toMatchObject({ type: 'step', id: 'tunnel', status: 'ok', durationMs: 42 })
  })
})
