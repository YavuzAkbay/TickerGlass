// Path sketch: synthetic candles along a clicked path (2+ anchors).
//
// Each segment a -> b gets n = max(1, round(|bars between a and b|)) candles
// at evenly spaced logical positions after a; candle j's close follows the
// segment (price at j/n) plus noise, the last close lands exactly on b and
// each open is the previous close (the first is a's price). Noise and wicks
// scale with `volatility` x unit, unit = max(|b - a| / n, 0.1% of |a|).
// Randomness: mulberry32 seeded with `style.seed` (set at creation, so a
// drawing always regenerates the same candles; 0 = derived from anchor 0).
import { BODY_HIT, inBox, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance, strokePolyline } from '../shape-utils';
import type { DrawingGeometry, DrawingPoint } from '../types';
import { pointsInView } from './shape-common';

export const PATH_SKETCH_DEFAULTS = {
  /** Path while selected; also the handle colour. */
  lineColor: '#6E9BD6',
  upColor: 'rgba(127, 176, 105, 0.5)',
  downColor: 'rgba(222, 106, 79, 0.5)',
  /** Noise multiplier (0 = candles exactly on the path). */
  volatility: 1,
  /** PRNG seed (set when the drawing is created). */
  seed: 0,
};

type PathSketchStyle = typeof PATH_SKETCH_DEFAULTS;

/** Generated candles cap. */
const MAX_CANDLES = 5000;

/** Deterministic PRNG in [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GhostCandle {
  /** Fractional logical bar position. */
  logical: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Seed in use: `style.seed`, or one derived from anchor 0 when it is 0. */
export function ghostSeed(seed: number, p0: DrawingPoint | undefined): number {
  if (seed) return seed >>> 0;
  if (!p0) return 1;
  return (Math.round(p0.time) ^ Math.round(p0.price * 1000) ^ 0x9e3779b9) >>> 0 || 1;
}

/** Candles along anchors at (logical[i], price[i]) (pure). */
export function ghostCandles(
  logical: readonly number[],
  price: readonly number[],
  seed: number,
  volatility: number,
): GhostCandle[] {
  const out: GhostCandle[] = [];
  const rnd = mulberry32(seed);
  const vol = Math.max(0, volatility);
  for (let k = 0; k + 1 < logical.length && out.length < MAX_CANDLES; k++) {
    const la = logical[k]!;
    const lb = logical[k + 1]!;
    const pa = price[k]!;
    const pb = price[k + 1]!;
    if (![la, lb, pa, pb].every(Number.isFinite)) continue;
    const n = Math.min(MAX_CANDLES - out.length, Math.max(1, Math.round(Math.abs(lb - la))));
    const unit = Math.max(Math.abs(pb - pa) / n, Math.abs(pa) * 0.001);
    let open = pa;
    for (let j = 1; j <= n; j++) {
      const noise = (rnd() * 2 - 1) * vol * unit;
      const close = j === n ? pb : pa + ((pb - pa) * j) / n + noise;
      const wickUp = rnd() * vol * unit * 0.5;
      const wickDown = rnd() * vol * unit * 0.5;
      out.push({
        logical: la + ((lb - la) * j) / n,
        open,
        close,
        high: Math.max(open, close) + wickUp,
        low: Math.min(open, close) - wickDown,
      });
      open = close;
    }
  }
  return out;
}

interface CacheEntry {
  key: string;
  candles: GhostCandle[];
}
const cache = new Map<string, CacheEntry>();
const CACHE_SIZE = 64;

/** Candles of a drawing, memoised per drawing id. */
export function pathSketchCandles(g: DrawingGeometry, s: PathSketchStyle): GhostCandle[] {
  const pts = g.drawing.points;
  const prices = pts.map((p) => p.price);
  const seed = ghostSeed(s.seed, pts[0]);
  const key = `${seed}|${s.volatility}|${g.logical.join(',')}|${prices.join(',')}`;
  const e = cache.get(g.drawing.id);
  if (e && e.key === key) return e.candles;
  const candles = ghostCandles(g.logical, prices, seed, s.volatility);
  cache.delete(g.drawing.id);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(g.drawing.id, { key, candles });
  return candles;
}

/** Synthetic candles following a clicked path; deterministic per drawing. */
export const pathSketch = defineDrawingTool({
  type: 'path-sketch',
  name: 'Path sketch',
  group: 'forecasting',
  creation: { kind: 'multi', min: 2 },
  panes: 'main',
  defaults: PATH_SKETCH_DEFAULTS,
  properties: [
    { kind: 'color', key: 'upColor', label: 'Up', inline: 'candles' },
    { kind: 'color', key: 'downColor', label: 'Down', inline: 'candles' },
    { kind: 'color', key: 'lineColor', label: 'Path' },
    { kind: 'number', key: 'volatility', label: 'Volatility', min: 0, max: 10, step: 0.1 },
    { kind: 'number', key: 'seed', label: 'Seed', min: 0, step: 1 },
  ],

  render({ ctx }, g, s, state) {
    if (g.bars.length === 0 || g.points.length < 2) return;
    const candles = pathSketchCandles(g, s);
    const bodyW = Math.max(1, g.barSpacing * 0.6);
    for (const c of candles) {
      const x = g.logicalToX(c.logical);
      if (x < -bodyW || x > g.width + bodyW) continue;
      const color = c.close >= c.open ? s.upColor : s.downColor;
      const yo = g.priceToY(c.open);
      const yc = g.priceToY(c.close);
      ctx.fillStyle = color;
      ctx.fillRect(x - 0.5, g.priceToY(c.high), 1, g.priceToY(c.low) - g.priceToY(c.high));
      ctx.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
    }
    if (state.selected || state.editing) {
      setLineStyle(ctx, s.lineColor, 1, 'dashed');
      strokePolyline(ctx, g.points);
    }
  },

  hitTest(g, s, x, y, tol) {
    if (g.bars.length === 0 || g.points.length < 2) return null;
    if (polylineDistance(g.points, x, y) <= tol) return BODY_HIT;
    const half = Math.max(tol, g.barSpacing * 0.3);
    for (const c of pathSketchCandles(g, s)) {
      const cx = g.logicalToX(c.logical);
      if (Math.abs(x - cx) > half) continue;
      if (inBox(x, y, cx - half, g.priceToY(c.high), cx + half, g.priceToY(c.low), tol))
        return BODY_HIT;
    }
    return null;
  },

  /** Fixes the seed so the drawing regenerates the same candles. */
  completePoints(points, _g, s) {
    if (!s.seed) s.seed = Math.floor(Math.random() * 0x7ffffffe) + 1;
    return points.map((p) => ({ ...p }));
  },

  isVisible(g) {
    return g.bars.length > 0 && pointsInView(g, g.points, 40);
  },
});
