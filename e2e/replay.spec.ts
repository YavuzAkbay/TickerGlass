import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

type ReplayStatus = 'off' | 'picking' | 'loading' | 'paused' | 'playing' | 'ended';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
    replay: {
      store: {
        getState(): { status: ReplayStatus; last: number; next: number; tick: string | null };
      };
      feed: import('@investopen/engine').ReplayFeed & {
        getBars: import('@investopen/engine').DataFeed['getBars'];
      };
    };
  }
}

// Synthetic intervals are independent random walks: assert structure, not prices.
const FEED = '/?feed=synthetic-multi';
const BEHIND = 30;

const ready = (page: Page) => page.waitForFunction(() => window.chart?.store.length > 0);
const barCount = (page: Page) => page.evaluate(() => window.chart.store.length);
const lastBarTime = (page: Page) =>
  page.evaluate(() => window.chart.store.time[window.chart.store.length - 1]!);
const state = (page: Page) => page.evaluate(() => window.replay.store.getState());
const status = (page: Page) => page.evaluate(() => window.replay.store.getState().status);

/** Choose how replay advances: 'Auto', 'Bars' or an interval such as '1h'. */
const setUpdate = (page: Page, label: string) =>
  page.getByLabel('Replay update interval').selectOption({ label: `Update: ${label}` });

/** Top bar Replay, then the scissors click on the bar `BEHIND` bars before the newest. */
async function startReplay(page: Page): Promise<{ time: number; length: number }> {
  await page.getByRole('button', { name: 'Bar replay' }).click();
  await expect.poll(() => status(page)).toBe('picking');
  const target = await page.evaluate((behind) => {
    const c = window.chart;
    const i = c.store.length - 1 - behind;
    const r = c.root.getBoundingClientRect();
    return {
      x: r.left + c.timeScale.indexToX(i),
      y: r.top + r.height / 3,
      time: c.store.time[i]!,
      length: i + 1,
    };
  }, BEHIND);
  await page.mouse.move(target.x - 40, target.y);
  await page.mouse.move(target.x, target.y);
  // The scissors cursor is on while picking.
  expect(await page.evaluate(() => window.chart.root.style.cursor)).toContain('svg');
  await page.mouse.click(target.x, target.y);
  await expect.poll(() => status(page)).toBe('paused');
  // The synthetic feed fills `limit` bars up to the cut, so compare against the count now.
  await expect.poll(() => lastBarTime(page)).toBe(target.time);
  return { time: target.time, length: await barCount(page) };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('replay-e2e')) return;
    sessionStorage.setItem('replay-e2e', '1');
    localStorage.clear();
  });
  await page.goto(FEED);
  await ready(page);
});

test('scissors pick starts replay at the clicked bar and hides what follows', async ({ page }) => {
  const fullLast = await lastBarTime(page);
  const picked = await startReplay(page);
  expect(picked.time).toBeLessThan(fullLast);
  expect(await lastBarTime(page)).toBe(picked.time);
  await expect(page.getByRole('toolbar', { name: 'Replay controls' })).toBeVisible();
  await expect(page.getByTestId('replay-time')).not.toBeEmpty();
  // The tool is released after the pick.
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBeNull();
  const s = await state(page);
  expect(await lastBarTime(page)).toBeLessThan(s.next);
});

test('Escape cancels picking', async ({ page }) => {
  await page.getByRole('button', { name: 'Bar replay' }).click();
  await expect.poll(() => status(page)).toBe('picking');
  await page.keyboard.press('Escape');
  await expect.poll(() => status(page)).toBe('off');
  await expect(page.getByRole('toolbar', { name: 'Replay controls' })).toHaveCount(0);
});

test('step reveals the next bar without moving earlier ones', async ({ page }) => {
  const picked = await startReplay(page);
  await setUpdate(page, 'Bars');
  await expect.poll(() => status(page)).toBe('paused');
  await expect.poll(() => barCount(page)).toBe(picked.length);
  const before = await state(page);
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(() => barCount(page)).toBe(picked.length + 1);
  const after = await state(page);
  expect(after.next).toBeGreaterThan(before.next);
  expect(await lastBarTime(page)).toBeLessThan(after.next);
  expect(await lastBarTime(page)).toBeGreaterThan(picked.time);
});

