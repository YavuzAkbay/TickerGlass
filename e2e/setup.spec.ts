import { expect, openOverflowItem, test } from './fixtures';

// Under automation the first-run step only shows when the URL asks for it (`firstRun`).
test('first run shows the data source with a connection test, once', async ({ page }) => {
  await page.goto('/?feed=synthetic&firstRun=1');
  const dialog = page.getByRole('dialog', { name: 'Welcome to TickerGlass' });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('list', { name: 'Data providers' });
  await expect(list.getByRole('listitem')).not.toHaveCount(0);
  await expect(list.locator('[aria-current="true"]')).toHaveCount(1);
  // The test runs on open; the result is either a quote or an error, never stuck.
  await expect(dialog.getByRole('status')).toContainText(/Connected|No data/);
  await dialog.getByRole('button', { name: 'Start charting' }).click();
  await expect(dialog).toHaveCount(0);

  // Seen once: not again.
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Later: from the More menu.
  await openOverflowItem(page, 'Data source…');
  await expect(page.getByRole('dialog', { name: 'Data source' })).toBeVisible();
});
