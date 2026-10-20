import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';
import type { MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
    charts: Record<string, import('@investopen/engine').Chart>;
  }
}

const cells = (page: Page) => page.locator('.chart-cell');
const layoutButton = (page: Page) => page.getByRole('button', { name: /^Layout:/ });

async function open(page: Page) {
  // Fresh indicator state (a new chart shows the default Volume only).
  await page.addInitScript(() => localStorage.removeItem('investopen-indicators'));
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(layoutButton(page)).toBeVisible();
}

async function chooseTemplate(page: Page, id: string) {
  await page.getByRole('button', { name: 'Chart layout', exact: true }).click();
  await page.locator(`[data-template="${id}"]`).click();
}

async function focusCell(page: Page, n: number) {
  await cells(page)
    .nth(n)
    .locator('.chart-host')
    .click({ position: { x: 120, y: 100 } });
  await expect(cells(page).nth(n)).toHaveClass(/\bactive\b/);
}

const intervals = (page: Page) =>
  page.evaluate(() => Object.values(window.charts).map((c) => c.getInterval()));

/** Server-side saved state of the current layout has settled (no unsaved changes). */
const saved = (page: Page) =>
  expect(layoutButton(page)).not.toHaveAttribute('aria-label', /unsaved/);

test('2x2 layout shows four charts with a canvas each', async ({ page }) => {
  await open(page);
  await expect(cells(page)).toHaveCount(1);
  await chooseTemplate(page, '2x2');
  await expect(cells(page)).toHaveCount(4);
  await expect(page.locator('.chart-host canvas').first()).toBeVisible();
  expect(await page.locator('.chart-host canvas').count()).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < 4; i++)
    await expect(cells(page).nth(i).locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(() => Object.keys(window.charts).length)).toBe(4);
  // New charts copy the focused chart's symbol.
  const symbols = await page.evaluate(() =>
    Object.values(window.charts).map((c) => c.getState().symbol),
  );
  expect(new Set(symbols).size).toBe(1);
});

test('dragging a splitter resizes the cells and the fractions survive a reload', async ({
  page,
}) => {
  await open(page);
  await chooseTemplate(page, '2c');
  await expect(cells(page)).toHaveCount(2);
  const widths = async () =>
    (await cells(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))).map(
      (w) => Math.round(w),
    );
  const [w0, w1] = await widths();
  expect(Math.abs(w0! - w1!)).toBeLessThanOrEqual(1);

  const handle = page.locator('.grid-splitter.vertical');
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.move(x + 150, y, { steps: 6 });
  await page.mouse.up();
  const [d0, d1] = await widths();
  expect(d0! - w0!).toBeGreaterThan(120);
  expect(d1!).toBeLessThan(w1!);

  await saved(page);
  await page.reload();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(cells(page)).toHaveCount(2);
  await expect.poll(widths).toEqual([d0, d1]);

  // Double-click equalises.
  await page.locator('.grid-splitter.vertical').dblclick();
  const [e0, e1] = await widths();
  expect(Math.abs(e0! - e1!)).toBeLessThanOrEqual(1);
});

test('the interval of the clicked chart changes, the other keeps its own', async ({ page }) => {
  await open(page);
  await chooseTemplate(page, '2c');
  await expect(cells(page)).toHaveCount(2);
  await focusCell(page, 1);
  await page.keyboard.type('1W');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await intervals(page)).sort()).toEqual(['1D', '1W']);
  const bySlot = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.chart-cell')].map((el) =>
      window.charts[el.dataset.chartId!]!.getInterval(),
    ),
  );
  expect(bySlot).toEqual(['1D', '1W']);
});

test('an indicator added after focusing the second chart shows only there; undo is per chart', async ({
  page,
}) => {
  await open(page);
  await chooseTemplate(page, '2c');
  await expect(cells(page)).toHaveCount(2);
  await expect(cells(page).nth(0)).toHaveClass(/\bactive\b/);
  // Both charts have the default Volume legend row (the new chart starts without indicators:
  // add nothing, only compare the rows after the add).
  const rows0 = await cells(page).nth(0).locator('.ind-legend-row').count();
  const rows1 = await cells(page).nth(1).locator('.ind-legend-row').count();

  await focusCell(page, 1);
  await expect(cells(page).nth(0)).not.toHaveClass(/\bactive\b/);

  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Simple Moving Average');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(cells(page).nth(1).locator('.ind-legend-row')).toHaveCount(rows1 + 1);
  await expect(cells(page).nth(1).locator('.ind-legend-row', { hasText: 'SMA' })).toHaveCount(1);
  await expect(cells(page).nth(0).locator('.ind-legend-row')).toHaveCount(rows0);
  await expect(cells(page).nth(0).locator('.ind-legend-row', { hasText: 'SMA' })).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(cells(page).nth(1).locator('.ind-legend-row')).toHaveCount(rows1);
  await expect(cells(page).nth(0).locator('.ind-legend-row')).toHaveCount(rows0);
});

test('Alt+] and Alt+[ cycle the focused chart', async ({ page }) => {
  await open(page);
  await chooseTemplate(page, '3c');
  await expect(cells(page)).toHaveCount(3);
  const active = async () =>
    cells(page).evaluateAll((els) => els.findIndex((e) => e.classList.contains('active')));
  await expect.poll(active).toBe(0);
  await page.keyboard.press('Alt+]');
  await expect.poll(active).toBe(1);
  await page.keyboard.press('Alt+]');
  await page.keyboard.press('Alt+]');
  await expect.poll(active).toBe(0);
  await page.keyboard.press('Alt+[');
  await expect.poll(active).toBe(2);
});

test('removing charts through a smaller template asks first', async ({ page }) => {
  await open(page);
  await chooseTemplate(page, '2x2');
  await expect(cells(page)).toHaveCount(4);
  await chooseTemplate(page, '2c');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(cells(page)).toHaveCount(4);
  await chooseTemplate(page, '2c');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(cells(page)).toHaveCount(2);
});

function seedList(server: MockServer) {
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.watchlists.set('wl-1', {
    id: 'wl-1',
    name: 'Tech',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: ['AAPL', 'MSFT'].map((symbol) => ({ type: 'symbol', symbol })),
  });
  server.settings.set('watchlist.prefs', {
    activeId: 'wl-1',
    columns: ['last', 'change', 'changePercent'],
    sort: null,
  });
}

test('"Open in new chart" in the watchlist adds a chart with that symbol', async ({
  page,
  server,
}) => {
  seedList(server);
  await mockMarket(page, {
    quotes: { AAPL: quote('AAPL', 101, 100), MSFT: quote('MSFT', 98, 100) },
  });
  await open(page);
  const panel = page.getByRole('region', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
  await expect(cells(page)).toHaveCount(1);

  await page.getByTestId('wl-row-MSFT').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in new chart' }).click();
  await expect(cells(page)).toHaveCount(2);
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Object.values(window.charts)
          .map((c) => c.getState().symbol)
          .sort(),
      ),
    )
    .toEqual(['AAPL', 'MSFT']);
});

test('a 16-chart layout loads without page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await chooseTemplate(page, '4x4');
  await expect(cells(page)).toHaveCount(16);
  await expect
    .poll(() => page.evaluate(() => Object.values(window.charts).every((c) => c.store.length > 0)))
    .toBe(true);
  expect(errors).toEqual([]);
});
