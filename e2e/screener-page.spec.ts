import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

// Rank order of the stocks universe (e2e/fixtures/screener-universe.json) starts NVDA, AAPL, MSFT, AMZN…
const QUOTES = {
  NVDA: quote('NVDA', 101, 100), // +1 %
  AAPL: quote('AAPL', 98, 100), // −2 %
  MSFT: quote('MSFT', 103, 100), // +3 %
  TSLA: quote('TSLA', 106, 100), // +6 %
};

async function openPanel(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
}

async function openScreen(page: Page) {
  await openPanel(page);
  await page.getByTestId('nav-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
}

const row = (page: Page, symbol: string) => page.getByTestId(`scr-row-${symbol}`);
const pageRows = (page: Page) => page.locator('.scr-body .scr-sym-text');
const grid = (page: Page) => page.getByRole('grid', { name: 'Screener results' });
const chartSymbol = (page: Page) => page.evaluate(() => window.chart.getState().symbol);

test('opens from the sidebar, scans the universe, sorts, Enter opens the chart', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.watchlists.set('wl-tech', {
    id: 'wl-tech',
    name: 'Tech',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: [{ type: 'symbol', symbol: 'AAPL' }],
  });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  // Full takeover: the shell's top bar is hidden, the page header is there.
  await expect(page.getByRole('toolbar', { name: 'Chart toolbar' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Screener' })).toBeVisible();
  await expect(page.getByTestId('scr-tab-stocks')).toHaveAttribute('aria-selected', 'true');

  // The scan subscribed the default top-100 slice over the socket.
  await expect.poll(() => market.subscribed.length).toBeGreaterThanOrEqual(100);

  // Default page of 20 rows, in universe rank order; the pager says so.
  await expect(page.getByTestId('scr-foot-count')).toContainText('1\u201320 of 100 matches');
  await expect(page.getByTestId('scr-page-info')).toContainText('Page 1 of 5');
  await expect(pageRows(page).first()).toHaveText('NVDA');
  await expect(pageRows(page)).toHaveCount(20);
  await expect(page.getByTestId('scr-universe-info')).toContainText(/Top 100 of \d+/);

  // Sort by Chg% (descending first): the +6 % row leads, names still resolved statically.
  await page.getByTestId('scr-col-changePercent').click();
  await expect(pageRows(page).first()).toHaveText('TSLA');
  await expect(page.getByTestId('scr-row-TSLA')).toContainText('Tesla');

  // Click previews in the detail pane; Enter opens the chart and leaves the screen.
  await row(page, 'MSFT').click();
  await expect(page.getByTestId('scr-detail')).toContainText('MSFT');
  await expect(page.getByTestId('scr-detail-last')).toHaveText('103.00');
  await grid(page).press('Enter');
  await expect(page.getByTestId('scr-root')).toHaveCount(0);
  await expect.poll(() => chartSymbol(page)).toBe('MSFT');
});

test('search narrows rows, Escape stages: filter, then close', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('scr-search').fill('tsl');
  await expect(pageRows(page)).toHaveText(['TSLA']);

  // First Escape clears the filter, the second one returns to the charts.
  await page.keyboard.press('Escape');
  await expect(pageRows(page).first()).toHaveText('NVDA');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scr-root')).toHaveCount(0);
});

test('sector filter chips and the show-more limit knob', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('scr-group-btn').click();
  await page.getByRole('menuitem', { name: 'Healthcare', exact: true }).click();
  await expect(page.locator('.scr-chip')).toContainText('Healthcare');
  // The first healthcare names of the top-100 slice (rank order preserved).
  await expect(pageRows(page).first()).toHaveText('LLY');

  // Clearing the chip restores the unfiltered view.
  await page.locator('.scr-chip button').first().click();
  await expect(pageRows(page).first()).toHaveText('NVDA');

  // The pager turns the page (20 → rows 21–40, still rank-ordered).
  await page.getByTestId('scr-page-next').click();
  await expect(page.getByTestId('scr-page-info')).toContainText('Page 2 of 5');
  await expect(page.getByTestId('scr-foot-count')).toContainText('21\u201340 of 100 matches');
  await expect(pageRows(page).first()).toHaveText('PG'); // #21 of the top 100
  await page.getByTestId('scr-page-prev').click();
  await expect(pageRows(page).first()).toHaveText('NVDA');

  // Rows per page: 50 → 2 pages; keyboard PageDown walks them.
  await page.getByTestId('scr-options-btn').click();
  await page.getByRole('menuitem', { name: 'Rows per page' }).click(); // opens the submenu
  await page.getByRole('menuitem', { name: '50', exact: true }).click();
  await expect(page.getByTestId('scr-page-info')).toContainText('Page 1 of 2');
  await grid(page).press('End');
  await expect(row(page, 'TMO')).toHaveAttribute('aria-current', 'true'); // #50 of the top 100
});

test('row menu adds the symbol to a server watchlist', async ({ page, server }) => {
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.watchlists.set('wl-tech', {
    id: 'wl-tech',
    name: 'Tech',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: [],
  });
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await row(page, 'NVDA').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add to watchlist…' }).click();
  await page.getByRole('menuitem', { name: 'Tech', exact: true }).click();
  await expect
    .poll(() =>
      server.watchlists.get('wl-tech')?.items.map((i) => (i.type === 'symbol' ? i.symbol : '')),
    )
    .toEqual(['NVDA']);
});

test('class tabs switch the universe; exports the view as CSV', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('scr-tab-crypto').click();
  await expect(pageRows(page).first()).toHaveText('BTC-USD');

  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('scr-more').click(),
    page.getByRole('menuitem', { name: 'Export view (CSV)' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^Screener-crypto_\d{4}-\d{2}-\d{2}\.csv$/);
});

test('Alt+Shift+S toggles the screen from anywhere', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);

  await page.keyboard.press('Alt+Shift+s');
  await expect(page.getByTestId('scr-root')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scr-root')).toHaveCount(0);
});

