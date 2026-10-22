/**
 * Shared Playwright fixtures. Every spec imports `test` from here (not from
 * @playwright/test): the auto `server` fixture routes the user-data API to an
 * in-test mock for every page, so e2e never writes to a real backend, and
 * fails the test if the app made an API call the sandbox does not cover.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { MockServer, mockPersistence } from './persistence';

export const test = base.extend<{ server: MockServer }>({
  // Start with the Navigator collapsed so coordinate-based specs get the full chart width.
  // Seeds only a fresh profile; specs that clear storage and reload keep this default.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('tickerglass-ui') !== null) return;
      localStorage.setItem(
        'tickerglass-ui',
        JSON.stringify({ state: { navOpen: false, navSection: 'watchlist' }, version: 3 }),
      );
    });
    await use(page);
  },
  server: [
    async ({ page }, use) => {
      const server = new MockServer();
      await mockPersistence(page, server);
      await use(server);
      expect(server.unhandled, 'API calls outside the e2e sandbox').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Click `name` in the top bar "More" menu. */
export async function openOverflowItem(page: Page, name: string) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}

/** Open the chart settings dialog through the "More" menu. */
export async function openChartSettings(page: Page) {
  await openOverflowItem(page, 'Settings');
}

/** Arm a drawing tool from its dock category ("Lines", "Shapes", "Text", "Measure", "Patterns"). */
export async function pickTool(page: Page, category: string, name: string) {
  await page.getByRole('button', { name: category, exact: true }).click();
  await page
    .getByRole('menu', { name: category })
    .getByRole('menuitem')
    .filter({ has: page.locator('.lt-fly-name').getByText(name, { exact: true }) })
    .click();
}
