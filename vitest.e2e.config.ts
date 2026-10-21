import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@flash-tunnel/adapter-cloudflare': resolvePath('./packages/adapter-cloudflare/src/index.ts'),
      '@flash-tunnel/cli': resolvePath('./packages/cli/src/index.ts'),
      '@flash-tunnel/config': resolvePath('./packages/config/src/index.ts'),
      '@flash-tunnel/core': resolvePath('./packages/core/src/index.ts'),
      '@flash-tunnel/types': resolvePath('./packages/types/src/index.ts'),
      '@flash-tunnel/utils': resolvePath('./packages/utils/src/index.ts')
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    passWithNoTests: true
  }
})
