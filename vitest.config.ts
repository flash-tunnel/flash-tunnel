import { defineConfig } from 'vitest/config'

export default defineConfig({
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
