import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Reporter } from '../src/ui/reporter'

let out: string[]
let err: string[]
let stdoutSpy: ReturnType<typeof vi.spyOn>
let stderrSpy: ReturnType<typeof vi.spyOn>
let directory: string

beforeEach(async () => {
  out = []
  err = []
  directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-reporter-'))
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  await rm(directory, { recursive: true, force: true })
})

describe('reporter', () => {
  it('writes NDJSON to stdout and keeps human output out of it', () => {
    const reporter = new Reporter({ json: true })

    reporter.human('hello\n')
    reporter.event({ type: 'server:ready', localUrl: 'http://127.0.0.1:5173' })
    reporter.error(new Error('boom'), 'E_BOOM', 'try again')

    expect(out).toEqual([
      '{"type":"server:ready","localUrl":"http://127.0.0.1:5173"}\n',
      '{"type":"error","code":"E_BOOM","message":"boom","hint":"try again"}\n'
    ])
    expect(err).toEqual([])
  })

  it('renders human errors on stderr', () => {
    const reporter = new Reporter()

    reporter.error(new Error('boom'), 'E_BOOM')
    reporter.warn('careful')

    expect(out).toEqual([])
    expect(err.join('')).toContain('boom')
    expect(err.join('')).toContain('[E_BOOM]')
    expect(err.join('')).toContain('careful')
  })

  it('suppresses human output in silent mode but keeps events and errors', () => {
    const reporter = new Reporter({ json: true, silent: true })

    reporter.human('hello\n')
    reporter.warn('careful')
    reporter.event({ type: 'ready' })
    reporter.error(new Error('boom'))

    expect(out).toEqual([
      '{"type":"ready"}\n',
      '{"type":"error","message":"boom"}\n'
    ])
    expect(err).toEqual([])
  })

  it('writes the ready payload to a file', async () => {
    const reporter = new Reporter({ json: true, cwd: directory, readyFile: 'nested/ready.json' })

    await reporter.ready({
      type: 'ready',
      url: 'https://demo.example.com',
      localUrl: 'http://127.0.0.1:5173',
      tunnelId: 'tunnel-1',
      sessionId: 'ft_1'
    })

    const content = JSON.parse(await readFile(join(directory, 'nested/ready.json'), 'utf8'))
    expect(content).toMatchObject({
      type: 'ready',
      url: 'https://demo.example.com',
      sessionId: 'ft_1'
    })
    expect(JSON.parse(out[0] ?? '{}')).toMatchObject({ type: 'ready' })
  })
})
