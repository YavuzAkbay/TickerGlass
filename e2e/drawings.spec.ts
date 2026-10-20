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

test('draw a trend line, restyle, drag, undo, persist across reload, delete', async ({ page }) => {
  // Start without stored drawings, but keep them across the reload below.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('drw-e2e')) return;
    sessionStorage.setItem('drw-e2e', '1');
    localStorage.removeItem('investopen-drawings');
    localStorage.removeItem('investopen-drawing-templates');
  });
  await page.goto('/?feed=synthetic');
  await waitForChart(page);

  // Pick the tool and draw with two clicks.
  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBe('trend-line');
  await page.mouse.click(500, 300);
  await page.mouse.click(800, 420);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  // Back to the cursor after one drawing.
  expect(await page.evaluate(() => window.chart.getActiveTool())).toBeNull();

  // Select it by clicking the line; the floating toolbar appears.
  await page.keyboard.press('Escape'); // clears the selection
  await expect.poll(() => page.evaluate(() => window.chart.getSelection().length)).toBe(0);
  await page.mouse.click(650, 360);
  await expect.poll(() => page.evaluate(() => window.chart.getSelection().length)).toBe(1);
  const toolbar = page.getByRole('toolbar', { name: 'Drawing toolbar' });
  await expect(toolbar).toBeVisible();

  // Change the colour from the floating toolbar.
  await toolbar.getByRole('button', { name: /^Line color/ }).click();
  await page.getByRole('option', { name: '#e5484d' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await drawings(page))[0]!.style.lineColor).toBe('#e5484d');
  const placed = (await drawings(page))[0]!.points;

  // Drag the line up.
  await page.mouse.move(650, 360);
  await page.mouse.down();
  await page.mouse.move(650, 300, { steps: 6 });
  await page.mouse.move(650, 260, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => (await drawings(page))[0]!.points[0]!.price)
    .toBeGreaterThan(placed[0]!.price);

  // Undo the drag (colour change stays).
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await drawings(page))[0]!.points).toEqual(placed);
  expect((await drawings(page))[0]!.style.lineColor).toBe('#e5484d');

  // Reload: the drawing comes back from localStorage.
  await page.reload();
  await waitForChart(page);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);
  const restored = (await drawings(page))[0]!;
  expect(restored.type).toBe('trend-line');
  expect(restored.style.lineColor).toBe('#e5484d');
  expect(restored.points).toEqual(placed);

  // Select and delete with the keyboard.
  await page.mouse.click(650, 360);
  await expect.poll(() => page.evaluate(() => window.chart.getSelection().length)).toBe(1);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
  await expect(toolbar).toHaveCount(0);
});

test('object tree lists drawings and indicators without crashing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.addInitScript(() => {
    localStorage.removeItem('investopen-drawings');
    localStorage.removeItem('investopen-indicators');
  });
  await page.goto('/?feed=synthetic');
  await waitForChart(page);

  // An indicator in its own pane (RSI if registered, otherwise SMA on main).
  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Relative Strength Index');
  if ((await page.locator('.ind-row').count()) === 0) await search.fill('Simple Moving Average');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // New charts also show the default Volume indicator.
  await expect.poll(() => page.evaluate(() => window.chart.getStudies().length)).toBe(2);
  const study = await page.evaluate(() => window.chart.getStudies().at(-1)!.title);

  // A drawing.
  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  await page.mouse.click(500, 250);
  await page.mouse.click(700, 300);
  await expect.poll(async () => (await drawings(page)).length).toBe(1);

  // Open the Object tree panel: one row per drawing and the study's series.
  await page.getByRole('button', { name: 'Object tree' }).click();
  const tree = page.getByRole('tree', { name: 'Object tree' });
  await expect(tree).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Trend line' })).toHaveCount(1);
  await expect(tree.getByText(study, { exact: false }).first()).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Main pane' })).toBeVisible();

  // The tree follows store changes (remove from the row) and keeps working.
  await tree.getByRole('button', { name: 'Remove Trend line' }).click();
  await expect.poll(async () => (await drawings(page)).length).toBe(0);
  await expect(tree.getByText('No drawings')).toBeVisible();
  expect(errors).toEqual([]);
});
