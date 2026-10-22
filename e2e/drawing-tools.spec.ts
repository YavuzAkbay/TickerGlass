import type { Page } from '@playwright/test';
import { expect, pickTool, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const drawings = (page: Page) => page.evaluate(() => window.chart.getDrawings());

async function waitForChart(page: Page) {
  await page.waitForFunction(() => window.chart?.store.length > 0);
}

test('place a sticker from the Text flyout', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.addInitScript(() => {
    if (sessionStorage.getItem('drw-e2e')) return;
    sessionStorage.setItem('drw-e2e', '1');
    localStorage.removeItem('tickerglass-drawings');
    localStorage.removeItem('tickerglass-drawing-templates');
  });
  await page.goto('/?feed=synthetic');
  await waitForChart(page);

  await page.getByRole('button', { name: 'Text', exact: true }).click();
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
/** Zigzag clicks alternating high/low, 60 px apart. */
const zigzag = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [300 + i * 60, i % 2 ? 250 : 450] as [number, number]);
const FOUR = zigzag(4);
const FIVE = zigzag(5);
const SIX = zigzag(6);
const SEVEN = zigzag(7);
const LINES = 'Lines';
const FIB = 'Measure';
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
  { group: LINES, name: 'Flat-edge channel', type: 'flat-channel', clicks: THREE, count: 3 },
  { group: LINES, name: 'Split channel', type: 'split-channel', clicks: THREE, count: 4 },
  { group: LINES, name: 'Pitchfork', type: 'pitchfork', clicks: THREE, count: 3 },
  { group: LINES, name: 'Schiff pitchfork', type: 'schiff-pitchfork', clicks: THREE, count: 3 },
  {
    group: LINES,
    name: 'Modified Schiff pitchfork',
    type: 'modified-schiff-pitchfork',
    clicks: THREE,
    count: 3,
  },
  { group: LINES, name: 'Inner pitchfork', type: 'inner-pitchfork', clicks: THREE, count: 3 },
  {
    group: FIB,
    name: 'Fork fan',
    type: 'fork-fan',
    clicks: THREE,
    count: 3,
  },
  { group: FIB, name: 'Fib channel', type: 'fib-channel', clicks: THREE, count: 3 },
  { group: FIB, name: 'Fib time zone', type: 'fib-time-zone', clicks: TWO, count: 2 },
  {
    group: FIB,
    name: 'Fib fan',
    type: 'fib-fan',
    clicks: TWO,
    count: 2,
  },
  { group: FIB, name: 'Fib time extension', type: 'fib-time-extension', clicks: THREE, count: 3 },
  { group: FIB, name: 'Fib circles', type: 'fib-circles', clicks: TWO, count: 2 },
  { group: FIB, name: 'Fib spiral', type: 'fib-spiral', clicks: TWO, count: 2 },
  {
    group: FIB,
    name: 'Fib arcs',
    type: 'fib-arcs',
    clicks: TWO,
    count: 2,
  },
  { group: FIB, name: 'Fib sector', type: 'fib-sector', clicks: THREE, count: 3 },
  { group: FIB, name: 'Gann box', type: 'gann-box', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann grid', type: 'gann-grid', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann square', type: 'gann-square', clicks: TWO, count: 2 },
  { group: FIB, name: 'Gann fan', type: 'gann-fan', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'XABCD pattern', type: 'xabcd', clicks: FIVE, count: 5 },
  { group: PATTERNS, name: 'Cypher pattern', type: 'cypher', clicks: FIVE, count: 5 },
  { group: PATTERNS, name: 'Head and shoulders', type: 'head-shoulders', clicks: SEVEN, count: 7 },
  { group: PATTERNS, name: 'ABCD pattern', type: 'abcd', clicks: FOUR, count: 4 },
  { group: PATTERNS, name: 'Triangle pattern', type: 'triangle-pattern', clicks: FOUR, count: 4 },
  { group: PATTERNS, name: 'Three drives pattern', type: 'three-drives', clicks: SEVEN, count: 7 },
  {
    group: PATTERNS,
    name: 'Elliott impulse (5-wave)',
    type: 'elliott-impulse',
    clicks: SIX,
    count: 6,
  },
  {
    group: PATTERNS,
    name: 'Elliott correction (3-wave)',
    type: 'elliott-correction',
    clicks: FOUR,
    count: 4,
  },
  {
    group: PATTERNS,
    name: 'Elliott triangle (5-wave)',
    type: 'elliott-triangle',
    clicks: SIX,
    count: 6,
  },
  {
    group: PATTERNS,
    name: 'Elliott double combination',
    type: 'elliott-double-combo',
    clicks: FOUR,
    count: 4,
  },
  {
    group: PATTERNS,
    name: 'Elliott triple combination',
    type: 'elliott-triple-combo',
    clicks: SIX,
    count: 6,
  },
  { group: PATTERNS, name: 'Cycle lines', type: 'cycle-lines', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'Cycle arcs', type: 'cycle-arcs', clicks: TWO, count: 2 },
  { group: PATTERNS, name: 'Sine wave', type: 'sine-wave', clicks: TWO, count: 2 },
];

