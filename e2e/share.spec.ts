import type { Browser, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';
import { MockServer, mockPersistence, seedActiveList } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const QUOTES = {
  AAPL: quote('AAPL', 101, 100),
  MSFT: quote('MSFT', 403, 400),
  NVDA: quote('NVDA', 101, 100),
};
const T = new Date(Date.UTC(2026, 0, 1)).toISOString();

async function seedTech(page: Page, server: MockServer) {
  server.watchlists.set('wl-tech', {
    id: 'wl-tech',
    name: 'Tech',
    revision: 1,
    createdAt: T,
    updatedAt: T,
    items: [
      { type: 'section', id: 's-core', title: 'Core' },
      { type: 'symbol', symbol: 'AAPL' },
      { type: 'symbol', symbol: 'BP.L' },
      { type: 'symbol', symbol: 'BTC-USD' },
      { type: 'section', id: 's-chips', title: 'Chips' },
      { type: 'symbol', symbol: 'NVDA' },
    ],
  });
  server.settings.set('watchlist.prefs', { columns: ['last', 'changePercent'], sort: null });
  await seedActiveList(page, 'wl-tech');
}

async function openPanel(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
}

async function boot(page: Page, server: MockServer, opts: Parameters<typeof mockMarket>[1] = {}) {
  await mockMarket(page, { quotes: QUOTES, ...opts });
  await seedTech(page, server);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openPanel(page);
}

/** Another person's TickerGlass: its own browser profile and its own (mock) server. */
async function otherInstance(browser: Browser, opts: Parameters<typeof mockMarket>[1] = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  const page = await context.newPage();
  const server = new MockServer();
  await mockPersistence(page, server);
  const market = await mockMarket(page, { quotes: QUOTES, ...opts });
  return { context, page, server, market };
}

const menuItem = (page: Page, name: string) =>
  page.getByRole('menu').last().getByRole('menuitem', { name, exact: true });

/** Open the share dialog of the active list from the list switcher. */
async function openShare(page: Page) {
  await page.getByTestId('wl-switcher').click();
  await menuItem(page, 'Share…').click();
  await expect(page.getByTestId('share-link')).toHaveValue(/#tg-import=/);
}

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const names = (server: MockServer) => [...server.watchlists.values()].map((w) => w.name);
const link = (payload: unknown) =>
  `/#tg-import=r.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

const SHARED = {
  v: 1,
  type: 'watchlist',
  name: 'Friend list',
  items: ['AAPL', { section: 'Semis' }, 'NVDA', 'MSFT'],
};

test('share a list: copy the link, open it in another instance, preview, import as a new list', async ({
  page,
  server,
  browser,
}) => {
  await boot(page, server);
  await openShare(page);
  await expect(page.getByTestId('share-name')).toHaveText('Tech');
  await expect(page.getByTestId('share-summary')).toHaveText('Symbols: 4 · Sections: 2');
  await expect(page.getByTestId('share-tv-approx')).toBeHidden(); // BP.L and BTC-USD map exactly

  await page.getByTestId('share-copy-link').click();
  const url = await readClipboard(page);
  expect(url).toMatch(/\/#tg-import=z\./);
  expect(url).toBe(await page.getByTestId('share-link').inputValue());
  // Copy symbols
  await page.getByTestId('share-copy-symbols').click();
  expect(await readClipboard(page)).toBe('AAPL, BP.L, BTC-USD, NVDA');

  const other = await otherInstance(browser);
  try {
    await other.page.goto(url);
    await expect(other.page.getByTestId('import-dialog')).toBeVisible();
    await expect(other.page.getByTestId('import-name-preview')).toHaveText('Tech');
    await expect(other.page.getByTestId('import-summary')).toHaveText('Symbols: 4 · Sections: 2');
    await expect(other.page.getByTestId('import-symbols')).toContainText('BTC-USD');
    // Preview only: nothing imported yet.
    expect(names(other.server)).not.toContain('Tech');

    await other.page.getByTestId('import-list-name').fill('Imported tech');
    await other.page.getByTestId('import-confirm').click();
    await expect(other.page.getByTestId('import-dialog')).toBeHidden();
    await expect.poll(() => names(other.server)).toContain('Imported tech');
    const row = [...other.server.watchlists.values()].find((w) => w.name === 'Imported tech')!;
    expect(row.items.map((i) => (i.type === 'section' ? `#${i.title}` : i.symbol))).toEqual([
      '#Core',
      'AAPL',
      'BP.L',
      'BTC-USD',
      '#Chips',
      'NVDA',
    ]);
    // The fragment is gone; reloading does not offer the import again.
    expect(other.page.url()).not.toContain('tg-import');
    await other.page.reload();
    await expect(other.page.getByTestId('import-dialog')).toBeHidden();
  } finally {
    await other.context.close();
  }
});

test('the list tab menu on the watchlists screen shares that list', async ({ page, server }) => {
  await boot(page, server);
  await page.getByTestId('nav-open-watchlists').click();
  await expect(page.getByTestId('wlp-root')).toBeVisible();
  await page.getByTestId('wlp-tab-Tech').click({ button: 'right' });
  await menuItem(page, 'Share…').click();
  await expect(page.getByRole('dialog', { name: 'Share watchlist' })).toBeVisible();
  await expect(page.getByTestId('share-name')).toHaveText('Tech');
});

