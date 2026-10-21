import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { formatTxt } from '../apps/web/src/watchlist/model';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';
import type { MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

type SeedItem = string | { section: string; id: string; collapsed?: boolean };

/** Put a list on the mock server before the page loads; it becomes the active list. */
function seed(server: MockServer, id: string, name: string, items: SeedItem[], active = true) {
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, server.watchlists.size)).toISOString();
  server.watchlists.set(id, {
    id,
    name,
    revision: 1,
    createdAt: t,
    updatedAt: t,
    items: items.map((i) =>
      typeof i === 'string'
        ? { type: 'symbol', symbol: i }
        : { type: 'section', id: i.id, title: i.section, collapsed: i.collapsed ?? false },
    ),
  });
  if (active)
    server.settings.set('watchlist.prefs', {
      activeId: id,
      columns: ['last', 'change', 'changePercent'],
      sort: null,
    });
}

async function open(page: Page) {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await openPanel(page);
}

async function openPanel(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
}

const switcher = (page: Page) => page.getByTestId('wl-switcher');
const row = (page: Page, symbol: string) => page.getByTestId(`wl-row-${symbol}`);
const chartSymbol = (page: Page) => page.evaluate(() => window.chart.getState().symbol);

/** Test ids of the symbol and section rows, top to bottom. */
const order = (page: Page) =>
  page
    .locator('[data-testid^="wl-row-"], [data-testid^="wl-section-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));

const menuItem = (page: Page, name: string | RegExp) =>
  page
    .getByRole('menu')
    .last()
    .locator('[role^="menuitem"]')
    .filter({
      hasText: typeof name === 'string' ? new RegExp(`^\\s*${escapeRe(name)}\\s*$`) : name,
    })
    .first();

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Run an item of the active list's menu (the switcher, or the toolbar's list menu). */
async function listAction(page: Page, name: string) {
  await switcher(page).click();
  const item = menuItem(page, name);
  if (!(await item.isVisible())) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^List (menu|actions)|^More/ }).click();
  }
  await menuItem(page, name).click();
}

/** Answer a name prompt (Enter submits). */
async function promptName(page: Page, name: string) {
  const input = page.locator('.io-prompt-input');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toBeHidden();
}

/** Symbol search in add mode (header "+"): adds each symbol and keeps the dialog open. */
async function searchAdd(page: Page, ...symbols: string[]) {
  await page.getByRole('button', { name: 'Add symbol', exact: true }).click();
  const input = page.getByLabel('Search symbols');
  for (const s of symbols) {
    await input.fill(s);
    await expect(page.getByRole('listbox').getByText(s, { exact: true }).first()).toBeVisible();
    await input.press('Enter');
    await expect(input).toHaveValue('');
  }
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
}

async function toggleColumn(page: Page, label: string) {
  await page.getByTestId('wl-columns-btn').click();
  await menuItem(page, label).click();
  await page.keyboard.press('Escape');
}

const serverItems = (server: MockServer, id: string) =>
  server.watchlists.get(id)?.items.map((i) => (i.type === 'section' ? `#${i.title}` : i.symbol));

const listByName = (server: MockServer, name: string) =>
  [...server.watchlists.values()].find((w) => w.name === name);

async function rightClick(page: Page, symbol: string) {
  await row(page, symbol).click({ button: 'right' });
  await expect(page.getByRole('menu').last()).toBeVisible();
}

async function download(page: Page, trigger: () => Promise<void>) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

const QUOTES = {
  AAPL: quote('AAPL', 101, 100),
  MSFT: quote('MSFT', 98, 100),
  TSLA: quote('TSLA', 103, 100),
};

test('create a list, add by Alt+W and by search, reload, rename, duplicate', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  await open(page);

  // First run seeds "Watchlist" (with the chart symbol); then a list of our own.
  await expect(switcher(page)).toContainText('Watchlist');
  await listAction(page, 'Create new list…');
  await promptName(page, 'Tech');
  await expect(switcher(page)).toContainText('Tech');

  await page.keyboard.press('Alt+w'); // adds the chart symbol, AAPL
  await expect(row(page, 'AAPL')).toBeVisible();
  await searchAdd(page, 'MSFT');
  await expect(row(page, 'MSFT')).toBeVisible();

  await expect
    .poll(() => serverItems(server, listByName(server, 'Tech')?.id ?? ''))
    .toEqual(['AAPL', 'MSFT']);

  await page.reload();
  await openPanel(page);
  await expect(switcher(page)).toContainText('Tech');
  expect(await order(page)).toEqual(['wl-row-AAPL', 'wl-row-MSFT']);

  await listAction(page, 'Rename…');
  await promptName(page, 'Tech stocks');
  await expect.poll(() => listByName(server, 'Tech stocks')?.revision).toBeGreaterThan(1);
  expect(listByName(server, 'Tech')).toBeUndefined();

  await listAction(page, 'Make a copy…');
  await promptName(page, 'Tech copy');
  await expect
    .poll(() => serverItems(server, listByName(server, 'Tech copy')?.id ?? ''))
    .toEqual(['AAPL', 'MSFT']);
  expect(server.watchlists.size).toBe(3);
});

