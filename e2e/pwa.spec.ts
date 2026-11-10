import { expect, test } from './fixtures';

test('serves the web app manifest, icons and favicon', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const manifest = (await res.json()) as {
    display: string;
    icons: { src: string }[];
  };
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    const iconRes = await page.request.get(icon.src);
    expect(iconRes.ok(), `icon ${icon.src}`).toBeTruthy();
  }
  expect((await page.request.get('/favicon.svg')).ok()).toBeTruthy();
});

test('the service worker serves the app shell offline', async ({ page }) => {
  await page.goto('/');
  // main.tsx registers the worker in production builds only; the e2e dev server
  // gets an explicit registration to exercise the same /sw.js file.
  await page.evaluate(() => void navigator.serviceWorker.register('/sw.js'));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 10_000,
  });
  // The install step caches the shell; give it a beat after the controller appears.
  await page.waitForTimeout(250);
  await page.context().setOffline(true);
  try {
    await page.reload();
    // The shell (not a browser error page) comes from the cache: the title proves it.
    await expect(page).toHaveTitle('TickerGlass');
  } finally {
    await page.context().setOffline(false);
  }
});
