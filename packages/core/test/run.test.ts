import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer } from '../src'

const directories: string[] = []
const handles: Array<{ stop: () => Promise<void> }> = []

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
