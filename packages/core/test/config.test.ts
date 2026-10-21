import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findConfigFile, loadFlashTunnelConfig } from '../src'

const directories: string[] = []

async function createDirectory(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'flash-tunnel-config-'))
  directories.push(directory)

  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }

  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('loadFlashTunnelConfig', () => {
  it('returns an empty config when nothing is found', async () => {
    const cwd = await createDirectory()
    await expect(loadFlashTunnelConfig(cwd)).resolves.toEqual({ config: {} })
  })

  it('loads defineConfig from the flash-tunnel shim', async () => {
    const cwd = await createDirectory({
      'flash-tunnel.ts': `
        import { defineConfig } from 'flash-tunnel'
        export default defineConfig({
          domain: { zone: 'example.com' },
          autoStopAfter: '2h',
        })
      `
    })

    const loaded = await loadFlashTunnelConfig(cwd)
    expect(loaded.config.domain?.zone).toBe('example.com')
    expect(loaded.config.autoStopAfter).toBe('2h')
    expect(loaded.source).toContain('flash-tunnel.ts')
  })

  it('finds a config in a parent directory', async () => {
    const cwd = await createDirectory({
      'flash-tunnel.ts': 'export default { domain: { zone: "parent.example.com" } }',
      'apps/web/package.json': '{}'
    })
    await mkdir(join(cwd, '.git'), { recursive: true })

    expect(findConfigFile(join(cwd, 'apps', 'web'))).toBe(join(cwd, 'flash-tunnel.ts'))
    const loaded = await loadFlashTunnelConfig(join(cwd, 'apps', 'web'))
    expect(loaded.config.domain?.zone).toBe('parent.example.com')
  })

  it('rejects a non-object config', async () => {
    const cwd = await createDirectory({
      'flash-tunnel.ts': 'export default 42'
    })

    await expect(loadFlashTunnelConfig(cwd)).rejects.toThrow(/config object/)
  })
})
