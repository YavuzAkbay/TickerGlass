import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@investopen/engine').Chart;
  }
}

const ready = (page: Page) => page.waitForFunction(() => window.chart?.store.length > 0);

/** Wait until the app finished restoring (the layout button shows a name). */
async function restored(page: Page, name = 'Untitled') {
  await ready(page);
  await expect(page.getByRole('button', { name: new RegExp(`^Layout: ${name}`) })).toBeVisible();
}

async function addSma(page: Page) {
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Moving Average Simple');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(smaRow(page)).toHaveCount(1);
}

const smaRow = (page: Page) => page.locator('.ind-legend-row', { hasText: 'SMA' });

const layoutButton = (page: Page) => page.getByRole('button', { name: /^Layout:/ });

async function layoutMenu(page: Page, item: string) {
  await layoutButton(page).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Server-side saved state of the current layout has settled (no unsaved changes). */
async function saved(page: Page) {
  await expect(layoutButton(page)).not.toHaveAttribute('aria-label', /unsaved/);
}

test('draw + add indicator, reload: restored from the server (not the browser cache)', async ({
  page,
  server,
}) => {
  await page.goto('/?feed=synthetic');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await restored(page);
  expect(server.layouts.size).toBe(1);

  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  await page.mouse.click(500, 300);
  await page.mouse.click(800, 420);
  await expect.poll(() => page.evaluate(() => window.chart.getDrawings().length)).toBe(1);
  await addSma(page);

  // Autosave: the drawing via a batch, the indicator via the layout state.
  await expect.poll(() => server.drawings.size).toBe(1);
  await expect
    .poll(() => {
      const l = [...server.layouts.values()][0]!;
      return (l.state.indicators as { type: string }[]).map((i) => i.type);
    })
    .toEqual(['volume', 'sma']);
  await saved(page);

  // Drop the browser copy: everything must come back from the API.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await restored(page);
  await expect.poll(() => page.evaluate(() => window.chart.getDrawings().length)).toBe(1);
  await expect(smaRow(page)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.chart.getStudies().length)).toBe(2);
});

test('save as a named layout, switch between layouts, delete one', async ({ page, server }) => {
  await page.goto('/?feed=synthetic');
  await restored(page);

  // Save as "Swing" and give it an indicator.
  await layoutMenu(page, 'Save as…');
  const name = page.getByRole('textbox', { name: 'Name' });
  await name.fill('Swing');
  await name.press('Enter');
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /^Layout: Swing/);
  await addSma(page);
  await saved(page);
  expect([...server.layouts.values()].map((l) => l.name).sort()).toEqual(['Swing', 'Untitled']);

  // Load "Untitled": only the default Volume there.
  await layoutMenu(page, 'Load layout…');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('option')).toHaveCount(2);
  await dialog.getByLabel('Search layouts').fill('untit');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await dialog.getByRole('option', { name: /Untitled/ }).click();
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /^Layout: Untitled/);
  await expect(page.locator('.ind-legend-row')).toHaveCount(1);
  await expect(smaRow(page)).toHaveCount(0);

  // And back to "Swing" (keyboard: Enter on the filtered row).
  await layoutMenu(page, 'Load layout…');
  await page.getByLabel('Search layouts').fill('swing');
  await expect(page.getByRole('option', { name: /Swing/ })).toBeVisible();
  await page.getByLabel('Search layouts').press('Enter');
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /^Layout: Swing/);
  await expect(smaRow(page)).toHaveCount(1);

  // Rename, then delete "Untitled" from the list.
  await layoutMenu(page, 'Rename…');
  await page.getByRole('textbox', { name: 'Name' }).fill('Swing 2');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /^Layout: Swing 2/);

  await layoutMenu(page, 'Load layout…');
  await page.getByRole('button', { name: 'Delete layout Untitled' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('option')).toHaveCount(1);
  expect([...server.layouts.values()].map((l) => l.name)).toEqual(['Swing 2']);

  // After a reload the last-used layout opens.
  await page.keyboard.press('Escape');
  await page.reload();
  await restored(page, 'Swing 2');
  await expect(smaRow(page)).toHaveCount(1);
});

test('export the layout and all data as downloads', async ({ page }) => {
  await page.goto('/?feed=synthetic');
  await restored(page);

  let download = page.waitForEvent('download');
  await layoutMenu(page, 'Export layout');
  let file = await download;
  expect(file.suggestedFilename()).toBe('Untitled.layout.json');
  const layout = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(layout).toMatchObject({ version: 1, kind: 'layout', layout: { name: 'Untitled' } });

  download = page.waitForEvent('download');
  await layoutMenu(page, 'Export all data');
  file = await download;
  expect(file.suggestedFilename()).toMatch(/^investopen-backup-\d{4}-\d\d-\d\d\.json$/);
  const bundle = JSON.parse(await readFile((await file.path())!, 'utf8'));
  expect(bundle).toMatchObject({ version: 1, app: 'investopen' });
  expect(bundle.layouts).toHaveLength(1);
});

test('API down: works from the browser copy, syncs when the server is back', async ({
  page,
  server,
}) => {
  server.down = true;
  await page.goto('/?feed=synthetic');
  await ready(page);
  await expect(page.getByText(/Server unreachable/)).toBeVisible();
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /Layout: Untitled/);

  await page.getByRole('button', { name: 'Trend line', exact: true }).click();
  await page.mouse.click(500, 300);
  await page.mouse.click(800, 420);
  await expect.poll(() => page.evaluate(() => window.chart.getDrawings().length)).toBe(1);
  await expect(layoutButton(page)).toHaveAttribute('aria-label', /unsaved/);

  // Back online: the queued drawing reaches the server.
  server.down = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => server.drawings.size, { timeout: 15_000 }).toBe(1);
  await expect(page.getByText(/Server reachable again/)).toBeVisible();
  await saved(page);
});