test('add a section, drag MSFT above it, order survives a reload', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT', 'TSLA']);
  await open(page);

  await rightClick(page, 'MSFT');
  await menuItem(page, 'Add section above…').click();
  await promptName(page, 'Growth');
  await expect.poll(() => serverItems(server, 'w1')).toEqual(['AAPL', '#Growth', 'MSFT', 'TSLA']);
  const sectionId = (
    server.watchlists.get('w1')!.items.find((i) => i.type === 'section') as {
      id: string;
    }
  ).id;
  const section = page.getByTestId(`wl-section-${sectionId}`);
  await expect(section).toContainText('Growth');

  // Drop on the upper half of the section row: MSFT lands above it.
  await row(page, 'MSFT').dragTo(section, { targetPosition: { x: 40, y: 2 } });
  await expect.poll(() => serverItems(server, 'w1')).toEqual(['AAPL', 'MSFT', '#Growth', 'TSLA']);

  await page.reload();
  await openPanel(page);
  expect(await order(page)).toEqual([
    'wl-row-AAPL',
    'wl-row-MSFT',
    `wl-section-${sectionId}`,
    'wl-row-TSLA',
  ]);
});

test('sort by Chg% descending and clear; sorted rows are not draggable', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT', 'TSLA']);
  await open(page);
  await expect(row(page, 'TSLA')).toContainText('103');
  await expect(row(page, 'AAPL')).toHaveAttribute('draggable', 'true');

  const header = page.getByTestId('wl-col-changePercent');
  for (let i = 0; i < 3 && (await header.getAttribute('aria-sort')) !== 'descending'; i++)
    await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => order(page)).toEqual(['wl-row-TSLA', 'wl-row-AAPL', 'wl-row-MSFT']);
  await expect(row(page, 'AAPL')).not.toHaveAttribute('draggable', 'true');

  await page.getByTestId('wl-columns-btn').click();
  await menuItem(page, 'Clear sort').click();
  await page.keyboard.press('Escape');
  await expect.poll(() => order(page)).toEqual(['wl-row-AAPL', 'wl-row-MSFT', 'wl-row-TSLA']);
  await expect(row(page, 'AAPL')).toHaveAttribute('draggable', 'true');
  // The sort is a synced setting.
  await expect
    .poll(() => (server.settings.get('watchlist.prefs') as { sort: unknown }).sort)
    .toBeNull();
});

test('Vol and Ext columns; extended tick fills Ext, regular tick flashes Last', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT']);
  await open(page);
  await toggleColumn(page, 'Volume');
  await toggleColumn(page, 'Pre/post-market price');
  await expect(page.getByTestId('wl-col-volume')).toBeVisible();
  await expect(page.getByTestId('wl-col-extPrice')).toBeVisible();

  await expect.poll(() => market.subscribed).toContain('AAPL');
  await expect(page.getByTestId('wl-cell-extPrice-AAPL')).toHaveText(/^\s*(—|-)?\s*$/);

  market.pushTick('AAPL', 190.25, { marketHours: 2 });
  await expect(page.getByTestId('wl-cell-extPrice-AAPL')).toContainText('190.25');
  // The regular price is untouched by a pre-market tick.
  await expect(page.getByTestId('wl-cell-last-AAPL')).toContainText('101');

  market.pushTick('AAPL', 105.5, { marketHours: 1 });
  const last = page.getByTestId('wl-cell-last-AAPL');
  await expect(last).toContainText('105.5');
  await expect(last).toHaveClass(/wl-flash-up/);
  market.pushTick('AAPL', 104.5, { marketHours: 1 });
  await expect(last).toContainText('104.5');
  await expect(last).toHaveClass(/wl-flash-down/);
});

test('flag red via the context menu, see it under Flagged, unflag', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT']);
  await open(page);

  await rightClick(page, 'AAPL');
  await menuItem(page, 'Flag').click();
  await menuItem(page, /^Red/).click();
  await expect.poll(() => server.flags.get('AAPL')?.color).toBe('red');

  await switcher(page).click();
  await menuItem(page, /^Red/).click();
  await expect(switcher(page)).toContainText(/red/i);
  expect(await order(page)).toEqual(['wl-row-AAPL']);

  await rightClick(page, 'AAPL');
  await menuItem(page, 'Flag').click();
  await menuItem(page, 'Remove flag').click();
  await expect.poll(() => server.flags.size).toBe(0);
  await expect(row(page, 'AAPL')).toHaveCount(0);
});

