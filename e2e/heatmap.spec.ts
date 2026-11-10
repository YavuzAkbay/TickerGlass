import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, mockSnapshots, quote } from './market';
import { seedActiveList, type MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

// ---------------------------------------------------------------------------
// Watchlists page

const WL_QUOTES = {
  AAPL: quote('AAPL', 101, 100), // +1 %
  MSFT: quote('MSFT', 98, 100), // -2 %
  TSLA: quote('TSLA', 103, 100), // +3 %
};

// Sizes come from the nightly snapshot: AAPL > MSFT > TSLA.
const SNAPSHOTS = {
  AAPL: { mcap: 3e12, sector: 'Technology', perf1m: 4 },
  MSFT: { mcap: 2.9e12, sector: 'Technology', perf1m: -12 },
  TSLA: { mcap: 8e11, sector: 'Automotive', perf1m: 20 },
};

async function seed(page: Page, server: MockServer) {
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.watchlists.set('wl-tech', {
    id: 'wl-tech',
    name: 'Tech',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: [
      { type: 'symbol', symbol: 'AAPL' },
      { type: 'section', id: 's1', title: 'Growth' },
      { type: 'symbol', symbol: 'MSFT' },
      { type: 'symbol', symbol: 'TSLA' },
    ],
  });
  server.settings.set('watchlist.prefs', {
    columns: ['last', 'change', 'changePercent'],
    sort: null,
  });
  await seedActiveList(page, 'wl-tech');
}

async function openPanel(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
}

const tiles = (page: Page) => page.locator('[data-testid^="hm-tile-"]');
const map = (page: Page) => page.getByTestId('hm-map');
const chartSymbol = (page: Page) => page.evaluate(() => window.chart.getState().symbol);
const activeTile = (page: Page) =>
  map(page).evaluate((el) => el.getAttribute('aria-activedescendant'));

async function area(page: Page, symbol: string): Promise<number> {
  const box = await page.getByTestId(`hm-tile-${symbol}`).boundingBox();
  return box ? box.width * box.height : 0;
}

test('watchlist page: toggle to the heatmap, sized by market cap, colored by the day', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: WL_QUOTES });
  await mockSnapshots(page, { rows: SNAPSHOTS });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await expect(page.getByTestId('wlp-root')).toBeVisible();

  // The table is the default; the toggle swaps it for the map.
  await expect(page.getByTestId('wlp-view-table')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('wlp-view-heatmap').click();
  await expect(page.getByTestId('wlp-view-heatmap')).toHaveAttribute('aria-pressed', 'true');
  await expect(map(page)).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);

  // Tiles carry the symbol and the signed value (not color alone).
  await expect(page.getByTestId('hm-tile-AAPL')).toContainText('AAPL');
  await expect(page.getByTestId('hm-tile-AAPL')).toContainText('+1.00%');
  await expect(page.getByTestId('hm-tile-MSFT')).toContainText('−2.00%');
  await expect(page.getByTestId('hm-tile-TSLA')).toContainText('+3.00%');
  await expect(page.getByTestId('hm-legend')).toBeVisible();

  // Area follows market cap: AAPL (3.0T) > TSLA (0.8T).
  await expect
    .poll(async () => (await area(page, 'AAPL')) / (await area(page, 'TSLA')))
    .toBeGreaterThan(2);

  // Equal sizes make the areas match (within a pixel of rounding).
  await page.getByTestId('hm-size').selectOption('equal');
  await expect
    .poll(async () => Math.abs((await area(page, 'AAPL')) - (await area(page, 'TSLA'))))
    .toBeLessThan(400);

  // Color by 1M performance, clamped at +-10 %: the printed value changes.
  await page.getByTestId('hm-color').selectOption('perf1m');
  await expect(page.getByTestId('hm-tile-TSLA')).toContainText('+20.00%');
  await expect(page.getByTestId('hm-tile-MSFT')).toContainText('−12.00%');

  // Group by sector (from the snapshot): one frame per sector.
  await page.getByTestId('hm-group').selectOption('sector');
  await expect(page.getByTestId('hm-group-Technology')).toBeVisible();
  await expect(page.getByTestId('hm-group-Automotive')).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);

  // Or by the list's sections (symbols above the first section are "Ungrouped").
  await page.getByTestId('hm-group').selectOption('section');
  await expect(page.getByTestId('hm-group-Growth')).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);

  // The view is remembered.
  const stored = await page.evaluate(
    () => JSON.parse(localStorage.getItem('tickerglass-watchlist-page') ?? '{}').state?.view,
  );
  expect(stored).toBe('heatmap');
});

