import { formatStudyValue } from './format';
import type {
  StudyData,
  StudyDataPatch,
  StudyLegendValue,
  StudyOutputMeta,
  StudyOutputStylePatch,
  StudyPlotMeta,
  StudySpec,
} from './types';

const EMPTY_F64 = new Float64Array(0);

/** Palette colour for bar j of an output (index arrays only for multi-colour palettes). */
export function paletteColor(
  colors: readonly string[],
  idx: Uint8Array | undefined,
  j: number,
): string {
  if (colors.length <= 1 || !idx) return colors[0] ?? '';
  return colors[idx[j] ?? 0] ?? colors[0] ?? '';
}

/**
 * One study's spec and computed values. Pure data, no drawing; values are
 * aligned to the displayed series of the revision they were computed on.
 */
export class Study {
  spec: StudySpec;
  paneId: string;
  /** seriesRevision of the stored values; -1 = no data yet. */
  revision = -1;
  length = 0;
  values: Record<string, Float64Array> = {};
  colors: Record<string, Uint8Array> = {};

  constructor(spec: StudySpec, paneId: string) {
    this.spec = structuredClone(spec);
    this.paneId = paneId;
  }

  get id(): string {
    return this.spec.id;
  }

  /** Values are drawable for the current displayed series. */
  isCurrent(seriesRevision: number): boolean {
    return this.revision === seriesRevision;
  }

  output(id: string): StudyOutputMeta | undefined {
    return this.spec.outputs.find((o) => o.id === id);
  }

  setData(d: StudyData): void {
    this.revision = d.revision;
    this.length = Math.max(0, d.length);
    this.values = { ...d.values };
    this.colors = { ...d.colors };
  }

  /**
   * Apply a tail patch. Returns false (and changes nothing) when its revision
   * is stale or does not match the stored data, or when it would leave a gap.
   */
  patch(p: StudyDataPatch, seriesRevision: number): boolean {
    if (p.revision !== seriesRevision || p.revision !== this.revision) return false;
    if (p.from < 0 || p.from > this.length || p.length < p.from) return false;
    const n = p.length;
    const count = n - p.from;
    for (const o of this.spec.outputs) {
      if (o.type === 'hline') continue;
      const id = o.id;
      if (o.type !== 'fill') {
        const arr = growF64(this.values[id], p.from, n);
        const src = p.values[id];
        for (let k = 0; k < count; k++) arr[p.from + k] = src?.[k] ?? NaN;
        this.values[id] = arr;
      }
      const srcColors = p.colors[id];
      const cur = this.colors[id];
      if (srcColors || cur) {
        const arr = growU8(cur, p.from, n);
        for (let k = 0; k < count; k++) arr[p.from + k] = srcColors?.[k] ?? 0;
        this.colors[id] = arr;
      }
    }
    this.length = n;
    return true;
  }

  /**
   * History prepend: move data of revision `from` right by `added` bars (NaN /
   * palette 0 in front) and re-stamp it as `to`. Other revisions are left as
   * they are (stale data stays undrawn). Returns whether data was shifted.
   */
  shift(added: number, from: number, to: number): boolean {
    if (this.revision !== from || added <= 0) return false;
    const n = this.length;
    for (const [id, arr] of Object.entries(this.values)) {
      const next = new Float64Array(n + added).fill(NaN);
      next.set(arr.subarray(0, Math.min(n, arr.length)), added);
      this.values[id] = next;
    }
    for (const [id, arr] of Object.entries(this.colors)) {
      const next = new Uint8Array(n + added);
      next.set(arr.subarray(0, Math.min(n, arr.length)), added);
      this.colors[id] = next;
    }
    this.length = n + added;
    this.revision = to;
    return true;
  }

  /** Values of a plot (empty when it has none). */
  plotValues(id: string): Float64Array {
    return this.values[id] ?? EMPTY_F64;
  }

