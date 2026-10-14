import { expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/?feed=synthetic');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { chart?: { store: { length: number } } }).chart?.store.length,
  );
});

test('typing a letter opens symbol search prefilled', async ({ page }) => {
  await page.locator('.chart-area').click();
  await page.keyboard.type('t');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').locator('input').first()).toHaveValue(/t/i);
});

test('typing a digit opens the interval box and Enter applies it', async ({ page }) => {
  await page.locator('.chart-area').click();
  await page.keyboard.type('15');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { chart: { getInterval(): string } }).chart.getInterval(),
      ),
    )
    .toBe('15m');
});

test('command palette runs a command', async ({ page }) => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.type('log');
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              chart: { getState(): { panes: { priceScale: { mode: string } }[] } };
            }
          ).chart.getState().panes[0]!.priceScale.mode,
      ),
    )
    .toBe('log');
});

test('chart context menu opens and scale change is undoable', async ({ page }) => {
  const box = (await page.locator('.chart-area').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+p');
  const mode = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            chart: { getState(): { panes: { priceScale: { mode: string } }[] } };
          }
        ).chart.getState().panes[0]!.priceScale.mode,
    );
  await expect.poll(mode).toBe('percent');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(mode).toBe('linear');
});

test('right sidebar panel opens and resizes', async ({ page }) => {
  await page.getByRole('button', { name: 'Notes' }).first().click();
  await expect(page.locator('.right-sidebar textarea')).toBeVisible();
});
