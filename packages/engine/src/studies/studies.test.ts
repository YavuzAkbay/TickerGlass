import { describe, expect, it } from 'vitest';
import type { OhlcvSource } from '../chart-types';
import { DARK_THEME } from '../options';
import { PriceScale } from '../scale/price-scale';
import { TimeScale } from '../scale/time-scale';
import { formatStudyTick, formatStudyValue } from './format';
import { hitTestStudy, segmentDistance } from './hit';
import { dataRange, drawSpan, drawStudy, type StudyDrawContext } from './render';
import { diffTail, snapshotSeries } from './series-diff';
import { Study, studyValueRange } from './study';
import { StudySeries, type StudyHost } from './study-series';
import {
  STUDY_COLOR_NONE,
  type StudyOutputMeta,
  type StudyPlotMeta,
  type StudySpec,
} from './types';

// ---------------------------------------------------------------------------
// Recording canvas context (device px, identity transform).

interface Call {
  op: string;
  args: number[];
  fillStyle: string;
  strokeStyle: string;
  alpha: number;
  /** For fill/stroke: path ops since beginPath. */
  path?: { op: string; args: number[] }[];
}

class RecCtx {
  fillStyle = '';
  strokeStyle = '';
  globalAlpha = 1;
  lineWidth = 1;
  lineJoin = 'miter';
  lineCap = 'butt';
  font = '';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  calls: Call[] = [];
  private path: { op: string; args: number[] }[] = [];

  private rec(op: string, args: number[] = [], withPath = false): void {
    const c: Call = {
      op,
      args,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      alpha: this.globalAlpha,
    };
    if (withPath) c.path = [...this.path];
    this.calls.push(c);
  }
  save(): void {}
  restore(): void {}
  setLineDash(): void {}
  beginPath(): void {
    this.path = [];
  }
  closePath(): void {
    this.path.push({ op: 'closePath', args: [] });
  }
  moveTo(x: number, y: number): void {
    this.path.push({ op: 'moveTo', args: [x, y] });
  }
  lineTo(x: number, y: number): void {
    this.path.push({ op: 'lineTo', args: [x, y] });
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.path.push({ op: 'rect', args: [x, y, w, h] });
  }
  arc(x: number, y: number, r: number): void {
    this.path.push({ op: 'arc', args: [x, y, r] });
  }
  fill(): void {
    this.rec('fill', [], true);
  }
  stroke(): void {
    this.rec('stroke', [], true);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rec('fillRect', [x, y, w, h]);
  }
  fillText(_t: string, x: number, y: number): void {
    this.rec('fillText', [x, y]);
  }
  measureText(t: string): { width: number } {
    return { width: t.length * 6 };
  }
  of(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }
}

// ---------------------------------------------------------------------------
// Fixtures.

function plot(id: string, extra: Partial<StudyPlotMeta> = {}): StudyPlotMeta {
  return {
    type: 'plot',
    id,
    title: id.toUpperCase(),
    visible: true,
    kind: 'line',
    colors: ['#2962ff'],
    lineWidth: 1,
    lineStyle: 'solid',
    base: null,
    offset: 0,
    showLastValue: true,
    ...extra,
  };
}

function spec(outputs: StudyOutputMeta[], extra: Partial<StudySpec> = {}): StudySpec {
  return {
    id: 's1',
    title: 'Test',
    target: { paneId: 'main' },
    outputs,
    format: 'inherit',
    precision: 2,
    scaleRange: null,
    priceScale: 'pane',
    visible: true,
    ...extra,
  };
}

function f64(vals: number[]): Float64Array {
  return Float64Array.from(vals);
}

function flatBars(n: number, price = 100): OhlcvSource {
  const a = (v: number) => new Float64Array(n).fill(v);
  const time = Float64Array.from({ length: n }, (_, i) => i * 60);
  return {
    time,
    open: a(price),
    high: a(price + 1),
    low: a(price - 1),
    close: a(price),
    volume: a(10),
    length: n,
  };
}

interface Setup {
  ctx: RecCtx;
  dc: StudyDrawContext;
  ts: TimeScale;
  ps: PriceScale;
}

/** n bars at `spacing` px, last bar at the right edge minus `rightOffset` slots. */
function setup(n: number, limit = n, spacing = 10, rightOffset = 0, width = 400): Setup {
  const ts = new TimeScale();
  ts.width = width;
  ts.barSpacing = spacing;
  ts.baseIndex = n - 1;
  ts.rightOffset = rightOffset;
  const ps = new PriceScale();
  ps.height = 200;
  ps.marginTop = 0;
  ps.marginBottom = 0;
  ps.min = 0;
  ps.max = 200;
  const ctx = new RecCtx();
  const { pFrom, pTo } = drawSpan(ts, width);
  const dc: StudyDrawContext = {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    dpr: 1,
    width,
    height: 200,
    timeScale: ts,
    priceScale: ps,
    theme: DARK_THEME,
    bars: flatBars(n),
    limit,
    pFrom,
    pTo,
  };
  return { ctx, dc, ts, ps };
}

function withData(
  outputs: StudyOutputMeta[],
  values: Record<string, Float64Array>,
  colors: Record<string, Uint8Array> = {},
  extra: Partial<StudySpec> = {},
): Study {
  const s = new Study(spec(outputs, extra), 'main');
  const length = Object.values(values)[0]?.length ?? 0;
  s.setData({ revision: 1, length, values, colors });
  return s;
}

const pathOps = (c: Call, op: string) => (c.path ?? []).filter((p) => p.op === op);

// ---------------------------------------------------------------------------

