import { timeToLogical, type AnchorTimeline } from '../drawings/mapping';
import type { ChartTheme } from '../options';
import { font, roundRect } from './draw';

export type ChartMarkerShape = 'bell' | 'circle' | 'arrowUp' | 'arrowDown' | 'letter';
export type ChartMarkerPosition = 'aboveBar' | 'belowBar' | 'price';

/** A time-anchored mark on the main pane (alert fired, event, ...). */
export interface ChartMarker {
  id: string;
  /** Unix seconds; mapped through the time scale, so it survives interval changes. */
  time: number;
  position: ChartMarkerPosition;
  /** Required for `position: 'price'`; ignored otherwise. */
  price?: number;
  color: string;
  shape: ChartMarkerShape;
  /** Badge text for `shape: 'letter'` (one or two characters). */
  text?: string;
  tooltip?: string;
}

export const MARKER_SIZE = 14;
const GAP = 6;
const STACK_STEP = MARKER_SIZE + 2;
const HIT_PAD = 2;

/** A marker resolved to pane coordinates (CSS px, pane-relative). */
export interface PlacedMarker {
  group: string;
  marker: ChartMarker;
  x: number;
  y: number;
}

/** Bar columns and scales a layout needs (the displayed series of the main pane). */
export interface MarkerLayoutInput {
  timeline: AnchorTimeline;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  indexToX: (i: number) => number;
  priceToY: (price: number) => number;
  paneWidth: number;
  paneHeight: number;
}

/**
 * Places markers of every group. Culled: a marker whose bar is outside the
 * visible x range or whose y is outside the pane is dropped, as is an
 * above/below marker before the first bar or a price marker without a finite
 * price. An above/below marker past the last bar (a future event) sits at the
 * last bar's extreme. Markers on the same bar and side stack outward.
 */
export function layoutMarkers(
  groups: ReadonlyMap<string, readonly ChartMarker[]>,
  inp: MarkerLayoutInput,
): PlacedMarker[] {
  const out: PlacedMarker[] = [];
  const tl = inp.timeline;
  if (!tl.length) return out;
  const stacks = new Map<string, number>();
  const pad = MARKER_SIZE;
  for (const [group, list] of groups) {
    for (const m of list) {
      const logical = timeToLogical(tl, { time: m.time });
      if (!Number.isFinite(logical)) continue;
      const index = Math.round(logical);
      const x = inp.indexToX(index);
      if (x < -pad || x > inp.paneWidth + pad) continue;
      let y: number;
      if (m.position === 'price') {
        if (m.price === undefined || !Number.isFinite(m.price)) continue;
        y = inp.priceToY(m.price);
      } else {
        if (index < 0) continue;
        // Past the newest bar: stack on the newest bar's extreme.
        const bar = Math.min(index, tl.length - 1);
        const key = `${index}|${m.position}`;
        const n = stacks.get(key) ?? 0;
        stacks.set(key, n + 1);
        const off = GAP + MARKER_SIZE / 2 + n * STACK_STEP;
        y =
          m.position === 'aboveBar'
            ? inp.priceToY(inp.high[bar]!) - off
            : inp.priceToY(inp.low[bar]!) + off;
      }
      if (!Number.isFinite(y) || y < -pad || y > inp.paneHeight + pad) continue;
      out.push({ group, marker: m, x, y });
    }
  }
  return out;
}

/** Topmost (last drawn) placed marker under (x, y). */
export function hitMarker(
  placed: readonly PlacedMarker[],
  x: number,
  y: number,
): PlacedMarker | null {
  const r = MARKER_SIZE / 2 + HIT_PAD;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) return p;
  }
  return null;
}

/** One marker/alert glyph centred on (cx, cy), fitting a `size` box. */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  shape: ChartMarkerShape,
  cx: number,
  cy: number,
  size: number,
  color: string,
  text?: string,
): void {
  const h = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'letter':
      // Rounded badge with a short label in the middle.
      roundRect(ctx, cx - h, cy - h, size, size, 3);
      ctx.fill();
      if (text) {
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.round(size * 0.65)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cx, cy + 0.5);
        ctx.restore();
      }
      return;
    case 'circle':
      ctx.arc(cx, cy, h * 0.8, 0, Math.PI * 2);
      break;
    case 'arrowUp':
      ctx.moveTo(cx, cy - h);
      ctx.lineTo(cx + h, cy + h * 0.2);
      ctx.lineTo(cx + h * 0.4, cy + h * 0.2);
      ctx.lineTo(cx + h * 0.4, cy + h);
      ctx.lineTo(cx - h * 0.4, cy + h);
      ctx.lineTo(cx - h * 0.4, cy + h * 0.2);
      ctx.lineTo(cx - h, cy + h * 0.2);
      ctx.closePath();
      break;
    case 'arrowDown':
      ctx.moveTo(cx, cy + h);
      ctx.lineTo(cx + h, cy - h * 0.2);
      ctx.lineTo(cx + h * 0.4, cy - h * 0.2);
      ctx.lineTo(cx + h * 0.4, cy - h);
      ctx.lineTo(cx - h * 0.4, cy - h);
      ctx.lineTo(cx - h * 0.4, cy - h * 0.2);
      ctx.lineTo(cx - h, cy - h * 0.2);
      ctx.closePath();
      break;
    case 'bell':
      // Dome + flared rim, then the clapper.
      ctx.moveTo(cx - h * 0.8, cy + h * 0.5);
      ctx.quadraticCurveTo(cx - h * 0.6, cy + h * 0.3, cx - h * 0.6, cy - h * 0.1);
      ctx.bezierCurveTo(
        cx - h * 0.6,
        cy - h * 0.9,
        cx + h * 0.6,
        cy - h * 0.9,
        cx + h * 0.6,
        cy - h * 0.1,
      );
      ctx.quadraticCurveTo(cx + h * 0.6, cy + h * 0.3, cx + h * 0.8, cy + h * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy + h * 0.75, h * 0.25, 0, Math.PI * 2);
      break;
  }
  ctx.fill();
}

export function drawMarkers(ctx: CanvasRenderingContext2D, placed: readonly PlacedMarker[]): void {
  for (const p of placed) {
    drawGlyph(ctx, p.marker.shape, p.x, p.y, MARKER_SIZE, p.marker.color, p.marker.text);
  }
}

/** Small text box above the marker (flipped below near the top edge). */
export function drawMarkerTooltip(
  ctx: CanvasRenderingContext2D,
  p: PlacedMarker,
  theme: ChartTheme,
  paneWidth: number,
): void {
  const text = p.marker.tooltip;
  if (!text) return;
  ctx.font = font(theme);
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  const x = Math.max(2, Math.min(paneWidth - w - 2, p.x - w / 2));
  let y = p.y - MARKER_SIZE / 2 - h - 4;
  if (y < 2) y = p.y + MARKER_SIZE / 2 + 4;
  ctx.fillStyle = theme.crosshairLabelBg;
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.fillStyle = theme.crosshairLabelText;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 6, y + h / 2 + 0.5);
}
