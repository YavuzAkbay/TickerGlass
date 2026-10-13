import type { StudyGeometry } from './render';
import { SHAPE_SIZES, shapeCenterY } from './render';
import { plotBase, type Study } from './study';
import type { StudyOutputMeta, StudyPlotMeta } from './types';

/** Which outputs a hit test considers: marks = everything except fills. */
export type StudyHitLayer = 'all' | 'marks' | 'fills';

/**
 * Output of `study` under CSS point (x, y), or null. Lines, marks, bars,
 * hlines and shapes win over fills; bgcolor is never hit. `layer` limits the
 * test to marks or fills (the chart tests marks of all series before fills).
 */
export function hitTestStudy(
  dc: StudyGeometry,
  study: Study,
  x: number,
  y: number,
  tol = 4,
  layer: StudyHitLayer = 'all',
): string | null {
  const outs = study.spec.outputs;
  for (let pass = 0; pass < 2; pass++) {
    if ((pass === 0 && layer === 'fills') || (pass === 1 && layer === 'marks')) continue;
    for (let k = outs.length - 1; k >= 0; k--) {
      const o = outs[k]!;
      if (!o.visible || (pass === 0) === (o.type === 'fill')) continue;
      if (hitOutput(dc, study, o, x, y, tol)) return o.id;
    }
  }
  return null;
}

function valueAt(dc: StudyGeometry, vals: Float64Array, off: number, p: number): number {
  const j = p - off;
  return j >= 0 && j < dc.limit ? vals[j]! : NaN;
}

function hitOutput(
  dc: StudyGeometry,
  study: Study,
  o: StudyOutputMeta,
  x: number,
  y: number,
  tol: number,
): boolean {
  const ts = dc.timeScale;
  const ps = dc.priceScale;
  const lp = ts.xToLogical(x);
  const p = Math.round(lp);
  switch (o.type) {
    case 'hline':
      return Number.isFinite(o.value) && Math.abs(ps.priceToY(o.value) - y) <= tol;
    case 'plot': {
      const vals = study.values[o.id];
      return vals ? hitPlot(dc, o, vals, lp, x, y, tol) : false;
    }
    case 'fill': {
      const ya = sideAt(dc, study, o.between[0], p);
      const yb = sideAt(dc, study, o.between[1], p);
      if (ya !== ya || yb !== yb) return false;
      return y >= Math.min(ya, yb) && y <= Math.max(ya, yb);
    }
    case 'shape': {
      const vals = study.values[o.id];
      if (!vals || p < 0 || p >= Math.min(dc.limit, dc.bars.length)) return false;
      const v = vals[p]!;
      if (v !== v) return false;
      const s = SHAPE_SIZES[o.size];
      const cy = shapeCenterY(dc, o, p, v, s);
      return Math.abs(ts.indexToX(p) - x) <= s / 2 + 1 && Math.abs(cy - y) <= s / 2 + tol;
    }
    case 'bgcolor':
      return false;
  }
}

function sideAt(dc: StudyGeometry, study: Study, id: string, p: number): number {
  const o = study.output(id);
  if (o?.type === 'hline') return dc.priceScale.priceToY(o.value);
  if (o?.type !== 'plot') return NaN;
  const vals = study.values[id];
  if (!vals) return NaN;
  const v = valueAt(dc, vals, o.offset, p);
  return v === v ? dc.priceScale.priceToY(v) : NaN;
}

function hitPlot(
  dc: StudyGeometry,
  o: StudyPlotMeta,
  vals: Float64Array,
  lp: number,
  x: number,
  y: number,
  tol: number,
): boolean {
  const ts = dc.timeScale;
  const ps = dc.priceScale;
  const p = Math.round(lp);
  const lw = Math.max(1, o.lineWidth);
  switch (o.kind) {
    case 'histogram':
    case 'columns': {
      const v = valueAt(dc, vals, o.offset, p);
      if (v !== v) return false;
      const half = o.kind === 'histogram' ? Math.max(lw / 2, 2) : Math.max(2, ts.barSpacing * 0.4);
      if (Math.abs(ts.indexToX(p) - x) > half) return false;
      const yv = ps.priceToY(v);
      const yb = ps.priceToY(plotBase(o));
      return y >= Math.min(yv, yb) - tol && y <= Math.max(yv, yb) + tol;
    }
    case 'circles':
    case 'cross': {
      const v = valueAt(dc, vals, o.offset, p);
      if (v !== v) return false;
      const r = lw + 2 + tol;
      return Math.hypot(ts.indexToX(p) - x, ps.priceToY(v) - y) <= r;
    }
    default: {
      // line, step, area: distance to the segment around x.
      const p0 = Math.floor(lp);
      const v0 = valueAt(dc, vals, o.offset, p0);
      const v1 = valueAt(dc, vals, o.offset, p0 + 1);
      const reach = tol + lw / 2;
      const x0 = ts.indexToX(p0);
      const x1 = ts.indexToX(p0 + 1);
      if (v0 === v0 && v1 === v1) {
        const y0 = ps.priceToY(v0);
        const y1 = ps.priceToY(v1);
        if (o.kind === 'step')
          return (
            Math.abs(y - y0) <= reach || (Math.abs(x - x1) <= reach && between(y, y0, y1, reach))
          );
        return segmentDistance(x, y, x0, y0, x1, y1) <= reach;
      }
      const v = valueAt(dc, vals, o.offset, p);
      if (v !== v) return false;
      return Math.hypot(ts.indexToX(p) - x, ps.priceToY(v) - y) <= reach;
    }
  }
}

function between(v: number, a: number, b: number, pad: number): boolean {
  return v >= Math.min(a, b) - pad && v <= Math.max(a, b) + pad;
}

/** Euclidean distance from (px, py) to the segment (x0, y0)-(x1, y1). */
export function segmentDistance(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
