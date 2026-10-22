import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

test('add an indicator, edit its settings, hide and remove it', async ({ page }) => {
  // Start without persisted indicators (a new chart: the default Volume only).
  await page.addInitScript(() => localStorage.removeItem('tickerglass-indicators'));
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);

  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await expect(search).toBeVisible();

  // RSI if it is registered, otherwise SMA.
  await search.fill('Relative Strength Index');
  const rows = page.locator('.ind-row');
  let short = 'RSI';
  if ((await rows.count()) === 0) {
    await search.fill('Simple Moving Average');
    short = 'SMA';
  }
  await expect(rows.first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const row = page.locator('.ind-legend-row', { hasText: short });
  await expect(row).toHaveCount(1);
  // Values arrive from the worker.
  await expect(row.locator('.ind-legend-value').first()).toHaveText(/\d/);
  const study = () =>
    page.evaluate(() => window.chart.getStudies().find((s) => s.id !== 'volume_default'));
  expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(2);

  // Settings: change the length.
  await row.hover();
  await row.getByRole('button', { name: 'Settings' }).click();
  const length = page.locator('#ind-in-length');
  await length.fill('21');
  await expect(row.locator('.ind-legend-inputs')).toContainText('21'); // live preview
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
  await expect(row.locator('.ind-legend-inputs')).toContainText('21');
  expect((await study())!.title).toContain('21');

  // Revert drops the edits made since the panel opened; one undo step per session.
  await row.hover();
  await row.getByRole('button', { name: 'Settings' }).click();
  await length.fill('30');
  await expect(row.locator('.ind-legend-inputs')).toContainText('30');
  await page.getByRole('button', { name: 'Revert' }).click();
  await expect(row.locator('.ind-legend-inputs')).toContainText('21');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  expect((await study())!.title).toContain('21');

  // Hide.
  await row.hover();
  await row.getByRole('button', { name: 'Hide' }).click();
  await expect(row).toHaveClass(/\boff\b/);
  expect((await study())!.visible).toBe(false);

  // Remove.
  await row.hover();
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  expect(await study()).toBeUndefined();
  await expect(page.locator('.ind-legend-row')).toHaveCount(1); // Volume
});
