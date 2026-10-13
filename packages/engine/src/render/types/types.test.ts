import { describe, expect, it } from 'vitest';
import {
  CHART_TYPES,
  defaultChartStyle,
  type ChartStyle,
  type ChartType,
  type OhlcvSource,
  type TransformExtra,
} from '../../chart-types';
import { DARK_THEME } from '../../options';
import { PriceScale } from '../../scale/price-scale';
import { TimeScale } from '../../scale/time-scale';
import type { SeriesRenderContext } from '../series';
import { drawMainSeries, magnetValuesFor, priceRangeFor, sourceValue } from './index';
import { baselineY } from './lines';

// ---------------------------------------------------------------------------
// Fake CanvasRenderingContext2D: records calls, with coordinates mapped through
// the current scale (so text drawn under ctx.scale(dpr) is checked in device px).

type Pt = [number, number];
interface PathOp {
  op: 'moveTo' | 'lineTo' | 'rect' | 'arc';
  pts: Pt[];
  args: number[];
}
interface Call {
  op: string;
  args: unknown[];
  fillStyle: unknown;
  strokeStyle: unknown;
  /** Device-px points touched by this call. */
  pts: Pt[];
  /** For fill/stroke/clip: the path at that moment. */
  path?: PathOp[];
}

class FakeCtx {
  fillStyle: unknown = '#000';
  strokeStyle: unknown = '#000';
  lineWidth = 1;
  lineJoin = 'miter';
  lineCap = 'butt';
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  calls: Call[] = [];
  private path: PathOp[] = [];
  private k = 1;
  private stack: number[] = [];

