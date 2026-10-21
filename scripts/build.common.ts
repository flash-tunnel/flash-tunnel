import type { BuildConfig } from 'unbuild'
import { defu } from 'defu'

const common: BuildConfig = {
  declaration: true,
  clean: true,
  rollup: {
    esbuild: { target: 'node22' },
    inlineDependencies: false,
    dts: { respectExternal: true }
  },
  failOnWarn: false
}

export function mergeDefaultBuildConfig(config: BuildConfig): BuildConfig {
  return defu(config, common)
}