for (const { group, name, type, clicks, count } of LINE_TOOL_CASES) {
  test(`draw ${type} from the ${group} flyout`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.addInitScript(() => {
      if (sessionStorage.getItem('drw-e2e')) return;
      sessionStorage.setItem('drw-e2e', '1');
      localStorage.removeItem('tickerglass-drawings');
      localStorage.removeItem('tickerglass-drawing-templates');
    });
    await page.goto('/?feed=synthetic');
    await waitForChart(page);

    await page.getByRole('button', { name: group, exact: true }).click();
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

const SHAPES = 'Shapes';
const PATH_CLICKS: [number, number][] = [
  [450, 400],
  [550, 300],
  [650, 400],
];

/** Shape tools: clicks, then how a multi-point creation finishes. */
const SHAPE_TOOL_CASES: {
  name: string;
  type: string;
  clicks: [number, number][];
  finish?: 'enter' | 'dblclick' | 'close';
  count: number;
}[] = [
  { name: 'Arrow pointer', type: 'arrow-pointer', clicks: TWO, count: 2 },
  { name: 'Up marker', type: 'up-marker', clicks: [[600, 400]], count: 1 },
  { name: 'Down marker', type: 'down-marker', clicks: [[600, 300]], count: 1 },
  { name: 'Rotated rectangle', type: 'rotated-rectangle', clicks: THREE, count: 3 },
  { name: 'Path', type: 'path', clicks: PATH_CLICKS, finish: 'dblclick', count: 3 },
  { name: 'Circle', type: 'circle', clicks: TWO, count: 2 },
  { name: 'Ellipse', type: 'ellipse', clicks: TWO, count: 2 },
  // Closing on the first anchor stores an exact copy of it as the last anchor.
  { name: 'Polyline', type: 'polyline', clicks: PATH_CLICKS, finish: 'close', count: 4 },
  { name: 'Triangle', type: 'triangle', clicks: THREE, count: 3 },
  { name: 'Arc', type: 'arc', clicks: THREE, count: 3 },
  { name: 'Curve', type: 'curve', clicks: TWO, count: 3 },
  { name: 'S-curve', type: 's-curve', clicks: TWO, count: 4 },
];

async function pickShapeTool(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: SHAPES, exact: true }).click();
  await page
    .getByRole('menu', { name: SHAPES })
    .getByRole('menuitem')
    .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
    .click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe(type);
}

async function openFresh(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('drw-e2e')) return;
    sessionStorage.setItem('drw-e2e', '1');
    localStorage.removeItem('tickerglass-drawings');
    localStorage.removeItem('tickerglass-drawing-templates');
  });
  await page.goto('/?feed=synthetic');
  await waitForChart(page);
}

for (const { name, type, clicks, finish, count } of SHAPE_TOOL_CASES) {
  test(`draw ${type} from the ${SHAPES} flyout`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await openFresh(page);
    await pickShapeTool(page, name, type);

    const last = clicks[clicks.length - 1]!;
    const placed = finish === 'dblclick' ? clicks.slice(0, -1) : clicks;
    for (const [x, y] of placed) await page.mouse.click(x, y);
    if (finish === 'dblclick') await page.mouse.dblclick(last[0], last[1]);
    if (finish === 'enter') await page.keyboard.press('Enter');
    if (finish === 'close') await page.mouse.click(clicks[0]![0], clicks[0]![1]);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const [d] = await drawings(page);
    expect(d!.type).toBe(type);
    expect(d!.points).toHaveLength(count);
    if (finish === 'close') expect(d!.points[count - 1]).toEqual(d!.points[0]);
    expect(errors).toEqual([]);
  });
}

test('draw a highlighter stroke by dragging', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await pickShapeTool(page, 'Highlighter', 'highlighter');

  await page.mouse.move(450, 400);
  await page.mouse.down();
  await page.mouse.move(550, 350, { steps: 10 });
  await page.mouse.move(650, 380, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [d] = await drawings(page);
  expect(d!.type).toBe('highlighter');
  expect(d!.points.length).toBeGreaterThan(2);
  expect(errors).toEqual([]);
});

test('finish a path with Enter', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await pickShapeTool(page, 'Path', 'path');

  for (const [x, y] of PATH_CLICKS) await page.mouse.click(x, y);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [d] = await drawings(page);
  expect(d!.points).toHaveLength(3);
  expect(errors).toEqual([]);
});

