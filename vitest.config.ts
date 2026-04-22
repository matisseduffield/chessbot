import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'shared/src/**/*.test.ts',
      'backend/**/*.test.{js,ts}',
      'extension/**/*.test.{js,ts,jsx,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
