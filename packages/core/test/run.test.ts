import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src'

const directories: string[] = []
const handles: Array<{ stop: () => Promise<void> }> = []

async function occupyPort(): Promise<number> {
  const server = createServer((_request, response) => response.end('unrelated-server'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  handles.push({ stop: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address')
  }
  return address.port
}

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-run-'))
  directories.push(directory)

  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }

  return directory
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.stop().catch(() => {})))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('startServer', () => {
  it('uses the actual printed URL when the guessed port belongs to another server', async () => {
    const port = await occupyPort()
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('actual-server'))
        server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port))
      `
    })
    const handle = await startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port,
      portSource: 'default',
      reason: 'unknown framework',
      confidence: 'low'
    }, { timeoutMs: 5000 })
    handles.push(handle)

    expect(handle.port).not.toBe(port)
    expect(await (await fetch(handle.url)).text()).toBe('actual-server')
    await handle.stop()
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe('unrelated-server')
  })

  it.each([false, true])('does not adopt an occupied guessed port even if it is printed: %s', async (printUrl) => {
    const port = await occupyPort()
    const cwd = await createDirectory({
      'server.mjs': `${printUrl ? `console.log('Local: http://localhost:${port}')` : ''}\nsetInterval(() => {}, 1000)`
    })
    await expect(startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port,
      portSource: 'framework',
      reason: 'framework default',
      confidence: 'high'
    }, { timeoutMs: 600 })).rejects.toThrow(/Timed out/)
  })

  it.each(['explicit', 'script'] as const)('rejects an occupied %s port before starting the command', async (portSource) => {
    const port = await occupyPort()
    const cwd = await createDirectory({ 'server.mjs': 'throw new Error("Command should not run")' })
    await expect(startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port,
      portSource,
      reason: 'fixed port',
      confidence: 'high'
    })).rejects.toMatchObject({ code: 'PORT_IN_USE', exitCode: 3 })
  })

  it('can use a previously free guessed port when the server prints no URL', async () => {
    const temporary = createServer()
    await new Promise<void>(resolve => temporary.listen(0, '127.0.0.1', resolve))
    const address = temporary.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP address')
    }
    const port = address.port
    await new Promise<void>(resolve => temporary.close(() => resolve()))
    const cwd = await createDirectory({
      'server.mjs': `import { createServer } from 'node:http'; createServer((req, res) => res.end('quiet-server')).listen(${port}, '127.0.0.1')`
    })
    const handle = await startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port,
      portSource: 'default',
      reason: 'guessed port',
      confidence: 'low'
    }, { timeoutMs: 5000 })
    handles.push(handle)

    expect(await (await fetch(handle.url)).text()).toBe('quiet-server')
  })

  it('starts a command and detects the printed url', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Preview: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const handle = await startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port: 3000,
      reason: 'test',
      confidence: 'high'
    }, { timeoutMs: 10_000 })
    handles.push(handle)

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(handle.startedByUs).toBe(true)

    const response = await fetch(handle.url)
    expect(await response.text()).toBe('ok')
  })

  it('ignores paths printed after the app url', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { createServer } from 'node:http'
        const server = createServer((request, response) => response.end('ok'))
        server.listen(0, '127.0.0.1', () => {
          const origin = 'http://127.0.0.1:' + server.address().port
          console.log('public slide show   > ' + origin + '/')
          console.log('presenter mode      > ' + origin + '/presenter/')
          console.log('mcp server          > ' + origin + '/__mcp')
        })
      `
    })

    const handle = await startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port: 3000,
      reason: 'test',
      confidence: 'high'
    }, { timeoutMs: 10_000 })
    handles.push(handle)

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(handle.url).not.toContain('/__mcp')
    expect(await (await fetch(handle.url)).text()).toBe('ok')
  })

  it('passes extra environment variables to the command', async () => {
    const cwd = await createDirectory({
      'env.mjs': `
        import { createServer } from 'node:http'
        const value = process.env.FLASH_TUNNEL_TEST_VALUE ?? 'missing'
        const server = createServer((request, response) => response.end(value))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const handle = await startServer({
      mode: 'command',
      cwd,
      command: 'node env.mjs',
      framework: 'unknown',
      port: 3000,
      reason: 'test',
      confidence: 'high'
    }, {
      timeoutMs: 10_000,
      env: { FLASH_TUNNEL_TEST_VALUE: 'injected' }
    })
    handles.push(handle)

    expect(await (await fetch(handle.url)).text()).toBe('injected')
  })

  it('serves a static directory with spa fallback', async () => {
    const cwd = await createDirectory({
      'dist/index.html': '<h1>preview</h1>'
    })

    const handle = await startServer({
      mode: 'static',
      cwd,
      dir: join(cwd, 'dist'),
      framework: 'unknown',
      port: 4173,
      reason: 'test',
      confidence: 'high'
    })
    handles.push(handle)

    const response = await fetch(handle.url)
    expect(await response.text()).toContain('preview')

    const fallback = await fetch(`${handle.url}/missing/route`, {
      headers: { accept: 'text/html' }
    })
    expect(await fallback.text()).toContain('preview')
  })

  it('rejects when a command exits before becoming ready', async () => {
    const cwd = await createDirectory({
      'exit.mjs': 'console.error("boom"); process.exit(1)'
    })

    await expect(startServer({
      mode: 'command',
      cwd,
      command: 'node exit.mjs',
      framework: 'unknown',
      port: 3000,
      reason: 'test',
      confidence: 'high'
    }, { timeoutMs: 5000 })).rejects.toThrow(/exited before it became ready/)
  })
})