const ANNOTATION = 'Text';
const ONE: [number, number][] = [[600, 350]];

async function pickAnnotationTool(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: ANNOTATION, exact: true }).click();
  await page
    .getByRole('menu', { name: ANNOTATION })
    .getByRole('menuitem')
    .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
    .click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe(type);
}

const ANNOTATION_CASES: { name: string; type: string; clicks: [number, number][] }[] = [
  { name: 'Pinned text', type: 'pinned-text', clicks: ONE },
  { name: 'Note', type: 'note', clicks: ONE },
  { name: 'Pinned note', type: 'pinned-note', clicks: ONE },
  { name: 'Callout', type: 'callout', clicks: TWO },
  { name: 'Comment', type: 'comment', clicks: ONE },
  { name: 'Price label', type: 'price-label', clicks: ONE },
  { name: 'Price tag', type: 'price-tag', clicks: TWO },
  { name: 'Pin', type: 'pin', clicks: ONE },
  { name: 'Flag', type: 'flag', clicks: ONE },
  { name: 'Table', type: 'table', clicks: ONE },
  { name: 'Image', type: 'image', clicks: TWO },
];

for (const { name, type, clicks } of ANNOTATION_CASES) {
  test(`draw ${type} from the ${ANNOTATION} flyout`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await openFresh(page);
    await pickAnnotationTool(page, name, type);

    for (const [x, y] of clicks) await page.mouse.click(x, y);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const [d] = await drawings(page);
    expect(d!.type).toBe(type);
    expect(d!.points).toHaveLength(clicks.length);
    expect(errors).toEqual([]);
  });
}

test('callout text typed in the editor persists across reload', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await pickAnnotationTool(page, 'Callout', 'callout');
  for (const [x, y] of TWO) await page.mouse.click(x, y);

  const editor = page.getByRole('textbox', { name: 'Callout text' });
  await expect(editor).toBeVisible();
  await editor.fill('Breakout level');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor).toHaveCount(0);
  await expect.poll(async () => (await drawings(page))[0]?.text).toBe('Breakout level');

  await page.reload();
  await waitForChart(page);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const [d] = await drawings(page);
  expect(d!.type).toBe('callout');
  expect(d!.text).toBe('Breakout level');
  expect(errors).toEqual([]);
});

test('image: choose a file in the settings dialog', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await pickAnnotationTool(page, 'Image', 'image');
  for (const [x, y] of [
    [500, 300],
    [700, 450],
  ] as [number, number][])
    await page.mouse.click(x, y);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);

  // Select it (inside the box), then open the settings from the floating toolbar.
  await page.keyboard.press('Escape');
  await page.mouse.click(600, 375);
  await expect.poll(() => page.evaluate(() => window.chart.getSelection().length)).toBe(1);
  await page
    .getByRole('toolbar', { name: 'Drawing toolbar' })
    .getByRole('button', { name: 'Settings' })
    .click();

  // 1x1 PNG, built in the test.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector
    .getByLabel('Image', { exact: true })
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await inspector.getByRole('button', { name: 'Done' }).click();

  await expect
    .poll(async () => String((await drawings(page))[0]?.style.src ?? '').slice(0, 11))
    .toBe('data:image/');
  expect(errors).toEqual([]);
});

const FORECASTING = 'Measure';

/** Forecasting/volume tools: clicks, optional double-click finish, stored anchors. */
const PROJECTION_TOOL_CASES: {
  name: string;
  type: string;
  clicks: [number, number][];
  finish?: 'dblclick';
  count: number;
}[] = [
  { name: 'Price target', type: 'price-target', clicks: TWO, count: 2 },
  // The copy origin is derived from the two clicks.
  { name: 'Bar replica', type: 'bar-replica', clicks: TWO, count: 3 },
  { name: 'Path sketch', type: 'path-sketch', clicks: PATH_CLICKS, finish: 'dblclick', count: 3 },
  { name: 'Swing projection', type: 'swing-projection', clicks: THREE, count: 3 },
  { name: 'Range volume profile', type: 'range-vp', clicks: TWO, count: 2 },
  { name: 'Anchored volume profile', type: 'anchored-vp', clicks: ONE, count: 1 },
];

