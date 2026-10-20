import {
  getDrawingTool,
  parseInterval,
  type Drawing,
  type DrawingIntervalVisibility,
  type DrawingPatch,
  type Interval,
} from '@investopen/engine';
import {
  VISIBILITY_UNITS,
  defaultVisibility,
  type IntervalVisibility,
  type VisibilityUnit,
} from '../indicators/model';

/** Structural equality for JSON values (key order ignored). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => deepEqual(ao[k], bo[k]));
}

/** `patch` applied like `Chart.updateDrawing` (style merged per key, id/type kept). */
export function patchDrawing(d: Drawing, patch: DrawingPatch): Drawing {
  const { id: _id, type: _type, style, ...rest } = patch;
  return structuredClone({ ...d, ...rest, style: style ? { ...d.style, ...style } : d.style });
}

/** Tool name for lists and undo labels ('Trend line'), or the raw type. */
export function toolName(type: string): string {
  return getDrawingTool(type)?.name ?? type;
}

// --------------------------------------------------------- visibility

export type VisibilityPreset = 'all' | 'above' | 'only' | 'below';

const UNIT_TO_VIS: Record<Interval['unit'], VisibilityUnit> = {
  minute: 'minutes',
  hour: 'hours',
  day: 'days',
  week: 'weeks',
  month: 'months',
};

/** Interval as (visibility unit, count); "60m" counts as 1 hour like the interval menu. */
export function visibilityPoint(interval: string): { unit: VisibilityUnit; count: number } | null {
  let iv: Interval;
  try {
    iv = parseInterval(interval);
  } catch {
    return null;
  }
  if (iv.unit === 'minute' && iv.count % 60 === 0) return { unit: 'hours', count: iv.count / 60 };
  return { unit: UNIT_TO_VIS[iv.unit], count: iv.count };
}

/** "Visibility on intervals" presets relative to the current interval. */
export function visibilityPreset(
  interval: string,
  preset: VisibilityPreset,
): DrawingIntervalVisibility | null {
  const at = visibilityPoint(interval);
  if (preset === 'all' || !at) return null;
  const vis: IntervalVisibility = defaultVisibility();
  const idx = VISIBILITY_UNITS.findIndex((u) => u.unit === at.unit);
  VISIBILITY_UNITS.forEach(({ unit, limit }, i) => {
    const r = vis[unit];
    if (i < idx) r.enabled = preset === 'below';
    else if (i > idx) r.enabled = preset === 'above';
    else {
      r.min = preset === 'below' ? limit[0] : at.count;
      r.max = preset === 'above' ? limit[1] : at.count;
    }
  });
  return vis;
}

/** The preset `vis` corresponds to on `interval`, if any. */
export function currentPreset(
  vis: DrawingIntervalVisibility | null,
  interval: string,
): VisibilityPreset | null {
  for (const p of ['all', 'above', 'only', 'below'] as const)
    if (deepEqual(visibilityPreset(interval, p), vis)) return p;
  return null;
}
