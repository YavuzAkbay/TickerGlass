import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockMarket, type MockMarket } from './market';
import type { MockServer } from './persistence';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
    __notifications: { title: string; options: { body?: string; tag?: string } }[];
    __sounds: number;
  }
}

const FEED = '/?feed=synthetic';

/**
 * Stubs before the app loads: a `Notification` that records its calls (permission
 * granted) and an `AudioContext` that counts the oscillators started (one per note).
 */
async function stubBrowser(page: Page) {
  await page.addInitScript(() => {
    window.__notifications = [];
    window.__sounds = 0;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      onclick: (() => void) | null = null;
      constructor(title: string, options: { body?: string; tag?: string } = {}) {
        window.__notifications.push({ title, options });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
      linearRampToValueAtTime() {},
    });
    class FakeAudio {
      currentTime = 0;
      state = 'running';
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createOscillator() {
        return {
          type: 'sine',
          frequency: param(),
          connect() {},
          start() {
            window.__sounds++;
          },
          stop() {},
        };
      }
      createGain() {
        return { gain: param(), connect() {} };
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: FakeAudio, configurable: true });
  });
}

async function open(page: Page) {
  await page.goto(FEED);
  await page.waitForFunction(() => window.chart?.store.length > 0);
}

async function openPanel(page: Page) {
  const panel = page.getByRole('region', { name: 'Alerts', exact: true });
  if (!(await panel.isVisible())) await page.locator('[data-panel="alerts"]').click();
  await expect(panel).toBeVisible();
  return panel;
}

const dialog = (page: Page) => page.getByRole('dialog').filter({ hasText: /alert/i }).last();
const saveDialog = async (page: Page) => {
  const dlg = dialog(page);
  await dlg.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dlg).toHaveCount(0);
};
const alertRow = (page: Page, name: string | RegExp) =>
  page.locator('.al-row').filter({
    has: page.locator('.al-name', {
      hasText: typeof name === 'string' ? new RegExp(`^${name}$`) : name,
    }),
  });
const lastClose = (page: Page) =>
  page.evaluate(() => {
    const s = window.chart.store;
    return s.close[s.length - 1]!;
  });
const chartSymbol = (page: Page) => page.evaluate(() => window.chart.getState().symbol);

