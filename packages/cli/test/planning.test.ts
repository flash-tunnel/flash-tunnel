import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { detectServer, detectWorkspaceCandidates, FlashTunnelError } from '@flash-tunnel/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src'

vi.mock('@flash-tunnel/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@flash-tunnel/core')>()
  return {
    ...actual,
    detectServer: vi.fn(actual.detectServer),
    detectWorkspaceCandidates: vi.fn(actual.detectWorkspaceCandidates)
  }
})

let directory: string
let output: string[]
let previousExitCode: typeof process.exitCode

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
  process.exitCode = previousExitCode
  await rm(directory, { recursive: true, force: true })
})

function events(): Array<{ type: string, code?: number | string }> {
  return output.join('').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function runPlanning(): Promise<void> {
  await runCli(['node', 'flash-tunnel', '--cwd', directory, '--mode', 'quick', '--no-sweep', '--json'])
  await vi.waitFor(() => expect(events().some(event => event.type === 'exit')).toBe(true))
}

describe('preview planning', () => {
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
