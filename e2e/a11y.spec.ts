import { expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/?feed=synthetic');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { chart?: { store: { length: number } } }).chart?.store.length,
  );
});

test('modal has dialog semantics, traps Tab and restores focus on close', async ({ page }) => {
  const opener = page.getByRole('button', { name: 'Keyboard shortcuts' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const labelledBy = await dialog.getAttribute('aria-labelledby');
  expect(labelledBy).toBeTruthy();
  await expect(page.locator(`[id="${labelledBy}"]`)).toHaveText(/Keyboard shortcuts/);

  // Focus starts inside and never leaves, in either direction.
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  expect(await inside()).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await inside()).toBe(true);
  }
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('a re-rendering parent does not take Escape or Tab from the nested modal', async ({
  page,
}) => {
  // Hold the template list so the Settings dialog re-renders (new onClose closure)
  // after the "Save chart template" prompt has opened on top of it.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/chart-templates', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await held;
    await route.fulfill({ json: [] });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Template', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save as…' }).click();
  const prompt = page.getByRole('dialog', { name: 'Save chart template' });
  await expect(prompt).toBeVisible();

  release();
  await page.waitForTimeout(300);

  const inPrompt = () => page.evaluate(() => !!document.activeElement?.closest('.io-prompt'));
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await inPrompt()).toBe(true);
  }

  // Escape closes the prompt only; Settings stays.
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});

test('dock tabs use tablist semantics and arrow keys', async ({ page }) => {
  await expect(page.getByRole('tablist', { name: 'Panels' })).toBeVisible();
  const watchlist = page.getByRole('tab', { name: 'Watchlist' });
  await watchlist.click();
  await expect(watchlist).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  const details = page.getByRole('tab', { name: 'Details' });
  await expect(details).toBeFocused();
  await expect(details).toHaveAttribute('aria-selected', 'true');
  await expect(watchlist).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Details');

  await page.keyboard.press('ArrowLeft');
  await expect(watchlist).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Notes' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(watchlist).toBeFocused();
});

test('chart host is an image named by symbol and interval', async ({ page }) => {
  const host = page.getByRole('img', { name: /^Chart: .+, .+$/ });
  await expect(host).toBeVisible();
  const symbol = await page.evaluate(() =>
    (window as unknown as { chart: { getSymbol(): string } }).chart.getSymbol(),
  );
  await expect(host).toHaveAttribute('aria-label', new RegExp(`^Chart: ${symbol}, `));
  await expect(page.locator('[role="status"][aria-live="polite"]').first()).toBeAttached();
});

test('toggle buttons expose their pressed state', async ({ page }) => {
  const stay = page.getByRole('button', { name: 'Stay in drawing mode' });
  await expect(stay).toHaveAttribute('aria-pressed', 'false');
  await stay.click();
  await expect(stay).toHaveAttribute('aria-pressed', 'true');
});