describe('Study data', () => {
  const outs = [plot('a'), plot('b', { colors: ['#0f0', '#f00'] })];

  it('patches the tail, appends and grows arrays', () => {
    const s = withData(
      outs,
      { a: f64([1, 2, 3]), b: f64([4, 5, 6]) },
      { b: new Uint8Array([0, 0, 0]) },
    );
    expect(
      s.patch(
        {
          revision: 1,
          from: 2,
          length: 4,
          values: { a: f64([30, 40]), b: f64([60, 70]) },
          colors: { b: new Uint8Array([1, 1]) },
        },
        1,
      ),
    ).toBe(true);
    expect(s.length).toBe(4);
    expect([...s.plotValues('a').subarray(0, 4)]).toEqual([1, 2, 30, 40]);
    expect([...s.plotValues('b').subarray(0, 4)]).toEqual([4, 5, 60, 70]);
    expect([...s.colors.b!.subarray(0, 4)]).toEqual([0, 0, 1, 1]);
  });

  it('fills outputs missing from a patch with NaN', () => {
    const s = withData(outs, { a: f64([1, 2]), b: f64([3, 4]) });
    s.patch({ revision: 1, from: 1, length: 2, values: { a: f64([9]) }, colors: {} }, 1);
    expect(s.plotValues('a')[1]).toBe(9);
    expect(s.plotValues('b')[1]).toBeNaN();
  });

  it('shifts data of the previous revision on a history prepend', () => {
    const s = new Study(spec([plot('a', { colors: ['#0f0', '#f00'] })]), 'main');
    s.setData({
      revision: 3,
      length: 2,
      values: { a: f64([1, 2]) },
      colors: { a: new Uint8Array([1, 0]) },
    });
    expect(s.shift(2, 2, 4)).toBe(false); // other revision: untouched
    expect(s.shift(2, 3, 4)).toBe(true);
    expect(s.revision).toBe(4);
    expect(s.length).toBe(4);
    expect(Array.from(s.values.a!)).toEqual([NaN, NaN, 1, 2]);
    expect(Array.from(s.colors.a!)).toEqual([0, 0, 1, 0]);
  });

  it('ignores stale revisions and gaps', () => {
    const s = withData(outs, { a: f64([1, 2]), b: f64([3, 4]) });
    const p = { from: 2, length: 3, values: { a: f64([5]) }, colors: {} };
    expect(s.patch({ ...p, revision: 0 }, 1)).toBe(false); // stale vs chart
    expect(s.patch({ ...p, revision: 2 }, 2)).toBe(false); // stored data is older
    expect(s.patch({ ...p, revision: 1, from: 3, length: 4 }, 1)).toBe(false); // gap
    expect(s.length).toBe(2);
  });

  it('applies style patches and spec updates without touching the caller spec', () => {
    const original = spec([plot('a')]);
    const s = new Study(original, 'main');
    s.setStyle('a', { color: '#123456', lineWidth: 3, kind: 'step', visible: false });
    const o = s.output('a') as StudyPlotMeta;
    expect(o).toMatchObject({ colors: ['#123456'], lineWidth: 3, kind: 'step', visible: false });
    expect((original.outputs[0] as StudyPlotMeta).colors).toEqual(['#2962ff']);
    expect(s.setStyle('nope', { visible: false })).toBe(false);
    s.updateSpec({ title: 'New', scaleRange: { min: 0, max: 100 } });
    expect(s.spec.title).toBe('New');
    expect(s.spec.id).toBe('s1');
  });

  it('legend values apply offsets, palettes and formatting', () => {
    const s = withData(
      [
        plot('a', { offset: 2 }),
        plot('b', { colors: ['#0f0', '#f00'] }),
        plot('h', { visible: false }),
      ],
      { a: f64([1.234, 2, 3, 4]), b: f64([5, 6, 7, NaN]), h: f64([0, 0, 0, 0]) },
      { b: new Uint8Array([0, 1, 0, 0]) },
    );
    const v = s.legendValues(3, 1, 4);
    expect(v.map((x) => x.outputId)).toEqual(['a', 'b']);
    expect(v[0]).toMatchObject({ value: 2, text: '2.00' });
    expect(v[1]).toMatchObject({ text: '', color: '#0f0' });
    expect(s.legendValues(1, 1, 4)[1]).toMatchObject({ value: 6, color: '#f00' });
    expect(s.legendValues(2, 1, 4)[0]).toMatchObject({ value: 1.234, text: '1.23' });
    // Stale data has no values.
    expect(s.legendValues(1, 2, 4).every((x) => Number.isNaN(x.value) && x.text === '')).toBe(true);
  });
});

