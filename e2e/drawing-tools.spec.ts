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
/** Zigzag clicks alternating high/low, 60 px apart. */
const zigzag = (n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [300 + i * 60, i % 2 ? 250 : 450] as [number, number]);
const FOUR = zigzag(4);
const FIVE = zigzag(5);
const SIX = zigzag(6);
const SEVEN = zigzag(7);
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
  { group: PATTERNS, name: 'XABCD pattern', type: 'xabcd', clicks: FIVE, count: 5 },
  { group: PATTERNS, name: 'Cypher pattern', type: 'cypher', clicks: FIVE, count: 5 },
  { group: PATTERNS, name: 'Head and shoulders', type: 'head-shoulders', clicks: SEVEN, count: 7 },
  { group: PATTERNS, name: 'ABCD pattern', type: 'abcd', clicks: FOUR, count: 4 },
  { group: PATTERNS, name: 'Triangle pattern', type: 'triangle-pattern', clicks: FOUR, count: 4 },
  { group: PATTERNS, name: 'Three drives pattern', type: 'three-drives', clicks: SEVEN, count: 7 },
  {
    group: PATTERNS,
    name: 'Elliott impulse wave (12345)',
    type: 'elliott-impulse',
    clicks: SIX,
    count: 6,
  },
  {
    group: PATTERNS,
    name: 'Elliott correction wave (ABC)',
    type: 'elliott-correction',
    clicks: FOUR,
    count: 4,
  },
  {
    group: PATTERNS,
    name: 'Elliott triangle wave (ABCDE)',
    type: 'elliott-triangle',
    clicks: SIX,
    count: 6,
  },
  {
    group: PATTERNS,
    name: 'Elliott double combo wave (WXY)',
    type: 'elliott-double-combo',
    clicks: FOUR,
    count: 4,
  },
  {
    group: PATTERNS,
    name: 'Elliott triple combo wave (WXYXZ)',
    type: 'elliott-triple-combo',
    clicks: SIX,
    count: 6,
  },
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

const SHAPES = 'Geometric shapes';
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
  { name: 'Arrow marker', type: 'arrow-marker', clicks: TWO, count: 2 },
  { name: 'Arrow mark up', type: 'arrow-mark-up', clicks: [[600, 400]], count: 1 },
  { name: 'Arrow mark down', type: 'arrow-mark-down', clicks: [[600, 300]], count: 1 },
  { name: 'Rotated rectangle', type: 'rotated-rectangle', clicks: THREE, count: 3 },
  { name: 'Path', type: 'path', clicks: PATH_CLICKS, finish: 'dblclick', count: 3 },
  { name: 'Circle', type: 'circle', clicks: TWO, count: 2 },
  { name: 'Ellipse', type: 'ellipse', clicks: TWO, count: 2 },
  // Closing on the first anchor stores an exact copy of it as the last anchor.
  { name: 'Polyline', type: 'polyline', clicks: PATH_CLICKS, finish: 'close', count: 4 },
  { name: 'Triangle', type: 'triangle', clicks: THREE, count: 3 },
  { name: 'Arc', type: 'arc', clicks: THREE, count: 3 },
  { name: 'Curve', type: 'curve', clicks: TWO, count: 3 },
  { name: 'Double curve', type: 'double-curve', clicks: TWO, count: 4 },
];

async function pickShapeTool(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: `More ${SHAPES.toLowerCase()}` }).click();
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
    localStorage.removeItem('investopen-drawings');
    localStorage.removeItem('investopen-drawing-templates');
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

const ANNOTATION = 'Annotation tools';
const ONE: [number, number][] = [[600, 350]];

async function pickAnnotationTool(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: `More ${ANNOTATION.toLowerCase()}` }).click();
  await page
    .getByRole('menu', { name: ANNOTATION })
    .getByRole('menuitem')
    .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
    .click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe(type);
}

const ANNOTATION_CASES: { name: string; type: string; clicks: [number, number][] }[] = [
  { name: 'Anchored text', type: 'anchored-text', clicks: ONE },
  { name: 'Note', type: 'note', clicks: ONE },
  { name: 'Anchored note', type: 'anchored-note', clicks: ONE },
  { name: 'Callout', type: 'callout', clicks: TWO },
  { name: 'Comment', type: 'comment', clicks: ONE },
  { name: 'Price label', type: 'price-label', clicks: ONE },
  { name: 'Price note', type: 'price-note', clicks: TWO },
  { name: 'Signpost', type: 'signpost', clicks: ONE },
  { name: 'Flag mark', type: 'flag-mark', clicks: ONE },
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
  await page
    .getByRole('dialog')
    .getByLabel('Image', { exact: true })
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('dialog').getByRole('button', { name: 'Ok' }).click();

  await expect
    .poll(async () => String((await drawings(page))[0]?.style.src ?? '').slice(0, 11))
    .toBe('data:image/');
  expect(errors).toEqual([]);
});
