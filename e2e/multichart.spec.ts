import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

test('two charts: an indicator added after focusing the second chart shows only there', async ({
  page,
}) => {
  // Fresh indicator state (a new chart shows the default Volume only).
  await page.addInitScript(() => localStorage.removeItem('investopen-indicators'));
  await page.goto('/?feed=synthetic&charts=2');
  const cells = page.locator('.chart-cell');
  await expect(cells).toHaveCount(2);
  await expect(cells.nth(0)).toHaveClass(/\bactive\b/);
  await page.waitForFunction(() => window.chart?.store.length > 0);
  // Both charts have the default Volume legend row.
  await expect(cells.nth(0).locator('.ind-legend-row')).toHaveCount(1);
  await expect(cells.nth(1).locator('.ind-legend-row')).toHaveCount(1);

  // Focus the second chart.
  await cells
    .nth(1)
    .locator('.chart-host')
    .click({ position: { x: 200, y: 100 } });
  await expect(cells.nth(1)).toHaveClass(/\bactive\b/);
  await expect(cells.nth(0)).not.toHaveClass(/\bactive\b/);

  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Simple Moving Average');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(cells.nth(1).locator('.ind-legend-row')).toHaveCount(2);
  await expect(cells.nth(1).locator('.ind-legend-row', { hasText: 'SMA' })).toHaveCount(1);
  await expect(cells.nth(0).locator('.ind-legend-row')).toHaveCount(1);
  await expect(cells.nth(0).locator('.ind-legend-row', { hasText: 'SMA' })).toHaveCount(0);

  // Undo acts on the focused chart only.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cells.nth(1).locator('.ind-legend-row')).toHaveCount(1);
  await expect(cells.nth(0).locator('.ind-legend-row')).toHaveCount(1);
});
