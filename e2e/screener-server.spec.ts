import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, quote } from './market';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const QUOTES = {
  NVDA: quote('NVDA', 101, 100),
  MSFT: quote('MSFT', 403, 400),
  AAPL: quote('AAPL', 198, 200),
  TSLA: quote('TSLA', 260, 250),
};

async function openScreen(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
  await page.getByTestId('nav-open-screener').click();
  await expect(page.getByTestId('scr-root')).toBeVisible();
}

async function boot(
  page: Page,
  screener: Parameters<typeof mockMarket>[1] extends infer O ? O : never,
) {
  const market = await mockMarket(page, { quotes: QUOTES, ...screener });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);
  return market;
}

const symbols = (page: Page) => page.locator('.scr-body .scr-sym-text');
const lastScan = (m: Awaited<ReturnType<typeof mockMarket>>) =>
  m.screener.scanRequests[m.screener.scanRequests.length - 1];

test('server mode: banner, rows from the scan, live quotes only for the visible page', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });

  await expect(page.getByTestId('scr-root')).toHaveAttribute('data-mode', 'server');
  await expect(page.getByTestId('scr-banner')).toHaveAttribute('data-kind', 'ready');
  await expect(page.getByTestId('scr-banner-text')).toContainText('Data as of 2026-11-05 (3h ago)');
  await expect(page.getByTestId('scr-asof')).toHaveText('2026-11-05');

  // The scan is the single source of rows (fixture order: default sort on a field the rows lack).
  await expect(symbols(page)).toHaveText(['NVDA', 'MSFT', 'AAPL', 'TSLA']);
  expect(m.screener.scanRequests[0]).toMatchObject({
    universe: { kind: 'class', cls: 'stocks' },
    filter: null,
    sort: { field: 'avgDollarVol30', dir: 'desc' },
    limit: 20,
    offset: 0,
  });
  await expect(page.getByTestId('scr-universe-info')).toContainText('4 matches of 4');
  // Snapshot fields render: RSI 28.0 and market cap $3.0T for NVDA, live last overlays the snapshot.
  await expect(page.getByTestId('scr-row-NVDA')).toContainText('28.0');
  await expect(page.getByTestId('scr-row-NVDA')).toContainText('$3.0T');
  await expect(page.getByTestId('scr-cell-last-NVDA')).toHaveText('101.00');

  // Quotes are subscribed for the four visible rows only, not the universe.
  await expect.poll(() => new Set(m.subscribed).size).toBe(4);
  expect([...new Set(m.subscribed)].sort()).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA']);

  // Sorting goes to the server.
  await page.getByTestId('scr-col-rsi14').click();
  await expect.poll(() => lastScan(m)?.sort).toEqual({ field: 'rsi14', dir: 'desc' });
  await expect(symbols(page)).toHaveText(['TSLA', 'AAPL', 'NVDA', 'MSFT']);
  await page.getByTestId('scr-col-rsi14').click();
  await expect(symbols(page)).toHaveText(['MSFT', 'NVDA', 'AAPL', 'TSLA']);
});

test('rule builder: an RSI < 30 rule becomes the contract filter of the next scan', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await expect(symbols(page)).toHaveCount(4);
  const before = m.screener.scanRequests.length;

  await page.getByTestId('scr-rules-btn').click();
  await page.getByTestId('rb-add-rule').first().click();
  // The new rule starts on RSI(14) with the first operator and no value: no scan yet.
  await expect(page.getByTestId('rb-field')).toHaveValue('rsi14');
  await expect(page.getByTestId('rb-rule')).toContainText('Enter a value');
  expect(m.screener.scanRequests.length).toBe(before);

  await page.getByTestId('rb-op').selectOption('<');
  await page.getByTestId('rb-value').fill('30');

  await expect
    .poll(() => lastScan(m)?.filter)
    .toEqual({ op: 'and', rules: [{ field: 'rsi14', op: '<', value: 30 }] });
  expect(lastScan(m)).toMatchObject({
    universe: { kind: 'class', cls: 'stocks' },
    limit: 20,
    offset: 0,
  });
  await expect(symbols(page)).toHaveText(['NVDA', 'MSFT']);
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('RSI(14) < 30');
  await expect(page.getByTestId('scr-universe-info')).toContainText('2 matches');

  // A second rule with money shorthand; rules combine with AND.
  await page.getByTestId('rb-add-rule').first().click();
  const rules = page.getByTestId('rb-rule');
  await rules.nth(1).getByTestId('rb-field').selectOption('mcap');
  await rules.nth(1).getByTestId('rb-value').fill('10B');
  await expect
    .poll(() => lastScan(m)?.filter)
    .toEqual({
      op: 'and',
      rules: [
        { field: 'rsi14', op: '<', value: 30 },
        { field: 'mcap', op: '>', value: 1e10 },
      ],
    });
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('RSI(14) < 30 AND Mkt cap > $10B');

  // OR flips the group op; removing a rule is keyboard reachable.
  await page.getByTestId('rb-op-or').first().click();
  await expect.poll(() => (lastScan(m)?.filter as { op: string }).op).toBe('or');
  await rules.nth(1).getByTestId('rb-remove').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rb-rule')).toHaveCount(1);

  // The rules survive a reload (prefs draft).
  await page.reload();
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('RSI(14) < 30');
});

