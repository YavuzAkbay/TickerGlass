import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';
import { seedActiveList, type MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const QUOTES = {
  AAPL: quote('AAPL', 101, 100),
  MSFT: quote('MSFT', 98, 100), // performance base close is 99: -1.01 %
  TSLA: quote('TSLA', 103, 100),
  NVDA: quote('NVDA', 101, 100),
};

async function openPanel(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
}

async function seedWatchlist(page: Page, server: MockServer) {
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

async function openWatchlists(page: Page) {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-watchlists').click();
  await expect(page.getByTestId('wlp-root')).toBeVisible();
}

async function openScreener(page: Page) {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
  await page.getByTestId('nav-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
}

test('watchlists detail pane: performance, key stats, events and news', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  await seedWatchlist(page, server);
  await openWatchlists(page);

  await page.getByTestId('wlp-row-MSFT').click();
  const detail = page.getByTestId('wlp-detail');
  await expect(detail).toContainText('MSFT');

  // Returns recomputed from the live price; the sign is written out.
  const chips = detail.getByTestId('si-perf-chips').locator('li');
  await expect(chips).toHaveCount(6);
  await expect(chips.first()).toContainText('1W');
  await expect(detail.locator('[data-period="1M"]')).toContainText('−1.01%');

  // Events: earnings in 6 days, the last ex-dividend and split.
  await expect(detail.getByTestId('si-next-earnings')).toContainText('in 6 days');
  await expect(detail.getByTestId('si-ex-dividend')).toContainText('Last ex-dividend');
  await expect(detail.getByTestId('si-last-split')).toContainText('4:1');

  // News: text only, external links open safely in a new tab.
  const first = detail.getByTestId('si-news-list').getByRole('link').first();
  await expect(first).toHaveText('MSFT unveils new product line');
  await expect(first).toHaveAttribute('href', 'https://news.example.com/MSFT/1');
  await expect(first).toHaveAttribute('target', '_blank');
  await expect(first).toHaveAttribute('rel', 'noopener noreferrer');

  // The slow calls ran at background priority; fundamentals wait for "More stats".
  const sent = market.infoRequests.filter((r) => r.symbol === 'MSFT');
  expect(sent.map((r) => r.kind).sort()).toEqual(['events', 'news']);
  expect(sent.every((r) => r.priority === 'background')).toBe(true);
  await expect(detail.getByTestId('si-morestats-rows')).toHaveCount(0);

  await detail.getByRole('button', { name: 'More stats' }).click();
  await expect(detail.getByTestId('si-morestats-rows')).toContainText('28.50');
  await expect(detail.getByTestId('si-morestats-rows')).toContainText('Technology');
  expect(market.infoRequests.filter((r) => r.kind === 'fundamentals')).toEqual([
    { kind: 'fundamentals', symbol: 'MSFT', priority: 'background' },
  ]);

  // Alerts section of this pane: add-alert command.
  await expect(detail.getByTestId('si-alerts')).toContainText('No alerts on this symbol');
  await expect(detail.getByTestId('si-note')).toHaveText('No note');
});

test('arrowing through rows fetches only for the symbol that rests, sections stay collapsed', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  await seedWatchlist(page, server);
  await openWatchlists(page);

  await page.getByTestId('wlp-row-AAPL').click();
  const detail = page.getByTestId('wlp-detail');
  await expect(detail.getByTestId('si-news-list')).toContainText('AAPL unveils');

  // Two quick moves down: MSFT is passed over, TSLA is where it rests.
  await page.getByRole('grid', { name: 'Watchlist symbols' }).press('ArrowDown');
  await page.getByRole('grid', { name: 'Watchlist symbols' }).press('ArrowDown');
  await expect(detail.getByTestId('si-news-list')).toContainText('TSLA unveils');
  expect(market.infoRequests.some((r) => r.symbol === 'MSFT')).toBe(false);

  // Collapsing a section is remembered and stops its requests.
  await detail.getByRole('button', { name: 'News', exact: true }).click();
  await expect(detail.getByTestId('si-news-list')).toHaveCount(0);
  const before = market.infoRequests.length;
  await page.getByRole('grid', { name: 'Watchlist symbols' }).press('ArrowUp');
  await expect(detail.getByTestId('si-next-earnings')).toBeVisible();
  await expect.poll(() => market.infoRequests.some((r) => r.symbol === 'MSFT')).toBe(true);
  expect(market.infoRequests.slice(before).every((r) => r.kind === 'events')).toBe(true);
  await page.reload();
  await openWatchlists(page);
  await page.getByTestId('wlp-row-AAPL').click();
  await expect(detail.getByTestId('si-events')).toBeVisible();
  await expect(detail.getByTestId('si-news')).toHaveAttribute('data-open', 'false');
});

test('screener detail pane: performance, events and news', async ({ page }) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  await openScreener(page);

  await page.getByTestId('scr-row-NVDA').click();
  const detail = page.getByTestId('scr-detail');
  await expect(detail).toContainText('NVDA');
  await expect(detail.getByTestId('si-perf-chips').locator('li')).toHaveCount(6);
  await expect(detail.locator('[data-period="1M"]')).toContainText('+2.02%');
  await expect(detail.getByTestId('si-next-earnings')).toContainText('in 6 days');
  await expect(detail.getByTestId('si-news-list').getByRole('link').first()).toHaveText(
    'NVDA unveils new product line',
  );
  // No alerts block on the screener, and no fundamentals until asked.
  await expect(detail.getByTestId('si-alerts')).toHaveCount(0);
  expect(market.infoRequests.some((r) => r.kind === 'fundamentals')).toBe(false);
});
