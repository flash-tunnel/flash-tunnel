import type { FlashTunnelConfig } from '@flash-tunnel/config'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from 'unconfig'

const require = createRequire(import.meta.url)

const CONFIG_FILE = 'flash-tunnel.ts'

export interface LoadedFlashTunnelConfig {
  config: FlashTunnelConfig
  source?: string
}

export function findConfigFile(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory)
  const root = parse(directory).root

  while (true) {
    const candidate = join(directory, CONFIG_FILE)
    if (existsSync(candidate)) {
      return candidate
    }

    if (existsSync(join(directory, '.git')) || directory === root) {
      return undefined
    }

    directory = dirname(directory)
  }
}

function createConfigTransform(): (code: string) => string {
  const shim = pathToFileURL(require.resolve('@flash-tunnel/config')).href

  return (code: string) => code
    .replace(/(from\s*)(['"])flash-tunnel\/config\2/g, `$1'${shim}'`)
    .replace(/(from\s*)(['"])flash-tunnel\2/g, `$1'${shim}'`)
    .replace(/(from\s*)(['"])@flash-tunnel\/config\2/g, `$1'${shim}'`)
}

export async function loadFlashTunnelConfig(cwd: string): Promise<LoadedFlashTunnelConfig> {
  const configPath = findConfigFile(cwd)
  if (!configPath) {
    return { config: {} }
  }

  const loaded = await loadConfig<FlashTunnelConfig>({
    cwd: dirname(configPath),
    merge: false,
    sources: [{
      files: 'flash-tunnel',
      extensions: ['ts'],
      transform: createConfigTransform()
    }]
  })

  const config = loaded.config
  if (config != null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('flash-tunnel.ts must export a config object')
  }

  return {
    config: config ?? {},
    source: loaded.sources[0] ?? configPath
  }
}
