import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./client/test/vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: [
      'src/__tests__/**/*.test.ts',
      'client/test/**/*.test.ts',
    ],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
    },
  },
});
