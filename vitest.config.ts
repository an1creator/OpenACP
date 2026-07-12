import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@n1creator/openacp-plugin-sdk/testing': path.resolve(__dirname, 'packages/plugin-sdk/src/testing/test-context.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
