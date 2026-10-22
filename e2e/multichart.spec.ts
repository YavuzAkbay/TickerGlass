import type { Page } from '@playwright/test';
import { expect, pickTool, test } from './fixtures';
import { mockMarket, quote } from './market';
import type { MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
    charts: Record<string, import('@tickerglass/engine').Chart>;
  }
}

const cells = (page: Page) => page.locator('.chart-cell');
const layoutButton = (page: Page) => page.getByRole('button', { name: /^Layout:/ });

async function open(page: Page) {
  // Fresh indicator state (a new chart shows the default Volume only).
  await page.addInitScript(() => localStorage.removeItem('tickerglass-indicators'));
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

test('window.chart follows the active chart across template changes and focus', async ({
  page,
}) => {
  await open(page);
  const matchesActive = () =>
    page.evaluate(() => {
      const id = document.querySelector('.chart-cell.active')?.getAttribute('data-chart-id');
      const cell = id ?? document.querySelector('.chart-cell')!.getAttribute('data-chart-id')!;
      return window.chart === window.charts[cell];
    });
  await chooseTemplate(page, '2x2');
  await expect(cells(page)).toHaveCount(4);
  expect(await matchesActive()).toBe(true);
  await chooseTemplate(page, '2c');
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(cells(page)).toHaveCount(2);
  await expect.poll(matchesActive).toBe(true);
  await focusCell(page, 1);
  await expect.poll(matchesActive).toBe(true);
  await focusCell(page, 0);
  await expect.poll(matchesActive).toBe(true);
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
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
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

// ------------------------------------------------------------ sync

type SyncLabel = 'Symbol' | 'Interval' | 'Crosshair' | 'Time' | 'Date range' | 'Drawings';

async function setSync(page: Page, label: SyncLabel, on: boolean) {
  await page.getByRole('button', { name: 'Chart layout', exact: true }).click();
  const box = page.getByRole('dialog', { name: 'Chart layout' }).getByLabel(label, { exact: true });
  await box.setChecked(on);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Chart layout' })).toHaveCount(0);
}

/** Symbol search from the focused chart's symbol card (each chart has its own). */
async function searchSymbol(page: Page, symbol: string) {
  await page
    .locator('.chart-cell.active')
    .getByRole('button', { name: /^Symbol search/ })
    .click();
  const input = page.getByLabel('Search symbols');
  await input.fill(symbol);
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** Chart ids in cell order. */
const chartIds = (page: Page) =>
  cells(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.chartId!));

const symbols = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.chart-cell')].map((el) =>
      window.charts[el.dataset.chartId!]!.getSymbol(),
    ),
  );

/** Logical index of the crosshair mirrored from another chart (NaN: none). */
const syncedIndex = (page: Page, n: number) =>
  page.evaluate((i) => {
    const id = document.querySelectorAll<HTMLElement>('.chart-cell')[i]!.dataset.chartId!;
    return (window.charts[id] as unknown as { syncedIndex(): number }).syncedIndex();
  }, n);

const visibleRange = (page: Page, n: number) =>
  page.evaluate((i) => {
    const id = document.querySelectorAll<HTMLElement>('.chart-cell')[i]!.dataset.chartId!;
    return window.charts[id]!.getVisibleTimeRange();
  }, n);

async function twoCharts(page: Page) {
  await open(page);
  await chooseTemplate(page, '2c');
  await expect(cells(page)).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => Object.values(window.charts).every((c) => c.store.length > 0)))
    .toBe(true);
}

test('symbol sync: off changes one chart, on changes both', async ({ page }) => {
  await twoCharts(page);
  await focusCell(page, 1);
  await searchSymbol(page, 'MSFT');
  await expect.poll(() => symbols(page)).toEqual(['AAPL', 'MSFT']);

  await setSync(page, 'Symbol', true);
  await focusCell(page, 0);
  await searchSymbol(page, 'NVDA');
  await expect.poll(() => symbols(page)).toEqual(['NVDA', 'NVDA']);
});

test('the crosshair of one chart shows on the other, across intervals (1D and 5m)', async ({
  page,
}) => {
  await twoCharts(page);
  await focusCell(page, 1);
  await page.keyboard.type('5m');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await intervals(page)).sort()).toEqual(['1D', '5m']);
  await expect
    .poll(() => page.evaluate(() => Object.values(window.charts).every((c) => c.store.length > 0)))
    .toBe(true);

  const host0 = cells(page).nth(0).locator('.chart-host');
  const box = (await host0.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 5);
  await expect.poll(() => syncedIndex(page, 1)).not.toBeNaN();
  expect(await syncedIndex(page, 0)).toBeNaN();

  // Pointer leaves the chart: the mirrored crosshair goes.
  await page.mouse.move(box.x + box.width + 400, 5);
  await expect.poll(() => syncedIndex(page, 1)).toBeNaN();

  // The other direction (5m -> 1D) and the flag.
  await setSync(page, 'Crosshair', false);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 5);
  await page.waitForTimeout(150);
  expect(await syncedIndex(page, 1)).toBeNaN();
  await setSync(page, 'Crosshair', true);
  const box1 = (await cells(page).nth(1).locator('.chart-host').boundingBox())!;
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
  await page.mouse.move(box1.x + box1.width / 2 + 20, box1.y + box1.height / 2 + 5);
  await expect.poll(() => syncedIndex(page, 0)).not.toBeNaN();
});

