import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

const drawings = (page: Page) => page.evaluate(() => window.chart.getDrawings());

async function waitForChart(page: Page) {
  await page.waitForFunction(() => window.chart?.store.length > 0);
}

test('place a sticker from the Icons flyout', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('drw-e2e')) return;
    sessionStorage.setItem('drw-e2e', '1');
    localStorage.removeItem('investopen-drawings');
    localStorage.removeItem('investopen-drawing-templates');
  });
  await page.goto('/?feed=synthetic');
  await waitForChart(page);

  await page.getByRole('button', { name: 'Icons, emojis and stickers' }).click();
  await page.getByRole('tab', { name: 'Stickers' }).click();
  await page.getByRole('menuitem', { name: 'Diamond hands' }).click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('icon');

  await page.mouse.click(600, 350);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [d] = await drawings(page);
  expect(d!.type).toBe('icon');
  expect(d!.points).toHaveLength(1);
  expect(d!.style.glyph).toBe('\u{1F48E}');
  expect(errors).toEqual([]);
});

const TWO: [number, number][] = [
  [500, 400],
  [800, 300],
];
const THREE: [number, number][] = [
  [450, 400],
  [700, 250],
  [700, 500],
];
const LINES = 'Trend line tools';
const FIB = 'Gann and Fibonacci tools';
const PATTERNS = 'Patterns';

/** Flyout (toolbar group label), tool name, engine type, clicks (viewport px), stored anchors. */
const LINE_TOOL_CASES: {
  group: string;
  name: string;
  type: string;
  clicks: [number, number][];
  count: number;
}[] = [
  { group: LINES, name: 'Trend angle', type: 'trend-angle', clicks: TWO, count: 2 },
  { group: LINES, name: 'Regression trend', type: 'regression-trend', clicks: TWO, count: 2 },
  { group: LINES, name: 'Flat top/bottom', type: 'flat-top-bottom', clicks: THREE, count: 3 },
  { group: LINES, name: 'Disjoint channel', type: 'disjoint-channel', clicks: THREE, count: 4 },
  { group: LINES, name: 'Pitchfork', type: 'pitchfork', clicks: THREE, count: 3 },
  { group: LINES, name: 'Schiff pitchfork', type: 'schiff-pitchfork', clicks: THREE, count: 3 },
  {
    group: LINES,
    name: 'Modified Schiff pitchfork',
    type: 'modified-schiff-pitchfork',
    clicks: THREE,
    count: 3,
  },
  { group: LINES, name: 'Inside pitchfork', type: 'inside-pitchfork', clicks: THREE, count: 3 },
  {
    group: FIB,
    name: 'Pitchfan',
    type: 'pitchfan',
    clicks: THREE,
    count: 3,
  },
  { group: FIB, name: 'Fib channel', type: 'fib-channel', clicks: THREE, count: 3 },
  { group: FIB, name: 'Fib time zone', type: 'fib-time-zone', clicks: TWO, count: 2 },
  {
    group: FIB,
    name: 'Fib speed resistance fan',
    type: 'fib-speed-fan',
    clicks: TWO,
    count: 2,
  },
  { group: FIB, name: 'Trend-based fib time', type: 'fib-trend-time', clicks: THREE, count: 3 },
  { group: FIB, name: 'Fib circles', type: 'fib-circles', clicks: TWO, count: 2 },
  { group: FIB, name: 'Fib spiral', type: 'fib-spiral', clicks: TWO, count: 2 },
  {
    group: FIB,
    name: 'Fib speed resistance arcs',
    type: 'fib-speed-arcs',
    clicks: TWO,
    count: 2,
  },
  { group: FIB, name: 'Fib wedge', type: 'fib-wedge', clicks: THREE, count: 3 },
  { group: FIB, name: 'Gann box', type: 'gann-box', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann square fixed', type: 'gann-square-fixed', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann square', type: 'gann-square', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann fan', type: 'gann-fan', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'Cyclic lines', type: 'cyclic-lines', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'Time cycles', type: 'time-cycles', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'Sine line', type: 'sine-line', clicks: TWO, count: 2 },
];

for (const { group, name, type, clicks, count } of LINE_TOOL_CASES) {
  test(`draw ${type} from the ${group} flyout`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('drw-e2e')) return;
      sessionStorage.setItem('drw-e2e', '1');
      localStorage.removeItem('investopen-drawings');
      localStorage.removeItem('investopen-drawing-templates');
    });
    await page.goto('/?feed=synthetic');
    await waitForChart(page);

    await page.getByRole('button', { name: `More ${group.toLowerCase()}` }).click();
    await page
      .getByRole('menu', { name: group })
      .getByRole('menuitem')
      .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
      .click();
    expect(await page.evaluate(() => window.chart.getActiveTool())).toBe(type);

    for (const [x, y] of clicks) await page.mouse.click(x, y);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const [d] = await drawings(page);
    expect(d!.type).toBe(type);
    expect(d!.points).toHaveLength(count);
    expect(errors).toEqual([]);
  });
}
