import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { firstChart } from './persistence';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

const FEED = '/?feed=synthetic-multi';

const ready = (page: Page) => page.waitForFunction(() => window.chart?.store.length > 0);

async function restored(page: Page) {
  await ready(page);
  await expect(page.getByRole('button', { name: /^Layout: Untitled/ })).toBeVisible();
}

/** Legend row of an overlay, by its exact symbol. */
const legendRow = (page: Page, symbol: string) =>
  page.locator('.cmp-legend-row', {
    has: page.locator('.cmp-legend-name', {
      hasText: new RegExp(`^${symbol.replace(/\//g, '\\/')}$`),
    }),
  });

const mainMode = (page: Page) =>
  page.evaluate(() => window.chart.getState().panes.find((p) => p.id === 'main')!.priceScale.mode);

const comparePanes = (page: Page) =>
  page.evaluate(() =>
    window.chart
      .getState()
      .panes.map((p) => p.id)
      .filter((id) => id.startsWith('pane-cmp-')),
  );

async function openCompare(page: Page) {
  await page.getByRole('button', { name: 'Compare or add symbol' }).click();
  const input = page.getByLabel('Search symbols to compare');
  await expect(input).toBeVisible();
  return input;
}

/** Type `query` in the open compare dialog and press the placement button of its first row. */
async function addOverlay(page: Page, query: string, placement: string) {
  const input = page.getByLabel('Search symbols to compare');
  await input.fill(query);
  const row = page.getByRole('option').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: new RegExp(`^${placement}:`) }).click();
}

test('compare: add on same scale and new pane, remove + undo, restore after reload', async ({
  page,
  server,
}) => {
  await page.goto(FEED);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await restored(page);
  expect(await mainMode(page)).toBe('linear');

  // 1) MSFT on the main scale: the legend row shows up and the pane switches to percent.
  await openCompare(page);
  await addOverlay(page, 'MSFT', 'Same % scale');
  await expect(legendRow(page, 'MSFT')).toHaveCount(1);
  await expect.poll(() => mainMode(page)).toBe('percent');
  await expect(legendRow(page, 'MSFT').locator('.cmp-legend-value')).toHaveText(/\d/);

  // 2) AAPL/MSFT in a new pane (the dialog stays open after an add).
  await addOverlay(page, 'AAPL/MSFT', 'New pane');
  await expect(legendRow(page, 'AAPL/MSFT')).toHaveCount(1);
  await expect.poll(() => comparePanes(page)).toHaveLength(1);
  await expect(page.getByTestId('compare-current').getByText('AAPL/MSFT')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 3) Remove MSFT from the legend: scale returns to linear; undo restores both.
  await legendRow(page, 'MSFT').hover();
  await legendRow(page, 'MSFT').getByRole('button', { name: 'Remove' }).click();
  await expect(legendRow(page, 'MSFT')).toHaveCount(0);
  await expect.poll(() => mainMode(page)).toBe('linear');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(legendRow(page, 'MSFT')).toHaveCount(1);
  await expect.poll(() => mainMode(page)).toBe('percent');

  // 4) Reload from the server copy: both overlays are back, saved as layout schema v5.
  await expect
    .poll(() => {
      const l = [...server.layouts.values()][0];
      const c = firstChart(l?.state)?.compares as { items: unknown[] } | undefined;
      return [l?.schemaVersion, c?.items.length];
    })
    .toEqual([5, 2]);
  await expect(page.getByRole('button', { name: /^Layout: Untitled$/ })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await restored(page);
  await expect(legendRow(page, 'MSFT')).toHaveCount(1);
  await expect(legendRow(page, 'AAPL/MSFT')).toHaveCount(1);
  expect(await comparePanes(page)).toHaveLength(1);
  expect(await mainMode(page)).toBe('percent');
});

test('symbol search: an expression becomes the chart symbol', async ({ page }) => {
  await page.goto(FEED);
  await ready(page);
  await page.getByRole('button', { name: /^Symbol search/ }).click();
  const input = page.getByLabel('Search symbols');
  await input.fill('(aapl+msft)/2');
  await expect(page.locator('[data-expression]')).toContainText('(AAPL+MSFT)/2');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.chart.getSymbol())).toBe('(AAPL+MSFT)/2');
  await expect
    .poll(() => page.evaluate(() => window.chart.symbolInfo?.exchangeName))
    .toBe('Expression');
  await expect.poll(() => page.evaluate(() => window.chart.store.length)).toBeGreaterThan(0);
});

test('symbol search: a main-symbol expression over 32 characters is refused', async ({ page }) => {
  await page.goto(FEED);
  await ready(page);
  await page.getByRole('button', { name: /^Symbol search/ }).click();
  const input = page.getByLabel('Search symbols');
  await input.fill('AAPL/MSFT+AAPL/MSFT+AAPL/MSFT+AAPL/MSFT');
  await input.press('Enter');
  await expect(page.getByText(/Too long for a chart symbol/)).toBeVisible();
  expect(await page.evaluate(() => window.chart.getSymbol())).toBe('AAPL');
});

test('compare: an invalid expression shows an inline error and cannot be added', async ({
  page,
}) => {
  await page.goto(FEED);
  await ready(page);
  const input = await openCompare(page);
  await input.fill('AAPL/');
  const error = page.getByRole('alert');
  await expect(error).toContainText('Expected a symbol, number or');
  await expect(error).toContainText('^');
  await expect(page.getByRole('button', { name: /^Same % scale:/ })).toBeDisabled();
  await input.press('Enter');
  await expect(page.locator('.cmp-legend-row')).toHaveCount(0);
  expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(1); // Volume only
});
