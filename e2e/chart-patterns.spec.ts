import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

/** One shape output per pattern kind, in definition order. */
const LABEL_IDS = [
  'dblTop',
  'dblBot',
  'triTop',
  'triBot',
  'hs',
  'ihs',
  'ascTri',
  'descTri',
  'symTri',
  'risWed',
  'falWed',
  'rect',
];

/** Clear persisted indicators, load the synthetic feed and add Chart Patterns. */
async function addChartPatterns(page: Page) {
  await page.addInitScript(() => localStorage.removeItem('tickerglass-indicators'));
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);

  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await expect(search).toBeVisible();
  await search.fill('chart patterns');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const row = page.locator('.ind-legend-row', { hasText: 'Patterns' });
  await expect(row).toHaveCount(1);
  return row;
}

/** The Chart Patterns study (id = the instance id, `chart-patterns_*`). */
const patternsStudy = (page: Page) =>
  page.evaluate(() => window.chart.getStudies().find((s) => s.id.startsWith('chart-patterns')));

test('adds Chart Patterns and renders its legend and study data', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The synthetic feed logs benign network/resource noise; only app errors matter.
    if (/net::|failed to load resource|err_|favicon/i.test(m.text())) return;
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const row = await addChartPatterns(page);
  expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(2); // Volume + Patterns

  const study = (await patternsStudy(page))!;
  expect(study).toBeTruthy();
  // Legend value slots render per output; outside patterns the boundaries are
  // NaN (shown as "∅"), so only their presence is asserted, not a number.
  await expect(row.locator('.ind-legend-value').first()).toBeVisible();

  // The full output set: zone fill, boundaries, pivot skeleton and one label per kind.
  const outputs = await page.evaluate(
    (id) => window.chart.getStudyData(id)?.spec.outputs.map((o) => o.id) ?? null,
    study.id,
  );
  expect(outputs).toEqual(['zone', 'upper', 'lower', 'zz', ...LABEL_IDS]);

  // The pivot skeleton has data: a ZigZag value at every pivot of the random walk.
  await expect
    .poll(() =>
      page.evaluate((id) => {
        const zz = window.chart.getStudyData(id)?.values.zz;
        if (!zz) return 0;
        let n = 0;
        for (let i = 0; i < zz.length; i++) if (!Number.isNaN(zz[i]!)) n++;
        return n;
      }, study.id),
    )
    .toBeGreaterThan(0);

  expect(pageErrors, 'no uncaught exceptions').toEqual([]);
  expect(
    consoleErrors.filter((t) => /chart-patterns|indicators|react/i.test(t)),
    'no console errors about the indicator or React',
  ).toEqual([]);
});

test('settings panel shows the pattern inputs and style outputs', async ({ page }) => {
  const row = await addChartPatterns(page);

  await row.hover();
  await row.getByRole('button', { name: 'Settings' }).click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();

  for (const label of [
    'Price deviation for reversals (%)',
    'Pivot legs',
    'Pattern match tolerance (%)',
    'Max pattern length (bars)',
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toBeVisible();
  }

  // Style: one entry per output, including the pattern labels.
  await page.getByRole('tab', { name: 'Style' }).click();
  for (const title of [
    'Pivot Lines',
    'Upper Boundary',
    'Lower Boundary',
    'Zone',
    'Double Top',
    'Head & Shoulders',
  ]) {
    await expect(page.getByLabel(title, { exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(inspector).toHaveCount(0);
});

test('visual: chart with Chart Patterns and its Style tab (SHOTS=1)', async ({ page }) => {
  test.skip(process.env.SHOTS !== '1', 'screenshots are only captured with SHOTS=1');
  const row = await addChartPatterns(page);

  // A longer window: the pivot skeleton and any detected pattern span more bars.
  await page
    .getByRole('group', { name: 'Range presets' })
    .getByRole('button', { name: '3M' })
    .click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'e2e/.artifacts/chart-patterns-3m.png', fullPage: false });

  await row.hover();
  await row.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Style' }).click();
  await expect(page.getByLabel('Pivot Lines', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'e2e/.artifacts/chart-patterns-style.png', fullPage: false });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0);
});
