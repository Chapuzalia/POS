import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/functional/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
  },
})
