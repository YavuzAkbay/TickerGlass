import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { firstChart, freshBoot } from './persistence';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
    lastStudyHover?: string | null;
  }
}

const VOLUME_ID = 'volume_default';

const layoutButton = (page: Page) => page.getByRole('button', { name: /^Layout:/ });
const volumeRow = (page: Page) => page.locator('.ind-legend-row', { hasText: 'Vol' });
const studies = (page: Page) =>
  page.evaluate(() => window.chart.getStudies().map((s) => ({ id: s.id, paneId: s.paneId })));

async function restored(page: Page, name = 'Untitled') {
  await page.waitForFunction(() => window.chart?.store.length > 0);
  await expect(layoutButton(page)).toHaveAttribute('aria-label', new RegExp(`^Layout: ${name}`));
}

async function saved(page: Page) {
  await expect(layoutButton(page)).not.toHaveAttribute('aria-label', /unsaved/);
}

/** Page point over a volume column (bottom of the price pane, not over a candle). */
async function volumePoint(page: Page) {
  return page.evaluate((id) => {
    const c = window.chart;
    const pane = c.panes[0]!;
    const rect = c.root.getBoundingClientRect();
    const y = pane.top + pane.height - 3;
    for (let i = c.store.length - 1; i > c.store.length - 80; i--) {
      const x = c.timeScale.indexToX(i);
      const hit = c.hitTest(x, y);
      if (hit.kind === 'pane' && hit.seriesId === id) return { x: rect.left + x, y: rect.top + y };
    }
    return null;
  }, VOLUME_ID);
}

test('new charts show Volume as an indicator: click, menus, hide, remove, undo, reload', async ({
  page,
  server,
}) => {
  await freshBoot(page, server, '/?feed=synthetic');
  await restored(page);

  // A legend row with values; the engine's built-in volume is off (one volume display).
  const row = volumeRow(page);
  await expect(row).toHaveCount(1);
  await expect(row.locator('.ind-legend-value').first()).toHaveText(/\d/);
  expect(await studies(page)).toEqual([{ id: VOLUME_ID, paneId: 'main' }]);
  expect(await page.evaluate(() => window.chart.getVolumeMode())).toBe('hidden');

  // Pointer on the columns: hover, right-click menu, double-click settings.
  await page.evaluate(() => {
    window.chart.on('studyHover', (e) => (window.lastStudyHover = e.id));
  });
  const p = await volumePoint(page);
  expect(p).not.toBeNull();
  await page.mouse.move(p!.x, p!.y);
  await expect.poll(() => page.evaluate(() => window.lastStudyHover)).toBe(VOLUME_ID);
  await page.mouse.click(p!.x, p!.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Settings…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.dblclick(p!.x, p!.y);
  await expect(page.getByRole('dialog').filter({ hasText: 'MA Length' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Move to a new pane and back via the legend "More" menu.
  await row.hover();
  await row.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Move to' }).click();
  await page.getByRole('menuitem', { name: 'New pane' }).click();
  await expect.poll(() => studies(page)).toEqual([{ id: VOLUME_ID, paneId: `pane-${VOLUME_ID}` }]);
  await row.hover();
  await row.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Move to' }).click();
  await page.getByRole('menuitem', { name: 'Price pane' }).click();
  await expect.poll(() => studies(page)).toEqual([{ id: VOLUME_ID, paneId: 'main' }]);

  // Hide with the eye, show again.
  await row.hover();
  await row.getByRole('button', { name: 'Hide' }).click();
  await expect(row).toHaveClass(/\boff\b/);
  expect(await page.evaluate(() => window.chart.getStudies()[0]!.visible)).toBe(false);
  await row.getByRole('button', { name: 'Show' }).click();
  await expect(row).not.toHaveClass(/\boff\b/);

  // Remove with ×, undo brings it back.
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  expect(await studies(page)).toEqual([]);
  await page.locator('.chart-host').click({ position: { x: 300, y: 100 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(row).toHaveCount(1);
  await expect.poll(() => studies(page)).toEqual([{ id: VOLUME_ID, paneId: 'main' }]);

  // Remove again; it stays removed after a reload (server state, mocked API).
  await row.hover();
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(() => {
      const l = server.current()!;
      return [l.schemaVersion, (firstChart(l.state)!.indicators as unknown[]).length];
    })
    .toEqual([5, 0]);
  await saved(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await restored(page);
  await expect(page.locator('.ind-legend-row')).toHaveCount(0);
  expect(await studies(page)).toEqual([]);
  expect(await page.evaluate(() => window.chart.getVolumeMode())).toBe('hidden');
});

test('a saved layout with built-in volume opens with the Volume indicator, once', async ({
  page,
  server,
}) => {
  server.layouts.set('L-old', {
    id: 'L-old',
    name: 'Old',
    state: {
      chart: null,
      indicators: [],
      chartSettings: {
        chartType: 'candles',
        chartStyle: {},
        volume: 'pane',
        showPrevClose: false,
        timezone: 'exchange',
        prepost: false,
      },
    },
    schemaVersion: 1,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  server.lastUsed = 'L-old';
  await page.goto('/?feed=synthetic');
  await restored(page, 'Old');
  await expect(volumeRow(page)).toHaveCount(1);
  await expect.poll(() => studies(page)).toEqual([{ id: VOLUME_ID, paneId: `pane-${VOLUME_ID}` }]);
  expect(await page.evaluate(() => window.chart.getVolumeMode())).toBe('hidden');

  // Reloading (server copy still v1, plus the browser cache) does not add a second one.
  await page.reload();
  await restored(page, 'Old');
  await expect(volumeRow(page)).toHaveCount(1);
  expect(await studies(page)).toHaveLength(1);
});
