import type { Page } from '@playwright/test';
import { expect, test, openChartSettings } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

async function open(page: Page) {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);
}

test('loads, shows legend and crosshair', async ({ page }) => {
  await open(page);
  await page.mouse.move(700, 400);
  await expect(page.locator('.io-legend').first()).toContainText('O');
  const info = await page.evaluate(() => window.chart.getState());
  expect(info.symbol).toBeTruthy();
});

test('panning into history lazy-loads older bars without moving the view', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => window.chart.store.length);
  await page.evaluate(() => window.chart.timeScale.setBarSpacing(1));
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(200, 300);
    await page.mouse.down();
    await page.mouse.move(1300, 300, { steps: 5 });
    await page.mouse.up();
  }
  // Time under a fixed x must not change when history is prepended.
  const timeAt = () =>
    page.evaluate(() => {
      const c = window.chart;
      return c.store.time[c.timeScale.xToIndex(700)];
    });
  // Let kinetic scrolling stop: the time under x stays the same for 10 frames in a row.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const at = () => {
          const c = window.chart;
          return c.store.time[c.timeScale.xToIndex(700)];
        };
        let last = at();
        let stable = 0;
        const frame = () => {
          const now = at();
          stable = now === last ? stable + 1 : 0;
          last = now;
          if (stable >= 10) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
  const t0 = await timeAt();
  await page.waitForFunction((n) => window.chart.store.length > n, before);
  expect(await timeAt()).toBe(t0);
});

test('wheel zoom changes bar spacing, double-click time axis resets', async ({ page }) => {
  await open(page);
  const s0 = await page.evaluate(() => window.chart.timeScale.barSpacing);
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, -400);
  const s1 = await page.evaluate(() => window.chart.timeScale.barSpacing);
  expect(s1).toBeGreaterThan(s0);
  const box = (await page.locator('.io-time-axis').boundingBox())!;
  await page.mouse.dblclick(box.x + 300, box.y + 10);
  expect(await page.evaluate(() => window.chart.timeScale.barSpacing)).toBeCloseTo(s0);
});

test('price axis drag disables auto-scale; double-click restores it', async ({ page }) => {
  await open(page);
  const axis = (await page.locator('.io-price-axis').first().boundingBox())!;
  const x = axis.x + axis.width / 2;
  await page.mouse.move(x, axis.y + 200);
  await page.mouse.down();
  await page.mouse.move(x, axis.y + 300, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.chart.getState().panes[0]!.priceScale.autoScale)).toBe(
    false,
  );
  await page.mouse.dblclick(x, axis.y + 200);
  expect(await page.evaluate(() => window.chart.getState().panes[0]!.priceScale.autoScale)).toBe(
    true,
  );
});

test('benchmark: 100k bars pan/zoom stays near 60fps', async ({ page }) => {
  await open(page);
  // Load the full 100k history up front.
  await page.evaluate(async () => {
    window.chart.applyOptions({ pageSize: 100_000 });
    await window.chart.setSymbolAndInterval('BENCH', '1D');
  });
  expect(await page.evaluate(() => window.chart.store.length)).toBe(100_000);
  // Zoom fully out (most bars visible = worst case) and animate pans.
  const result = await page.evaluate(async () => {
    const chart = window.chart;
    chart.timeScale.setBarSpacing(0.5);
    const times: number[] = [];
    let last = performance.now();
    await new Promise<void>((resolve) => {
      let frames = 0;
      const tick = (t: number) => {
        times.push(t - last);
        last = t;
        chart.timeScale.pan(frames % 2 ? -40 : 40);
        chart.timeScale.zoom(chart.paneWidth / 2, frames % 20 < 10 ? 1.02 : 1 / 1.02);
        chart.viewChanged();
        if (++frames < 240) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    return {
      p50: times[Math.floor(times.length / 2)]!,
      p95: times[Math.floor(times.length * 0.95)]!,
    };
  });
  console.log(`frame time p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms`);
  expect(result.p50).toBeLessThan(20);
});

test('Settings > Status line: turning OHLC off removes the values from the legend', async ({
  page,
}) => {
  await open(page);
  const legend = page.locator('.io-legend-info').first();
  const labels = legend.locator('.io-legend-label', { hasText: /^[OHLC]$/ });
  await expect(labels).toHaveCount(4);
  await expect(legend).toContainText('%');
  await openChartSettings(page);
  await page.getByRole('tab', { name: 'Legend' }).click();
  await page.getByLabel('Open, high, low and close').uncheck();
  // The title and the change stay; the four values are gone.
  await expect(labels).toHaveCount(0);
  await expect(legend).toContainText('%');
  await page.getByRole('button', { name: 'Ok' }).click();
  await expect(labels).toHaveCount(0);
});

test('axis controls: range chips over the time axis, scale toggles in the axes corner, session in the header', async ({
  page,
}) => {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(
    () => (window as unknown as { chart?: { store: { length: number } } }).chart?.store.length,
  );
  const chart = () =>
    page.evaluate(() => {
      const c = (
        window as unknown as {
          chart: {
            getInterval(): string;
            getState(): { panes: { priceScale: { mode: string } }[] };
          };
        }
      ).chart;
      return { interval: c.getInterval(), mode: c.getState().panes[0]!.priceScale.mode };
    });

  await page
    .getByRole('group', { name: 'Range presets' })
    .getByRole('button', { name: '1Y' })
    .click();
  await expect.poll(async () => (await chart()).interval).toBe('1D');

  const scale = page.getByRole('group', { name: 'Price scale' });
  await scale.getByRole('button', { name: 'Log scale' }).click();
  await expect.poll(async () => (await chart()).mode).toBe('log');
  await expect(scale.getByRole('button', { name: 'Log scale' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const session = page.getByRole('group', { name: /symbol/i }).getByRole('button', { name: 'RTH' });
  await session.click();
  await expect(page.getByRole('button', { name: 'ETH' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.range-strip')).toHaveCount(0);
});

test('symbol card on the chart; a legend chip click opens its settings in the Inspector', async ({
  page,
}) => {
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(
    () => (window as unknown as { chart?: { store: { length: number } } }).chart?.store.length,
  );
  const card = page.locator('.chart-cell').getByRole('group', { name: 'Symbol summary' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: /^Symbol search/ })).toBeVisible();
  // The card sits in the main pane's legend, above the engine's OHLC line.
  const legend = page.locator('.io-legend').first();
  await expect(legend.locator('.io-legend-header .sc-card')).toHaveCount(1);

  const chip = page.locator('.ind-legend-row').first();
  await chip.locator('.ind-legend-open').click();
  await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Inputs' })).toBeVisible();
});
