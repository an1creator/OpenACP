import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  dts: true,
  // The public testing subpath integrates with the consumer's Vitest runner.
  // Keep Vitest external so one package never bundles a second runner instance.
  external: ['vitest'],
  clean: true,
  outDir: 'dist-publish/dist',
})