test('rule builder: unavailable fields are not offered and invalid input blocks the scan', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await page.getByTestId('scr-rules-btn').click();
  await page.getByTestId('rb-add-rule').first().click();
  const options = await page.getByTestId('rb-field').locator('option').allTextContents();
  expect(options).toContain('RSI(14)');
  expect(options).not.toContain('P/E'); // available: false
  await expect(page.getByTestId('rb-hidden')).toContainText('1 fields unavailable');

  const before = m.screener.scanRequests.length;
  await page.getByTestId('rb-op').selectOption('between');
  await page.getByTestId('rb-value-lo').fill('70');
  await page.getByTestId('rb-value-hi').fill('30');
  await expect(page.getByRole('alert').filter({ hasText: 'Enter a valid value' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(m.screener.scanRequests.length).toBe(before);
  await page.getByTestId('rb-value-lo').fill('30');
  await page.getByTestId('rb-value-hi').fill('70');
  await expect
    .poll(() => lastScan(m)?.filter)
    .toEqual({ op: 'and', rules: [{ field: 'rsi14', op: 'between', value: [30, 70] }] });
});

test('saving a screen persists the draft and marks it active; built-in presets apply', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await page.getByTestId('scr-preset-oversold-large-caps').click();
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('RSI(14) < 30 AND Mkt cap > $10B');
  await expect(symbols(page)).toHaveText(['MSFT', 'NVDA']); // sorted by rsi14 ascending

  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-save-as').click();
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Oversold giants');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => m.screener.screens.size).toBe(1);
  const saved = [...m.screener.screens.values()][0]!;
  expect(saved).toMatchObject({
    name: 'Oversold giants',
    revision: 1,
    alert: null,
    spec: {
      schemaVersion: 1,
      universe: { kind: 'class', cls: 'stocks' },
      sort: { field: 'rsi14', dir: 'asc' },
      filter: {
        op: 'and',
        rules: [
          { field: 'rsi14', op: '<', value: 30 },
          { field: 'mcap', op: '>', value: 1e10 },
        ],
      },
    },
  });
  await expect(page.getByTestId('scr-screens-btn')).toContainText('Oversold giants');

  // Clearing the rules and loading the screen restores them.
  await page.getByTestId('rb-remove').first().click();
  await page.getByTestId('rb-remove').first().click();
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('No rules');
  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-screen-load').click();
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('RSI(14) < 30 AND Mkt cap > $10B');

  // The alert toggle saves with revision and the default channel.
  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-screen-alert').click();
  await expect
    .poll(() => (m.screener.screens.values().next().value as { revision: number }).revision)
    .toBe(2);
  expect([...m.screener.screens.values()][0]!.alert).toEqual({
    enabled: true,
    notify: { webhook: true, telegram: false, email: false },
  });
  await page.getByTestId('scr-alert-telegram').click();
  await expect
    .poll(
      () =>
        ([...m.screener.screens.values()][0]!.alert as { notify: { telegram: boolean } }).notify
          .telegram,
    )
    .toBe(true);
});

test('a slow screens list that predates a save does not wipe the new screen', async ({ page }) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  // Every list request answers with the screens as of when it was issued, 1.5 s late.
  await page.route(
    (url) => url.pathname === '/api/screener/screens',
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const json = [...m.screener.screens.values()];
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill({ json }).catch(() => undefined);
    },
  );
  await page.getByTestId('scr-screens-btn').click();
  await page.getByTestId('scr-save-as').click();
  await page.getByRole('textbox', { name: 'Screen name' }).fill('Late list');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => m.screener.screens.size).toBe(1);
  await expect(page.getByTestId('scr-screens-btn')).toContainText('Late list');
  // The stale (empty) answers have all landed by now; the saved screen must survive them.
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('scr-screens-btn')).toContainText('Late list');
});

