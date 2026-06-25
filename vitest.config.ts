import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest runs the pure main-process logic (parsers, normalization, the
 * recommendation rules) directly in Node — no Electron, no live database.
 * The path aliases mirror tsconfig.json so test imports match production.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
