import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, mockSnapshots, quote } from './market';
import { seedActiveList, type MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const QUOTES = {
  AAPL: quote('AAPL', 101, 100), // +1 %
  MSFT: quote('MSFT', 98, 100), // −2 %
  TSLA: quote('TSLA', 103, 100), // +3 %
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

async function openScreen(page: Page) {
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await expect(page.getByTestId('wlp-root')).toBeVisible();
}

const row = (page: Page, symbol: string) => page.getByTestId(`wlp-row-${symbol}`);
const pageRows = (page: Page) => page.locator('.wlp-body .wlp-sym-text');
const grid = (page: Page) => page.getByRole('grid', { name: 'Watchlist symbols' });
const chartSymbol = (page: Page) => page.evaluate(() => window.chart.getState().symbol);
const tabByName = (page: Page, name: string) => page.getByTestId(`wlp-tab-${name}`);

test('opens from the sidebar, shows quotes and breadth, Enter opens the chart', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  // Full takeover: the shell's top bar is hidden, the page header is there.
  await expect(page.getByRole('toolbar', { name: 'Chart toolbar' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Watchlists' })).toBeVisible();
  await expect(tabByName(page, 'Tech')).toBeVisible();

  // Breadth strip from the mocked quotes: 2 up, 1 down, top mover TSLA +3 %.
  await expect(page.getByTestId('wlp-overview')).toContainText('3 symbols');
  await expect(page.getByTestId('wlp-overview')).toContainText('2 up');
  await expect(page.getByTestId('wlp-overview')).toContainText('1 down');
  await expect(page.getByTestId('wlp-overview')).toContainText('TSLA');

  // Table shows the (synthetic) resolved names once they arrive.
  await expect(page.getByTestId('wlp-cell-name-AAPL')).toContainText('Synthetic', {
    timeout: 10_000,
  });

  // Click previews in the detail pane; Enter opens the chart and leaves the screen.
  await row(page, 'MSFT').click();
  await expect(page.getByTestId('wlp-detail')).toContainText('MSFT');
  await expect(page.getByTestId('wlp-detail-last')).toHaveText('98.00');
  await grid(page).press('Enter');
  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('MSFT');
});

test('filter narrows rows and Escape stages: filter, then close', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('wlp-filter').fill('tsl');
  await expect(pageRows(page)).toHaveText(['TSLA']);

  // First Escape clears the filter, the second one returns to the charts.
  await page.keyboard.press('Escape');
  await expect(pageRows(page)).toHaveText(['AAPL', 'MSFT', 'TSLA']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
});

test('multi-select and bulk remove sync to the server', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await row(page, 'AAPL').click();
  await row(page, 'TSLA').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('wlp-bulk')).toContainText('2 selected');

  await page.getByTestId('wlp-bulk').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByTestId('wlp-bulk')).toHaveCount(0);
  await expect(pageRows(page)).toHaveText(['MSFT']);
  const id = [...server.watchlists.values()].find((w) => w.name === 'Tech')?.id ?? '';
  await expect
    .poll(() => server.watchlists.get(id)?.items.map((i) => (i.type === 'symbol' ? i.symbol : '')))
    .toEqual(['MSFT']);
});

test('creates a list from the tab strip, switches tabs, sorts by Chg%', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  // New list via the tab-strip + button; the prompt opens and activates it.
  await page.getByRole('button', { name: 'New list…' }).click();
  const input = page.locator('.io-prompt-input');
  await expect(input).toBeVisible();
  await input.fill('Crypto');
  await input.press('Enter');
  await expect(tabByName(page, 'Crypto')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Add symbols' })).toBeVisible();

  // Back to Tech: rows are back; sort by Chg% puts TSLA (+3 %) first.
  await tabByName(page, 'Tech').click();
  await expect(pageRows(page)).toHaveText(['AAPL', 'MSFT', 'TSLA']);
  await page.getByTestId('wlp-col-changePercent').click();
  await expect(pageRows(page)).toHaveText(['TSLA', 'AAPL', 'MSFT']);
});

test('exports the view as CSV', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('wlp-more').click(),
    page.getByRole('menuitem', { name: 'Export view (CSV)' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^Tech_\d{4}-\d{2}-\d{2}\.csv$/);
});

test('Alt+Shift+W toggles the screen from anywhere', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);

  await page.keyboard.press('Alt+Shift+w');
  await expect(page.getByTestId('wlp-root')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
});