test('universe picker: lists and pasted symbols go to the server', async ({ page }) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await page.getByTestId('scr-universe-btn').click();
  await page.getByRole('menuitem', { name: /S&P 500/ }).click();
  await expect.poll(() => lastScan(m)?.universe).toEqual({ kind: 'list', id: 'sp500' });
  await expect(page.getByTestId('scr-tab-stocks')).toHaveAttribute('aria-selected', 'false');

  await page.getByTestId('scr-universe-btn').click();
  await page.getByRole('menuitem', { name: 'Symbols…' }).click();
  await page.getByTestId('scr-symbols-text').fill('nvda, msft\naapl');
  await page.getByTestId('scr-symbols-apply').click();
  await expect
    .poll(() => lastScan(m)?.universe)
    .toEqual({ kind: 'symbols', symbols: ['NVDA', 'MSFT', 'AAPL'] });

  await page.getByTestId('scr-tab-crypto').click();
  await expect.poll(() => lastScan(m)?.universe).toEqual({ kind: 'class', cls: 'crypto' });
});

test('first run: the banner explains and the live-only screener runs meanwhile', async ({
  page,
}) => {
  await boot(page, { screener: { mode: 'first_run' } });

  await expect(page.getByTestId('scr-banner')).toHaveAttribute('data-kind', 'first_run');
  await expect(page.getByTestId('scr-banner-text')).toContainText('Building first snapshot… 2/4');
  await expect(page.getByTestId('scr-banner-fallback')).toContainText('live-only screener');
  await expect(page.getByTestId('scr-refresh')).toBeDisabled();

  // Client mode: the API's class universe in rank order, no server scan.
  await expect(page.getByTestId('scr-root')).not.toHaveAttribute('data-mode', 'server');
  await expect(symbols(page).first()).toHaveText('NVDA');
  await expect(page.getByTestId('scr-rules-btn')).toHaveCount(0);
});

test('Refresh now starts a run; a run already in progress is reported', async ({ page }) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await page.getByTestId('scr-refresh').click();
  await expect.poll(() => m.screener.runRequests).toEqual([{ kind: 'snapshot' }]);
  await expect(page.getByText('Snapshot refresh started')).toBeVisible();

  // A run started elsewhere that the page has not polled yet: the 409 is reported and the
  // status is re-read, so the banner shows progress and the button is disabled.
  m.screener.setStatus({
    running: {
      runId: 2,
      kind: 'snapshot',
      done: 1,
      total: 4,
      startedAt: new Date().toISOString(),
      etaS: 30,
    },
  });
  await page.getByTestId('scr-refresh').click();
  await expect(page.getByText('A snapshot run is already in progress')).toBeVisible();
  await expect(page.getByTestId('scr-banner-run')).toContainText('Updating 1/4');
  await expect(page.getByTestId('scr-refresh')).toBeDisabled();
});

test('the server screener off: the live-only page needs no scan endpoint', async ({ page }) => {
  const m = await boot(page, {});
  await expect(page.getByTestId('scr-banner')).toHaveAttribute('data-kind', 'disabled');
  await expect(symbols(page).first()).toHaveText('NVDA');
  expect(m.screener.scanRequests).toEqual([]);
});

