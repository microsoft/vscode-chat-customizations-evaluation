import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts', 'client/src/__tests__/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'client/src/**/*.ts'],
      exclude: ['src/__tests__/**', 'client/src/__tests__/**'],
    },
  },
});
