import type { FlashTunnelConfig } from '@flash-tunnel/config'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from 'unconfig'

const require = createRequire(import.meta.url)

export { resolveConfig } from './resolve'
export type {
  ConfigSource,
  ConfigSourceInfo,
  ConfigSources,
  ResolveConfigInput,
  ResolvedConfig,
  ResolvedConfigValues
} from './resolve'

const CONFIG_FILE = 'flash-tunnel.ts'

export interface LoadedFlashTunnelConfig {
  config: FlashTunnelConfig
  source?: string
}

export interface LoadFlashTunnelConfigOptions {
  /** Explicit flash-tunnel.ts path; relative paths resolve from cwd. */
  config?: string
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

export async function loadFlashTunnelConfig(
  cwd: string,
  options: LoadFlashTunnelConfigOptions = {}
): Promise<LoadedFlashTunnelConfig> {
  const configPath = options.config ? resolve(cwd, options.config) : findConfigFile(cwd)
  if (!configPath) {
    return { config: {} }
  }
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`)
  }

  const file = parse(configPath)
  const loaded = await loadConfig<FlashTunnelConfig>({
    cwd: file.dir,
    merge: false,
    sources: [{
      files: file.name,
      extensions: [file.ext.replace(/^\./, '') || 'ts'],
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
