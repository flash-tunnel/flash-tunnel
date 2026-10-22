import type { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import type { ServerHandle, ServerPlan, StartServerOptions } from './types'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { sleep, stripAnsi } from '@flash-tunnel/utils'
import { killProcessTree } from '../process'
import { startStaticServer } from './static'

// Only the origin is useful: cloudflared proxies to a host/port and keeps the
// request path, so a path printed by the dev server (Slidev prints /__mcp last)
// must not become part of the tunnel target.
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/
const OUTPUT_LIMIT = 200

function normalizeUrl(raw: string): string {
  const withScheme = raw.startsWith('http') ? raw : `http://${raw}`
  const url = new URL(withScheme)

  if (url.hostname === '0.0.0.0' || url.hostname === '[::1]' || url.hostname === '::1') {
    url.hostname = '127.0.0.1'
  }

  url.hash = ''
  const output = url.toString()
  return output.endsWith('/') ? output.slice(0, -1) : output
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1500)
    })
    return true
  }
  catch {
    return false
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid || child.exitCode !== null) {
    return
  }

  // One kill policy for every process the tool spawns or reaps.
  await killProcessTree(pid)
}

async function attachToServer(plan: ServerPlan): Promise<ServerHandle> {
  const url = normalizeUrl(plan.url ?? `http://127.0.0.1:${plan.port}`)

  if (!await reachable(url)) {
    throw new Error(`No server is reachable at ${url}`)
  }

  return {
    plan,
    url,
    port: Number(new URL(url).port) || plan.port,
    startedByUs: false,
    output: [],
    stop: async () => {}
  }
}

async function startCommandServer(plan: ServerPlan, options: StartServerOptions): Promise<ServerHandle> {
  if (!plan.command) {
    throw new Error('Command server requires a command')
  }

  const child = spawn(plan.command, {
    cwd: plan.cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      FLASH_TUNNEL: '1',
      ...options.env
    }
  })

  const output: string[] = []
  let detectedUrl: string | undefined
  let exitInfo: { code: number | null, signal: string | null } | undefined
  let buffer = ''
  let resolveExited: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })

  const pushLine = (rawLine: string, stream: 'stderr' | 'stdout'): void => {
    const line = rawLine.trimEnd()
    if (!line) {
      return
    }

    output.push(line)
    if (output.length > OUTPUT_LIMIT) {
      output.shift()
    }

    options.onLog?.(line, stream)

    const match = URL_PATTERN.exec(line)
    if (match?.[0]) {
      detectedUrl = normalizeUrl(match[0])
    }
  }

  const consume = (chunk: Buffer, stream: 'stderr' | 'stdout'): void => {
    buffer += stripAnsi(chunk.toString())
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      pushLine(line, stream)
    }
  }

  child.stdout?.on('data', (chunk: Buffer): void => consume(chunk, 'stdout'))
  child.stderr?.on('data', (chunk: Buffer): void => consume(chunk, 'stderr'))
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null): void => {
    exitInfo = { code, signal }
    resolveExited()
  })

  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 60_000

  const handle: ServerHandle = {
    plan,
    url: `http://127.0.0.1:${plan.port}`,
    port: plan.port,
    pid: child.pid,
    startedByUs: true,
    output,
    exited,
    stop: async () => {
      await stopChild(child)
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) {
      await stopChild(child)
      throw options.signal.reason ?? new Error('Aborted')
    }

    if (exitInfo) {
      throw new Error(
        `Dev server exited before it became ready (code ${exitInfo.code ?? 'null'}).\n${output.slice(-20).join('\n')}`
      )
    }

    const candidates = new Set<string>()
    if (detectedUrl) {
      candidates.add(detectedUrl)
    }
    candidates.add(`http://127.0.0.1:${plan.port}`)

    for (const candidate of candidates) {
      if (await reachable(candidate)) {
        handle.url = candidate
        handle.port = Number(new URL(candidate).port) || plan.port
        return handle
      }
    }

    try {
      await sleep(300, options.signal)
    }
    catch (error) {
      await stopChild(child)
      throw error
    }
  }

  await stopChild(child)
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the dev server.\n${output.slice(-20).join('\n')}`)
}

export async function startServer(plan: ServerPlan, options: StartServerOptions = {}): Promise<ServerHandle> {
  if (plan.mode === 'static') {
    return startStaticServer(plan)
  }

  if (plan.mode === 'attach') {
    return attachToServer(plan)
  }

  return startCommandServer(plan, options)
}