test('move a symbol to another list, remove one', async ({ page, server }) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'a', 'Alpha', ['AAPL', 'MSFT']);
  seed(server, 'b', 'Beta', [], false);
  await open(page);

  await rightClick(page, 'MSFT');
  await menuItem(page, 'Move to list').click();
  await menuItem(page, 'Beta').click();
  await expect.poll(() => serverItems(server, 'b')).toEqual(['MSFT']);
  await expect.poll(() => serverItems(server, 'a')).toEqual(['AAPL']);
  await expect(row(page, 'MSFT')).toHaveCount(0);

  await rightClick(page, 'AAPL');
  await menuItem(page, 'Remove from list').click();
  await expect.poll(() => serverItems(server, 'a')).toEqual([]);
  await expect(row(page, 'AAPL')).toHaveCount(0);
});

test('keyboard: arrows move the selection and change the chart symbol', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT', 'TSLA']);
  await open(page);
  expect(await chartSymbol(page)).toBe('AAPL');

  await page.getByRole('grid').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => chartSymbol(page)).toBe('MSFT');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => chartSymbol(page)).toBe('TSLA');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => chartSymbol(page)).toBe('MSFT');
  await page.keyboard.press('Home');
  await expect.poll(() => chartSymbol(page)).toBe('AAPL');
});

test('.txt import and export round-trip', async ({ page, server }) => {
  await mockMarket(page);
  seed(server, 'w1', 'Main', ['AAPL']);
  await open(page);

  const txt = '###INDICES,SP:SPX,NASDAQ:AAPL,BIST:THYAO,BINANCE:BTCUSDT,CME_MINI:ES1!,FX:EURUSD';
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    listAction(page, 'Import list…'),
  ]);
  await chooser.setFiles({
    name: 'watchlist-export.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(txt),
  });

  await expect.poll(() => server.watchlists.size).toBe(2);
  const imported = [...server.watchlists.values()].find((w) => w.id !== 'w1')!;
  expect(imported.name).toBe('watchlist-export');
  expect(imported.items[0]).toMatchObject({ type: 'section', title: 'INDICES' });
  const symbols = imported.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol as string] : []));
  expect(symbols).toEqual(expect.arrayContaining(['^GSPC', 'AAPL', 'THYAO.IS', 'ES=F']));
  await expect(row(page, 'AAPL')).toBeVisible();
  await expect(page.locator('[data-testid^="wl-section-"]')).toContainText('INDICES');

  const file = await download(page, () => listAction(page, 'Export list (.txt)'));
  expect(file.name).toBe('watchlist-export.txt');
  expect(file.text).toBe(formatTxt(imported.items as Parameters<typeof formatTxt>[0]));
});

test('closed /ws: quotes fall back to polling /api/quotes', async ({ page, server }) => {
  test.setTimeout(90_000);
  const market = await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL', 'MSFT']);
  await open(page);
  await expect.poll(() => market.sockets).toBe(1);
  await expect(row(page, 'AAPL')).toContainText('101');

  market.close();
  await expect.poll(() => market.sockets).toBe(0);
  const before = market.quoteRequests.length;
  // The stream polls every 15 s while its socket is down.
  await expect
    .poll(() => market.quoteRequests.slice(before).some((r) => /AAPL/.test(r)), {
      timeout: 40_000,
      intervals: [1000],
    })
    .toBe(true);
});

test('API down: edits queue and sync later; a stale save offers "Keep mine"', async ({
  page,
  server,
}) => {
  await mockMarket(page, { quotes: QUOTES });
  seed(server, 'w1', 'Main', ['AAPL']);
  await open(page);
  await expect(row(page, 'AAPL')).toBeVisible();

  server.down = true;
  await searchAdd(page, 'MSFT');
  await expect(row(page, 'MSFT')).toBeVisible();
  expect(serverItems(server, 'w1')).toEqual(['AAPL']);

  server.down = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => serverItems(server, 'w1'), { timeout: 20_000 }).toEqual(['AAPL', 'MSFT']);

  // Another device changed the list: our next save is stale (409).
  const w = server.watchlists.get('w1')!;
  Object.assign(w, {
    name: 'Main (other device)',
    items: [{ type: 'symbol', symbol: 'AAPL' }],
    revision: w.revision + 1,
  });
  await searchAdd(page, 'TSLA');
  const toast = page.getByRole('status').filter({ hasText: /changed elsewhere/ });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Keep mine' })).toBeVisible();
  await toast.getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(() => serverItems(server, 'w1')).toEqual(['AAPL', 'MSFT', 'TSLA']);
});
