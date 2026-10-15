import { anchorsInView } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingHandle } from '../types';
import {
  hitVolumeProfile,
  renderVolumeProfile,
  VP_DEFAULTS,
  VP_PROPERTIES,
  vpInView,
  vpLayout,
  type VpStyle,
} from './vp-common';

/** Bar range of the two anchors (logical, unrounded), or null. */
function range(g: DrawingGeometry): [number, number] | null {
  const [l0, l1] = g.logical;
  if (l0 === undefined || l1 === undefined || !Number.isFinite(l0) || !Number.isFinite(l1))
    return null;
  return [l0, l1];
}

function layoutOf(g: DrawingGeometry, s: VpStyle) {
  const r = range(g);
  return r ? vpLayout(g, s, r[0], r[1]) : null;
}

/**
 * Volume profile of the bars between two anchors (inclusive): up/down volume
 * per price row, point of control and value area. Anchors only set the bar
 * range (their prices are ignored).
 */
export const fixedRangeVp = defineDrawingTool({
  type: 'fixed-range-vp',
  name: 'Fixed range volume profile',
  group: 'forecasting',
  creation: { kind: 'points', count: 2 },
  axes: 'time',
  panes: 'main',
  shiftConstraint: 'none',
  defaults: VP_DEFAULTS,
  properties: VP_PROPERTIES,

  render(rc, g, s) {
    const L = layoutOf(g, s);
    if (L) renderVolumeProfile(rc, g, s, L);
  },

  hitTest(g, s, x, y, tol) {
    const L = layoutOf(g, s);
    return L ? hitVolumeProfile(g, s, L, x, y, tol) : null;
  },

  /** At each anchor's x on the POC line (anchor prices are ignored). */
  handles(g, s) {
    const L = layoutOf(g, s);
    const hs: DrawingHandle[] = [];
    for (let i = 0; i < Math.min(2, g.points.length); i++) {
      const p = g.points[i]!;
      hs.push({ x: p.x, y: L ? L.pocY : p.y, cursor: 'ew-resize' });
    }
    return hs;
  },

  priceAxisLabels() {
    return [];
  },

  isVisible(g, s) {
    const L = layoutOf(g, s);
    return L ? vpInView(g, s, L) : g.bars.length > 0 && anchorsInView(g);
  },
});
