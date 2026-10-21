// Volume profile study outputs: the engine bins the displayed bars itself
// (drawings/tools/volume-profile.ts) and draws them with the Fixed range
// profile renderer. `values[id]` only marks session period starts.
import {
  cachedVolumeProfile,
  type VolumeProfile,
  type VolumeProfileOptions,
} from '../drawings/tools/volume-profile';
import {
  renderVolumeProfile,
  VP_DEFAULTS,
  vpLayoutOf,
  type VpStyle,
} from '../drawings/tools/vp-common';
import type { StudyDrawContext } from './render';
import type { Study } from './study';
import type { StudyVolumeProfileMeta } from './types';

/** Profiles drawn per output (the shared profile cache holds 64). */
export const MAX_SESSION_PROFILES = 48;
/** Sessions narrower than this many px are skipped (zoomed far out). */
const MIN_SESSION_PX = 4;

/** Drawing style of an output; VAH/VAL lines and the background are off. */
export function profileStyle(o: StudyVolumeProfileMeta): VpStyle {
  const c = o.colors;
  return {
    ...VP_DEFAULTS,
    rowsLayout: o.rowsLayout,
    rows: o.rows,
    rowSize: o.rowSize,
    valueArea: o.valueArea,
    widthPercent: o.widthPercent,
    placement: o.placement,
    upColor: c[0] ?? VP_DEFAULTS.upColor,
    downColor: c[1] ?? VP_DEFAULTS.downColor,
    valueAreaUpColor: c[2] ?? VP_DEFAULTS.valueAreaUpColor,
    valueAreaDownColor: c[3] ?? VP_DEFAULTS.valueAreaDownColor,
    pocColor: c[4] ?? VP_DEFAULTS.pocColor,
    showValueAreaLines: false,
    showBackground: false,
  };
}

/**
 * Session periods as [first, last] bar indices over [0, limit): a period
 * starts at index 0 and at every non-NaN value.
 */
export function sessionPeriods(vals: Float64Array | undefined, limit: number): [number, number][] {
  const out: [number, number][] = [];
  if (limit <= 0) return out;
  let start = 0;
  const n = Math.min(limit, vals?.length ?? 0);
  for (let i = 1; i < n; i++) {
    if (vals![i]! === vals![i]!) {
      out.push([start, i - 1]);
      start = i;
    }
  }
  out.push([start, limit - 1]);
  return out;
}

/**
 * Profiles of an output for the view [v0, v1] (logical bar indices). Each is
 * memoised (study id, output, period start; range, options, bar arrays and
 * the period's last bar), so a live tick only rebins the period it falls in.
 */
export function studyProfiles(
  study: Study,
  o: StudyVolumeProfileMeta,
  dc: Pick<StudyDrawContext, 'bars' | 'limit'>,
  v0: number,
  v1: number,
  minPx = 0,
  barSpacing = 1,
): VolumeProfile[] {
  const limit = Math.min(dc.limit, dc.bars.length);
  if (limit <= 0) return [];
  const opts: VolumeProfileOptions = o;
  const key = `study:${study.id}:${o.id}`;
  const out: VolumeProfile[] = [];
  if (o.mode === 'visible') {
    const p = cachedVolumeProfile(key, dc.bars, Math.max(0, v0), Math.min(limit - 1, v1), opts);
    if (p) out.push(p);
    return out;
  }
  const periods = sessionPeriods(study.values[o.id], limit);
  for (let k = periods.length - 1; k >= 0 && out.length < MAX_SESSION_PROFILES; k--) {
    const [a, b] = periods[k]!;
    if (a > v1) continue;
    if (b < v0) break;
    if ((b - a + 1) * barSpacing < minPx) continue;
    const p = cachedVolumeProfile(`${key}:${a}`, dc.bars, a, b, opts);
    if (p) out.unshift(p);
  }
  return out;
}

export function drawVolumeProfile(
  dc: StudyDrawContext,
  study: Study,
  o: StudyVolumeProfileMeta,
): void {
  const ts = dc.timeScale;
  const v0 = Math.floor(ts.xToLogical(0));
  const v1 = Math.ceil(ts.xToLogical(dc.width));
  const profiles = studyProfiles(study, o, dc, v0, v1, MIN_SESSION_PX, ts.barSpacing);
  if (profiles.length === 0) return;
  const style = profileStyle(o);
  const g = {
    width: dc.width,
    height: dc.height,
    barSpacing: ts.barSpacing,
    priceToY: (p: number) => dc.priceScale.priceToY(p),
    logicalToX: (i: number) => ts.indexToX(i),
  };
  const ctx = dc.ctx;
  // Renderer works in CSS px; study draws use device px.
  ctx.save();
  ctx.scale(dc.dpr, dc.dpr);
  for (const p of profiles) {
    const layout = vpLayoutOf(g, style, p);
    if (layout) renderVolumeProfile({ ctx }, g, style, layout);
  }
  ctx.restore();
}