test('server mode exports every page of the scan as CSV', async ({ page }) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  const before = m.screener.scanRequests.length;
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('scr-more').click(),
    page.getByRole('menuitem', { name: 'Export view (CSV)' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^Screener-stocks_\d{4}-\d{2}-\d{2}\.csv$/);
  // One extra page request at the server's maximum page size, from offset 0.
  expect(m.screener.scanRequests[before]).toMatchObject({ limit: 500, offset: 0 });
  const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  expect(lines[0]).toMatch(
    /^Symbol,Name,Last,Change %,Volume,Rel Volume,Perf 1M %,RSI \(14\),Market Cap \(USD\)$/,
  );
  expect(lines).toHaveLength(5);
  expect(lines[1]).toContain('NVDA,NVIDIA,100,1,2000000,1.2,4.5,28,3000000000000');
});

test('rule builder: a formula rule validates as typed and becomes a formula filter', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await expect(symbols(page)).toHaveCount(4);
  await page.getByTestId('scr-rules-btn').click();
  const before = m.screener.scanRequests.length;
  await page.getByTestId('rb-add-formula').first().click();
  const box = page.getByTestId('rb-formula');
  await expect(box).toBeVisible();

  // Autocomplete: field ids and functions for the word at the caret.
  await box.fill('last / sm');
  const list = page.getByTestId('rb-formula-suggestions');
  await expect(list.getByRole('option').first()).toContainText('sma200');
  await box.press('Enter');
  await expect(box).toHaveValue('last / sma200');

  // An unknown field is flagged client-side at its offset; nothing is sent.
  await box.fill('last / nope');
  await expect(page.getByTestId('rb-formula-error')).toContainText('Unknown field “nope”');
  await expect(page.getByTestId('rb-formula-error')).toContainText('character 8');
  await page.getByTestId('rb-value').fill('1');
  await page.waitForTimeout(500);
  expect(m.screener.scanRequests.length).toBe(before);

  await box.fill('last / sma200 - 1');
  await expect(page.getByTestId('rb-formula-error')).toHaveCount(0);
  await page.getByTestId('rb-op').selectOption('<');
  await page.getByTestId('rb-value').fill('0.05');
  await expect
    .poll(() => lastScan(m)?.filter)
    .toEqual({ op: 'and', rules: [{ formula: 'last / sma200 - 1', op: '<', value: 0.05 }] });
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('{last / sma200 - 1} < 0.05');

  // The formula survives a reload (prefs draft).
  await page.reload();
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);
  await expect(page.getByTestId('scr-rule-summary')).toHaveText('{last / sma200 - 1} < 0.05');
});

test('formula columns: added from the column menu, requested, exported, removable', async ({
  page,
}) => {
  const m = await boot(page, { screener: { mode: 'server' } });
  await expect(symbols(page)).toHaveCount(4);
  const openColumns = async () => {
    await page.getByTestId('scr-options-btn').click();
    await page.getByRole('menuitem', { name: 'Columns' }).click();
  };
  await openColumns();
  await page.getByRole('menuitem', { name: 'Add formula column…' }).click();
  await page.getByTestId('fx-col-name').fill('Dist 200');
  const box = page.getByRole('dialog').getByTestId('rb-formula');
  await box.fill('last / nope');
  await expect(page.getByTestId('rb-formula-error')).toContainText('Unknown field “nope”');
  await expect(page.getByTestId('fx-col-add')).toBeDisabled();
  await box.fill('last / sma200');
  await page.getByTestId('fx-col-add').click();

  await expect
    .poll(() => (lastScan(m)?.fields as string[] | undefined) ?? [])
    .toContain('=last / sma200');
  const header = page.getByRole('columnheader', { name: 'Dist 200' });
  await expect(header).toBeVisible();
  // Not sortable: the server sorts by field ids only.
  await expect(header).not.toHaveAttribute('aria-sort');

  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('scr-more').click(),
    page.getByRole('menuitem', { name: 'Export view (CSV)' }).click(),
  ]);
  const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
  expect(text.replace(/^\uFEFF/, '').split('\n')[0]).toMatch(/,Dist 200$/);

  // Survives a reload; selecting it in the column menu removes it.
  await page.reload();
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);
  await expect(page.getByRole('columnheader', { name: 'Dist 200' })).toBeVisible();
  await openColumns();
  await page.getByRole('menuitem', { name: 'Dist 200' }).click();
  await expect(page.getByRole('columnheader', { name: 'Dist 200' })).toHaveCount(0);
});
