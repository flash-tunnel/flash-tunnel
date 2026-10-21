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
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/index.ts',
        'packages/cli/**',
        'packages/flash-tunnel/**'
      ],
      thresholds: {
        lines: 75,
        functions: 75,
        branches: 65
      }
    }
  }
})
