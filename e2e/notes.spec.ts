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
  MSFT: quote('MSFT', 98, 100),
  TSLA: quote('TSLA', 103, 100),
};

const MSFT_NOTE = 'MSFT thesis: <b>cloud</b> growth\nwatch margins';

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
  server.notes.set('N-msft', {
    id: 'N-msft',
    symbol: 'MSFT',
    text: MSFT_NOTE,
    revision: 1,
    createdAt: t,
    updatedAt: t,
  });
  server.settings.set('watchlist.prefs', {
    columns: ['last', 'change', 'changePercent'],
    sort: null,
  });
  await seedActiveList(page, 'wl-tech');
}

async function openScreen(page: Page) {
  const panel = page.getByRole('tabpanel', { name: 'Watchlist', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="watchlist"]').click();
  await expect(panel).toBeVisible();
  await page.getByTestId('nav-open-watchlists').click();
  await expect(page.getByTestId('wlp-root')).toBeVisible();
}

async function start(page: Page, server: MockServer) {
  await mockMarket(page, { quotes: QUOTES });
  await seed(page, server);
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.getState() != null);
  await openScreen(page);
}

test('note badge opens that symbol note; edits persist; back returns to the chart symbol', async ({
  page,
  server,
}) => {
  await start(page, server);
  const chartSymbol = await page.evaluate(() => window.chart.getState().symbol);
  expect(chartSymbol).toBe('AAPL');

  // Only symbols with a note get the badge; clicking it must not select the row's chart.
  await expect(page.getByTestId('rb-note-AAPL')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open note for MSFT' }).click();

  await expect(page.getByTestId('wlp-root')).toHaveCount(0);
  const panel = page.getByTestId('notes-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('notes-target')).toContainText('Pinned to MSFT');
  const input = page.getByRole('textbox', { name: 'Notes for MSFT' });
  await expect(input).toHaveValue(MSFT_NOTE);
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => window.chart.getState().symbol)).toBe('AAPL');

  // Edit: saved to MSFT's note on the server.
  await input.fill(`${MSFT_NOTE}\nadded`);
  await expect
    .poll(() => server.notes.get('N-msft')?.text, { timeout: 10_000 })
    .toBe(`${MSFT_NOTE}\nadded`);

  // Back to the chart's symbol: its (empty) note, not MSFT's.
  await page.getByTestId('notes-back').click();
  await expect(page.getByTestId('notes-target')).toContainText('Following chart');
  await expect(page.getByTestId('notes-tab-symbol')).toHaveText('AAPL');
  await expect(page.getByRole('textbox', { name: 'Notes for AAPL' })).toHaveValue('');
});

test('detail pane previews the note as text and opens it; Add note pins an empty one', async ({
  page,
  server,
}) => {
  await start(page, server);

  await page.getByTestId('wlp-row-MSFT').click();
  const note = page.getByTestId('wlp-detail').getByTestId('si-note');
  // Plain text, whitespace collapsed; markup is shown, not rendered.
  await expect(note).toHaveText('MSFT thesis: <b>cloud</b> growth watch margins');
  await expect(note.locator('b')).toHaveCount(0);
  await page.getByTestId('wlp-detail').getByRole('button', { name: 'Open note for MSFT' }).click();
  await expect(page.getByRole('textbox', { name: 'Notes for MSFT' })).toHaveValue(MSFT_NOTE);

  // TSLA has no note: "Add note" opens an empty editor for it, and typing creates it.
  await page.getByTestId('notes-back').click();
  await page.locator('[data-panel="watchlist"]').click();
  await page.getByTestId('nav-open-watchlists').click();
  await page.getByTestId('wlp-row-TSLA').click();
  await page.getByTestId('wlp-detail').getByRole('button', { name: 'Add note for TSLA' }).click();
  const input = page.getByRole('textbox', { name: 'Notes for TSLA' });
  await expect(input).toHaveValue('');
  await input.fill('TSLA: deliveries');
  await expect
    .poll(() => [...server.notes.values()].find((n) => n.symbol === 'TSLA')?.text, {
      timeout: 10_000,
    })
    .toBe('TSLA: deliveries');
});
