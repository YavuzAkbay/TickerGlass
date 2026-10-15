import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

const FEED = '/?feed=synthetic-multi';

const ready = (page: Page) => page.waitForFunction(() => window.chart?.store.length > 0);

/** Add the first indicator matching `query` from the Indicators dialog. */
async function addIndicator(page: Page, query: string) {
  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill(query);
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const legendRow = (page: Page, short: string) =>
  page.locator('.ind-legend-row', { has: page.locator('.ind-legend-name', { hasText: short }) });

async function openSettings(page: Page, short: string) {
  const row = legendRow(page, short);
  await row.hover();
  await row.getByRole('button', { name: 'Settings' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(FEED);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ready(page);
});

test('correlation: another symbol, computed against the chart', async ({ page }) => {
  await addIndicator(page, 'Correlation');
  const row = legendRow(page, 'CC');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.ind-legend-inputs')).toContainText('GOOG');
  // Values arrive once the symbol's bars are fetched and aligned.
  await expect(row.locator('.ind-legend-value').first()).toHaveText(/^[−-]?\d/);
  // The legend prints a real minus sign.
  const text = await row.locator('.ind-legend-value').first().innerText();
  const value = Number(text.replace('\u2212', '-'));
  expect(Math.abs(value)).toBeLessThanOrEqual(1);

  // Another symbol through the settings dialog's symbol search.
  await openSettings(page, 'CC');
  const symbol = page.locator('#ind-in-symbol');
  await symbol.fill('MSFT');
  await symbol.press('Enter');
  await page.getByRole('button', { name: 'Ok' }).click();
  await expect(row.locator('.ind-legend-inputs')).toContainText('MSFT');
  await expect(row.locator('.ind-legend-value').first()).toHaveText(/^[−-]?\d/);
});

test('an SMA sourced from an overlay symbol survives a reload', async ({ page, server }) => {
  // MSFT overlay through Compare.
  await page.getByRole('button', { name: 'Compare or add symbol' }).click();
  const input = page.getByLabel('Search symbols to compare');
  await input.fill('MSFT');
  const option = page.getByRole('option').first();
  await expect(option).toBeVisible();
  await option.getByRole('button', { name: /^Same % scale:/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await addIndicator(page, 'Moving Average Simple');
  const row = legendRow(page, 'SMA');
  await expect(row).toHaveCount(1);
  await openSettings(page, 'SMA');
  await page.locator('#ind-in-source').selectOption({ label: 'MSFT: Close' });
  await page.getByRole('button', { name: 'Ok' }).click();
  await expect(row.locator('.ind-legend-inputs')).toContainText('MSFT: Close');
  await expect(row.locator('.ind-legend-value').first()).toHaveText(/\d/);

  // Saved with the layout as a sym: source reference.
  await expect
    .poll(() => {
      const l = [...server.layouts.values()][0];
      const list = (l?.state.indicators ?? []) as { type: string; inputs: { source?: unknown } }[];
      return list.find((i) => i.type === 'sma')?.inputs.source;
    })
    .toEqual({ instanceId: 'sym:MSFT', outputId: 'close' });

  await page.reload();
  await ready(page);
  const again = legendRow(page, 'SMA');
  await expect(again.locator('.ind-legend-inputs')).toContainText('MSFT: Close');
  await expect(again.locator('.ind-legend-value').first()).toHaveText(/\d/);
});
