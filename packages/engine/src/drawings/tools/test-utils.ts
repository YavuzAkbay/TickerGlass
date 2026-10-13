// Test harness for tool tests (not imported by production code).
import { DARK_THEME } from '../../options';
import { PriceScale } from '../../scale/price-scale';
import { TimeScale } from '../../scale/time-scale';
import { Geometry, type DrawingPane } from '../geometry';
import type { AnchorTimeline } from '../mapping';
import { getDrawingTool } from '../registry';
import type {
  AnyDrawingToolDefinition,
  Drawing,
  DrawingFormat,
  DrawingPoint,
  DrawingRenderContext,
  DrawingStyle,
} from '../types';
import './index';

export const D = 86_400;
export const START = 1_700_000_000;
export const N = 100;

export const FORMAT: DrawingFormat = {
  price: (v) => v.toFixed(2),
  percent: (v) => `${v.toFixed(2)}%`,
  time: String,
};

/** 800 x 400 pane, 10 px bars (bar N-1 at the right edge), prices 0..100 linear. */
export function makeView() {
  const ts = new TimeScale();
  ts.width = 800;
  ts.barSpacing = 10;
  ts.baseIndex = N - 1;
  ts.rightOffset = 0;
  const ps = new PriceScale();
  ps.height = 400;
  ps.marginTop = 0;
  ps.marginBottom = 0;
  ps.min = 0;
  ps.max = 100;
  const pane: DrawingPane = { id: 'main', priceScale: ps, height: 400, top: 0 };
  const timeline: AnchorTimeline = {
    time: Float64Array.from({ length: N }, (_, i) => START + i * D),
    length: N,
    interval: { unit: 'day', count: 1 },
    bricks: false,
    endTime: START + (N - 1) * D,
  };
  return {
    ts,
    pane,
    timeline,
    X: (i: number) => ts.indexToX(i),
    Y: (p: number) => ps.priceToY(p),
  };
}

/** Anchor at bar i, price p. */
export const pt = (i: number, price: number): DrawingPoint => ({ time: START + i * D, price });

export function tool(type: string): AnyDrawingToolDefinition {
  const def = getDrawingTool(type);
  if (!def) throw new Error(`tool not registered: ${type}`);
  return def;
}

export function makeDrawing(
  type: string,
  points: DrawingPoint[],
  style: DrawingStyle = {},
  text = '',
): Drawing {
  const def = tool(type);
  return {
    id: 'd1',
    type,
    points,
    style: { ...structuredClone(def.defaults), ...style },
    text,
    locked: false,
    hidden: false,
    zIndex: 1,
    visibility: null,
    scope: 'symbol',
    symbol: 'TEST',
    paneId: 'main',
  };
}

/** Geometry of `d` in a fresh default view. */
export function geometryOf(d: Drawing, view = makeView()): Geometry {
  const g = new Geometry();
  g.update(d, view.pane, { timeline: view.timeline, timeScale: view.ts, width: 800 }, FORMAT);
  return g;
}

/** Recording canvas: calls by name, fillText strings; measureText ~ 7 px/char. */
export function recordingContext() {
  const calls: string[] = [];
  const texts: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'measureText') return (s: string) => ({ width: s.length * 7 });
        if (k === 'fillText')
          return (s: string) => {
            calls.push('fillText');
            texts.push(s);
          };
        return (..._a: unknown[]) => calls.push(String(k));
      },
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  const rc: DrawingRenderContext = { ctx, dpr: 1, theme: DARK_THEME };
  return { rc, calls, texts };
}

export const IDLE = { selected: false, hovered: false, editing: false };
export const SELECTED = { selected: true, hovered: false, editing: false };
