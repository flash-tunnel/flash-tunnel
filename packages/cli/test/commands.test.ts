import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectDoctorChecks } from '../src/commands/doctor'
import { runInit } from '../src/commands/init'
import { runProviders } from '../src/commands/providers'
import { Reporter } from '../src/ui/reporter'

let out: string[]
let directory: string
let previousHome: string | undefined
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  out = []
  directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-commands-'))
  previousHome = process.env.FLASH_TUNNEL_HOME
  process.env.FLASH_TUNNEL_HOME = join(directory, 'home')
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  stdoutSpy.mockRestore()
  if (previousHome === undefined) {
    delete process.env.FLASH_TUNNEL_HOME
  }
  else {
    process.env.FLASH_TUNNEL_HOME = previousHome
  }
  await rm(directory, { recursive: true, force: true })
})

describe('init', () => {
  it('creates the config without touching the project gitignore', async () => {
    const reporter = new Reporter({ json: true })

    await runInit({ cwd: directory }, reporter)
    await runInit({ cwd: directory, force: true }, reporter)

    const config = await readFile(join(directory, 'flash-tunnel.ts'), 'utf8')

    expect(config).toContain('defineConfig')
    await expect(readFile(join(directory, '.gitignore'), 'utf8')).rejects.toThrow()
    expect(out.filter(line => line.includes('"type":"init"'))).toHaveLength(2)
  })

  it('refuses to overwrite without force', async () => {
    await writeFile(join(directory, 'flash-tunnel.ts'), 'export default {}\n')
    const reporter = new Reporter({ json: true })

    await expect(runInit({ cwd: directory }, reporter)).rejects.toThrow(/already exists/)
  })
})

describe('providers', () => {
  it('lists the built-in adapters as JSON', () => {
    runProviders(new Reporter({ json: true }))

    const event = JSON.parse(out[0] ?? '{}')
    expect(event.type).toBe('providers')
    expect(event.providers.map((provider: { id: string, kind: string }) => `${provider.kind}:${provider.id}`)).toEqual([
      'tunnel:cloudflare',
      'dns:cloudflare'
    ])
  })
})

describe('doctor', () => {
  it('reports node, config, token and session checks', async () => {
    const checks = await collectDoctorChecks({ cwd: directory })
    const ids = checks.map(check => check.id)

    expect(ids).toContain('node')
    expect(ids).toContain('config')
    expect(ids).toContain('token')
    expect(ids).toContain('sessions')
    expect(checks.find(check => check.id === 'node')?.level).toBe('ok')
    expect(checks.find(check => check.id === 'config')?.message).toContain('No flash-tunnel.ts')
  })
})