/** The alert the mock holds, asserting there is exactly one. */
function only(server: MockServer) {
  expect(server.alerts.size).toBe(1);
  return [...server.alerts.values()][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Put an alert on the mock before the page loads. */
function seed(server: MockServer, id: string, name: string, over: Record<string, unknown> = {}) {
  const t = new Date(Date.UTC(2026, 0, 1, 0, 0, server.alerts.size)).toISOString();
  server.alerts.set(id, {
    id,
    name,
    symbol: 'AAPL',
    interval: '1D',
    prepost: false,
    spec: {
      schemaVersion: 1,
      left: { kind: 'price', field: 'close' },
      condition: { op: 'crossing', right: { kind: 'value', value: 200 } },
      trigger: 'once',
    },
    notify: { toast: true, sound: true, browser: true },
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
    ...over,
  });
}

/** Log a fire on the mock server (as the real API would) and push `alert.fired` to the page. */
function fire(
  server: MockServer,
  market: MockMarket,
  alertId: string,
  over: { message?: string; symbol?: string; barTime?: number } = {},
) {
  const alert = server.alerts.get(alertId)!;
  const id = (server.alertLog.at(-1)?.id ?? 0) + 1;
  const entry = {
    id,
    alertId,
    alertName: alert.name,
    symbol: over.symbol ?? alert.symbol,
    interval: alert.interval,
    firedAt: new Date().toISOString(),
    barTime: over.barTime ?? Math.floor(Date.now() / 1000) - 3600,
    message: over.message ?? `${alert.name} fired`,
    values: { x: 150 },
    delayed: false,
    final: false,
    read: false,
    deliveries: [],
  };
  server.alertLog.push(entry);
  alert.fireCount = (alert.fireCount as number) + 1;
  alert.lastFiredAt = entry.firedAt;
  market.pushAlertFired(entry, {
    id: alertId,
    status: alert.status,
    revision: alert.revision,
    fireCount: alert.fireCount,
    lastFiredAt: alert.lastFiredAt,
  });
  return entry;
}

const markers = (page: Page) =>
  page.evaluate(
    () =>
      // Test-only peek at the engine's marker groups.
      (window.chart as unknown as { markerGroups: Map<string, { id: string }[]> }).markerGroups
        .get('alerts')
        ?.map((m) => m.id) ?? [],
  );

test('create from the top bar: dialog -> POST -> row in the panel', async ({ page, server }) => {
  await mockMarket(page);
  await open(page);
  const last = await lastClose(page);

  await page.getByRole('button', { name: 'Create alert', exact: true }).first().click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Symbol', { exact: true })).toHaveValue(await chartSymbol(page));
  await saveDialog(page);

  const a = only(server);
  expect(a.symbol).toBe(await chartSymbol(page));
  expect(a.spec.left).toEqual({ kind: 'price', field: 'close' });
  expect(a.spec.condition.op).toBe('crossing');
  expect(a.spec.condition.right.kind).toBe('value');
  expect(a.spec.condition.right.value).toBeCloseTo(last, 0);
  expect(a.spec.trigger).toBe('once');
  expect(server.log).toContain('POST /alerts');

  const panel = await openPanel(page);
  await expect(panel.locator('.al-row')).toHaveCount(1);
  await expect(panel.locator('.al-row').first()).toContainText(a.name);
});

test('price-axis "+" prefills the hovered price', async ({ page, server }) => {
  await mockMarket(page);
  await open(page);
  const { x, y } = await page.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    // The "+" is the first 18 px of the price label, at the left edge of the axis.
    return { x: r.left + window.chart.paneWidth + 10, y: r.top + 140 };
  });
  await page.mouse.move(x + 20, y);
  await page.mouse.move(x, y, { steps: 3 });
  const price = await page.evaluate((yy) => {
    const ch = window.chart as unknown as {
      panes: { top: number; priceScale: { yToPrice(y: number): number } }[];
    };
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    const p = ch.panes[0]!;
    return p.priceScale.yToPrice(yy - r.top - p.top);
  }, y);
  await page.mouse.click(x, y);
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  const value = Number(await dlg.getByLabel('Target', { exact: true }).inputValue());
  expect(Math.abs(value - price)).toBeLessThan(Math.abs(price) * 0.005);
  // Not the plain default (the last price).
  expect(Math.abs(value - (await lastClose(page)))).toBeGreaterThan(Math.abs(price) * 0.005);
  await saveDialog(page);
  expect(only(server).spec.condition.right.value).toBeCloseTo(value, 2);
});

test('trend line menu: "Add alert…" flushes the drawing and stores a drawing operand', async ({
  page,
  server,
}) => {
  await mockMarket(page);
  await open(page);
  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  await page.mouse.click(500, 300);
  await page.mouse.click(800, 420);
  await expect.poll(() => page.evaluate(() => window.chart.getDrawings().length)).toBe(1);
  const drawingId = await page.evaluate(() => window.chart.getDrawings()[0]!.id);

  await page.mouse.click(650, 360, { button: 'right' });
  await page
    .getByRole('menu')
    .last()
    .getByRole('menuitem', { name: /Add alert/ })
    .click();
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await saveDialog(page);

  const a = only(server);
  expect(a.spec.condition.op).toBe('crossing');
  expect(a.spec.condition.right).toMatchObject({
    kind: 'drawing',
    drawingId,
    part: 'line',
    scale: expect.any(String),
  });
  expect(a.drawingId).toBe(drawingId);
  // The drawing reached the server before the alert did.
  const posts = server.log.filter((l) => /^(POST|PUT) \/(drawings|alerts)/.test(l));
  const batch = posts.findIndex((l) => l.startsWith('POST /drawings/batch'));
  const create = posts.findIndex((l) => l === 'POST /alerts');
  expect(batch).toBeGreaterThanOrEqual(0);
  expect(batch).toBeLessThan(create);
});

