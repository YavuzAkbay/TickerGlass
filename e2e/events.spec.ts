import type { Page } from '@playwright/test';
import { expect, test, openChartSettings } from './fixtures';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

interface EngineProbe {
  markerGroups: Map<string, { id: string; text?: string; tooltip?: string }[]>;
  placedMarkers(): { marker: { id: string; tooltip?: string }; x: number; y: number }[];
}

const FEED = '/?feed=synthetic';

const groupIds = (page: Page) =>
  page.evaluate(
    () =>
      (window.chart as unknown as EngineProbe).markerGroups.get('events')?.map((m) => m.id) ?? [],
  );

/** Mocks /api/events/* with a payload the test fills in once the bar times are known. */
async function mockEvents(page: Page) {
  const state: { body: unknown; calls: string[] } = {
    body: { dividends: [], splits: [], earnings: [] },
    calls: [],
  };
  await page.route('**/api/events/**', (route) => {
    state.calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: state.body });
  });
  return state;
}

async function openWithEvents(page: Page) {
  const state = await mockEvents(page);
  await page.goto(FEED);
  await page.waitForFunction(() => window.chart?.store.length > 0);
  const t = await page.evaluate(() => {
    const s = window.chart.store;
    return { a: s.time[s.length - 6]!, b: s.time[s.length - 4]!, c: s.time[s.length - 2]! };
  });
  const last = await page.evaluate(() => {
    const s = window.chart.store;
    // One bar after the newest.
    return 2 * s.time[s.length - 1]! - s.time[s.length - 2]!;
  });
  state.body = {
    dividends: [{ t: t.a, amount: 0.24 }],
    splits: [{ t: t.b, ratio: 4 }],
    earnings: [
      { t: t.c, epsEstimate: 1.2, epsActual: 1.3, surprisePercent: 8.3 },
      { t: last, epsEstimate: 1.5, epsActual: null, surprisePercent: null },
    ],
  };
  await page.reload();
  await page.waitForFunction(() => window.chart?.store.length > 0);
  return state;
}

async function openEventsTab(page: Page) {
  await openChartSettings(page);
  await page.getByRole('dialog').getByRole('tab', { name: 'Events' }).click();
}

test('event markers render, show tooltips on hover and follow the Events tab toggles', async ({
  page,
}) => {
  const state = await openWithEvents(page);
  await expect.poll(() => groupIds(page)).toHaveLength(4);
  expect(state.calls.length).toBeGreaterThan(0);

  // Hover the dividend badge: the crosshair is over a marker whose tooltip is the amount.
  const tooltipAt = async (id: string) => {
    const pos = await page.evaluate((want) => {
      const p = (window.chart as unknown as EngineProbe)
        .placedMarkers()
        .find((m) => m.marker.id.startsWith(want));
      return p ? { x: p.x, y: p.y } : null;
    }, id);
    expect(pos, `marker ${id} placed`).not.toBeNull();
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(box.x + pos!.x, box.y + pos!.y);
    return page.evaluate(({ x, y }) => {
      const hit = window.chart.hitTest(x, y);
      if (hit.kind !== 'pane' || !hit.marker) return null;
      return (window.chart as unknown as EngineProbe).markerGroups
        .get(hit.marker.group)
        ?.find((m) => m.id === hit.marker!.id)?.tooltip;
    }, pos!);
  };
  expect(await tooltipAt('div-')).toBe('Dividend 0.24');
  expect(await tooltipAt('split-')).toBe('Split 4:1');
  expect(await tooltipAt('earn-')).toContain('actual 1.3');

  // Future earnings sit past the last bar.
  const futureX = await page.evaluate(() => {
    const p = (window.chart as unknown as EngineProbe)
      .placedMarkers()
      .filter((m) => m.marker.tooltip?.includes('estimate 1.5'));
    return p.length;
  });
  expect(futureX).toBe(1);

  await openEventsTab(page);
  await page.getByLabel('Dividends (D)').uncheck();
  await expect.poll(() => groupIds(page)).toHaveLength(3);
  await page.getByLabel('Splits (S)').uncheck();
  await page.getByLabel(/^Earnings \(E\)/).uncheck();
  await expect.poll(() => groupIds(page)).toEqual([]);
  await page.getByLabel('Dividends (D)').check();
  await expect.poll(() => groupIds(page)).toHaveLength(1);
});
