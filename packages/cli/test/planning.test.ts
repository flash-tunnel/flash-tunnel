import type { Server } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { detectServer, detectWorkspaceCandidates, FlashTunnelError, startPreviewSession } from '@flash-tunnel/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src'

vi.mock('@flash-tunnel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@flash-tunnel/core')>()
  return {
    ...actual,
    detectServer: vi.fn(actual.detectServer),
    detectWorkspaceCandidates: vi.fn(actual.detectWorkspaceCandidates),
    startPreviewSession: vi.fn(async () => { throw new Error('Session boundary reached') })
  }
})

let directory: string
let output: string[]
let previousExitCode: typeof process.exitCode
const servers: Server[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-planning-'))
  previousExitCode = process.exitCode
  output = []
  vi.stubEnv('FLASH_TUNNEL_HOME', join(directory, 'home'))
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    output.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(detectServer).mockClear()
  vi.mocked(detectWorkspaceCandidates).mockClear()
  vi.mocked(startPreviewSession).mockClear()
  process.exitCode = previousExitCode
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await rm(directory, { recursive: true, force: true })
})

function events(): Array<{ type: string, code?: number | string }> {
  return output.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function runPlanning(args: string[] = []): Promise<void> {
  await runCli(['node', 'flash-tunnel', '--cwd', directory, '--mode', 'quick', '--no-sweep', '--json', ...args])
  await vi.waitFor(() => expect(events().some(event => event.type === 'exit')).toBe(true))
}

async function occupiedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address')
  }
  return address.port
}

describe('preview planning', () => {
  it('passes the original detected plan to the session', async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.mjs' } }))

    await runPlanning(['--port', '0'])

    expect(detectServer).toHaveBeenCalledTimes(1)
    expect(startPreviewSession).toHaveBeenCalledWith(expect.objectContaining({
      serverPlan: expect.objectContaining({ script: 'dev', reason: 'dev script', confidence: 'low', port: 0 })
    }))
  })

  it.each(['default', 'framework'] as const)('lets a command start when its %s port is occupied', async (portSource) => {
    const port = await occupiedPort()
    vi.mocked(detectServer).mockReturnValueOnce({
      mode: 'command',
      cwd: directory,
      command: 'node app.mjs',
      framework: 'unknown',
      port,
      portSource,
      reason: 'guessed port',
      confidence: 'low'
    })

    await runPlanning()

    expect(startPreviewSession).toHaveBeenCalledWith(expect.objectContaining({
      serverPlan: expect.objectContaining({ mode: 'command', port, portSource })
    }))
    expect(events()).not.toContainEqual(expect.objectContaining({ code: 'PORT_IN_USE' }))
  })

  it('requires consent before reusing an occupied fixed port', async () => {
    const port = await occupiedPort()
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.mjs' } }))

    await runPlanning(['--port', String(port)])

    expect(startPreviewSession).not.toHaveBeenCalled()
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'PORT_IN_USE' }))
    expect(process.exitCode).toBe(3)
  })

  it('only attaches to an occupied guessed port when reuse is requested', async () => {
    const port = await occupiedPort()
    vi.mocked(detectServer).mockReturnValueOnce({
      mode: 'command',
      cwd: directory,
      command: 'node app.mjs',
      framework: 'unknown',
      port,
      portSource: 'default',
      reason: 'guessed port',
      confidence: 'low'
    })

    await runPlanning(['--reuse'])

    expect(startPreviewSession).toHaveBeenCalledWith(expect.objectContaining({
      serverPlan: expect.objectContaining({ mode: 'attach', url: `http://127.0.0.1:${port}`, command: undefined })
    }))
  })

  it('uses the error code to offer workspaces even when the message changes', async () => {
    await mkdir(join(directory, 'apps/web'), { recursive: true })
    await writeFile(join(directory, 'apps/web/package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    vi.mocked(detectServer).mockImplementationOnce(() => {
      throw new FlashTunnelError('No application entry point is available', { code: 'NO_RUNNABLE_SCRIPT', exitCode: 3 })
    })

    await runPlanning()

    expect(detectWorkspaceCandidates).toHaveBeenCalledWith(directory)
    expect(events()).toContainEqual(expect.objectContaining({ type: 'error', code: 'WORKSPACE_REQUIRED' }))
    expect(process.exitCode).toBe(2)
  })

  it('does not offer workspaces for unrelated errors containing the old message', async () => {
    vi.mocked(detectServer).mockImplementationOnce(() => {
      throw new Error('Invalid configuration: No runnable script is not a command')
    })

    await runPlanning()

    expect(detectWorkspaceCandidates).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