test('watchlist row menu: "Add alert…" uses the row symbol', async ({ page, server }) => {
  await mockMarket(page);
  server.watchlists.set('wl1', {
    id: 'wl1',
    name: 'Main',
    revision: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    items: [
      { type: 'symbol', symbol: 'MSFT' },
      { type: 'symbol', symbol: 'NVDA' },
    ],
  });
  server.settings.set('watchlist.prefs', {
    activeId: 'wl1',
    columns: ['last', 'change', 'changePercent'],
    sort: null,
  });
  await open(page);
  await page.locator('[data-panel="watchlist"]').click();
  await page.getByTestId('wl-row-NVDA').click({ button: 'right' });
  await page
    .getByRole('menu')
    .last()
    .getByRole('menuitem', { name: /Add alert/ })
    .click();
  const dlg = dialog(page);
  await expect(dlg.getByLabel('Symbol', { exact: true })).toHaveValue('NVDA');
  await saveDialog(page);
  expect(only(server).symbol).toBe('NVDA');
});

test('panel: pause, resume, clone, edit with a conflict, delete', async ({ page, server }) => {
  await mockMarket(page);
  seed(server, 'a1', 'Apple 200');
  await open(page);
  await openPanel(page);
  const row = alertRow(page, 'Apple 200');
  await expect(row).toHaveCount(1);
  const menu = async (name: string) => {
    await alertRow(page, 'Apple 200')
      .first()
      .getByRole('button', { name: /^Actions for/ })
      .click();
    await page.getByRole('menu').last().getByRole('menuitem', { name }).click();
  };

  await menu('Pause');
  await expect.poll(() => server.alerts.get('a1')!.status).toBe('paused');
  await expect(row.locator('.al-dot')).toHaveAttribute('aria-label', 'paused');
  await menu('Resume');
  await expect.poll(() => server.alerts.get('a1')!.status).toBe('active');
  expect(server.log.filter((l) => l === 'PATCH /alerts/a1')).toHaveLength(2);

  // Clone: the dialog opens prefilled, saving creates a second alert with a new id.
  await menu('Clone');
  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await saveDialog(page);
  expect(server.alerts.size).toBe(2);
  const clone = [...server.alerts.values()].find((a) => a.id !== 'a1')!;
  expect(clone.spec).toEqual(server.alerts.get('a1')!.spec);

  // Edit while someone else changed the alert: 409 -> "Keep mine".
  await menu('Edit…');
  await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  const other = server.alerts.get('a1')!;
  other.revision = 5; // changed elsewhere
  other.name = 'Renamed elsewhere';
  await dialog(page).getByRole('tab', { name: 'Message' }).click();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /changed elsewhere|conflict/i }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(() => server.log.filter((l) => l === 'PUT /alerts/a1').length).toBe(2);
  expect(server.alerts.get('a1')!.revision).toBe(6);

  // Delete (confirm).
  await alertRow(page, /^Apple 200 \(copy\)$/)
    .first()
    .getByRole('button', { name: /^Actions for/ })
    .click();
  await page.getByRole('menu').last().getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => server.alerts.has(clone.id as string)).toBe(false);
  expect(server.alerts.size).toBe(1);
});

test('fired alert: toast, sound, marker, log entry and unread badge; persists across reload', async ({
  page,
  server,
}) => {
  await stubBrowser(page);
  const market = await mockMarket(page);
  seed(server, 'a1', 'Apple 200', { symbol: '' });
  await open(page);
  const symbol = await chartSymbol(page);
  server.alerts.get('a1')!.symbol = symbol;
  await page.reload();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect.poll(() => market.eventTopics.flat()).toContain('alerts');
  // The chart's last bar open time, so the marker lands on a drawn bar.
  const barTime = await page.evaluate(() => {
    const s = window.chart.store;
    return s.time[s.length - 2]!;
  });

  fire(server, market, 'a1', { message: 'Apple crossed 200', barTime });

  await expect(page.locator('.io-toast').filter({ hasText: 'Apple crossed 200' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sounds)).toBeGreaterThan(0);
  await expect.poll(() => markers(page)).toEqual(['1']);
  // Tab is visible: no browser notification.
  expect(await page.evaluate(() => window.__notifications.length)).toBe(0);
  const badge = page.locator('[data-panel="alerts"]').locator('.rs-badge');
  await expect(badge).toHaveText('1');

  // Log tab: the entry, unread; it is marked read once seen.
  const panel = await openPanel(page);
  await panel.getByRole('tab', { name: /^Log/ }).click();
  const entry = panel.locator('.al-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('Apple crossed 200');
  await expect.poll(() => server.alertLog[0]!.read).toBe(true);
  await expect(badge).toHaveCount(0);

  // A second fire while the tab is hidden raises a browser notification with a tag.
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }),
  );
  fire(server, market, 'a1', { message: 'Apple again', barTime });
  await expect.poll(() => page.evaluate(() => window.__notifications.length)).toBe(1);
  expect(await page.evaluate(() => window.__notifications[0])).toMatchObject({
    title: 'Apple 200',
    options: { body: 'Apple again', tag: 'alert-2' },
  });
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }),
  );

  // Reload: alerts and the log come back from the API; the markers are rebuilt.
  await page.reload();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect.poll(() => markers(page)).toEqual(['2', '1']);
  const panel2 = await openPanel(page);
  await expect(panel2.locator('.al-row')).toHaveCount(1);
  await expect(panel2.locator('.al-row')).toContainText('fired 2×');
  await panel2.getByRole('tab', { name: /^Log/ }).click();
  await expect(panel2.locator('.al-entry')).toHaveCount(2);
});