describe('studyValueRange (auto-scale)', () => {
  it('includes shifted values drawn past the last bar and skips NaN/hidden outputs', () => {
    const s = withData([plot('a', { offset: 3 }), plot('h', { visible: false })], {
      a: f64([NaN, 10, 20, 500]),
      h: f64([-1000, -1000, -1000, -1000]),
    });
    // Positions 0..3 only show a[0..0] (NaN) -> no range.
    expect(studyValueRange(s, 0, 3, 4)).toBeNull();
    // Positions 0..5 show a[0..2] = NaN, 10, 20.
    expect(studyValueRange(s, 0, 5, 4)).toEqual({ min: 10, max: 20 });
    // Past the last bar (position 6 = a[3]).
    expect(studyValueRange(s, 0, 6, 4)).toEqual({ min: 10, max: 500 });
    // `limit` hides values the displayed series does not have yet.
    expect(studyValueRange(s, 0, 6, 3)).toEqual({ min: 10, max: 20 });
  });

  it('includes hidden plots that bound a visible fill', () => {
    const s = withData(
      [
        plot('u', { visible: false }),
        plot('l', { visible: false }),
        plot('m'),
        {
          type: 'fill',
          id: 'f',
          title: 'F',
          visible: true,
          between: ['u', 'l'],
          colors: ['#0f01'],
        },
      ],
      { u: f64([30, 31]), l: f64([10, 9]), m: f64([20, 20]) },
    );
    expect(studyValueRange(s, 0, 1, 2)).toEqual({ min: 9, max: 31 });
    // Hidden fill: only the visible plot counts.
    s.setStyle('f', { visible: false });
    expect(studyValueRange(s, 0, 1, 2)).toEqual({ min: 20, max: 20 });
  });

  it('includes hlines and the histogram base', () => {
    const s = withData(
      [
        plot('h', { kind: 'histogram' }),
        {
          type: 'hline',
          id: 'l',
          title: 'L',
          visible: true,
          value: 70,
          color: '#fff',
          lineWidth: 1,
          lineStyle: 'dashed',
        },
      ],
      { h: f64([5, 8, 6]) },
    );
    expect(studyValueRange(s, 0, 2, 3)).toEqual({ min: 0, max: 70 });
  });
});

