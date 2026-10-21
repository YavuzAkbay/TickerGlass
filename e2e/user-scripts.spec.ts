/**
 * User scripts end to end (docs/plans/user-scripts.md §8): the editor dialog, the
 * per-instance sandbox worker, the watchdog and the saved-chart round trip, against the
 * in-test mock of /api/user-scripts* (e2e/persistence.ts).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { firstChart } from './persistence';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
    /** Set by `takeOverLiveFeed`: pushes a bar into the chart like a live feed would. */
    __pushBar?: (bar: Record<string, number>) => void;
  }
}

/** Source whose `step` body sits on line 7 (the plan's "throw on line 7"). */
function scriptSource(stepBody: string, setupBody = ''): string {
  return [
    "defineIndicator({ name: 'E2E Script', shortName: 'E2EX', category: 'trend', overlay: true,", // 1
    '  inputs: {},', // 2
    "  outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#6E9BD6' }],", // 3
    `  setup() { ${setupBody}`, // 4
    '    return (c) => {', // 5
    '      c.set("v", c.close[c.i]);', // 6
    `      ${stepBody}`, // 7
    '    };', // 8
    '  },', // 9
    '});', // 10
    '',
  ].join('\n');
}

const GOOD = scriptSource('');

const ready = (page: Page) => page.waitForFunction(() => window.chart?.store.length > 0);
const scriptRow = (page: Page) => page.locator('.ind-legend-row', { hasText: 'E2EX' });
const smaRow = (page: Page) => page.locator('.ind-legend-row', { hasText: 'SMA' });
const editor = (page: Page) => page.locator('.se-dialog');

async function open(page: Page) {
  await page.addInitScript(() => localStorage.removeItem('tickerglass-indicators'));
  await page.goto('/?feed=synthetic');
  await ready(page);
}

/** Indicators dialog → Custom → New script: leaves the editor open with the template. */
async function openNewScriptEditor(page: Page) {
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  await page.locator('.dlg-side-item', { hasText: 'Custom' }).click();
  await page.getByRole('button', { name: 'New script' }).click();
  await expect(editor(page)).toBeVisible();
}

/** Replaces the editor's source. */
async function setSource(page: Page, source: string) {
  await editor(page).getByLabel('Script source').fill(source);
}

/** Creates a script through the UI and adds it to the chart ("Add to chart" saves first). */
async function createAndAdd(page: Page, source: string) {
  await openNewScriptEditor(page);
  await setSource(page, source);
  await editor(page).getByRole('button', { name: 'Add to chart' }).click();
  await expect(scriptRow(page)).toHaveCount(1);
}