test('intrabar replay adds one forming bar on the first step, then updates it in place', async ({
  page,
}) => {
  const picked = await startReplay(page);
  await expect.poll(() => barCount(page)).toBe(picked.length);
  expect((await state(page)).tick).not.toBeNull();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(() => barCount(page)).toBe(picked.length + 1);
  const t = await lastBarTime(page);
  await page.getByRole('button', { name: 'Step forward' }).click();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(async () => (await state(page)).last).toBeGreaterThan(t);
  expect(await barCount(page)).toBe(picked.length + 1);
  expect(await lastBarTime(page)).toBe(t);
});

test('play advances bar by bar and pause stops it', async ({ page }) => {
  const picked = await startReplay(page);
  await setUpdate(page, 'Bars');
  await page.getByLabel('Replay speed').selectOption({ label: '30 ms' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => status(page)).toBe('playing');
  await expect.poll(() => barCount(page)).toBeGreaterThan(picked.length + 3);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => status(page)).toBe('paused');
  const n = await barCount(page);
  await page.waitForTimeout(300);
  expect(await barCount(page)).toBe(n);
  expect(await lastBarTime(page)).toBeLessThan((await state(page)).next);
});

test('changing the interval during replay keeps the clock and shows nothing beyond it', async ({
  page,
}) => {
  await startReplay(page);
  const before = await state(page);
  await page.locator('.chart-area').click();
  await page.keyboard.type('1W');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.chart.getInterval())).toBe('1W');
  await expect.poll(() => status(page)).toBe('paused');
  const after = await state(page);
  expect(after.next).toBeLessThanOrEqual(before.next);
  await expect.poll(async () => (await lastBarTime(page)) < (await state(page)).next).toBe(true);
  expect(await barCount(page)).toBeGreaterThan(0);
});

test('compare overlays are refetched through the clipped feed', async ({ page }) => {
  await page.getByRole('button', { name: 'Compare or add symbol' }).click();
  const input = page.getByLabel('Search symbols to compare');
  await input.fill('MSFT');
  const row = page.getByRole('option').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^Same % scale:/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmp-legend-row', { hasText: 'MSFT' })).toBeVisible();

  // Record what the shared feed returns for the overlay symbol from now on.
  await page.evaluate(() => {
    const w = window as unknown as { seen: { max: number; next: number }[] };
    w.seen = [];
    const feed = window.replay.feed;
    const orig = feed.getBars.bind(feed);
    feed.getBars = async (req) => {
      const res = await orig(req);
      if (req.symbol === 'MSFT') {
        const t = res.bars.time;
        const s = window.replay.store.getState();
        w.seen.push({ max: t.length ? t[t.length - 1]! : -Infinity, next: s.next });
      }
      return res;
    };
  });
  await startReplay(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { seen: unknown[] }).seen.length))
    .toBeGreaterThan(0);
  const seen = await page.evaluate(
    () => (window as unknown as { seen: { max: number; next: number }[] }).seen,
  );
  for (const s of seen) expect(s.max).toBeLessThan(s.next);
  // The overlay study is still on the chart.
  expect(await page.evaluate(() => window.chart.getStudies().some((s) => s.title === 'MSFT'))).toBe(
    true,
  );
});