  setStyle(outputId: string, s: StudyOutputStylePatch): boolean {
    const o = this.output(outputId);
    if (!o) return false;
    if (s.visible !== undefined) o.visible = s.visible;
    switch (o.type) {
      case 'plot':
        if (s.kind !== undefined) o.kind = s.kind;
        if (s.lineWidth !== undefined) o.lineWidth = s.lineWidth;
        if (s.lineStyle !== undefined) o.lineStyle = s.lineStyle;
        applyColors(o, s);
        break;
      case 'hline':
        if (s.color !== undefined) o.color = s.color;
        else if (s.colors?.[0] !== undefined) o.color = s.colors[0];
        if (s.lineWidth !== undefined) o.lineWidth = s.lineWidth;
        if (s.lineStyle !== undefined) o.lineStyle = s.lineStyle;
        break;
      case 'fill':
      case 'bgcolor':
        applyColors(o, s);
        break;
      case 'shape':
        applyColors(o, s);
        if (s.size !== undefined) o.size = s.size;
        if (s.textColor !== undefined) o.textColor = s.textColor;
        break;
    }
    return true;
  }

  updateSpec(patch: Partial<Omit<StudySpec, 'id' | 'target'>>): void {
    const next = structuredClone(patch);
    this.spec = { ...this.spec, ...next };
  }

  /** Legend values of visible plots at displayed bar `index` (offset applied). */
  legendValues(index: number, seriesRevision: number, symbolDecimals: number): StudyLegendValue[] {
    const out: StudyLegendValue[] = [];
    const current = this.isCurrent(seriesRevision);
    const { format, precision } = this.spec;
    for (const o of this.spec.outputs) {
      if (o.type !== 'plot' || !o.visible) continue;
      const j = index - o.offset;
      const vals = this.values[o.id];
      const v = current && vals && j >= 0 && j < this.length ? vals[j]! : NaN;
      out.push({
        outputId: o.id,
        title: o.title,
        value: v,
        text: formatStudyValue(v, format, precision, symbolDecimals),
        color:
          current && j >= 0 && j < this.length
            ? paletteColor(o.colors, this.colors[o.id], j)
            : (o.colors[0] ?? ''),
      });
    }
    return out;
  }
}

/** Bounds of visible-plot (and hline, histogram base) values drawn at positions [pFrom, pTo]. */
export function studyValueRange(
  study: Study,
  pFrom: number,
  pTo: number,
  limit: number,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const o of study.spec.outputs) {
    if (!o.visible) continue;
    if (o.type === 'hline') {
      if (Number.isFinite(o.value)) {
        if (o.value < min) min = o.value;
        if (o.value > max) max = o.value;
      }
      continue;
    }
    if (o.type !== 'plot') continue;
    const vals = study.values[o.id];
    if (!vals) continue;
    const j0 = Math.max(0, pFrom - o.offset);
    const j1 = Math.min(limit - 1, pTo - o.offset);
    let found = false;
    for (let j = j0; j <= j1; j++) {
      const v = vals[j]!;
      if (v !== v) continue; // NaN
      if (v < min) min = v;
      if (v > max) max = v;
      found = true;
    }
    if (found && (o.kind === 'histogram' || o.kind === 'columns')) {
      const b = plotBase(o);
      if (b < min) min = b;
      if (b > max) max = b;
    }
  }
  return min <= max ? { min, max } : null;
}

/** Histogram/columns base (0 when unset). */
export function plotBase(o: StudyPlotMeta): number {
  return o.base ?? 0;
}

function applyColors(o: { colors: string[] }, s: StudyOutputStylePatch): void {
  if (s.colors) o.colors = [...s.colors];
  else if (s.color !== undefined) o.colors = [s.color, ...o.colors.slice(1)];
}

function growF64(cur: Float64Array | undefined, keep: number, n: number): Float64Array {
  if (cur && cur.length >= n) return cur;
  const next = new Float64Array(Math.max(n, Math.ceil(n * 1.25) + 16)).fill(NaN);
  if (cur) next.set(cur.subarray(0, Math.min(keep, cur.length)));
  return next;
}

function growU8(cur: Uint8Array | undefined, keep: number, n: number): Uint8Array {
  if (cur && cur.length >= n) return cur;
  const next = new Uint8Array(Math.max(n, Math.ceil(n * 1.25) + 16));
  if (cur) next.set(cur.subarray(0, Math.min(keep, cur.length)));
  return next;
}