test('panning follows on the other chart only with time sync', async ({ page }) => {
  await twoCharts(page);
  const host0 = cells(page).nth(0).locator('.chart-host');
  const box = (await host0.boundingBox())!;
  const pan = async (dx: number) => {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 5 });
    await page.mouse.move(x + dx, y, { steps: 5 });
    await page.mouse.up();
  };

  const before = await visibleRange(page, 1);
  await pan(120);
  await page.waitForTimeout(300);
  expect(await visibleRange(page, 1)).toEqual(before);

  await setSync(page, 'Time', true);
  const a0 = (await visibleRange(page, 0))!;
  await pan(-80);
  await expect.poll(async () => (await visibleRange(page, 0))!.to).not.toBe(a0.to);
  await expect
    .poll(async () => (await visibleRange(page, 1))!.to)
    .toBe((await visibleRange(page, 0))!.to);
});

test('a range preset applies to every chart only with date-range sync', async ({ page }) => {
  await twoCharts(page);
  // Each chart has its own presets on its time axis; these are the first chart's.
  const preset = (label: string) =>
    page
      .locator('.chart-cell')
      .nth(0)
      .getByRole('group', { name: 'Range presets' })
      .getByRole('button', { name: label, exact: true });
  const DAY = 86_400;

  await focusCell(page, 0);
  const initial = (await visibleRange(page, 1))!;
  await preset('1M').click();
  await expect.poll(async () => (await intervals(page))[0]).toBe('1h');
  await page.waitForTimeout(300);
  expect(await visibleRange(page, 1)).toEqual(initial);

  await setSync(page, 'Date range', true);
  await focusCell(page, 0);
  await preset('3M').click();
  await expect.poll(async () => (await intervals(page))[0]).toBe('4h');
  // Both charts now start about three months before the last bar.
  await expect
    .poll(async () => {
      const [a, b] = [(await visibleRange(page, 0))!, (await visibleRange(page, 1))!];
      return Math.abs(a.from - b.from) < 4 * DAY && b.from !== initial.from;
    })
    .toBe(true);
});

test('drawing sync off: a drawing stays on its chart; selection is per chart', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('mc-drw')) return;
    sessionStorage.setItem('mc-drw', '1');
    localStorage.removeItem('tickerglass-drawings');
  });
  await twoCharts(page);
  await setSync(page, 'Drawings', false);
  // Charts with legacy ids are re-created under fresh ids; wait for the grid to settle.
  await expect(cells(page)).toHaveCount(2);
  await expect
    .poll(() => page.evaluate(() => Object.values(window.charts).every((c) => c.store.length > 0)))
    .toBe(true);
  const [idA, idB] = await chartIds(page);
  expect(idA).toMatch(/^[0-9a-f-]{36}$/);

  const drawn = (id: string) => page.evaluate((i) => window.charts[i]!.getDrawings().length, id);
  const hostB = cells(page).nth(1).locator('.chart-host');
  const box = (await hostB.boundingBox())!;
  await pickTool(page, 'Lines', 'Trend line');
  // Below the symbol card and legend chips at the top-left.
  await page.mouse.click(box.x + 80, box.y + 260);
  await page.mouse.click(box.x + 260, box.y + 340);
  await expect.poll(() => drawn(idB!)).toBe(1);
  await page.waitForTimeout(300);
  expect(await drawn(idA!)).toBe(0);
  // The new drawing is bound to chart B.
  expect(await page.evaluate((i) => window.charts[i]!.getDrawings()[0]!.chartId, idB!)).toBe(idB);

  // Selecting it on B leaves A without a selection.
  await page.keyboard.press('Escape');
  await page.mouse.click(box.x + 170, box.y + 300);
  await expect
    .poll(() => page.evaluate((i) => window.charts[i]!.getSelection().length, idB!))
    .toBe(1);
  expect(await page.evaluate((i) => window.charts[i]!.getSelection().length, idA!)).toBe(0);
  // Focusing A hides B's drawing toolbar (state is per chart).
  await focusCell(page, 0);
  await expect(page.getByRole('toolbar', { name: 'Drawing toolbar' })).toHaveCount(0);
  await page.keyboard.press('Alt+]');
  await expect(cells(page).nth(1)).toHaveClass(/\bactive\b/);
  await expect(page.getByRole('toolbar', { name: 'Drawing toolbar' })).toBeVisible();

  // Switching drawing sync back on does not move it: still only on B.
  await setSync(page, 'Drawings', true);
  expect(await drawn(idA!)).toBe(0);
});

test('a 4-chart layout of one symbol and interval fetches bars once', async ({ page }) => {
  const requests: string[] = [];
  const N = 400;
  const DAY = 86_400;
  const t0 = Math.floor(Date.UTC(2024, 0, 1) / 1000);
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
  await page.route('**/api/bars?*', (route) => {
    const q = new URL(route.request().url()).searchParams;
    requests.push(`${q.get('symbol')}|${q.get('interval')}`);
    const t = Array.from({ length: N }, (_, i) => t0 + i * DAY);
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
  await page.goto('/');
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(layoutButton(page)).toBeVisible();
  await chooseTemplate(page, '2x2');
  await expect(cells(page)).toHaveCount(4);
  await page.waitForFunction(() => {
    const all = Object.values(window.charts);
    return all.length === 4 && all.every((c) => c.store.length > 0);
  });
  const counts = new Map<string, number>();
  for (const r of requests) counts.set(r, (counts.get(r) ?? 0) + 1);
  expect(counts.size).toBeGreaterThan(0);
  for (const [, n] of counts) expect(n).toBe(1);
});
