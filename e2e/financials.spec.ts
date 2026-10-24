import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const FEED = '/?feed=synthetic';

/** Mocks /api/fundamentals/* with a payload the test fills in once bar times are known. */
async function mockFundamentals(page: Page) {
  const state: { body: unknown; calls: string[] } = { body: null, calls: [] };
  await page.route('**/api/fundamentals/**', (route) => {
    state.calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: state.body });
  });
  return state;
}

/** Statement period ends that straddle the chart: at its start, mid and last bar. */
async function periodsAroundBars(page: Page): Promise<string[]> {
  const times = await page.evaluate(() => {
    const s = window.chart.store;
    const n = s.length;
    return [s.time[0]!, s.time[Math.floor(n / 2)]!, s.time[n - 1]!];
  });
  return times.map((t) => new Date(t * 1000).toISOString().slice(0, 10));
}

/** Adds the indicator whose dialog name is exactly `name`. */
async function addIndicator(page: Page, name: string) {
  await page.getByRole('button', { name: 'Indicators', exact: false }).first().click();
  const search = page.getByLabel('Search indicators');
  await search.fill(name);
  await page.locator('.ind-row-name', { hasText: new RegExp(`^${name}$`) }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const legendRow = (page: Page, short: string) =>
  page.locator('.ind-legend-row', { has: page.locator('.ind-legend-name', { hasText: short }) });

test.beforeEach(async ({ page }) => {
  await page.goto(FEED);
  await page.waitForFunction(() => window.chart?.store.length > 0);
});

test('revenue: quarterly statements load and plot on the chart', async ({ page }) => {
  const state = await mockFundamentals(page);
  const periods = await periodsAroundBars(page);
  state.body = {
    info: {},
    financials: {
      quarterly: {
        income: {
          periods: [periods[0]!, periods[1]!],
          rows: { 'Total Revenue': [1.2e9, 1.5e9] },
        },
      },
    },
  };

  await addIndicator(page, 'Revenue');
  const row = legendRow(page, 'Revenue');
  await expect(row).toHaveCount(1);
  await expect.poll(() => state.calls.length).toBeGreaterThan(0);
  // The last bar sits after the second period end: the newer quarter shows,
  // and the TTM plot stays empty with fewer than four quarters.
  const last = async () =>
    page.evaluate(() => {
      const chart = window.chart;
      const study = chart.getStudies().find((s) => s.title.startsWith('Revenue'));
      return study
        ? chart
            .getStudyValues(study.id, chart.store.length - 1)
            .map((v) => v.text || '∅')
            .join(' ')
        : '';
    });
  await expect.poll(last).toContain('1.5B');
  await expect.poll(last).toContain('∅');
});

test('a symbol without statements shows the error in the legend', async ({ page }) => {
  const state = await mockFundamentals(page);
  state.body = { info: {}, financials: { quarterly: {} } };
  await addIndicator(page, 'Earnings Per Share');
  const row = legendRow(page, 'EPS');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.ind-legend-error')).toHaveText(
    /No quarterly (diluted EPS|net income) data/,
  );
});