for (const { name, type, clicks, finish, count } of PROJECTION_TOOL_CASES) {
  test(`draw ${type} from the ${FORECASTING} flyout`, async ({ page }) => {
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await openFresh(page);
    await page.getByRole('button', { name: FORECASTING, exact: true }).click();
    await page
      .getByRole('menu', { name: FORECASTING })
      .getByRole('menuitem')
      .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
      .click();
    expect(await page.evaluate(() => window.chart.getActiveTool())).toBe(type);

    const last = clicks[clicks.length - 1]!;
    const placed = finish === 'dblclick' ? clicks.slice(0, -1) : clicks;
    for (const [x, y] of placed) await page.mouse.click(x, y);
    if (finish === 'dblclick') await page.mouse.dblclick(last[0], last[1]);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const [d] = await drawings(page);
    expect(d!.type).toBe(type);
    expect(d!.points).toHaveLength(count);
    if (type === 'path-sketch') expect(d!.style.seed).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

/** The transient measurement's anchors (never part of getDrawings()). */
const measurement = (page: Page) => page.evaluate(() => window.chart.getMeasure());

test('zoom in: drag a box to zoom the chart to it', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  const before = await page.evaluate(() => window.chart.getState());
  await pickTool(page, 'Measure', 'Zoom in');
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('zoom-in');

  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(700, 350, { steps: 5 });
  await page.mouse.move(800, 450, { steps: 5 });
  await page.mouse.up();

  const after = await page.evaluate(() => window.chart.getState());
  expect(after.timeScale.barSpacing).toBeGreaterThan(before.timeScale.barSpacing * 2);
  const main = after.panes.find((p) => p.id === 'main')!;
  expect(main.priceScale.autoScale).toBe(false);
  expect(main.priceScale.max! - main.priceScale.min!).toBeGreaterThan(0);
  // Back to the cursor, nothing drawn.
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBeNull();
  expect(await drawings(page)).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('zoom in: Esc cancels the box', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  const before = await page.evaluate(() => window.chart.getState().timeScale.barSpacing);
  await pickTool(page, 'Measure', 'Zoom in');
  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(800, 450, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await page.evaluate(() => window.chart.getState().timeScale.barSpacing)).toBe(before);
  expect(errors).toEqual([]);
});

test('measure: transient range, cleared by the next click, never stored', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await pickTool(page, 'Measure', 'Measure');
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('measure');

  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(650, 330, { steps: 5 });
  await page.mouse.up();
  expect(await measurement(page)).toHaveLength(2);
  expect(await drawings(page)).toHaveLength(0);
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBeNull();

  // The next click clears it.
  await page.mouse.click(300, 300);
  expect(await measurement(page)).toBeNull();

  // Esc clears it too.
  await pickTool(page, 'Measure', 'Measure');
  await page.mouse.click(500, 400);
  await page.mouse.click(650, 330);
  expect(await measurement(page)).toHaveLength(2);
  await page.keyboard.press('Escape');
  expect(await measurement(page)).toBeNull();
  expect(await drawings(page)).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('measure: Shift+click quick-measures from the cursor', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  await page.keyboard.down('Shift');
  await page.mouse.click(500, 400);
  await page.mouse.move(650, 330, { steps: 5 });
  await page.mouse.click(650, 330);
  await page.keyboard.up('Shift');
  expect(await measurement(page)).toHaveLength(2);
  expect(await drawings(page)).toHaveLength(0);
  await page.mouse.click(300, 300);
  expect(await measurement(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('anchored VWAP: a click adds the indicator anchored at that bar', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await openFresh(page);
  const studies = () => page.evaluate(() => window.chart.getStudies().length);
  const before = await studies();
  await page.getByRole('button', { name: 'Measure', exact: true }).click();
  await page
    .getByRole('menu', { name: 'Measure' })
    .getByRole('menuitem')
    .filter({ has: page.locator('.lt-fly-name').getByText('Anchored VWAP', { exact: true }) })
    .click();
  await page.mouse.click(700, 350);
  await expect.poll(studies).toBe(before + 1);
  expect(await drawings(page)).toHaveLength(0);
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBeNull();
  expect(
    await page.evaluate(() => window.chart.getStudies().some((s) => /anchored/i.test(s.title))),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test('quick tools at the cursor: a default tool, then search across categories', async ({
  page,
}) => {
  await openFresh(page);
  await page.mouse.move(700, 350);
  await page.keyboard.press('Alt+d');
  const quick = page.getByRole('menu', { name: 'Quick drawing tools' });
  await expect(quick).toBeVisible();
  await quick.getByRole('menuitem', { name: 'Rectangle' }).click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('rectangle');
  await expect(quick).toHaveCount(0);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+d');
  await page.keyboard.type('gann box');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('gann-box');
});

test('dock search: typing filters a category, Enter arms the first match', async ({ page }) => {
  await openFresh(page);
  await page.getByRole('button', { name: 'Lines', exact: true }).click();
  await page.keyboard.type('pitch');
  const rows = page.getByRole('menu', { name: 'Lines' }).locator('.lt-fly-name');
  await expect(rows.first()).toHaveText('Pitchfork');
  await expect(rows.filter({ hasText: 'Trend line' })).toHaveCount(0);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('pitchfork');
});
