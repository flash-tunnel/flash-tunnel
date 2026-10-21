import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { SessionCleaner } from '../src'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  killProcessTree,
  listSessionStates,
  readGlobalSessionState,
  reapSession
} from '../src'

const fixture = new URL('./fixtures/crash-session.mjs', import.meta.url)
const built = existsSync(new URL('../dist/index.mjs', import.meta.url))

let home: string
let project: string
let previousHome: string | undefined
let child: ChildProcess | undefined

async function waitForReady(process: ChildProcess): Promise<number[]> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`session did not become ready:\n${output}`))
    }, 20_000)

    process.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /READY \S+ (\d+) (\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolveReady([Number(match[1]), Number(match[2])])
      }
    })
    process.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    process.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`session exited before ready (code ${code}):\n${output}`))
    })
  })
}

beforeEach(async () => {
  previousHome = process.env.FLASH_TUNNEL_HOME
  home = await mkdtemp(join(tmpdir(), 'flash-tunnel-home-'))
  project = await mkdtemp(join(tmpdir(), 'flash-tunnel-recovery-'))
  process.env.FLASH_TUNNEL_HOME = home

  await mkdir(join(project, '.flash-tunnel'), { recursive: true })
  await writeFile(join(project, 'server.mjs'), `
    import { createServer } from 'node:http'
    console.log('SERVER_PID ' + process.pid)
    const server = createServer((request, response) => response.end('recovery-ok'))
    server.listen(0, '127.0.0.1', () => {
      console.log('Local: http://127.0.0.1:' + server.address().port)
    })
  `)
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL')
  }
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe.skipIf(!built)('signal recovery', () => {
  it.skipIf(process.platform === 'win32')('cleans up on a real SIGINT', async () => {
    child = spawn(process.execPath, [fileURLToPath(fixture), project], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FLASH_TUNNEL_HOME: home, GRACEFUL: '1' }
    })

    await waitForReady(child)
    const pids = JSON.parse(await readFile(join(project, 'pids.json'), 'utf8')) as {
      sessionId: string
      serverProcessPid: number
      tunnelPid: number
    }

    const exitCode = new Promise<number | null>((resolveExit) => {
      child?.once('exit', code => resolveExit(code))
    })

    child.kill('SIGINT')
    expect(await exitCode).toBe(130)

    expect(await readGlobalSessionState(pids.sessionId)).toBeUndefined()
    expect(await listSessionStates()).toHaveLength(0)
    expect(isProcessAlive(pids.tunnelPid)).toBe(false)
    expect(isProcessAlive(pids.serverProcessPid)).toBe(false)
  })
})

describe.skipIf(!built)('kill -9 recovery', () => {
  it('reaps a session whose process was killed', async () => {
    child = spawn(process.execPath, [fileURLToPath(fixture), project], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FLASH_TUNNEL_HOME: home }
    })

    await waitForReady(child)
    const pids = JSON.parse(await readFile(join(project, 'pids.json'), 'utf8')) as {
      sessionId: string
      serverProcessPid: number
      tunnelPid: number
    }

    const states = await listSessionStates()
    expect(states).toHaveLength(1)
    const sessionId = states[0]?.sessionId as string
    expect(sessionId).toBe(pids.sessionId)

    child.kill('SIGKILL')
    await new Promise<void>(resolveExit => child?.once('exit', () => resolveExit()))

    expect(await readGlobalSessionState(sessionId)).toBeDefined()

    try {
      const cleaner: SessionCleaner = {
        removeDns: async () => {},
        removeTunnel: async () => {}
      }

      const result = await reapSession(sessionId, { cleaner })
      expect(result.status).toBe('removed')
      expect(await readGlobalSessionState(sessionId)).toBeUndefined()
      expect(await listSessionStates()).toHaveLength(0)
      expect(isProcessAlive(pids.tunnelPid)).toBe(false)
    }
    finally {
      // The recorded server pid is the shell wrapper on Windows; stop the real node child too.
      await killProcessTree(pids.serverProcessPid)
    }
  })
})
