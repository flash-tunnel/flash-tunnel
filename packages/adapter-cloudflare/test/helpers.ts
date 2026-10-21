import type { AdapterContext } from '@flash-tunnel/types'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export interface FetchCall {
  url: URL
  method: string
  body?: string
}

export interface FetchHandlerInput extends FetchCall {
  headers: Headers
}

export type FetchHandler = (input: FetchHandlerInput) => Response | Promise<Response>

export function createFetcher(handler: FetchHandler, calls: FetchCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined
    }
    calls.push(call)
    return handler({
      ...call,
      headers: new Headers(init?.headers)
    })
  }) as typeof fetch
}

export function jsonResponse(
  result: unknown,
  options: { status?: number, success?: boolean, errors?: Array<{ code?: number, message?: string }> } = {}
): Response {
  return new Response(JSON.stringify({
    success: options.success ?? true,
    errors: options.errors ?? [],
    result
  }), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' }
  })
}

export function createContext(cwd: string): AdapterContext {
  return {
    sessionId: 'ft_test',
    cwd,
    signal: new AbortController().signal,
    now: Date.now,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  }
}

const directories: string[] = []

export async function createFakeCloudflared(): Promise<{ directory: string, binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-cloudflared-'))
  directories.push(directory)

  await writeFile(join(directory, 'fake-cloudflared.mjs'), `
    if (process.argv.includes('--version')) {
      console.log('cloudflared version 2026.1.0')
      process.exit(0)
    }
    console.error('INF |  https://fake-preview.trycloudflare.com  |')
    setInterval(() => {}, 1000)
  `)

  if (process.platform === 'win32') {
    const binary = join(directory, 'cloudflared.cmd')
    await writeFile(binary, '@echo off\r\nnode "%~dp0fake-cloudflared.mjs" %*\r\n')
    return { directory, binary }
  }

  const binary = join(directory, 'cloudflared')
  await writeFile(binary, '#!/bin/sh\nexec node "$(dirname "$0")/fake-cloudflared.mjs" "$@"\n')
  await chmod(binary, 0o755)
  return { directory, binary }
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
}
