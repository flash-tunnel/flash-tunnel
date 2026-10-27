import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPortAvailable, packageManagerFor, runBuildScript } from '../src/commands/build'
import { Reporter } from '../src/ui/reporter'

let directory: string
let spy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-build-'))
  spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  spy.mockRestore()
  await rm(directory, { recursive: true, force: true })
})

describe('build helpers', () => {
  it('detects the package manager from lockfiles', async () => {
    expect(packageManagerFor(directory)).toBe('npm')

    await writeFile(join(directory, 'pnpm-lock.yaml'), '')
    expect(packageManagerFor(directory)).toBe('pnpm')

    await writeFile(join(directory, 'yarn.lock'), '')
    expect(packageManagerFor(directory)).toBe('pnpm')
  })

  it('runs the build script', async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      scripts: { build: 'node build.mjs' }
    }))
    await writeFile(join(directory, 'build.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("built.txt", "ok")\n')

    runBuildScript(directory, new Reporter({ silent: true }))

    expect(await readFile(join(directory, 'built.txt'), 'utf8')).toBe('ok')
  })

  it('uses the workspace package manager when building a nested app', async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.14.0' }))
    await writeFile(join(directory, '.git'), '')
    const app = join(directory, 'apps/web')
    await mkdir(app, { recursive: true })
    await writeFile(join(app, 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }))
    await writeFile(join(app, 'build.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("built.txt", process.env.npm_config_user_agent)\n')

    runBuildScript(app, new Reporter({ silent: true }))

    expect(await readFile(join(app, 'built.txt'), 'utf8')).toMatch(/^pnpm\//)
  })

  it('rejects a missing build script', async () => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: {} }))

    expect(() => runBuildScript(directory, new Reporter({ silent: true })))
      .toThrow(/No build script/)
  })

  it('reports whether a port is available', async () => {
    expect(await isPortAvailable(0)).toBe(true)

    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    expect(await isPortAvailable(port)).toBe(false)
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