async function closeDialogs(page: Page) {
  await page.keyboard.press('Escape'); // editor
  // An unsaved draft (the editor opens a fresh one after a delete) asks before closing.
  const discard = page.getByRole('button', { name: 'Discard' });
  if (await discard.isVisible()) await discard.click();
  await page.keyboard.press('Escape'); // Indicators dialog
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function addSma(page: Page) {
  await page.getByRole('button', { name: 'Indicators', exact: true }).click();
  const search = page.getByLabel('Search indicators');
  await search.fill('Simple Moving Average');
  await expect(page.locator('.ind-row').first()).toBeVisible();
  await search.press('Enter');
  await page.keyboard.press('Escape');
  await expect(smaRow(page)).toHaveCount(1);
}

/**
 * The synthetic feed never ticks. Swap in a subscription we control and resubscribe, so
 * `__pushBar` delivers live bars through the chart's real live path.
 */
async function takeOverLiveFeed(page: Page) {
  await page.evaluate(async () => {
    const chart = window.chart as unknown as {
      feed: { subscribe: (...a: unknown[]) => () => void };
      reload(): Promise<void>;
    };
    chart.feed.subscribe = (_req, _last, onBar) => {
      window.__pushBar = onBar as (bar: Record<string, number>) => void;
      return () => {};
    };
    await chart.reload();
  });
  await page.waitForFunction(() => typeof window.__pushBar === 'function');
}

/** A live update of the last bar with a new close. */
async function tickLast(page: Page, close: number) {
  await page.evaluate((c) => {
    const s = window.chart.store;
    const i = s.length - 1;
    window.__pushBar!({
      time: s.time[i]!,
      open: s.open[i]!,
      high: Math.max(s.high[i]!, c),
      low: Math.min(s.low[i]!, c),
      close: c,
      volume: s.volume[i]!,
    });
  }, close);
}

test.describe('user scripts', () => {
  test('create, save and add to chart from the editor: legend value, POST recorded', async ({
    page,
    server,
  }) => {
    await open(page);
    await openNewScriptEditor(page);
    // The New script template (SMA cross) is saved and added as it is.
    await editor(page).getByRole('button', { name: 'Add to chart' }).click();

    const row = page.locator('.ind-legend-row', { hasText: 'SMA X' });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.ind-legend-value').first()).toHaveText(/\d/);
    expect(server.log.filter((l) => l.startsWith('POST /user-scripts'))).toHaveLength(1);
    expect(server.userScripts.size).toBe(1);
    const saved = [...server.userScripts.values()][0]!;
    expect(saved.source).toContain("name: 'SMA Cross'");
    expect(saved.manifest).not.toBeNull();
    expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(2); // + Volume
  });

  test('a throw inside step on line 7 shows "line 7" in the legend', async ({ page }) => {
    await open(page);
    await createAndAdd(page, GOOD);
    await expect(scriptRow(page).locator('.ind-legend-value').first()).toHaveText(/\d/);

    await setSource(page, scriptSource("throw new Error('boom');"));
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();

    const error = scriptRow(page).locator('.ind-legend-error');
    await expect(error).toContainText('line 7');
    await expect(error).toContainText('boom');
  });

  test('a script that loops forever at load is saved without a manifest and says why', async ({
    page,
    server,
  }) => {
    await open(page);
    await openNewScriptEditor(page);
    await setSource(page, `while (true) {}\n${GOOD}`);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    const message = 'Script did not finish loading within 10 s (endless loop?)';
    await expect(editor(page).locator('.se-diag-msg', { hasText: message })).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(page.locator('.io-toast', { hasText: message })).toHaveCount(1);
    const saved = [...server.userScripts.values()][0]!;
    expect(saved.manifest).toBeNull();
  });

  test('an endless loop in step is stopped by the watchdog; builtin SMA keeps updating', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await open(page);
    await takeOverLiveFeed(page);
    await addSma(page);
    // The editor's save runs the script once on sample data (its `load`), and a script that
    // loops unconditionally never gets a manifest (it cannot be added). So the loop is
    // gated on a close that no historical bar has: the live tick below springs it.
    await createAndAdd(page, scriptSource('if (c.close[c.i] > 1e6) { while (true) {} }'));
    await closeDialogs(page);

    await expect(scriptRow(page).locator('.ind-legend-value').first()).toHaveText(/\d/);

    const value = () => smaRow(page).locator('.ind-legend-value').first().textContent();
    const before = await value();
    await tickLast(page, 2e6); // the script's loop starts; SMA sees a huge close too
    // About 7 s: the 5 s watchdog plus slack (bound generous against CI noise).
    await expect(scriptRow(page).locator('.ind-legend-error')).toHaveText(/^Stopped/, {
      timeout: 15_000,
    });

    // The builtin runs in another worker, so it moved with that tick and still follows more.
    expect(await value()).not.toBe(before);
    const afterFirst = await value();
    await tickLast(page, 3e6);
    await expect.poll(value).not.toBe(afterFirst);
  });

  test('fetch() in setup sends no request; import() is a documented dev-only exposure', async ({
    page,
    server,
  }) => {
    await open(page);
    const importHits: string[] = [];
    // Registered after the fixture's /api mock, so it wins for this URL (as in sandbox.spec.ts).
    await page.route(
      (url) => url.pathname === '/api/layouts' && url.searchParams.get('x') === '1',
      async (route) => {
        importHits.push(route.request().url());
        await route.fulfill({ contentType: 'text/javascript', body: 'export default 1;' });
      },
    );
    const layoutGets = () => server.log.filter((l) => l === 'GET /layouts').length;
    const before = layoutGets();

    const setup =
      "try { fetch('/api/layouts'); } catch (e) {} " +
      "try { import('/api/layouts?x=1').catch(() => {}); } catch (e) {} " +
      'return (c) => { c.set("v", c.close[c.i]); };';
    const source = [
      "defineIndicator({ name: 'E2E Script', shortName: 'E2EX', category: 'trend', overlay: true,",
      '  inputs: {},',
      "  outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#6E9BD6' }],",
      `  setup() { ${setup} },`,
      '});',
      '',
    ].join('\n');
    await createAndAdd(page, source);
    // The sandbox ran setup and produced values, so the attempts were made.
    await expect(scriptRow(page).locator('.ind-legend-value').first()).toHaveText(/\d/);
    await page.waitForTimeout(500); // let any stray request surface

    expect(layoutGets(), 'GET /api/layouts caused by fetch() in the sandbox').toBe(before);
    // Dev serves the worker as same-origin modules and needs script-src 'self'; builds
    // block it (sandbox.spec.ts).
    const isBuild = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((e) => e.name.includes('/assets/')),
    );
    if (isBuild) {
      expect(importHits).toEqual([]);
    } else {
      test
        .info()
        .annotations.push({ type: 'dev-only exposure', description: 'same-origin import()' });
      // At least one: the editor's throwaway load sandbox and the chart's instance sandbox
      // both run setup.
      expect(importHits.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('reload restores the script instance with a value', async ({ page, server }) => {
    await open(page);
    await createAndAdd(page, GOOD);
    await closeDialogs(page);
    await expect(scriptRow(page).locator('.ind-legend-value').first()).toHaveText(/\d/);
    const id = [...server.userScripts.keys()][0]!;
    await expect
      .poll(() => {
        const l = server.current();
        return ((firstChart(l?.state)?.indicators ?? []) as { type: string }[]).map((i) => i.type);
      })
      .toContain(`user:${id}`);
    await expect(page.getByRole('button', { name: /^Layout:/ })).not.toHaveAttribute(
      'aria-label',
      /unsaved/,
    );

    await page.reload();
    await ready(page);
    await expect(scriptRow(page)).toHaveCount(1);
    await expect(scriptRow(page).locator('.ind-legend-value').first()).toHaveText(/\d/);
    await expect(scriptRow(page).locator('.ind-legend-error')).toHaveCount(0);
  });

  test.describe('delete from the editor', () => {
    async function deleteCurrent(page: Page, alsoRemove: boolean) {
      await page.getByRole('button', { name: 'Indicators', exact: true }).click();
      await page.locator('.dlg-side-item', { hasText: 'Custom' }).click();
      await page.getByRole('button', { name: 'Edit script E2E Script' }).first().click();
      await expect(editor(page)).toBeVisible();
      await editor(page).getByRole('button', { name: 'Delete script' }).click();
      const confirm = page.locator('.io-prompt');
      const box = confirm.getByRole('checkbox');
      await expect(box).toBeChecked(); // default: also remove from the chart
      await box.setChecked(alsoRemove);
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(confirm).toHaveCount(0);
    }

    test('confirm checkbox off: the instance stays and reads "Script deleted"', async ({
      page,
      server,
    }) => {
      await open(page);
      await createAndAdd(page, GOOD);
      await closeDialogs(page);
      await deleteCurrent(page, false);
      await closeDialogs(page);

      expect(server.userScripts.size).toBe(0);
      await expect(scriptRow(page)).toHaveCount(0); // short name is unknown without the script
      // The instance stays in the layout (it comes back if the script is restored), so its
      // engine study stays too, with the error in the legend.
      expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(2); // + Volume
      const errored = page.locator('.ind-legend-error', { hasText: 'Script deleted' });
      await expect(errored).toHaveCount(1);
    });

    test('confirm checkbox on: the instance is removed from the chart', async ({
      page,
      server,
    }) => {
      await open(page);
      await createAndAdd(page, GOOD);
      await closeDialogs(page);
      await deleteCurrent(page, true);
      await closeDialogs(page);

      expect(server.userScripts.size).toBe(0);
      await expect(page.locator('.ind-legend-row')).toHaveCount(1); // Volume only
      await expect(page.locator('.ind-legend-error')).toHaveCount(0);
      expect(await page.evaluate(() => window.chart.getStudies().length)).toBe(1);
    });
  });
});
