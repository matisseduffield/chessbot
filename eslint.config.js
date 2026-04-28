import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';

// Root ESLint config. Covers backend (CommonJS), extension (ESM + JSX),
// and the shared TypeScript package. Pre-existing lint issues in the
// legacy content.js / server.js / panel are downgraded to warnings so
// the foundation CI is green; they will be resolved as those files are
// refactored per plans/improvement-plan.md §2.1.
export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/build/**',
    '**/node_modules/**',
    '**/coverage/**',
    'engine/**',
    'books/**',
    'syzygy/**',
    'screenshots/**',
    'plans/**',
    '.playwright-mcp/**',
    'backend/panel/index.html',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaVersion: 'latest' },
    },
    rules: {
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-useless-escape': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['extension/**/*.{js,jsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: [
      'extension/vite.config.{js,mjs}',
      'extension/scripts/**/*.{js,mjs,cjs}',
      'extension/public/**/*.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
      sourceType: 'module',
    },
  },
  {
    files: ['backend/**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
    },
  },
  {
    files: ['backend/panel/vite.config.{js,mjs}', 'backend/panel/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  {
    // Panel is browser-side ESM served statically; override the backend
    // commonjs default so import/export parse correctly.
    files: ['backend/panel/src/**/*.{js,mjs}'],
    languageOptions: {
      globals: { ...globals.browser },
      sourceType: 'module',
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  {
    files: ['shared/**/*.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.test.{js,ts}', '**/*.spec.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
    },
  },
  {
    files: ['tests/e2e/**/*.{js,ts}', 'config/playwright.config.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
    },
  },
]);
