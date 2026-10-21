/** Screenshot composition: filename, footer text and cell placement (pure), plus the canvas build. */
import type { Chart } from '@tickerglass/engine';

export const FOOTER_HEIGHT = 24;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Placement {
  /** Pixel position of the cell's image in the output canvas. */
  x: number;
  y: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` in UTC. */
export function utcStamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

/** `<symbol>_<interval>_<YYYY-MM-DD_HH-mm>.png`, UTC, safe for file systems. */
export function screenshotFilename(symbol: string, interval: string, date: Date): string {
  const safe = (s: string) => s.replace(/[^\w.^=-]+/g, '_');
  const stamp = utcStamp(date).replace(' ', '_').replace(':', '-');
  return `${safe(symbol)}_${safe(interval)}_${stamp}.png`;
}

/** Footer line: every chart's symbol and interval, then the UTC time. */
export function footerText(
  charts: readonly { symbol: string; interval: string }[],
  date: Date,
): string {
  const names = charts.map((c) => `${c.symbol} ${c.interval}`).join('  |  ');
  return `${names}  ·  ${utcStamp(date)} UTC`;
}

/**
 * Where each cell's image goes, and the size of the output, for cell `rects`
 * (client coordinates) inside the grid at `origin`, drawn at `scale` (device
 * pixels per CSS pixel). `footer` CSS pixels are added below the grid.
 */
export function layoutPlacements(
  rects: readonly Rect[],
  origin: Rect,
  scale: number,
  footer: number,
): { width: number; height: number; placements: Placement[] } {
  return {
    width: Math.round(origin.w * scale),
    height: Math.round((origin.h + footer) * scale),
    placements: rects.map((r) => ({
      x: Math.round((r.x - origin.x) * scale),
      y: Math.round((r.y - origin.y) * scale),
    })),
  };
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/**
 * Composite `charts` (in grid order) into one canvas by their on-screen cell
 * rectangles, with a footer. One chart is just its own image plus the footer.
 */
export function composeScreenshot(charts: readonly Chart[], date: Date): HTMLCanvasElement {
  const first = charts[0];
  if (!first) throw new Error('No chart to capture');
  const shots = charts.map((c) => ({ canvas: c.takeScreenshot(), rect: rectOf(c.root) }));
  const grid = charts.length > 1 ? first.root.closest('.chart-stack') : null;
  const origin = grid ? rectOf(grid) : shots[0]!.rect;
  const scale = shots[0]!.rect.w > 0 ? shots[0]!.canvas.width / shots[0]!.rect.w : 1;
  const { width, height, placements } = layoutPlacements(
    shots.map((s) => s.rect),
    origin,
    scale,
    FOOTER_HEIGHT,
  );

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  const theme = first.theme;
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  shots.forEach((s, i) => ctx.drawImage(s.canvas, placements[i]!.x, placements[i]!.y));

  const top = Math.round(origin.h * scale);
  ctx.fillStyle = theme.border;
  ctx.fillRect(0, top, width, Math.max(1, Math.floor(scale)));
  ctx.save();
  ctx.scale(scale, scale);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = theme.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(
    footerText(
      charts.map((c) => ({ symbol: c.getSymbol(), interval: c.getInterval() })),
      date,
    ),
    8,
    origin.h + FOOTER_HEIGHT / 2,
  );
  ctx.restore();
  return out;
}