test('an indicator follows the replay step by step', async ({ page }) => {
  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Moving Average Simple');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  const sma = page.locator('.ind-legend-row', { hasText: 'SMA' });
  await expect(sma.locator('.ind-legend-value').first()).toHaveText(/\d/);

  const picked = await startReplay(page);
  await setUpdate(page, 'Bars');
  await expect.poll(() => barCount(page)).toBe(picked.length);
  const id = await page.evaluate(
    () => window.chart.getStudies().find((s) => s.title.startsWith('SMA'))!.id,
  );
  const valueAt = (index: number) =>
    page.evaluate(
      ([sid, i]) => window.chart.getStudyValues(sid as string, i as number).map((v) => v.text),
      [id, index] as const,
    );
  // Nothing exists for the bar before it is revealed.
  expect((await valueAt(picked.length)).join('')).not.toMatch(/\d/);
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(() => barCount(page)).toBe(picked.length + 1);
  await expect.poll(async () => (await valueAt(picked.length)).join('')).toMatch(/\d/);
});

test('jump to realtime restores the full history and live data', async ({ page }) => {
  const full = await barCount(page);
  const fullLast = await lastBarTime(page);
  await startReplay(page);
  expect(await lastBarTime(page)).toBeLessThan(fullLast);
  await page.getByRole('button', { name: 'Jump to realtime' }).click();
  await expect.poll(() => status(page)).toBe('off');
  await expect.poll(() => barCount(page)).toBe(full);
  expect(await lastBarTime(page)).toBe(fullLast);
  expect(await page.evaluate(() => window.replay.feed.mode)).toBe('live');
  await expect(page.getByRole('toolbar', { name: 'Replay controls' })).toHaveCount(0);
});

test('exit leaves replay; Shift+Alt+R toggles it', async ({ page }) => {
  const fullLast = await lastBarTime(page);
  await startReplay(page);
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await expect.poll(() => status(page)).toBe('off');
  await expect.poll(() => lastBarTime(page)).toBe(fullLast);

  // The chart has focus: the engine must not swallow the shortcut.
  await page.locator('.chart-area').click();
  await page.keyboard.press('Shift+Alt+KeyR');
  await expect.poll(() => status(page)).toBe('picking');
  await page.keyboard.press('Shift+Alt+KeyR');
  await expect.poll(() => status(page)).toBe('off');
});

test('a price alert fires locally during replay: toast and replay marker, cleared on exit', async ({
  page,
  server,
}) => {
  const symbol = await page.evaluate(() => window.chart.getState().symbol);
  const t = new Date(Date.UTC(2026, 0, 1)).toISOString();
  server.alerts.set('replay-alert', {
    id: 'replay-alert',
    name: 'Replay probe',
    symbol,
    interval: '1D',
    prepost: false,
    spec: {
      schemaVersion: 1,
      left: { kind: 'price', field: 'close' },
      // Always true once the replay takes a step: a state condition keeps the test independent of prices.
      condition: { op: 'greater', right: { kind: 'value', value: -1_000_000 } },
      trigger: 'once',
    },
    notify: { toast: true, sound: false, browser: false },
    message: '',
    expiresAt: null,
    drawingId: null,
    status: 'active',
    statusReason: null,
    revision: 1,
    fireCount: 0,
    lastFiredAt: null,
    createdAt: t,
    updatedAt: t,
  });
  await page.reload();
  await ready(page);
  const groups = () =>
    page.evaluate(
      () =>
        (
          window.chart as unknown as { markerGroups: Map<string, { id: string }[]> }
        ).markerGroups.get('replay-alerts')?.length ?? 0,
    );

  const picked = await startReplay(page);
  await setUpdate(page, 'Bars');
  await expect.poll(() => status(page)).toBe('paused');
  expect(await groups()).toBe(0); // priming never fires
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(() => barCount(page)).toBe(picked.length + 1);
  await expect(page.getByText('Replay: Replay probe')).toBeVisible();
  await expect.poll(groups).toBe(1);
  // 'once': more steps add nothing.
  await page.getByRole('button', { name: 'Step forward' }).click();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect.poll(() => barCount(page)).toBe(picked.length + 3);
  expect(await groups()).toBe(1);
  // Nothing was sent to the server: replay alerts are local.
  expect(server.alertLog).toHaveLength(0);

  await page.getByRole('button', { name: 'Exit replay' }).click();
  await expect.poll(() => status(page)).toBe('off');
  expect(await groups()).toBe(0);
});