test('static filters see the whole universe, not just the scanned top slice', async ({ page }) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  // Zscaler ranks far below the default top-100 scan slice.
  await page.getByTestId('scr-search').fill('zscaler');
  await expect(pageRows(page)).toHaveText(['ZS']);
  // The info line says what was scanned, and only the match is subscribed on top.
  await expect(page.getByTestId('scr-universe-info')).toContainText(/1 matching of \d+/);
  await expect.poll(() => market.subscribed).toContain('ZS');
});

test('price filters say they only judge subscribed symbols; the order can be paused', async ({
  page,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await expect(page.getByTestId('scr-live-note')).toHaveCount(0);
  await page.getByTestId('scr-filters-btn').click();
  await page.getByTestId('scr-quick-up-5').click();
  await expect(page.getByTestId('scr-live-note')).toContainText(
    /Live filters evaluated on \d+ subscribed symbols/,
  );
  await expect(pageRows(page)).toHaveText(['TSLA']); // the only +5 % mover
  await page.getByRole('button', { name: 'Done' }).click();

  const toggle = page.getByTestId('scr-live-toggle');
  await expect(toggle).toHaveText('Live');
  await toggle.click();
  await expect(toggle).toHaveText('Paused');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveText('Live');
});

test('min above max is explained instead of silently empty', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('scr-filters-btn').click();
  const popover = page.getByTestId('scr-numfilters');
  await popover.getByLabel('Price ≥').fill('200');
  await popover.getByLabel('Price ≥').press('Enter');
  await popover.getByLabel('Price ≤').fill('100');
  await popover.getByLabel('Price ≤').press('Enter');
  await expect(page.getByTestId('scr-range-error')).toContainText('Price');
});

test('adds every result to a watchlist from the page menu', async ({ page, server }) => {
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.watchlists.set('wl-tech', {
    id: 'wl-tech',
    name: 'Tech',
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: [{ type: 'symbol', symbol: 'AAPL' }],
  });
  await mockMarket(page, { quotes: QUOTES });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  await page.getByTestId('scr-search').fill('a'); // many matches, AAPL among them
  await page.getByTestId('scr-more').click();
  await page.getByRole('menuitem', { name: /Add all \d+ results to watchlist/ }).click();
  await page.getByRole('menuitem', { name: 'Tech', exact: true }).click();
  await expect(
    page.getByText(/Added \d+ of \d+ symbols to Tech \(1 already there\)/),
  ).toBeVisible();
});

test('shows an error state with Retry when the universe API is unreachable', async ({ page }) => {
  const market = await mockMarket(page, {
    quotes: QUOTES,
    screener: { universeStatus: 503 },
  });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);

  const error = page.getByTestId('scr-universe-error');
  await expect(error).toContainText('Universe unavailable — API unreachable');
  await expect(page.getByTestId('scr-row-NVDA')).toHaveCount(0);

  // The API comes back: Retry loads the universe.
  market.screener.options.universeStatus = undefined;
  await error.getByRole('button', { name: 'Retry' }).click();
  await expect(error).toHaveCount(0);
  await expect(pageRows(page).first()).toHaveText('NVDA');
});
