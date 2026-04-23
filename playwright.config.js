import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E config (plan §3.1).
 *
 * Boots the backend (which also serves the panel on :8080), runs smoke
 * tests against the live dashboard. Keep the suite narrow — this is a
 * regression net, not a pixel-perfect acceptance harness.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    cwd: './backend',
    url: 'http://localhost:8080/healthz',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
