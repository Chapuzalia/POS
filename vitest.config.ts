import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/functional/**/*.test.ts'],
    environment: 'node',
    // PGlite startup and migration fixtures need headroom on shared CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Bound concurrent files so embedded databases do not saturate the runner.
    maxWorkers: 2,
    clearMocks: true,
    restoreMocks: true,
  },
})
