import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { hotlistRow, mockHotlists, mockMarket, quote, type HotlistsMockOptions } from './market';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const QUOTES = {
  NVDA: quote('NVDA', 110, 100),
  MSFT: quote('MSFT', 400, 400),
  AAPL: quote('AAPL', 190, 200),
};

const ROWS: HotlistsMockOptions['rows'] = {
  gainers: [hotlistRow('NVDA', 3, 101, 3), hotlistRow('MSFT', 1.5, 403, 1.5)],
  unusualVolume: [hotlistRow('AAPL', 3.2, 198, -1), hotlistRow('MSFT', 2.4, 403, 1.5)],
  oversold: [hotlistRow('AAPL', 27, 198, -1)],
};

async function boot(page: Page, hot: HotlistsMockOptions = { rows: ROWS }) {
  await mockMarket(page, { quotes: QUOTES, screener: { mode: 'server' } });
  const hotlists = await mockHotlists(page, hot);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  return hotlists;
}

const openPanel = async (page: Page) => {
  await page.locator('[data-panel="hotlists"]').click();
  await expect(page.getByTestId('hl-panel')).toBeVisible();
};

test('opens, ranks the default universe and overlays live prices', async ({ page }) => {
  const hotlists = await boot(page);
  await openPanel(page);

  await expect(page.getByTestId('hl-asof')).toContainText('As of 2026-11-05 close');
  await expect(page.getByTestId('hl-asof')).toContainText('prices are live');
  await expect(page.getByTestId('hl-universe')).toHaveValue('list:sp500');
  await expect(page.locator('.hl-row')).toHaveCount(2);
  await expect(page.getByTestId('hl-metric-NVDA')).toHaveText('+3.00%');
  // The live quote (110 vs 100) replaces the snapshot's last (101) and change (3%).
  await expect(page.getByTestId('hl-last-NVDA')).toHaveText('110.00');
  await expect(page.getByTestId('hl-chg-NVDA')).toHaveText('+10.00%');
  expect(hotlists.requests[0]).toEqual({ kind: 'gainers', universe: 'list:sp500', limit: '25' });
});

test('switches kind and universe', async ({ page }) => {
  const hotlists = await boot(page);
  await openPanel(page);
  await expect(page.locator('.hl-row')).toHaveCount(2);

  await page.getByTestId('hl-kind').selectOption('unusualVolume');
  await expect(page.locator('.hl-row')).toHaveCount(2);
  await expect(page.getByTestId('hl-metric-AAPL')).toHaveText('3.20x');
  await expect(page.locator('.hl-head')).toContainText('RelVol');

  await page.getByTestId('hl-kind').selectOption('oversold');
  await expect(page.getByTestId('hl-metric-AAPL')).toHaveText('27');
  await expect(page.locator('.hl-row')).toHaveCount(1);

  await page.getByTestId('hl-universe').selectOption('etfs');
  await expect
    .poll(() => hotlists.requests.at(-1))
    .toMatchObject({
      kind: 'oversold',
      universe: 'etfs',
    });

  // An empty ranking says so and points to the screener.
  await page.getByTestId('hl-kind').selectOption('gapDown');
  await expect(page.getByTestId('hl-none')).toBeVisible();
  await expect(page.getByTestId('hl-open-screener')).toBeVisible();
});

test('clicking or pressing Enter on a row opens the symbol in the chart', async ({ page }) => {
  await boot(page);
  await openPanel(page);
  await page.getByTestId('hl-row-MSFT').click();
  await expect.poll(() => page.evaluate(() => window.chart.getSymbol())).toBe('MSFT');

  await page.getByTestId('hl-row-NVDA').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.chart.getSymbol())).toBe('NVDA');
  await expect(page.getByTestId('hl-row-NVDA')).toHaveAttribute('aria-current', 'true');
});

test('row menu offers the watchlist and alert actions', async ({ page }) => {
  await boot(page);
  await openPanel(page);
  await page.getByTestId('hl-row-MSFT').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Open in chart' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add to watchlist…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add alert…' })).toBeVisible();
});

test('without a snapshot it explains and links to the screener', async ({ page }) => {
  await mockMarket(page, { quotes: QUOTES, screener: { mode: 'first_run' } });
  await mockHotlists(page, { asOf: null });
  await page.goto('/?feed=synthetic');
  await openPanel(page);
  await expect(page.getByTestId('hl-empty')).toContainText('being built');
  await page.getByTestId('hl-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
});

test('the Show Hotlists command opens the panel', async ({ page }) => {
  await boot(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.getByRole('combobox').fill('Show Hotlists');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('hl-panel')).toBeVisible();
});