const headOrder = (page: Page) =>
  page
    .locator('.wlp-head [data-col]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-col')));

test('Alt+Arrow reorders a column header (kept focused, synced); a preset swaps the columns', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await expect
    .poll(() => headOrder(page))
    .toEqual(['name', 'last', 'change', 'changePercent', 'volume', 'dayRange', 'trend']);
  await page.getByTestId('wlp-col-last').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect
    .poll(() => headOrder(page))
    .toEqual(['name', 'change', 'last', 'changePercent', 'volume', 'dayRange', 'trend']);
  await expect(page.getByTestId('wlp-col-last')).toBeFocused();
  await expect
    .poll(
      () =>
        (server.settings.get('watchlist.page.prefs') as { columns: string[] } | undefined)?.columns,
    )
    .toEqual(['name', 'change', 'last', 'changePercent', 'volume', 'dayRange', 'trend']);

  // Presets live in the columns menu.
  await page.getByTestId('wlp-columns-btn').click();
  await page.getByRole('menuitem', { name: 'Presets' }).click();
  await page.getByRole('menuitem', { name: 'Minimal' }).click();
  await expect.poll(() => headOrder(page)).toEqual(['name', 'last', 'changePercent']);
});

test('new columns: Gap % and Rel vol show "—" with an explanation when the source lacks the data', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  server.settings.set('watchlist.page.prefs', {
    columns: ['name', 'last', 'relVolume', 'marketCap'],
  });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await expect.poll(() => headOrder(page)).toEqual(['name', 'last', 'relVolume', 'marketCap']);
  await expect(page.getByTestId('wlp-cell-last-AAPL')).toContainText('101');
  await expect(page.getByTestId('wlp-cell-relVolume-AAPL')).toHaveText('—');
  await expect(page.getByTestId('wlp-cell-marketCap-AAPL')).toHaveText('—');
});

const SNAPSHOT_ROWS = {
  AAPL: {
    perf1m: 4.5,
    rsi14: 28.4,
    pctVsSma200: 12.3,
    nextEarnings: Math.floor(Date.now() / 1000) + 3 * 86_400,
  },
  MSFT: { perf1m: -2, rsi14: 74.2, pctVsSma200: -1, nextEarnings: null },
  // TSLA: untracked, no row
};

test('snapshot columns: values, sort covers rows without a snapshot, no fetch while hidden', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  const snap = await mockSnapshots(page, { rows: SNAPSHOT_ROWS });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  // Not shown: nothing is requested.
  await expect(pageRows(page)).toHaveText(['AAPL', 'MSFT', 'TSLA']);
  expect(snap.requests).toEqual([]);

  // Technical preset adds the columns and fetches the whole list once.
  await page.getByTestId('wlp-columns-btn').click();
  await page.getByRole('menuitem', { name: 'Presets' }).click();
  await page.getByRole('menuitem', { name: /^Technical/ }).click();
  await expect(page.getByTestId('wlp-cell-perf1m-AAPL')).toHaveText('+4.50%');
  await expect(page.getByTestId('wlp-cell-rsi14-AAPL')).toHaveText('↓ 28.4');
  await expect(page.getByTestId('wlp-cell-rsi14-MSFT')).toHaveText('↑ 74.2');
  await expect(page.getByTestId('wlp-cell-nextEarnings-AAPL')).toHaveAttribute(
    'title',
    'in 3 days',
  );
  await expect(page.getByTestId('wlp-cell-perf1m-TSLA')).toHaveText('—');
  expect(snap.requests).toEqual(['AAPL,MSFT,TSLA']);

  // Sort by 1M%: the row without a snapshot stays last in both directions.
  await page.getByTestId('wlp-col-perf1m').click();
  await expect(pageRows(page)).toHaveText(['AAPL', 'MSFT', 'TSLA']); // descending first
  await page.getByTestId('wlp-col-perf1m').click();
  await expect(pageRows(page)).toHaveText(['MSFT', 'AAPL', 'TSLA']);
});

test('snapshot columns show "—" with a tooltip when the server screener is not available', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  const snap = await mockSnapshots(page, { status: 404 });
  await seed(page, server);
  server.settings.set('watchlist.page.prefs', { columns: ['name', 'last', 'rsi14'] });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  const cell = page.getByTestId('wlp-cell-rsi14-AAPL');
  await expect(cell).toHaveText('—');
  await expect(cell).toHaveAttribute('title', 'Server screener not available');
  expect(snap.requests).toHaveLength(1); // one failed call, no retry storm
});