describe('drawStudy', () => {
  it('draws only the visible range of a 100k-bar series', () => {
    const n = 100_000;
    const vals = new Float64Array(n).map((_, i) => 50 + (i % 7));
    const s = withData([plot('a')], { a: vals });
    const { ctx, dc } = setup(n);
    drawStudy(dc, s);
    const strokes = ctx.of('stroke');
    expect(strokes).toHaveLength(1);
    const pts = strokes[0]!.path!.length;
    // 400px / 10px = 40 bars, plus one slot each side.
    expect(pts).toBeGreaterThanOrEqual(40);
    expect(pts).toBeLessThanOrEqual(44);
  });

  it('leaves gaps at NaN and starts a new subpath', () => {
    const s = withData([plot('a')], { a: f64([10, 20, NaN, 30, 40]) });
    const { ctx, dc } = setup(5);
    drawStudy(dc, s);
    const st = ctx.of('stroke');
    expect(st).toHaveLength(1);
    expect(pathOps(st[0]!, 'moveTo')).toHaveLength(2);
    expect(pathOps(st[0]!, 'lineTo')).toHaveLength(2);
  });

  it('strokes one path per palette run', () => {
    const s = withData(
      [plot('a', { colors: ['#0f0', '#f00'] })],
      { a: f64([1, 2, 3, 4, 5, 6]) },
      { a: new Uint8Array([0, 0, 1, 1, 0, 0]) },
    );
    const { ctx, dc } = setup(6);
    drawStudy(dc, s);
    expect(ctx.of('stroke').map((c) => c.strokeStyle)).toEqual(['#0f0', '#f00', '#0f0']);
  });

  it('draws positive offsets past the last bar and negative offsets back', () => {
    const n = 10;
    const vals = f64(Array.from({ length: n }, (_, i) => i + 10));
    for (const offset of [3, -3]) {
      const s = withData([plot('a', { offset })], { a: vals });
      const { ctx, dc, ts } = setup(n, n, 10, 5);
      drawStudy(dc, s);
      const xs = ctx.of('stroke')[0]!.path!.map((p) => p.args[0]!);
      const xLast = ts.indexToX(n - 1);
      if (offset > 0) expect(Math.max(...xs)).toBeCloseTo(ts.indexToX(n - 1 + 3));
      else expect(Math.max(...xs)).toBeCloseTo(xLast - 30);
      // value[0] sits at bar `offset`.
      expect(Math.min(...xs)).toBeCloseTo(ts.indexToX(offset));
    }
  });

  it('draws step lines as horizontal then vertical moves', () => {
    const s = withData([plot('a', { kind: 'step' })], { a: f64([10, 20]) });
    const { ctx, dc, ps } = setup(2);
    drawStudy(dc, s);
    const path = ctx.of('stroke')[0]!.path!;
    expect(path.map((p) => p.op)).toEqual(['moveTo', 'lineTo', 'lineTo']);
    expect(path[1]!.args[1]).toBeCloseTo(ps.priceToY(10));
    expect(path[2]!.args[1]).toBeCloseTo(ps.priceToY(20));
  });

  it('draws histogram bars from the base with per-bar colours', () => {
    const s = withData(
      [plot('h', { kind: 'histogram', colors: ['#0f0', '#f00'], base: 50, lineWidth: 2 })],
      { h: f64([60, 40, NaN, 70]) },
      { h: new Uint8Array([0, 1, 0, 0]) },
    );
    const { ctx, dc, ps } = setup(4);
    drawStudy(dc, s);
    const rects = ctx.of('fillRect');
    expect(rects).toHaveLength(3);
    expect(rects.filter((r) => r.fillStyle === '#f00')).toHaveLength(1);
    const baseY = Math.round(ps.priceToY(50));
    for (const r of rects) {
      const [, y, w, h] = r.args as [number, number, number, number];
      expect(w).toBe(2);
      expect(y === baseY || y + h === baseY).toBe(true);
    }
  });

  it('batches circles and crosses into one path per colour', () => {
    const s = withData(
      [plot('c', { kind: 'circles' }), plot('x', { kind: 'cross', colors: ['#fff'] })],
      { c: f64([1, NaN, 3]), x: f64([4, 5, 6]) },
    );
    const { ctx, dc } = setup(3);
    drawStudy(dc, s);
    expect(pathOps(ctx.of('fill')[0]!, 'arc')).toHaveLength(2);
    expect(pathOps(ctx.of('stroke')[0]!, 'moveTo')).toHaveLength(6);
  });

  it('fills an area down to the base or the pane bottom', () => {
    const s = withData([plot('a', { kind: 'area' })], { a: f64([10, 20, 30]) });
    const { ctx, dc } = setup(3);
    drawStudy(dc, s);
    const fill = ctx.of('fill')[0]!;
    expect(fill.alpha).toBeLessThan(1);
    // Two segments -> two quads reaching y = height.
    expect(pathOps(fill, 'closePath')).toHaveLength(2);
    expect(fill.path!.some((p) => p.op === 'lineTo' && p.args[1] === 200)).toBe(true);
    expect(ctx.of('stroke')).toHaveLength(1);
  });

  it('fills between plots only where both sides exist, coloured per bar', () => {
    const s = withData(
      [
        plot('a', { offset: 1 }),
        plot('b', { offset: 1 }),
        {
          type: 'fill',
          id: 'f',
          title: 'F',
          visible: true,
          between: ['a', 'b'],
          colors: ['#0f04', '#f004'],
        },
      ],
      { a: f64([10, 20, 30, 40, 50]), b: f64([15, NaN, 35, 45, 55]) },
      { f: new Uint8Array([0, 0, 0, 1, 1]) },
    );
    const { ctx, dc } = setup(5, 5, 10, 3);
    drawStudy(dc, s);
    const fills = ctx.of('fill');
    // Segments (positions p-1..p, data j = p-1): valid pairs (2,3) and (3,4).
    // Colour index of the segment ending at data j: j=3 -> 1, j=4 -> 1.
    expect(fills.map((f) => f.fillStyle)).toEqual(['#f004']);
    expect(pathOps(fills[0]!, 'closePath')).toHaveLength(2);
  });

  it('fills between two hlines with a single rectangle', () => {
    const hl = (id: string, value: number): StudyOutputMeta => ({
      type: 'hline',
      id,
      title: id,
      visible: true,
      value,
      color: '#fff',
      lineWidth: 1,
      lineStyle: 'dashed',
    });
    const s = withData(
      [
        hl('u', 70),
        hl('l', 30),
        {
          type: 'fill',
          id: 'f',
          title: 'F',
          visible: true,
          between: ['u', 'l'],
          colors: ['#7e57c220'],
        },
      ],
      {},
    );
    s.length = 5;
    const { ctx, dc, ps } = setup(5);
    drawStudy(dc, s);
    const rect = ctx.of('fillRect')[0]!;
    expect(rect.args[1]).toBeCloseTo(ps.priceToY(70));
    expect(rect.args[3]).toBeCloseTo(ps.priceToY(30) - ps.priceToY(70));
    expect(ctx.of('stroke')).toHaveLength(2); // both hlines
  });

  it('merges adjacent bgcolor bars into runs', () => {
    const s = withData(
      [{ type: 'bgcolor', id: 'bg', title: 'BG', visible: true, colors: ['#0f02'] }],
      { bg: f64([1, 1, NaN, 1, NaN, 1, 1, 1]) },
    );
    const { ctx, dc } = setup(8);
    drawStudy(dc, s);
    const rects = ctx.of('fillRect');
    expect(rects).toHaveLength(3);
    expect(rects[0]!.args[2]).toBe(20);
    expect(rects[2]!.args[2]).toBe(30);
  });

  it('places shapes above/below the bar and at absolute prices', () => {
    const mk = (location: 'aboveBar' | 'belowBar' | 'absolute'): StudyOutputMeta => ({
      type: 'shape',
      id: location,
      title: location,
      visible: true,
      shape: 'triangleUp',
      location,
      size: 'small',
      colors: ['#fff'],
      text: '',
      textColor: '',
    });
    const s = withData([mk('aboveBar'), mk('belowBar'), mk('absolute')], {
      aboveBar: f64([NaN, 1]),
      belowBar: f64([1, NaN]),
      absolute: f64([NaN, 50]),
    });
    const { ctx, dc, ps } = setup(2);
    drawStudy(dc, s);
    const fills = ctx.of('fill');
    expect(fills).toHaveLength(3);
    const ys = fills.map((f) => f.path!.filter((p) => p.args.length).map((p) => p.args[1]!));
    expect(Math.max(...ys[0]!)).toBeLessThan(ps.priceToY(101)); // above high
    expect(Math.min(...ys[1]!)).toBeGreaterThan(ps.priceToY(99)); // below low
    expect(Math.min(...ys[2]!)).toBeLessThan(ps.priceToY(50));
    expect(Math.max(...ys[2]!)).toBeGreaterThan(ps.priceToY(50));
  });

  it('shifts bgcolor and shapes by their offset', () => {
    const shape: StudyOutputMeta = {
      type: 'shape',
      id: 'sh',
      title: 'SH',
      visible: true,
      shape: 'circle',
      location: 'absolute',
      size: 'small',
      colors: ['#fff'],
      text: '',
      textColor: '',
      offset: 2,
    };
    const s = withData(
      [
        { type: 'bgcolor', id: 'bg', title: 'BG', visible: true, colors: ['#0f02'], offset: 2 },
        shape,
      ],
      { bg: f64([1, NaN, NaN, NaN]), sh: f64([50, NaN, NaN, NaN]) },
    );
    const { ctx, dc, ts } = setup(4);
    drawStudy(dc, s);
    const rect = ctx.of('fillRect')[0]!;
    expect(rect.args[0]).toBe(Math.round(ts.indexToX(2) - 5));
    const arc = pathOps(ctx.of('fill')[0]!, 'arc')[0]!;
    expect(arc.args[0]).toBeCloseTo(ts.indexToX(2));
    // Hit testing uses the drawn position.
    const g = { ...dc };
    expect(hitTestStudy(g, s, ts.indexToX(2), dc.priceScale.priceToY(50))).toBe('sh');
    expect(hitTestStudy(g, s, ts.indexToX(0), dc.priceScale.priceToY(50))).toBeNull();
  });

  it('skips bars whose palette index is STUDY_COLOR_NONE', () => {
    const N = STUDY_COLOR_NONE;
    const s = withData(
      [
        plot('a', { colors: ['#0f0'] }),
        plot('h', { kind: 'histogram', colors: ['#0f0', '#f00'] }),
        { type: 'bgcolor', id: 'bg', title: 'BG', visible: true, colors: ['#00f', '#0ff'] },
      ],
      { a: f64([1, 2, 3, 4]), h: f64([1, 2, 3, 4]), bg: f64([1, 1, 1, 1]) },
      {
        a: Uint8Array.from([0, 0, N, 0]),
        h: Uint8Array.from([0, N, 1, 7]),
        bg: Uint8Array.from([N, N, 1, 1]),
      },
    );
    const { ctx, dc } = setup(4);
    drawStudy(dc, s);
    // Line: segments 0-1 and 2-3 drawn, 1-2 hidden (moveTo instead of lineTo).
    const line = ctx.of('stroke')[0]!;
    expect(pathOps(line, 'lineTo')).toHaveLength(2);
    // Histogram: 3 bars (index 7 is out of range -> entry 0), the "none" bar skipped.
    const bars = ctx.of('fillRect').filter((c) => c.fillStyle === '#0f0' || c.fillStyle === '#f00');
    expect(bars).toHaveLength(3);
    // Background: one run over bars 2..3 in entry 1.
    const bg = ctx.of('fillRect').filter((c) => c.fillStyle === '#00f' || c.fillStyle === '#0ff');
    expect(bg).toHaveLength(1);
    expect(bg[0]!.fillStyle).toBe('#0ff');
    // Legend falls back to entry 0 for a "none" bar.
    expect(s.legendValues(2, 1, 2)[0]!.color).toBe('#0f0');
  });

  it('skips hidden outputs and draws nothing without data', () => {
    const s = withData([plot('a', { visible: false })], { a: f64([1, 2, 3]) });
    const { ctx, dc } = setup(3);
    drawStudy(dc, s);
    expect(ctx.calls).toHaveLength(0);
    const empty = new Study(spec([plot('a')]), 'main');
    drawStudy(dc, empty);
    expect(ctx.calls).toHaveLength(0);
  });
});