  private rec(op: string, args: unknown[], pts: Pt[] = [], path?: PathOp[]): void {
    const c: Call = { op, args, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, pts };
    if (path) c.path = path;
    this.calls.push(c);
  }
  private p(x: number, y: number): Pt {
    return [x * this.k, y * this.k];
  }
  save(): void {
    this.stack.push(this.k);
    this.rec('save', []);
  }
  restore(): void {
    this.k = this.stack.pop() ?? 1;
    this.rec('restore', []);
  }
  scale(x: number, y: number): void {
    expect(x).toBe(y);
    this.k *= x;
    this.rec('scale', [x, y]);
  }
  setLineDash(d: number[]): void {
    this.rec('setLineDash', [d]);
  }
  beginPath(): void {
    this.path = [];
    this.rec('beginPath', []);
  }
  closePath(): void {
    this.rec('closePath', []);
  }
  moveTo(x: number, y: number): void {
    this.path.push({ op: 'moveTo', pts: [this.p(x, y)], args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.path.push({ op: 'lineTo', pts: [this.p(x, y)], args: [x, y] });
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.path.push({ op: 'rect', pts: [this.p(x, y), this.p(x + w, y + h)], args: [x, y, w, h] });
  }
  arc(x: number, y: number, r: number, a0: number, a1: number): void {
    this.path.push({
      op: 'arc',
      pts: [this.p(x - r, y - r), this.p(x + r, y + r)],
      args: [x, y, r, a0, a1],
    });
  }
  fill(): void {
    this.rec('fill', [], [], [...this.path]);
  }
  stroke(): void {
    this.rec('stroke', [], [], [...this.path]);
  }
  clip(): void {
    this.rec('clip', [], [], [...this.path]);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', [x, y, w, h], [this.p(x, y), this.p(x + w, y + h)]);
  }
  fillText(text: string, x: number, y: number): void {
    this.rec('fillText', [text, x, y], [this.p(x, y)]);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): object {
    for (const v of [x0, y0, x1, y1]) expect(Number.isFinite(v)).toBe(true);
    return { addColorStop: () => undefined };
  }

  of(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomBars(n: number, seed = 1): OhlcvSource {
  const r = rng(seed);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  const volume = new Float64Array(n);
  const time = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + (r() - 0.5) * 4;
    open[i] = o;
    close[i] = c;
    high[i] = Math.max(o, c) + r() * 2;
    low[i] = Math.min(o, c) - r() * 2;
    volume[i] = Math.floor(r() * 1000);
    time[i] = i * 60;
    p = c;
  }
  return { time, open, high, low, close, volume, length: n };
}

function bars(rows: [number, number, number, number][], volume?: number[]): OhlcvSource {
  const n = rows.length;
  return {
    time: rows.map((_, i) => i),
    open: rows.map((b) => b[0]),
    high: rows.map((b) => b[1]),
    low: rows.map((b) => b[2]),
    close: rows.map((b) => b[3]),
    volume: volume ?? rows.map(() => 100),
    length: n,
  };
}

interface Setup {
  ctx: FakeCtx;
  rc: SeriesRenderContext;
}

function setup(
  data: OhlcvSource,
  type: ChartType,
  style: ChartStyle,
  spacing: number,
  dpr = 1,
  extra: TransformExtra = {},
  width = 800,
  height = 400,
): Setup {
  const ts = new TimeScale();
  ts.width = width;
  ts.baseIndex = data.length - 1;
  ts.barSpacing = spacing;
  ts.rightOffset = 0;
  const { from, to } = ts.visibleRange();
  const ps = new PriceScale();
  ps.height = height;
  const range = priceRangeFor(type, data, style, from, to, extra);
  if (range) ps.setAutoRange(range.min, range.max);
  const ctx = new FakeCtx();
  const rc: SeriesRenderContext = {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    dpr,
    width,
    height,
    timeScale: ts,
    priceScale: ps,
    theme: DARK_THEME,
    from,
    to,
  };
  return { ctx, rc };
}

function allPoints(ctx: FakeCtx): Pt[] {
  const pts: Pt[] = [];
  for (const c of ctx.calls) {
    pts.push(...c.pts);
    // Clip rectangles are bounds themselves; fill/stroke paths are checked once.
    if (c.op === 'fill' || c.op === 'stroke') for (const op of c.path ?? []) pts.push(...op.pts);
  }
  return pts;
}

const style = defaultChartStyle(DARK_THEME);
const extraFor = (data: OhlcvSource): TransformExtra => {
  const n = data.length;
  const kagiYang = new Uint8Array(n);
  const pfDirection = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    kagiYang[i] = i % 3 === 0 ? 1 : 0;
    pfDirection[i] = data.close[i]! >= data.open[i]! ? 1 : -1;
  }
  return { boxSize: 0.5, kagiYang, pfDirection };
};

// ---------------------------------------------------------------------------

describe('drawMainSeries', () => {
  const data = randomBars(300, 7);
  const extra = extraFor(data);

  for (const type of CHART_TYPES) {
    it(`draws ${type} within device bounds at every spacing`, () => {
      for (const spacing of [0.5, 3, 12, 40]) {
        for (const dpr of [1, 2]) {
          const { ctx, rc } = setup(data, type, style, spacing, dpr, extra);
          expect(() => drawMainSeries({ rc, data, type, style, extra })).not.toThrow();
          expect(ctx.calls.length).toBeGreaterThan(0);
          const W = rc.width * dpr;
          const H = rc.height * dpr;
          // Line-like types draw one extra bar on each side.
          const slack = 2 * spacing * dpr + 2;
          const pts = allPoints(ctx);
          expect(pts.length).toBeGreaterThan(0);
          for (const [x, y] of pts) {
            expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
            expect(x).toBeGreaterThanOrEqual(-slack);
            expect(x).toBeLessThanOrEqual(W + slack);
            expect(y).toBeGreaterThanOrEqual(-1);
            expect(y).toBeLessThanOrEqual(H + 1);
          }
          // save/restore balanced.
          expect(ctx.of('save').length).toBe(ctx.of('restore').length);
        }
      }
    });
  }

  it('does nothing for empty data', () => {
    const empty = bars([]);
    const { ctx, rc } = setup(randomBars(10), 'candles', style, 10);
    drawMainSeries({ rc, data: empty, type: 'candles', style, extra: {} });
    expect(ctx.calls).toHaveLength(0);
  });

  it('batches candle fills by colour (one fillStyle switch per pass)', () => {
    const { ctx, rc } = setup(data, 'candles', style, 12);
    drawMainSeries({ rc, data, type: 'candles', style, extra: {} });
    const styles = ctx.of('fillRect').map((c) => c.fillStyle);
    let switches = 0;
    for (let i = 1; i < styles.length; i++) if (styles[i] !== styles[i - 1]) switches++;
    // wick up, body up, wick down, body down (wick/body colours equal by default).
    expect(switches).toBeLessThanOrEqual(3);
  });
});

describe('hollow candles', () => {
  // [open, high, low, close]
  const data = bars([
    [10, 13, 9, 12], // close > open: hollow; first bar, colour by close vs open: up
    [13, 14, 10, 11], // close < open: filled; 11 < 12: down
    [10, 12, 9, 11.5], // close > open: hollow; 11.5 > 11: up
    [12.5, 13, 9, 10], // close < open: filled; 10 < 11.5: down
    [9, 10.5, 8, 9.5], // close > open: hollow; 9.5 < 10: down
  ]);
  const s = defaultChartStyle(DARK_THEME);
  s.hollowCandles = {
    ...s.hollowCandles,
    upColor: 'UP',
    downColor: 'DOWN',
    borderUpColor: 'BUP',
    borderDownColor: 'BDOWN',
    wickUpColor: 'WUP',
    wickDownColor: 'WDOWN',
  };

  it('fills bodies only when close < open, colours by previous close', () => {
    const { ctx, rc } = setup(data, 'hollowCandles', s, 20, 1, {}, 200);
    drawMainSeries({ rc, data, type: 'hollowCandles', style: s, extra: {} });
    const ts = rc.timeScale;
    const xOf = (i: number) => Math.round(ts.indexToX(i));
    const body = 15; // floor(20 * 0.75) = 15
    const bodyFills = ctx.of('fillRect').filter((c) => c.args[2] === body);
    const filledAt = (i: number) =>
      bodyFills.filter((c) => (c.args[0] as number) === xOf(i) - (body >> 1));
    expect(filledAt(0)).toHaveLength(0);
    expect(filledAt(2)).toHaveLength(0);
    expect(filledAt(4)).toHaveLength(0);
    expect(filledAt(1).map((c) => c.fillStyle)).toEqual(['DOWN']);
    expect(filledAt(3).map((c) => c.fillStyle)).toEqual(['DOWN']);

    // Every body is outlined; colour follows close vs previous close.
    const strokes = ctx.of('stroke');
    const outlineColour = (i: number) =>
      strokes.find((st) =>
        st.path?.some((op) => op.op === 'rect' && Math.floor(op.args[0]!) === xOf(i) - (body >> 1)),
      )?.strokeStyle;
    expect(outlineColour(0)).toBe('BUP');
    expect(outlineColour(1)).toBe('BDOWN');
    expect(outlineColour(2)).toBe('BUP');
    expect(outlineColour(3)).toBe('BDOWN');
    expect(outlineColour(4)).toBe('BDOWN');
  });

  it('wicks stop at hollow bodies', () => {
    const { ctx, rc } = setup(data, 'hollowCandles', s, 20, 1, {}, 200);
    drawMainSeries({ rc, data, type: 'hollowCandles', style: s, extra: {} });
    const ps = rc.priceScale;
    const xc = Math.round(rc.timeScale.indexToX(0));
    const bodyTop = Math.round(ps.priceToY(12));
    const bodyBot = Math.round(ps.priceToY(10));
    const wicks = ctx.of('fillRect').filter((c) => c.args[0] === xc && c.args[2] === 1);
    for (const w of wicks) {
      const y0 = w.args[1] as number;
      const y1 = y0 + (w.args[3] as number);
      expect(y1 <= bodyTop || y0 >= bodyBot).toBe(true);
    }
    expect(wicks.length).toBe(2);
  });
});

describe('volume candles', () => {
  it('scales body width with volume', () => {
    const data = bars(
      [
        [10, 12, 9, 11],
        [11, 13, 10, 12],
        [12, 14, 11, 13],
      ],
      [1000, 500, 0],
    );
    const s = defaultChartStyle(DARK_THEME);
    const { ctx, rc } = setup(data, 'volumeCandles', s, 40, 1, {}, 200);
    drawMainSeries({ rc, data, type: 'volumeCandles', style: s, extra: {} });
    const widths = ctx
      .of('fillRect')
      .map((c) => c.args[2] as number)
      .filter((w) => w > 1);
    // max 90% of 40 = 36 (-> 35 odd), half volume 18 (-> 17), zero volume -> 1px.
    expect(widths).toEqual([35, 17]);
  });
});

describe('baseline', () => {
  it('splits the line exactly at the base crossing', () => {
    // Autoscale 0..10, base at 50% -> price 5, halfway between the two points.
    const data = bars([
      [0, 0, 0, 0],
      [10, 10, 10, 10],
    ]);
    const s = defaultChartStyle(DARK_THEME);
    s.baseline = { ...s.baseline, topLineColor: 'TOP', bottomLineColor: 'BOT' };
    const { ctx, rc } = setup(data, 'baseline', s, 40, 2, {}, 200);
    drawMainSeries({ rc, data, type: 'baseline', style: s, extra: {} });
    const base = baselineY(rc, s.baseline);
    expect(base).toBeCloseTo(rc.priceScale.priceToY(5) * 2, 6);
    const x0 = rc.timeScale.indexToX(0) * 2;
    const x1 = rc.timeScale.indexToX(1) * 2;
    const xMid = (x0 + x1) / 2;

    const top = ctx.of('stroke').find((c) => c.strokeStyle === 'TOP')!;
    const bot = ctx.of('stroke').find((c) => c.strokeStyle === 'BOT')!;
    expect(top.path!.map((p) => p.op)).toEqual(['moveTo', 'lineTo']);
    expect(bot.path!.map((p) => p.op)).toEqual(['moveTo', 'lineTo']);
    // Bottom part ends at the crossing, top part starts there.
    const [bx, by] = bot.path![1]!.args;
    const [tx, ty] = top.path![0]!.args;
    expect(bx).toBeCloseTo(xMid, 6);
    expect(by).toBeCloseTo(base, 6);
    expect(tx).toBeCloseTo(xMid, 6);
    expect(ty).toBeCloseTo(base, 6);

    // Fills are clipped to each side of the base.
    const clips = ctx.of('clip').map((c) => c.path![0]!.args);
    expect(clips).toHaveLength(2);
    expect(clips[0]![1]! + clips[0]![3]!).toBeCloseTo(base, 6);
    expect(clips[1]![1]).toBeCloseTo(base, 6);
  });
});

describe('point & figure', () => {
  it('draws one glyph per box', () => {
    // box 1: X column 10..14 (4 boxes), O column 11..14 (3 boxes), X column 11..16 (5).
    const data = bars([
      [10, 14, 10, 14],
      [14, 14, 11, 11],
      [11, 16, 11, 16],
    ]);
    const extra: TransformExtra = { boxSize: 1, pfDirection: new Int8Array([1, -1, 1]) };
    const s = defaultChartStyle(DARK_THEME);
    s.pointFigure = { ...s.pointFigure, upColor: 'X', downColor: 'O' };
    const { ctx, rc } = setup(data, 'pointFigure', s, 40, 1, extra, 200);
    drawMainSeries({ rc, data, type: 'pointFigure', style: s, extra });
    const xs = ctx.of('stroke').find((c) => c.strokeStyle === 'X')!;
    const os = ctx.of('stroke').find((c) => c.strokeStyle === 'O')!;
    // Each X is two diagonals (two moveTo + lineTo pairs).
    expect(xs.path!.filter((p) => p.op === 'moveTo')).toHaveLength(2 * (4 + 5));
    expect(xs.path!.filter((p) => p.op === 'lineTo')).toHaveLength(2 * (4 + 5));
    expect(os.path!.filter((p) => p.op === 'arc')).toHaveLength(3);
    expect(ctx.of('fillRect')).toHaveLength(0);
  });

  it('falls back to bars when boxes are tiny', () => {
    const data = bars([
      [10, 14, 10, 14],
      [14, 14, 11, 11],
    ]);
    const extra: TransformExtra = { boxSize: 0.001, pfDirection: new Int8Array([1, -1]) };
    const { ctx, rc } = setup(data, 'pointFigure', style, 40, 1, extra, 200);
    drawMainSeries({ rc, data, type: 'pointFigure', style, extra });
    expect(ctx.of('fillRect')).toHaveLength(2);
    expect(ctx.of('stroke')).toHaveLength(0);
  });

  it('range includes the full top box', () => {
    const data = bars([[10, 13.4, 10, 13.4]]);
    expect(priceRangeFor('pointFigure', data, style, 0, 0, { boxSize: 1 })).toEqual({
      min: 10,
      max: 13.4,
    });
    expect(priceRangeFor('pointFigure', data, style, 0, 0, { boxSize: 2 })).toEqual({
      min: 10,
      max: 14,
    });
  });
});

describe('priceRangeFor', () => {
  const data = bars([
    [10, 20, 5, 12],
    [12, 18, 8, 15],
  ]);

  it('lines use the source only, candles use high/low', () => {
    expect(priceRangeFor('line', data, style, 0, 1)).toEqual({ min: 12, max: 15 });
    expect(priceRangeFor('candles', data, style, 0, 1)).toEqual({ min: 5, max: 20 });
    const s = defaultChartStyle(DARK_THEME);
    s.area = { ...s.area, source: 'hl2' };
    expect(priceRangeFor('area', data, s, 0, 1)).toEqual({ min: 12.5, max: 13 });
  });

  it('renko includes the brick body', () => {
    const brick = bars([[10, 10.5, 10.2, 11]]);
    expect(priceRangeFor('renko', brick, style, 0, 0)).toEqual({ min: 10, max: 11 });
  });

  it('returns null for an empty range', () => {
    expect(priceRangeFor('candles', data, style, 5, 9)).toBeNull();
  });
});

describe('magnetValuesFor', () => {
  const data = bars([[10, 20, 5, 12]]);

  it('returns OHLC for candles and the source for lines', () => {
    expect(magnetValuesFor('candles', data, style, 0)).toEqual([10, 20, 5, 12]);
    expect(magnetValuesFor('line', data, style, 0)).toEqual([12]);
    const s = defaultChartStyle(DARK_THEME);
    s.line = { ...s.line, source: 'ohlc4' };
    expect(magnetValuesFor('line', data, s, 0)).toEqual([(10 + 20 + 5 + 12) / 4]);
    expect(magnetValuesFor('candles', data, style, 3)).toEqual([]);
  });
});

describe('sourceValue', () => {
  it('computes every source', () => {
    const d = bars([[1, 4, 0, 3]]);
    expect(sourceValue(d, 0, 'open')).toBe(1);
    expect(sourceValue(d, 0, 'high')).toBe(4);
    expect(sourceValue(d, 0, 'low')).toBe(0);
    expect(sourceValue(d, 0, 'close')).toBe(3);
    expect(sourceValue(d, 0, 'hl2')).toBe(2);
    expect(sourceValue(d, 0, 'hlc3')).toBeCloseTo(7 / 3);
    expect(sourceValue(d, 0, 'ohlc4')).toBe(2);
  });
});

describe('kagi', () => {
  it('splits colour at the previous shoulder', () => {
    // Yin up 10->12, yin down 12->11, then up 11->13 crosses the shoulder at 12 and
    // turns yang there: states [0, 0, 1].
    const data = bars([
      [10, 12, 10, 12],
      [12, 12, 11, 11],
      [11, 13, 11, 13],
    ]);
    const s = defaultChartStyle(DARK_THEME);
    s.kagi = { ...s.kagi, yangColor: 'YANG', yinColor: 'YIN' };
    const extra: TransformExtra = { kagiYang: new Uint8Array([0, 0, 1]) };
    const { ctx, rc } = setup(data, 'kagi', s, 40, 1, extra, 200);
    drawMainSeries({ rc, data, type: 'kagi', style: s, extra });
    const yang = ctx.of('stroke').find((c) => c.strokeStyle === 'YANG')!;
    // yangWidth 2 at dpr 1: even width, so no half-pixel offset.
    const ys = Math.round(rc.priceScale.priceToY(12));
    // Yang path starts at the shoulder price on the third segment.
    expect(yang.path![0]!.op).toBe('moveTo');
    expect(yang.path![0]!.args[1]).toBeCloseTo(ys, 6);
  });
});

describe('highLow', () => {
  it('draws labels only when they fit, in css coordinates', () => {
    const data = randomBars(50, 3);
    const wide = setup(data, 'highLow', style, 60, 2);
    drawMainSeries({ rc: wide.rc, data, type: 'highLow', style, extra: {} });
    const texts = wide.ctx.of('fillText');
    const visible = wide.rc.to - wide.rc.from + 1;
    expect(texts).toHaveLength(2 * visible);
    expect(wide.ctx.of('scale')).toEqual([expect.objectContaining({ args: [2, 2] })]);

    const narrow = setup(data, 'highLow', style, 12, 2);
    drawMainSeries({ rc: narrow.rc, data, type: 'highLow', style, extra: {} });
    expect(narrow.ctx.of('fillText')).toHaveLength(0);
  });
});