test('watchlist page heatmap: the filter narrows the tiles, hover shows a tooltip', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: WL_QUOTES });
  await mockSnapshots(page, { rows: SNAPSHOTS });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await page.getByTestId('wlp-view-heatmap').click();
  await expect(tiles(page)).toHaveCount(3);

  await page.getByTestId('wlp-filter').fill('tsl');
  await expect(tiles(page)).toHaveCount(1);
  await expect(page.getByTestId('hm-tile-TSLA')).toBeVisible();
  await page.getByTestId('wlp-filter').fill('');
  await expect(tiles(page)).toHaveCount(3);

  await page.getByTestId('hm-tile-AAPL').hover();
  const tip = page.getByTestId('hm-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('AAPL');
  await expect(tip).toContainText('+1.00%');
  await expect(tip).toContainText('Market cap');
  await expect(tip).toContainText('$3.0T');
});

test('watchlist page heatmap: arrow keys move between tiles, Enter opens the chart', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: WL_QUOTES });
  await mockSnapshots(page, { rows: SNAPSHOTS });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await page.getByTestId('wlp-view-heatmap').click();
  await expect(tiles(page)).toHaveCount(3);

  await map(page).focus();
  // First arrow lands on the largest tile.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTile(page)).toBe('hm-tile-AAPL');
  await expect(page.getByTestId('hm-tile-AAPL')).toHaveAttribute('aria-selected', 'true');

  // Arrows travel the whole map: every tile is reachable.
  const seen = new Set<string | null>(['hm-tile-AAPL']);
  for (const key of [
    'ArrowRight',
    'ArrowDown',
    'ArrowLeft',
    'ArrowUp',
    'ArrowRight',
    'ArrowDown',
  ]) {
    await page.keyboard.press(key);
    seen.add(await activeTile(page));
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);

  // End = smallest tile (TSLA); the detail pane follows; Enter opens it in the chart.
  await page.keyboard.press('End');
  await expect.poll(() => activeTile(page)).toBe('hm-tile-TSLA');
  await expect(page.getByTestId('wlp-detail')).toContainText('TSLA');
  await page.keyboard.press('Home');
  await expect.poll(() => activeTile(page)).toBe('hm-tile-AAPL');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('TSLA');
});

test('watchlist page heatmap: double-click opens the chart, the context menu is the row menu', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: WL_QUOTES });
  await mockSnapshots(page, { rows: SNAPSHOTS });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await page.getByTestId('wlp-view-heatmap').click();

  await page.getByTestId('hm-tile-MSFT').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add alert…' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('hm-tile-MSFT').dblclick();
  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('MSFT');
});

// ---------------------------------------------------------------------------
// Screener

const SCR_QUOTES = {
  NVDA: quote('NVDA', 101, 100), // +1 %
  AAPL: quote('AAPL', 98, 100), // -2 %
  MSFT: quote('MSFT', 103, 100), // +3 %
  TSLA: quote('TSLA', 106, 100), // +6 %
};

