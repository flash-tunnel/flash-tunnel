import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive, killProcessTree, startServer } from '../src'

const directories: string[] = []

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-tree-'))
  directories.push(directory)
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(directory, path), content)
  }
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('process tree stop', () => {
  it('stops a server and the child process it spawned', async () => {
    const cwd = await createDirectory({
      'server.mjs': `
        import { spawn } from 'node:child_process'
        import { createServer } from 'node:http'
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        console.log('GRANDCHILD ' + child.pid)
        const server = createServer((request, response) => response.end('tree-ok'))
        server.listen(0, '127.0.0.1', () => {
          console.log('Local: http://127.0.0.1:' + server.address().port)
        })
      `
    })

    const server = await startServer({
      mode: 'command',
      cwd,
      command: 'node server.mjs',
      framework: 'unknown',
      port: 0,
      reason: 'test',
      confidence: 'high'
    })

    const line = server.output.find(item => item.startsWith('GRANDCHILD '))
    const grandchildPid = Number(line?.slice('GRANDCHILD '.length))
    expect(grandchildPid).toBeGreaterThan(0)
    expect(isProcessAlive(grandchildPid)).toBe(true)

    await server.stop()

    const start = Date.now()
    while (isProcessAlive(grandchildPid) && Date.now() - start < 5000) {
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }

    expect(isProcessAlive(grandchildPid)).toBe(false)
    await killProcessTree(grandchildPid)
  })
})
