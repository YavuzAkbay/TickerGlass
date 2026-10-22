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

test('navigator section opens in the left panel', async ({ page }) => {
  await page.getByRole('tab', { name: 'Notes' }).click();
  await expect(page.locator('.navigator textarea')).toBeVisible();
});

test('? opens the shortcut help with chart navigation keys', async ({ page }) => {
  await page.locator('.chart-area').click();
  await page.keyboard.press('Shift+?');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Chart navigation')).toBeVisible();
  await expect(dialog.getByText('Jump to the latest bar')).toBeVisible();
  await expect(dialog.getByText('Keyboard shortcuts').first()).toBeVisible();
});

test('typed commands: an interval, an indicator with inputs, and an alert', async ({ page }) => {
  const palette = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  const chart = () =>
    page.evaluate(() => {
      const c = (
        window as unknown as {
          chart: { getInterval(): string; getStudies(): { id: string; name?: string }[] };
        }
      ).chart;
      return { interval: c.getInterval(), studies: c.getStudies().length };
    });
  const before = await chart();

  await palette();
  await page.keyboard.type('4h');
  await expect(page.getByRole('option').first()).toContainText('Switch to 4 hours');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chart()).interval).toBe('4h');

  await palette();
  await page.keyboard.type('rsi 21');
  await expect(page.getByRole('option').first()).toContainText('Add RSI (21)');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await chart()).studies).toBe(before.studies + 1);
  await expect(page.locator('.ind-legend-row', { hasText: 'RSI' })).toContainText('21');

  await palette();
  await page.keyboard.type('alert below 50');
  await expect(page.getByRole('option').first()).toContainText('Alert when price crosses below 50');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').filter({ hasText: /alert/i }).last()).toBeVisible();
});

test('? typed into an input does not open the help', async ({ page }) => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.type('?');
  await expect(page.getByRole('dialog').getByText('Chart navigation')).toHaveCount(0);
});

const imageSize = async (path: string) => {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};

async function runCommand(page: import('@playwright/test').Page, query: string) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

test('screenshot downloads a PNG named symbol_interval_stamp', async ({ page }) => {
  const download = page.waitForEvent('download');
  await runCommand(page, 'Download chart image');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^[\w.^=-]+_1D_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.png$/);
});

test('layout screenshot of two charts is wider than a single chart image', async ({ page }) => {
  await page.getByRole('button', { name: 'Chart layout', exact: true }).click();
  await page.locator('[data-template="2c"]').click();
  await expect(page.locator('.chart-cell')).toHaveCount(2);
  await page
    .locator('.chart-cell')
    .nth(0)
    .locator('.chart-host')
    .click({ position: { x: 120, y: 100 } });

  let download = page.waitForEvent('download');
  await runCommand(page, 'Download chart image');
  const single = await imageSize((await (await download).path())!);

  download = page.waitForEvent('download');
  await runCommand(page, 'Download layout image');
  const layout = await imageSize((await (await download).path())!);
  expect(layout.w).toBeGreaterThan(single.w * 1.5);
});

test('Alt+Enter maximizes the focused chart and Escape restores', async ({ page }) => {
  await page.getByRole('button', { name: 'Chart layout', exact: true }).click();
  await page.locator('[data-template="2c"]').click();
  await expect(page.locator('.chart-cell')).toHaveCount(2);
  await page
    .locator('.chart-cell')
    .nth(1)
    .locator('.chart-host')
    .click({ position: { x: 120, y: 100 } });
  const widths = () =>
    page
      .locator('.grid-cell')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  const [before] = await widths();
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('.grid-cell[data-maximized]')).toHaveCount(1);
  const max = await page
    .locator('.grid-cell[data-maximized]')
    .evaluate((e) => e.getBoundingClientRect().width);
  expect(max).toBeGreaterThan(before! * 1.5);
  await page.keyboard.press('Escape');
  await expect(page.locator('.grid-cell[data-maximized]')).toHaveCount(0);
});
