/**
 * Sweep over every registered drawing type: add it through the chart API with
 * a sensible number of anchors spread across the visible bars, let the overlay
 * render it, and require that nothing throws. A sample of types also opens and
 * closes the Inspector settings from the floating toolbar.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare global {
  interface Window {
    chart: import('@tickerglass/engine').Chart;
  }
}

const ENGINE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../packages/engine/src/index.ts',
);

interface ToolInfo {
  type: string;
  name: string;
  /** Anchors to place. */
  count: number;
  /** Anchors hold pane fractions (screen-anchored tools). */
  pane: boolean;
}

async function openFresh(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('drw-e2e')) return;
    sessionStorage.setItem('drw-e2e', '1');
    localStorage.removeItem('tickerglass-drawings');
    localStorage.removeItem('tickerglass-drawing-templates');
  });
  await page.goto('/?feed=synthetic');
  await page.waitForFunction(() => window.chart?.store.length > 0);
}

/** Registered tools with the anchor count the sweep uses for each. */
function listTools(page: Page): Promise<ToolInfo[]> {
  return page.evaluate(async (engine) => {
    const { listDrawingTools } = await import(/* @vite-ignore */ `/@fs${engine}`);
    return listDrawingTools().map((d: import('@tickerglass/engine').AnyDrawingToolDefinition) => {
      const c = d.creation;
      const count =
        c.kind === 'click'
          ? 1
          : c.kind === 'points'
            ? c.count
            : c.kind === 'multi'
              ? Math.min(c.max ?? Infinity, Math.max(c.min, 4))
              : 8;
      return { type: d.type, name: d.name, count, pane: d.coords === 'pane' };
    });
  }, ENGINE);
}

/** Add `tool` with anchors across the last visible bars; returns the stored point count. */
function addSweepDrawing(page: Page, tool: ToolInfo, announce: boolean) {
  return page.evaluate(
    ({ type, count, pane, announce }) => {
      const chart = window.chart;
      const s = chart.store;
      const wobble = [0, 1, -1, 0.5, -0.5];
      const points = Array.from({ length: count }, (_, k) => {
        if (pane)
          return { time: 0.2 + (0.6 * k) / Math.max(count - 1, 1), price: 0.3 + 0.1 * (k % 3) };
        const span = Math.min(60, s.length - 10);
        const i = s.length - 5 - span + Math.round((k * span) / Math.max(count - 1, 1));
        return { time: s.time[i]!, price: s.close[i]! * (1 + 0.04 * wobble[k % 5]!) };
      });
      const d = chart.addDrawing({ type, points });
      if (announce) {
        // Tell the app (store, undo) about it like a drawn one.
        (chart as unknown as { events: { emit(e: string, p: unknown): void } }).events.emit(
          'drawingCreated',
          { drawing: d },
        );
        chart.selectDrawings([d.id]);
      }
      return { id: d.id, points: d.points.length };
    },
    { type: tool.type, count: tool.count, pane: tool.pane, announce },
  );
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(k);
      }),
    n,
  );

test('every registered drawing type can be added, rendered and removed', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFresh(page);
  const tools = await listTools(page);
  expect(tools.length).toBeGreaterThanOrEqual(86);

  for (const tool of tools) {
    const added = await addSweepDrawing(page, tool, false);
    expect(added.points, `${tool.type} points`).toBe(tool.count);
    const stored = await page.evaluate(
      (id) => window.chart.getDrawings().find((d) => d.id === id),
      added.id,
    );
    expect(stored?.type, tool.type).toBe(tool.type);
    await frames(page);
    expect(errors, `after ${tool.type}`).toEqual([]);
    await page.evaluate((id) => window.chart.removeDrawings([id]), added.id);
  }

  // All at once: overlapping drawings of every kind in one frame.
  for (const tool of tools) await addSweepDrawing(page, tool, false);
  await frames(page, 3);
  expect(await page.evaluate(() => window.chart.getDrawings().length)).toBe(tools.length);
  expect(errors).toEqual([]);
});

const DIALOG_SAMPLE = [
  'trend-line',
  'fib-retracement',
  'pitchfork',
  'xabcd',
  'elliott-impulse',
  'gann-box',
  'polyline',
  'callout',
  'table',
  'image',
  'path-sketch',
  'range-vp',
  'pinned-text',
  'icon',
];

test('Inspector settings open and close for a sample of types', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openFresh(page);
  const tools = (await listTools(page)).filter((t) => DIALOG_SAMPLE.includes(t.type));
  expect(tools.map((t) => t.type).sort()).toEqual([...DIALOG_SAMPLE].sort());

  for (const tool of tools) {
    const { id } = await addSweepDrawing(page, tool, true);
    await expect.poll(() => page.evaluate(() => window.chart.getSelection().length)).toBe(1);
    await page
      .getByRole('toolbar', { name: 'Drawing toolbar' })
      .getByRole('button', { name: 'Settings' })
      .click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector, tool.type).toBeVisible();
    await expect(inspector.getByRole('tablist')).toBeVisible();
    await inspector.getByRole('button', { name: 'Done' }).click();
    await expect(inspector, tool.type).toHaveCount(0);
    await page.evaluate((d) => window.chart.removeDrawings([d]), id);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});
