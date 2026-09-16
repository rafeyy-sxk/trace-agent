import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Every test must be hermetic. Anything that reaches the network is a bug.
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
