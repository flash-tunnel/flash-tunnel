import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectServer } from '../src'

const directories: string[] = []

async function createFixture(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-detect-'))
  directories.push(directory)

  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  return directory
}

function vitePackage(scripts: Record<string, string>): string {
  return JSON.stringify({
    name: 'fixture-app',
    packageManager: 'pnpm@12.12.1',
    scripts,
    devDependencies: { vite: '^7.0.0' }
  })
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('detectServer', () => {
  it('prefers preview when build output exists', async () => {
    const cwd = await createFixture({
      'package.json': vitePackage({ dev: 'vite', preview: 'vite preview' }),
      'dist/index.html': '<html></html>'
    })

    const plan = detectServer(cwd)
    expect(plan.mode).toBe('command')
    expect(plan.script).toBe('preview')
    expect(plan.command).toBe('pnpm run preview')
    expect(plan.port).toBe(4173)
    expect(plan.framework).toBe('vite')
    expect(plan.confidence).toBe('high')
  })

  it('falls back to dev when preview has no build output', async () => {
    const cwd = await createFixture({
      'package.json': vitePackage({ dev: 'vite', preview: 'vite preview' })
    })

    const plan = detectServer(cwd)
    expect(plan.script).toBe('dev')
    expect(plan.port).toBe(5173)
    expect(plan.reason).toContain('fell back to dev')
  })

  it('throws when preview exists without output and no dev script', async () => {
    const cwd = await createFixture({
      'package.json': vitePackage({ preview: 'vite preview' })
    })

    expect(() => detectServer(cwd)).toThrow(/no build output/)
  })

  it('reads the port from the script', async () => {
    const cwd = await createFixture({
      'package.json': vitePackage({ dev: 'vite --port 4100' })
    })

    expect(detectServer(cwd).port).toBe(4100)
  })

  it('detects the package manager from the lockfile', async () => {
    const cwd = await createFixture({
      'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
      'yarn.lock': ''
    })

    expect(detectServer(cwd).command).toBe('yarn run dev')
  })

  it('uses an explicit command', async () => {
    const cwd = await createFixture({})
    const plan = detectServer(cwd, { command: 'pnpm dev', port: 4321 })

    expect(plan).toMatchObject({
      mode: 'command',
      command: 'pnpm dev',
      port: 4321,
      confidence: 'high'
    })
  })

  it('attaches with an explicit url', async () => {
    const cwd = await createFixture({})
    const plan = detectServer(cwd, { url: 'http://127.0.0.1:4321' })

    expect(plan).toMatchObject({
      mode: 'attach',
      url: 'http://127.0.0.1:4321',
      port: 4321
    })
  })

  it('detects a static build directory without scripts', async () => {
    const cwd = await createFixture({
      'dist/index.html': '<html></html>'
    })

    const plan = detectServer(cwd)
    expect(plan.mode).toBe('static')
    expect(plan.dir).toBe(join(cwd, 'dist'))
    expect(plan.port).toBe(4173)
  })

  it('honors server.cwd', async () => {
    const cwd = await createFixture({
      'apps/web/package.json': vitePackage({ dev: 'vite' })
    })

    const plan = detectServer(cwd, { cwd: 'apps/web' })
    expect(plan.cwd).toBe(join(cwd, 'apps', 'web'))
    expect(plan.command).toBe('pnpm run dev')
  })
})
