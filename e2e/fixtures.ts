/**
 * Shared Playwright fixtures. Every spec imports `test` from here (not from
 * @playwright/test): the auto `server` fixture routes the user-data API to an
 * in-test mock for every page, so e2e never writes to a real backend, and
 * fails the test if the app made an API call the sandbox does not cover.
 */
import { test as base, expect } from '@playwright/test';
import { MockServer, mockPersistence } from './persistence';

export const test = base.extend<{ server: MockServer }>({
  // Start with the Navigator collapsed so coordinate-based specs get the full chart width.
  // Seeds only a fresh profile; specs that clear storage and reload keep this default.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('investopen-ui') !== null) return;
      localStorage.setItem(
        'investopen-ui',
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
