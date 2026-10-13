import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';

export const CROSS_LINE_DEFAULTS = {
  lineColor: '#2962ff',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  showPriceLabel: true,
  showTimeLabel: true,
};

/** Horizontal + vertical line through one anchor; price and time axis labels. */
export const crossLine = defineDrawingTool({
  type: 'cross-line',
  name: 'Cross line',
  group: 'lines',
  creation: { kind: 'click' },
  defaults: CROSS_LINE_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'showPriceLabel', label: 'Price label' },
    { kind: 'bool', key: 'showTimeLabel', label: 'Time label' },
  ],

  render({ ctx }, g, s) {
    const p = g.points[0];
    if (!p) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    ctx.moveTo(0, p.y);
    ctx.lineTo(g.width, p.y);
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, g.height);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const p = g.points[0];
    if (!p) return null;
    const t = tol + s.lineWidth / 2;
    return Math.abs(y - p.y) <= t || Math.abs(x - p.x) <= t ? BODY_HIT : null;
  },

  handles(g) {
    const p = g.points[0];
    return p ? [{ x: p.x, y: p.y, cursor: 'move' }] : [];
  },

  priceAxisLabels(d, s, state) {
    const p = d.points[0];
    return p && (s.showPriceLabel || state.selected)
      ? [{ value: p.price, color: s.lineColor }]
      : [];
  },

  timeAxisLabels(d, s, state) {
    const p = d.points[0];
    return p && (s.showTimeLabel || state.selected) ? [{ value: p.time, color: s.lineColor }] : [];
  },

  isVisible(g) {
    const p = g.points[0];
    if (!p) return false;
    return (p.x >= -20 && p.x <= g.width + 20) || (p.y >= -20 && p.y <= g.height + 20);
  },
});
