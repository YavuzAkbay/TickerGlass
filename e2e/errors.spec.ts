import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket } from './market';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

type Mode = 'ok' | 404 | 429 | 503;

const N = 200;
const DAY = 86_400;
const T0 = Math.floor(Date.UTC(2024, 0, 1) / 1000);

/** Serve bars through the HTTP feed; `state.mode` picks the response, `state.calls` counts requests. */
async function serveBars(page: Page, state: { mode: Mode; calls: number }) {
  await mockMarket(page);
  await page.route('**/api/symbols/*', (route) =>
    route.fulfill({
      json: {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        exchange: 'NMS',
        exchangeName: 'NasdaqGS',
        type: 'EQUITY',
        currency: 'USD',
        timezone: 'America/New_York',
        session: '0930-1600',
        priceHint: 2,
        minTick: 0.01,
      },
    }),
  );
  await page.route('**/api/events/**', (route) =>
    route.fulfill({ json: { dividends: [], splits: [], earnings: [] } }),
  );
  await page.route('**/api/bars**', (route: Route) => {
    state.calls++;
    if (state.mode === 404) {
      return route.fulfill({ status: 404, json: { detail: 'symbol not found: AAPL' } });
    }
    if (state.mode === 429) {
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '1' },
        json: { detail: 'rate limited' },
      });
    }
    if (state.mode === 503) {
      return route.fulfill({ status: 503, json: { detail: 'upstream unreachable' } });
    }
    const t = Array.from({ length: N }, (_, i) => T0 + i * DAY);
    const c = t.map((_, i) => 100 + Math.sin(i / 9) * 8);
    return route.fulfill({
      json: {
        t,
        o: c,
        h: c.map((x) => x + 1),
        l: c.map((x) => x - 1),
        c,
        v: t.map(() => 1000),
        hasMore: false,
      },
    });
  });
  await page.addInitScript(() => localStorage.removeItem('tickerglass-indicators'));
}

const overlay = (page: Page) => page.locator('.chart-error');

test('404 names the symbol and offers symbol search', async ({ page }) => {
  const state = { mode: 404 as Mode, calls: 0 };
  await serveBars(page, state);
  await page.goto('/');
  await expect(overlay(page)).toBeVisible();
  await expect(overlay(page)).toContainText('Symbol not found');
  await expect(overlay(page)).toContainText('AAPL');
  await page.getByRole('button', { name: 'Search symbols' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('429 counts down from Retry-After and reloads by itself', async ({ page }) => {
  const state = { mode: 429 as Mode, calls: 0 };
  await serveBars(page, state);
  await page.goto('/');
  await expect(overlay(page)).toContainText('Rate limited');
  await expect(overlay(page)).toContainText(/Retrying in \d+ s/);
  state.mode = 'ok';
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(overlay(page)).toHaveCount(0);
});

test('429 Retry now reloads immediately', async ({ page }) => {
  const state = { mode: 429 as Mode, calls: 0 };
  await serveBars(page, state);
  await page.goto('/');
  await expect(overlay(page)).toContainText('Rate limited');
  state.mode = 'ok';
  await page.getByRole('button', { name: 'Retry now' }).click();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(overlay(page)).toHaveCount(0);
});

test('503 shows Retry, which recovers once the service is back', async ({ page }) => {
  const state = { mode: 503 as Mode, calls: 0 };
  await serveBars(page, state);
  await page.goto('/');
  await expect(overlay(page)).toContainText('Data unavailable');
  const before = state.calls;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(overlay(page)).toBeVisible();
  await expect.poll(() => state.calls).toBeGreaterThan(before);
  state.mode = 'ok';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(overlay(page)).toHaveCount(0);
});