test('banner when the alerts service is offline', async ({ page, server }) => {
  await mockMarket(page);
  server.alertService = {
    online: false,
    lastHeartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  };
  await open(page);
  const panel = await openPanel(page);
  await expect(panel.getByRole('alert')).toContainText('Alerts service is not running');
});

test('panel: a triggered alert can be restarted', async ({ page, server }) => {
  await mockMarket(page);
  seed(server, 'a1', 'Apple 200', { status: 'triggered', fireCount: 1 });
  await open(page);
  await openPanel(page);
  await expect(alertRow(page, 'Apple 200').locator('.al-dot')).toHaveAttribute(
    'aria-label',
    'triggered',
  );
  await alertRow(page, 'Apple 200')
    .getByRole('button', { name: /^Actions for/ })
    .click();
  await page.getByRole('menu').last().getByRole('menuitem', { name: 'Restart' }).click();
  await expect.poll(() => server.alerts.get('a1')!.status).toBe('active');
  await expect(alertRow(page, 'Apple 200').locator('.al-dot')).toHaveAttribute(
    'aria-label',
    'active',
  );
});

test('edit: a server revision bump while the dialog is open still conflicts', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page);
  seed(server, 'a1', 'Apple 200');
  await open(page);
  await openPanel(page);
  await alertRow(page, 'Apple 200')
    .first()
    .getByRole('button', { name: /^Actions for/ })
    .click();
  await page.getByRole('menu').last().getByRole('menuitem', { name: 'Edit…' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  // The service marks the alert triggered while the dialog is open; the page learns of it.
  const row = server.alerts.get('a1')!;
  row.revision = 2;
  row.status = 'triggered';
  market.push({ type: 'alerts.changed', topic: 'alerts', ids: ['a1'], deleted: [] });
  await expect(alertRow(page, 'Apple 200').first().locator('.al-dot')).toHaveAttribute(
    'aria-label',
    'triggered',
  );
  await dialog(page).getByRole('tab', { name: 'Message' }).click(); // re-renders the dialog
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /changed elsewhere|conflict/i }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep mine' })).toBeVisible();
  expect(server.alerts.get('a1')!.revision).toBe(2); // not overwritten
});

test('edit: deleting the alert while the dialog is open does not re-create it', async ({
  page,
  server,
}) => {
  const market = await mockMarket(page);
  seed(server, 'a1', 'Apple 200');
  await open(page);
  await openPanel(page);
  await alertRow(page, 'Apple 200')
    .first()
    .getByRole('button', { name: /^Actions for/ })
    .click();
  await page.getByRole('menu').last().getByRole('menuitem', { name: 'Edit…' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  server.alerts.delete('a1');
  market.push({ type: 'alerts.changed', topic: 'alerts', ids: ['a1'], deleted: ['a1'] });
  await expect(alertRow(page, 'Apple 200')).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/deleted while you were editing/i)).toBeVisible();
  expect(server.alerts.size).toBe(0);
});