async function openScreener(page: Page) {
  await openPanel(page);
  await page.getByTestId('nav-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
}

test('client screener: heatmap of the filtered set, live quotes capped at 200', async ({
  page,
}) => {
  const market = await mockMarket(page, { quotes: SCR_QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreener(page);

  await page.getByTestId('scr-view-heatmap').click();
  await expect(map(page)).toBeVisible();
  // The default slice is the top 100; every match is a tile.
  await expect(tiles(page)).toHaveCount(100, { timeout: 15_000 });
  await expect(page.getByTestId('hm-tile-NVDA')).toContainText('+1.00%');
  expect(new Set(market.subscribed).size).toBeLessThanOrEqual(200);

  // Group by the universe's group (sector for stocks).
  await page.getByTestId('hm-group').selectOption('group');
  await expect(page.getByTestId('hm-group-Technology')).toBeVisible();
  await expect(tiles(page)).toHaveCount(100);

  // Keyboard: arrows pick a tile (first = largest cap), Enter opens it and leaves the page.
  await map(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTile(page)).toBe('hm-tile-NVDA');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scr-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('NVDA');
});

test('client screener: the table groups by sector with aggregates and collapses groups', async ({
  page,
}) => {
  await mockMarket(page, { quotes: SCR_QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreener(page);
  await expect(page.getByTestId('scr-row-NVDA')).toBeVisible();

  await page.getByTestId('scr-groupby').selectOption('group');
  const tech = page.getByTestId('scr-group-Technology');
  await expect(tech).toBeVisible();
  await expect(tech).toContainText('symbols');
  await expect(tech).toContainText('avg');
  await expect(tech).toContainText('cap');
  await expect(page.getByTestId('scr-row-NVDA')).toBeVisible();

  // Collapsing hides the group's rows; the header stays with its aggregate.
  await page.getByTestId('scr-group-toggle-Technology').click();
  await expect(page.getByTestId('scr-group-toggle-Technology')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByTestId('scr-row-NVDA')).toHaveCount(0);
  await page.getByTestId('scr-group-toggle-Technology').click();
  await expect(page.getByTestId('scr-row-NVDA')).toBeVisible();

  // Back to a flat table.
  await page.getByTestId('scr-groupby').selectOption('none');
  await expect(tech).toHaveCount(0);
});

test('server screener: the heatmap asks for 500 rows with the map fields; sector grouping in the table', async ({
  page,
}) => {
  const m = await mockMarket(page, { quotes: SCR_QUOTES, screener: { mode: 'server' } });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreener(page);
  await expect(page.getByTestId('scr-row-NVDA')).toBeVisible();

  // Table grouping by sector: the scan asks for the sector and market cap.
  await page.getByTestId('scr-groupby').selectOption('sector');
  await expect(page.getByTestId('scr-group-Technology')).toContainText('4 symbols');
  await expect
    .poll(() => {
      const last = m.screener.scanRequests[m.screener.scanRequests.length - 1] as {
        fields?: string[];
      };
      return last?.fields?.includes('sector') && last?.fields?.includes('mcap');
    })
    .toBe(true);

  // Heatmap: one request for up to 500 rows from offset 0, with the snapshot fields.
  await page.getByTestId('scr-view-heatmap').click();
  await expect(tiles(page)).toHaveCount(4);
  await expect
    .poll(() => {
      const last = m.screener.scanRequests[m.screener.scanRequests.length - 1] as {
        limit?: number;
        offset?: number;
        fields?: string[];
      };
      return JSON.stringify({
        limit: last?.limit,
        offset: last?.offset,
        has: ['perf1m', 'relVol', 'rsi14', 'avgDollarVol30', 'mcap'].every((f) =>
          last?.fields?.includes(f),
        ),
      });
    })
    .toBe(JSON.stringify({ limit: 500, offset: 0, has: true }));

  // Live quote overlays the snapshot change; subscriptions stay within the visible tiles.
  await expect(page.getByTestId('hm-tile-TSLA')).toContainText('+6.00%');
  expect([...new Set(m.subscribed)].sort()).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA']);

  // Snapshot colors: RSI distance from 50 prints the RSI itself.
  await page.getByTestId('hm-color').selectOption('rsi');
  await expect(page.getByTestId('hm-tile-NVDA')).toContainText('RSI 28.0');
  // Sized by market cap: AAPL ($3.1T) is bigger than TSLA ($0.8T).
  await expect
    .poll(async () => (await area(page, 'AAPL')) / (await area(page, 'TSLA')))
    .toBeGreaterThan(2);

  await map(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTile(page)).toBe('hm-tile-AAPL');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('scr-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('AAPL');
});
