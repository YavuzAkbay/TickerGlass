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