describe('hit testing', () => {
  const hl: StudyOutputMeta = {
    type: 'hline',
    id: 'l',
    title: 'L',
    visible: true,
    value: 150,
    color: '#fff',
    lineWidth: 1,
    lineStyle: 'solid',
  };

  it('hits lines near the segment, hlines, and fills only when no line is hit', () => {
    const s = withData(
      [
        plot('a'),
        plot('b'),
        hl,
        { type: 'fill', id: 'f', title: 'F', visible: true, between: ['a', 'b'], colors: ['#fff'] },
      ],
      { a: f64([100, 100, 120, 120]), b: f64([50, 50, 50, 50]) },
    );
    const { dc, ts, ps } = setup(4);
    const x = (ts.indexToX(1) + ts.indexToX(2)) / 2;
    expect(hitTestStudy(dc, s, x, ps.priceToY(110) + 2)).toBe('a');
    expect(hitTestStudy(dc, s, x, ps.priceToY(150) - 3)).toBe('l');
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(80))).toBe('f');
    // Layers: marks never return fills, fills never return lines.
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(80), 4, 'marks')).toBeNull();
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(80), 4, 'fills')).toBe('f');
    expect(hitTestStudy(dc, s, x, ps.priceToY(110) + 2, 4, 'fills')).toBe('f');
    expect(hitTestStudy(dc, s, x, ps.priceToY(110) + 2, 4, 'marks')).toBe('a');
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(20))).toBeNull();
  });

  it('hits histogram bars and shifted plots', () => {
    const s = withData([plot('h', { kind: 'histogram', lineWidth: 4 }), plot('o', { offset: 2 })], {
      h: f64([0, 30, 0, 0]),
      o: f64([170, 170, 170, 170]),
    });
    const { dc, ts, ps } = setup(4, 4, 10, 3);
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(15))).toBe('h');
    expect(hitTestStudy(dc, s, ts.indexToX(5), ps.priceToY(170))).toBe('o');
    expect(hitTestStudy(dc, s, ts.indexToX(0), ps.priceToY(170))).toBeNull();
  });

  it('does not hit bars drawn with no colour (STUDY_COLOR_NONE)', () => {
    const N = STUDY_COLOR_NONE;
    const shape: StudyOutputMeta = {
      type: 'shape',
      id: 'sh',
      title: 'SH',
      visible: true,
      shape: 'circle',
      location: 'absolute',
      size: 'small',
      colors: ['#fff'],
      text: '',
      textColor: '',
    };
    const fill: StudyOutputMeta = {
      type: 'fill',
      id: 'f',
      title: 'F',
      visible: true,
      between: ['a', 'b'],
      colors: ['#fff'],
    };
    const s = withData(
      [plot('a'), plot('b'), plot('h', { kind: 'histogram', lineWidth: 4 }), shape, fill],
      {
        a: f64([100, 100, 100, 100]),
        b: f64([50, 50, 50, 50]),
        h: f64([20, 20, 20, 20]),
        sh: f64([180, 180, 180, 180]),
      },
      {
        a: Uint8Array.from([0, 0, N, 0]),
        h: Uint8Array.from([N, 0, 0, 0]),
        sh: Uint8Array.from([0, N, 0, 0]),
        f: Uint8Array.from([0, N, 0, 0]),
      },
    );
    const { dc, ts, ps } = setup(4);
    const mid = (i: number) => (ts.indexToX(i) + ts.indexToX(i + 1)) / 2;
    // Line: the segment ending at bar 2 is not drawn; the others are.
    expect(hitTestStudy(dc, s, mid(1), ps.priceToY(100))).not.toBe('a');
    expect(hitTestStudy(dc, s, mid(0), ps.priceToY(100))).toBe('a');
    expect(hitTestStudy(dc, s, mid(2), ps.priceToY(100))).toBe('a');
    // Histogram, shape and fill: bar 0 / 1 are "none".
    expect(hitTestStudy(dc, s, ts.indexToX(0), ps.priceToY(10))).toBeNull();
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(10))).toBe('h');
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(180))).toBeNull();
    expect(hitTestStudy(dc, s, ts.indexToX(2), ps.priceToY(180))).toBe('sh');
    expect(hitTestStudy(dc, s, ts.indexToX(1), ps.priceToY(75))).toBeNull();
    expect(hitTestStudy(dc, s, ts.indexToX(2), ps.priceToY(75))).toBe('f');
  });

  it('segmentDistance clamps to the segment ends', () => {
    expect(segmentDistance(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
});

describe('StudySeries', () => {
  function host(n: number, revision = 1): StudyHost {
    const ts = new TimeScale();
    ts.width = 400;
    ts.barSpacing = 10;
    ts.baseIndex = n - 1;
    ts.rightOffset = 0;
    return {
      store: flatBars(n),
      timeScale: ts,
      seriesRevision: revision,
      theme: DARK_THEME,
      compareReference: () => null,
    };
  }

  it('uses the fixed scale range and skips stale or hidden studies', () => {
    const s = withData(
      [plot('a')],
      { a: f64([30, 40, 50]) },
      {},
      { scaleRange: { min: 0, max: 100 } },
    );
    expect(new StudySeries(s, host(3)).priceRange(0, 2)).toEqual({ min: 0, max: 100 });
    s.spec.scaleRange = null;
    expect(new StudySeries(s, host(3)).priceRange(0, 2)).toEqual({ min: 30, max: 50 });
    expect(new StudySeries(s, host(3, 2)).priceRange(0, 2)).toBeNull();
    // A fixed range holds while the data is stale (recompute pending).
    s.spec.scaleRange = { min: 0, max: 100 };
    expect(new StudySeries(s, host(3, 2)).priceRange(0, 2)).toEqual({ min: 0, max: 100 });
    s.spec.visible = false;
    expect(new StudySeries(s, host(3)).priceRange(0, 2)).toBeNull();
  });

  it("keeps priceScale 'none' out of auto-scale and draws on its own scale", () => {
    const s = withData(
      [plot('v', { kind: 'columns' })],
      { v: f64([1e6, 2e6, 3e6]) },
      {},
      { priceScale: 'none' },
    );
    const ser = new StudySeries(s, host(3));
    expect(ser.excludeFromAutoscale).toBe(true);
    expect(ser.priceRange(0, 2)).toBeNull();
    expect(ser.valuesAt(1)).toEqual([]);
    const ctx = new RecCtx();
    const ps = new PriceScale();
    ps.height = 200;
    ps.min = 90;
    ps.max = 110;
    const h = host(3);
    ser.draw({
      ctx: ctx as unknown as CanvasRenderingContext2D,
      dpr: 1,
      width: 400,
      height: 200,
      timeScale: h.timeScale,
      priceScale: ps,
      theme: DARK_THEME,
      from: 0,
      to: 2,
    });
    const rects = ctx.of('fillRect');
    expect(rects).toHaveLength(3);
    // Own scale: bottom 20% of the pane.
    for (const r of rects) {
      expect(r.args[1]!).toBeGreaterThanOrEqual(200 * 0.8 - 1);
      expect(r.args[1]! + r.args[3]!).toBeLessThanOrEqual(201);
    }
    // Hit testing uses the own scale: a column at the pane bottom, nothing above it.
    const x = h.timeScale.indexToX(2);
    expect(ser.hitTestPx(x, 195)).toBe('v');
    expect(ser.hitTestPx(x, 195, 'marks')).toBe('v');
    expect(ser.hitTestPx(x, 60)).toBeNull();
    expect(ser.hitTestPx(x + 5, 195)).toBeNull(); // between columns
  });

  it('reports last values, magnet values and hit tests after a draw', () => {
    const s = withData(
      [plot('a', { colors: ['#0f0', '#f00'] }), plot('b', { showLastValue: false })],
      { a: f64([10, 20, 30]), b: f64([1, 2, 3]) },
      { a: new Uint8Array([0, 0, 1]) },
    );
    const h = host(3);
    const ser = new StudySeries(s, h);
    expect(ser.lastValues()).toEqual([{ outputId: 'a', price: 30, raw: 30, color: '#f00' }]);
    expect(ser.valuesAt(1)).toEqual([20, 2]);
    expect(ser.hitTestPx(0, 0)).toBeNull(); // not drawn yet
    const ps = new PriceScale();
    ps.height = 200;
    ps.min = 0;
    ps.max = 40;
    ser.draw({
      ctx: new RecCtx() as unknown as CanvasRenderingContext2D,
      dpr: 1,
      width: 400,
      height: 200,
      timeScale: h.timeScale,
      priceScale: ps,
      theme: DARK_THEME,
      from: 0,
      to: 2,
    });
    expect(ser.hitTestPx(h.timeScale.indexToX(2), ps.priceToY(30))).toBe('a');
  });
});

describe('StudySeries compare and own scale', () => {
  /** Host whose main series closes are `closes` (compare reference = close). */
  function refHost(closes: number[]): StudyHost {
    const n = closes.length;
    const ts = new TimeScale();
    ts.width = 400;
    ts.barSpacing = 10;
    ts.baseIndex = n - 1;
    ts.rightOffset = 0;
    const store = flatBars(n);
    (store.close as Float64Array).set(closes);
    return {
      store,
      timeScale: ts,
      seriesRevision: 1,
      theme: DARK_THEME,
      compareReference: (i) => store.close[Math.max(0, Math.min(i, n - 1))] ?? null,
    };
  }

  function rc(h: StudyHost, ps: PriceScale, from: number, to: number, ctx = new RecCtx()) {
    return {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      dpr: 1,
      width: 400,
      height: ps.height,
      timeScale: h.timeScale,
      priceScale: ps,
      theme: DARK_THEME,
      from,
      to,
    };
  }

  function percentScale(base: number): PriceScale {
    const ps = new PriceScale();
    ps.height = 200;
    ps.mode = 'percent';
    ps.base = base;
    ps.min = -50;
    ps.max = 50;
    return ps;
  }

  const closes = [10, 12, 15, 18];

  it('rescales a same-% overlay to the main series at the first visible bar', () => {
    const s = withData([plot('close')], { close: f64([50, 55, 60, 54]) }, {}, { compare: true });
    const ser = new StudySeries(s, refHost(closes));
    expect(ser.excludeFromAutoscale).toBe(false);
    expect(ser.behind).toBe(false);
    const f = ser.compareFactor(1, 3);
    expect(f).toBe(12 / 55);
    // Auto-scale gets the scaled range of [1, 3].
    expect(ser.priceRange(1, 3)).toEqual({ min: 54 * f, max: 60 * f });
    const drawn = ser.valuesAt(3)[0]!;
    expect(drawn).toBe(54 * (12 / 55)); // golden 11.781818181818182 (same double)
    const ps = percentScale(12); // main baseValue(from = 1)
    expect(ps.toInternal(drawn)).toBeCloseTo(-20 / 11, 12); // -1.8181818181818181 (golden)
    // Drawn and hit-tested on the scaled y.
    const ctx = new RecCtx();
    ser.draw(rc(refHost(closes), ps, 1, 3, ctx));
    const line = ctx.of('stroke')[0]!;
    const pts = line.path!.filter((p) => p.op === 'moveTo' || p.op === 'lineTo');
    const h = refHost(closes);
    const p3 = pts.find((p) => Math.abs(p.args[0]! - h.timeScale.indexToX(3)) < 1e-9)!;
    expect(p3.args[1]).toBeCloseTo(ps.priceToY(drawn), 9);
    expect(ser.hitTestPx(h.timeScale.indexToX(3), ps.priceToY(drawn))).toBe('close');
    expect(ser.hitTestPx(h.timeScale.indexToX(3), ps.priceToY(54))).toBeNull();
    // Last value: scaled price for the axis, raw value kept.
    expect(ser.lastValues()).toEqual([
      { outputId: 'close', price: drawn, raw: 54, color: '#2962ff' },
    ]);
    // Legends stay raw.
    expect(s.legendValues(3, 1, 2)[0]!.value).toBe(54);
  });

  it('skips leading NaN overlay values for the reference bar', () => {
    const s = withData([plot('close')], { close: f64([50, NaN, 60, 54]) }, {}, { compare: true });
    const ser = new StudySeries(s, refHost(closes));
    expect(ser.compareFactor(1, 3)).toBe(0.25);
    const ps = percentScale(12);
    expect(ps.toInternal(ser.valuesAt(2)[0]!)).toBe(25);
    expect(ps.toInternal(ser.valuesAt(3)[0]!)).toBe(12.5);
  });

  it('draws nothing when the first visible overlay value is not positive', () => {
    const s = withData([plot('close')], { close: f64([-3, 55, 60, 54]) }, {}, { compare: true });
    const ser = new StudySeries(s, refHost(closes));
    expect(ser.compareFactor(0, 3)).toBeNaN();
    expect(ser.priceRange(0, 3)).toBeNull();
    const ctx = new RecCtx();
    ser.draw(rc(refHost(closes), percentScale(10), 0, 3, ctx));
    expect(ctx.calls).toHaveLength(0);
    expect(ser.valuesAt(2)).toEqual([]);
    expect(ser.lastValues()).toEqual([]);
    expect(ser.hitTestPx(0, 0)).toBeNull();
  });

  it('recomputes the cached factor when data or the reference changes', () => {
    const s = withData([plot('close')], { close: f64([50, 55, 60, 54]) }, {}, { compare: true });
    const h = refHost(closes);
    const ser = new StudySeries(s, h);
    expect(ser.compareFactor(1, 3)).toBe(12 / 55);
    (h.store.close as Float64Array)[1] = 11; // live update of the reference bar
    expect(ser.compareFactor(1, 3)).toBe(11 / 55);
    s.values.close![1] = NaN;
    ser.dataVersion++;
    expect(ser.compareFactor(1, 3)).toBe(0.25);
  });

  it('ignores compare off the main pane or on other scales', () => {
    const s = withData([plot('close')], { close: f64([50, 55, 60, 54]) }, {}, { compare: true });
    s.paneId = 'p2';
    const ser = new StudySeries(s, refHost(closes));
    expect(ser.isCompare).toBe(false);
    expect(ser.valuesAt(3)).toEqual([54]);
  });

  it("draws 'own' studies on a full-height linear scale outside the pane's auto-scale", () => {
    const s = withData([plot('close')], { close: f64([5, 10]) }, {}, { priceScale: 'own' });
    const h = refHost([100, 100]);
    const ser = new StudySeries(s, h);
    expect(ser.excludeFromAutoscale).toBe(true);
    expect(ser.behind).toBe(false);
    expect(ser.priceRange(0, 1)).toBeNull();
    expect(ser.baseValue(0)).toBeNull();
    expect(ser.valuesAt(1)).toEqual([]); // no magnet
    expect(ser.lastValues()).toEqual([]); // not drawn yet
    const ps = percentScale(100);
    ps.height = 100;
    const ctx = new RecCtx();
    ser.draw(rc(h, ps, 0, 1, ctx));
    const pts = ctx.of('stroke')[0]!.path!.filter((p) => p.op !== 'arc');
    const y = (i: number) =>
      pts.find((p) => Math.abs(p.args[0]! - h.timeScale.indexToX(i)) < 1e-9)!.args[1]!;
    expect(y(1)).toBeCloseTo(10, 9);
    expect(y(0)).toBeCloseTo(92, 9);
    expect(ser.lastValues()).toEqual([
      { outputId: 'close', price: 10, raw: 10, y: 10, color: '#2962ff' },
    ]);
    expect(ser.hitTestPx(h.timeScale.indexToX(0), 92)).toBe('close');
  });

  it("keeps 'none' studies behind without last values", () => {
    const s = withData([plot('v')], { v: f64([1, 2]) }, {}, { priceScale: 'none' });
    const ser = new StudySeries(s, refHost([1, 2]));
    expect(ser.behind).toBe(true);
    expect(ser.lastValues()).toEqual([]);
  });
});

describe('render helpers', () => {
  it('maps positions to data indices with offsets', () => {
    expect(dataRange(10, 50, 0, 100)).toEqual([10, 50]);
    expect(dataRange(10, 50, 26, 30)).toEqual([0, 24]);
    expect(dataRange(10, 50, -26, 100)).toEqual([36, 76]);
  });
});

describe('diffTail (brick live updates)', () => {
  const series = (closes: number[]): OhlcvSource => {
    const n = closes.length;
    const c = Float64Array.from(closes);
    return {
      time: Float64Array.from({ length: n }, (_, i) => i),
      open: c,
      high: c,
      low: c,
      close: c,
      volume: c,
      length: n,
    };
  };

  it('detects update, append, update + append and no change', () => {
    expect(diffTail(series([1, 2, 3]), series([1, 2, 3]))).toEqual([]);
    expect(diffTail(series([1, 2, 3]), series([1, 2, 4]))).toEqual([{ kind: 'update', index: 2 }]);
    expect(diffTail(series([1, 2, 3]), series([1, 2, 3, 4]))).toEqual([
      { kind: 'append', index: 3 },
    ]);
    expect(diffTail(series([1, 2, 3]), series([1, 2, 5, 6, 7]))).toEqual([
      { kind: 'update', index: 2 },
      { kind: 'append', index: 3 },
      { kind: 'append', index: 4 },
    ]);
  });

  it('falls back to reset when earlier bars change or bars disappear', () => {
    expect(diffTail(series([1, 2, 3]), series([1, 9, 3]))).toBeNull();
    expect(diffTail(series([1, 2, 3]), series([1, 2]))).toBeNull();
    expect(diffTail(series([]), series([1]))).toBeNull();
  });

  it('snapshots and compares only the tail window', () => {
    const closes = Array.from({ length: 40 }, (_, i) => i);
    const snap = snapshotSeries(series(closes));
    expect(snap.offset).toBe(40 - 17);
    expect(snap.length).toBe(40);
    expect(snap.close).toHaveLength(17);
    expect(diffTail(snap, series([...closes, 40]))).toEqual([{ kind: 'append', index: 40 }]);
    const inWindow = [...closes];
    inWindow[30] = -1;
    expect(diffTail(snap, series(inWindow))).toBeNull();
    expect(diffTail(snap, series(closes.slice(0, 39)))).toBeNull();
  });

  it('snapshots are independent copies', () => {
    const src = series([1, 2, 3]);
    const snap = snapshotSeries(src);
    (src.close as Float64Array)[0] = 99;
    expect(snap.close[0]).toBe(1);
    expect(snap.length).toBe(3);
  });
});

describe('formatting', () => {
  it('formats by study format and precision', () => {
    expect(formatStudyValue(1234.5678, 'inherit', null, 2)).toBe('1234.57');
    expect(formatStudyValue(1234.5678, 'price', 3, 2)).toBe('1234.568');
    expect(formatStudyValue(12.3456, 'percent', null, 4)).toBe('12.35%');
    expect(formatStudyValue(2_500_000, 'volume', null, 2)).toBe('2.5M');
    expect(formatStudyValue(NaN, 'price', 2, 2)).toBe('');
    expect(formatStudyTick(50, 'percent', 0)).toBe('50%');
    expect(formatStudyTick(50, 'price', 0)).toBeNull();
  });
});