test('downloads: TradingView .txt with exchange prefixes and sections, and a JSON file that re-imports', async ({
  page,
  server,
}) => {
  await boot(page, server);
  await openShare(page);

  const [tv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-download-tv').click(),
  ]);
  expect(tv.suggestedFilename()).toBe('Tech.txt');
  const tvText = await (await import('node:fs/promises')).readFile((await tv.path())!, 'utf8');
  expect(tvText).toBe('###Core,AAPL,LSE:BP,COINBASE:BTCUSD,###Chips,NVDA');

  const [json] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-download-json').click(),
  ]);
  expect(json.suggestedFilename()).toBe('Tech.json');
  const body = await (await import('node:fs/promises')).readFile((await json.path())!, 'utf8');
  expect(JSON.parse(body)).toEqual({
    v: 1,
    type: 'watchlist',
    name: 'Tech',
    items: [{ section: 'Core' }, 'AAPL', 'BP.L', 'BTC-USD', { section: 'Chips' }, 'NVDA'],
  });

  // Import the file through "Import shared file (.json)…".
  await page.keyboard.press('Escape');
  await page.getByTestId('wl-switcher').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    menuItem(page, 'Import shared file (.json)…').click(),
  ]);
  await chooser.setFiles({
    name: 'tech.json',
    mimeType: 'application/json',
    buffer: Buffer.from(body),
  });
  await expect(page.getByTestId('import-dialog')).toBeVisible();
  // The name is taken: the default is deduped.
  await expect(page.getByTestId('import-list-name')).toHaveValue('Tech (2)');
  await page.getByTestId('import-confirm').click();
  await expect.poll(() => names(server)).toContain('Tech (2)');
});

test('add to an existing list: only the missing symbols, no sections', async ({ page, server }) => {
  await boot(page, server);
  await page.goto(link(SHARED));
  await page.waitForFunction(() => window.chart?.getState() != null);
  await expect(page.getByTestId('import-name-preview')).toHaveText('Friend list');
  await page.getByTestId('import-mode-existing').check();
  await page.getByTestId('import-target').selectOption({ label: 'Tech' });
  await page.getByTestId('import-confirm').click();
  await expect
    .poll(() =>
      server.watchlists.get('wl-tech')!.items.map((i) => (i.type === 'symbol' ? i.symbol : '#')),
    )
    .toEqual(['#', 'AAPL', 'BP.L', 'BTC-USD', '#', 'NVDA', 'MSFT']);
});

test('a broken link explains itself and imports nothing; cancel leaves the data alone', async ({
  page,
  server,
}) => {
  await boot(page, server);
  const before = names(server);

  await page.goto('/#tg-import=z.not-valid!!');
  await expect(page.getByTestId('import-error')).toContainText('damaged');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('import-error')).toBeHidden();
  expect(page.url()).not.toContain('tg-import');

  // A well-formed payload with a bad symbol is refused, not trimmed.
  await page.goto(link({ ...SHARED, items: ['AAPL', '<img src=x>'] }));
  await expect(page.getByTestId('import-error')).toContainText('not valid');
  await page.getByTestId('import-close').click();

  // A good link: cancel.
  await page.goto(link(SHARED));
  await expect(page.getByTestId('import-dialog')).toBeVisible();
  await page.getByTestId('import-cancel').click();
  await expect(page.getByTestId('import-dialog')).toBeHidden();
  expect(page.url()).not.toContain('tg-import');
  expect(names(server)).toEqual(before);
});

test('opening a link in an already open tab (hashchange) shows the preview', async ({
  page,
  server,
}) => {
  await boot(page, server);
  await page.evaluate((h) => {
    location.hash = h;
  }, link(SHARED).slice(2));
  await expect(page.getByTestId('import-name-preview')).toHaveText('Friend list');
});

test('share a screen: copy the link, open it elsewhere, save it as a new screen', async ({
  page,
  server,
  browser,
}) => {
  await boot(page, server, { screener: { mode: 'server' } });
  await page.getByTestId('nav-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
  await page.getByTestId('scr-preset-oversold-large-caps').click();

  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-save-as').click();
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Oversold giants');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-screen-share').click();

  await expect(page.getByRole('dialog', { name: 'Share screen' })).toBeVisible();
  await expect(page.getByTestId('share-name')).toHaveText('Oversold giants');
  await expect(page.getByTestId('share-summary')).toContainText('Rules: 2');
  await expect(page.getByTestId('share-copy-symbols')).toBeHidden();
  await expect(page.getByTestId('share-download-tv')).toBeHidden();
  await page.getByTestId('share-copy-link').click();
  const url = await readClipboard(page);
  expect(url).toMatch(/#tg-import=/);

  const other = await otherInstance(browser);
  try {
    await other.page.goto(url);
    await expect(other.page.getByTestId('import-name-preview')).toHaveText('Oversold giants');
    await expect(other.page.getByTestId('import-summary')).toContainText('Rules: 2');
    expect(other.market.screener.screens.size).toBe(0);
    await other.page.getByTestId('import-confirm').click();
    await expect.poll(() => other.market.screener.screens.size).toBe(1);
    const saved = [...other.market.screener.screens.values()][0] as {
      name: string;
      alert: unknown;
      spec: { universe: unknown; filter: unknown; sort: unknown };
    };
    const original = [...(await serverScreens(page))][0]!;
    expect(saved.name).toBe('Oversold giants');
    expect(saved.alert).toBeNull();
    expect(saved.spec).toMatchObject({
      universe: original.spec.universe,
      filter: original.spec.filter,
      sort: original.spec.sort,
    });
    await expect.poll(() => other.page.url()).not.toContain('tg-import');
  } finally {
    await other.context.close();
  }
});

/** The saved screens of the first page's mock, through the app's own API client. */
async function serverScreens(page: Page) {
  return page.evaluate(async () => {
    const res = await fetch('/api/screener/screens');
    return (await res.json()) as { spec: Record<string, unknown> }[];
  });
}
