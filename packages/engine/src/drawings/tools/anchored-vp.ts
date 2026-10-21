import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import {
  hitVolumeProfile,
  renderVolumeProfile,
  VP_DEFAULTS,
  VP_PROPERTIES,
  vpInView,
  vpLayout,
  type VpStyle,
} from './vp-common';

function layoutOf(g: DrawingGeometry, s: VpStyle) {
  const l0 = g.logical[0];
  const last = g.bars.length - 1;
  if (l0 === undefined || !Number.isFinite(l0) || last < 0 || Math.round(l0) > last) return null;
  return vpLayout(g, s, l0, last);
}

/**
 * Volume profile from the anchor bar to the last bar (grows with new data).
 * One click; the anchor's price is ignored.
 */
export const anchoredVp = defineDrawingTool({
  type: 'anchored-vp',
  name: 'Anchored volume profile',
  group: 'forecasting',
  creation: { kind: 'click' },
  axes: 'time',
  panes: 'main',
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

  /** On the POC line at the anchor's x. */
  handles(g, s) {
    const p = g.points[0];
    if (!p) return [];
    const L = layoutOf(g, s);
    return [{ x: p.x, y: L ? L.pocY : p.y, cursor: 'ew-resize' }];
  },

  priceAxisLabels() {
    return [];
  },

  /** The profile spans anchor -> last bar, beyond the anchor. */
  isVisible(g, s) {
    const L = layoutOf(g, s);
    return !!L && vpInView(g, s, L);
  },
});
