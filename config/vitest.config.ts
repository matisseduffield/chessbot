import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

export default defineConfig({
  test: {
    root: repoRoot,
    include: [
      'shared/src/**/*.test.ts',
      'backend/**/*.test.{js,ts}',
      'extension/**/*.test.{js,ts,jsx,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
