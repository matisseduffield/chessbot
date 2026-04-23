import { test, expect } from '@playwright/test';

// Plan §3.1 — narrow smoke tests for the dashboard panel. Boots the backend,
// navigates to the panel, checks the key DOM anchors + WS connectivity.

test('panel loads and core DOM is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/chessbot|dashboard|panel/i);
  await expect(page.locator('#board-svg')).toBeVisible({ timeout: 10_000 });
});

test('panel establishes WebSocket to backend', async ({ page }) => {
  await page.goto('/');
  // The panel stores its socket on window.state.ws after module init.
  const connected = await page.waitForFunction(
    () => {
      const w = /** @type {any} */ (window);
      return w.state && w.state.ws && w.state.ws.readyState === 1;
    },
    { timeout: 10_000 },
  );
  expect(connected).toBeTruthy();
});

test('healthz returns 200', async ({ request }) => {
  const res = await request.get('/healthz');
  expect(res.status()).toBe(200);
});
