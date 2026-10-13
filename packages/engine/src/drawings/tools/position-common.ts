// Long/Short position: entry/target/stop zones with risk/reward stats.
//
// Anchors: [0] entry (left edge time, entry price), [1] target (right edge
// time, target price), [2] stop (right edge time, stop price). One-click
// creation derives [1] and [2] in `completePoints`.
import {
  BODY_HIT,
  clamp,
  hitLabelSize,
  infoLabel,
  infoLabelSize,
  setLineStyle,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import type {
  DrawingAxisLabel,
  DrawingGeometry,
  DrawingLineStyle,
  DrawingPoint,
  DrawingRenderState,
  DrawingToolDefinition,
} from '../types';

export type PositionSide = 'long' | 'short';

/** Width (bars) and level offsets (fraction of the pane height) of a one-click position. */
export const POSITION_DEFAULT_BARS = 20;
export const POSITION_TARGET_FRACTION = 0.1;
export const POSITION_STOP_FRACTION = 0.05;

export const POSITION_DEFAULTS = {
  /** Entry line; also the handle colour. */
  lineColor: '#787b86',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  profitColor: 'rgba(8, 153, 129, 0.2)',
  stopColor: 'rgba(242, 54, 69, 0.2)',
  targetLabelColor: '#089981',
  stopLabelColor: '#f23645',
  textColor: '#ffffff',
  accountSize: 1000,
  lotSize: 1,
  risk: 25,
  riskUnit: 'percent' as 'percent' | 'currency',
  /** Short labels (prices only). */
  compact: false,
  /** Centre stats (qty, R:R) also when not selected/hovered. */
  alwaysShowStats: false,
};

export type PositionStyle = typeof POSITION_DEFAULTS;

export interface PositionStats {
  /** Money at risk: accountSize * risk% or `risk` in currency. */
  riskAmount: number;
  /** Units (lots) sized so hitting the stop loses `riskAmount`; 0 when entry = stop. */
  qty: number;
  /** |target - entry| and |entry - stop| (price units). */
  reward: number;
  riskDistance: number;
  /** Signed % move from entry to target / stop. */
  targetPercent: number;
  stopPercent: number;
  /** Money won at the target / lost at the stop for `qty`. */
  profitAmount: number;
  lossAmount: number;
  /** reward / riskDistance (Infinity when entry = stop). */
  riskReward: number;
}

/** Risk/reward math (pure). */
export function positionStats(
  entry: number,
  target: number,
  stop: number,
  s: Pick<PositionStyle, 'accountSize' | 'lotSize' | 'risk' | 'riskUnit'>,
): PositionStats {
  const riskAmount = s.riskUnit === 'percent' ? (s.accountSize * s.risk) / 100 : s.risk;
  const reward = Math.abs(target - entry);
  const riskDistance = Math.abs(entry - stop);
  const lot = s.lotSize > 0 ? s.lotSize : 1;
  const qty = riskDistance > 0 ? riskAmount / (riskDistance * lot) : 0;
  const pct = (v: number) => (entry !== 0 ? ((v - entry) / Math.abs(entry)) * 100 : NaN);
  return {
    riskAmount,
    qty,
    reward,
    riskDistance,
    targetPercent: pct(target),
    stopPercent: pct(stop),
    profitAmount: reward * lot * qty,
    lossAmount: riskDistance * lot * qty,
    riskReward: riskDistance > 0 ? reward / riskDistance : Infinity,
  };
}

/** Pixel layout: left/right x, entry/target/stop y and prices (reused). */
const lay = { x0: 0, x1: 0, yE: 0, yT: 0, yS: 0, entry: 0, target: 0, stop: 0 };

/**
 * Layout from the anchors; with only the entry anchor (one-click draft) the
 * target/stop/right edge are the defaults `completePoints` will create.
 */
function layout(g: DrawingGeometry, side: PositionSide): typeof lay | null {
  const [pE, pT, pS] = g.drawing.points;
  const [a, b, c] = g.points;
  if (!pE || !a) return null;
  lay.x0 = a.x;
  lay.yE = a.y;
  lay.entry = pE.price;
  if (pT && pS && b && c) {
    lay.x1 = b.x;
    lay.yT = b.y;
    lay.yS = c.y;
    lay.target = pT.price;
    lay.stop = pS.price;
  } else {
    const dir = side === 'long' ? -1 : 1;
    lay.x1 = g.logicalToX((g.logical[0] ?? 0) + POSITION_DEFAULT_BARS);
    lay.yT = a.y + dir * g.height * POSITION_TARGET_FRACTION;
    lay.yS = a.y - dir * g.height * POSITION_STOP_FRACTION;
    lay.target = g.yToPrice(lay.yT);
    lay.stop = g.yToPrice(lay.yS);
  }
  return lay;
}

function money(v: number): string {
  return v.toFixed(2);
}

const one: string[] = [''];
const two: string[] = ['', ''];

const box = { x: 0, y: 0, w: 0, h: 0 };

/** Zone label box (size w x h) centred at cx, above or below the zone edge y, inside the pane. */
function zoneBox(g: DrawingGeometry, w: number, h: number, cx: number, y: number, above: boolean) {
  box.w = w;
  box.h = h;
  box.x = clamp(cx - w / 2, 2, Math.max(2, g.width - w - 2));
  box.y = clamp(above ? y - h - 4 : y + 4, 2, Math.max(2, g.height - h - 2));
  return box;
}

/** Stats box (Qty, R/R) on the entry line, on the side of the larger zone. */
function statsBox(g: DrawingGeometry, L: typeof lay, w: number, h: number) {
  const cx = (Math.min(L.x0, L.x1) + Math.max(L.x0, L.x1)) / 2;
  box.w = w;
  box.h = h;
  box.x = clamp(cx - w / 2, 2, Math.max(2, g.width - w - 2));
  const below = Math.abs(L.yS - L.yE) >= Math.abs(L.yT - L.yE) === L.yS > L.yE;
  box.y = clamp(below ? L.yE + 4 : L.yE - h - 4, 2, Math.max(2, g.height - h - 2));
  return box;
}

const inRect = (r: typeof box, x: number, y: number) =>
  x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Target/stop label texts and the stats lines (shared buffers). */
function labelTexts(g: DrawingGeometry, L: typeof lay, s: PositionStyle) {
  const st = positionStats(L.entry, L.target, L.stop, s);
  const f = g.format;
  const target = s.compact
    ? f.price(L.target)
    : `Target: ${f.price(L.target)} (${f.percent(st.targetPercent)}) ${f.price(st.reward)}, Amount: ${money(st.profitAmount)}`;
  const stop = s.compact
    ? f.price(L.stop)
    : `Stop: ${f.price(L.stop)} (${f.percent(st.stopPercent)}) ${f.price(st.riskDistance)}, Amount: ${money(st.lossAmount)}`;
  two[0] = `Qty: ${+st.qty.toFixed(4)}`;
  two[1] = `Risk/Reward Ratio: ${Number.isFinite(st.riskReward) ? st.riskReward.toFixed(2) : '∞'}`;
  return { target, stop, stats: two };
}

/** Label box centred at x, above (`above`) or below the zone edge y. */
function zoneLabel(
  ctx: CanvasRenderingContext2D,
  theme: Parameters<typeof infoLabel>[4],
  lines: string[],
  cx: number,
  y: number,
  above: boolean,
  bg: string,
  fg: string,
  g: DrawingGeometry,
): void {
  const { w, h } = infoLabelSize(ctx, lines, theme);
  const b = zoneBox(g, w, h, cx, y, above);
  infoLabel(ctx, lines, b.x, b.y, theme, bg, fg);
}

/** Tool definition for one side. */
export function positionTool(side: PositionSide): DrawingToolDefinition<PositionStyle> {
  const long = side === 'long';
  return defineDrawingTool({
    type: long ? 'long-position' : 'short-position',
    name: long ? 'Long position' : 'Short position',
    group: 'forecasting',
    creation: { kind: 'click' },
    shiftConstraint: 'none',
    defaults: POSITION_DEFAULTS,
    properties: [
      { kind: 'number', key: 'accountSize', label: 'Account size', group: 'Inputs', min: 0 },
      { kind: 'number', key: 'lotSize', label: 'Lot size', group: 'Inputs', min: 0 },
      { kind: 'number', key: 'risk', label: 'Risk', group: 'Inputs', inline: 'risk', min: 0 },
      {
        kind: 'enum',
        key: 'riskUnit',
        label: 'Unit',
        group: 'Inputs',
        inline: 'risk',
        options: ['percent', 'currency'],
        labels: ['%', 'Currency'],
      },
      { kind: 'color', key: 'lineColor', label: 'Lines', inline: 'line' },
      { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
      { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
      { kind: 'color', key: 'profitColor', label: 'Profit background', inline: 'bg' },
      { kind: 'color', key: 'stopColor', label: 'Stop background', inline: 'bg' },
      { kind: 'color', key: 'targetLabelColor', label: 'Target label', inline: 'labels' },
      { kind: 'color', key: 'stopLabelColor', label: 'Stop label', inline: 'labels' },
      { kind: 'color', key: 'textColor', label: 'Text', inline: 'labels' },
      { kind: 'bool', key: 'compact', label: 'Compact stats mode' },
      { kind: 'bool', key: 'alwaysShowStats', label: 'Always show stats' },
    ],

    render({ ctx, theme }, g, s, state) {
      const L = layout(g, side);
      if (!L) return;
      const l = Math.min(L.x0, L.x1);
      const r = Math.max(L.x0, L.x1);
      ctx.fillStyle = s.profitColor;
      ctx.fillRect(l, Math.min(L.yE, L.yT), r - l, Math.abs(L.yT - L.yE));
      ctx.fillStyle = s.stopColor;
      ctx.fillRect(l, Math.min(L.yE, L.yS), r - l, Math.abs(L.yS - L.yE));
      setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
      ctx.beginPath();
      ctx.moveTo(l, L.yE);
      ctx.lineTo(r, L.yE);
      ctx.stroke();

      const t = labelTexts(g, L, s);
      const cx = (l + r) / 2;
      one[0] = t.target;
      zoneLabel(ctx, theme, one, cx, L.yT, L.yT < L.yE, s.targetLabelColor, s.textColor, g);
      one[0] = t.stop;
      zoneLabel(ctx, theme, one, cx, L.yS, L.yS < L.yE, s.stopLabelColor, s.textColor, g);
      if (s.alwaysShowStats || state.selected || state.hovered || state.editing) {
        const { w, h } = infoLabelSize(ctx, t.stats, theme);
        const b = statsBox(g, L, w, h);
        infoLabel(ctx, t.stats, b.x, b.y, theme, s.lineColor, s.textColor);
      }
    },

    hitTest(g, s, x, y, tol) {
      const L = layout(g, side);
      if (!L) return null;
      const l = Math.min(L.x0, L.x1);
      const r = Math.max(L.x0, L.x1);
      // Target/stop labels and the stats box (shown on hover) are strong parts.
      const t = labelTexts(g, L, s);
      const cx = (l + r) / 2;
      one[0] = t.target;
      let sz = hitLabelSize(one);
      if (inRect(zoneBox(g, sz.w, sz.h, cx, L.yT, L.yT < L.yE), x, y)) return BODY_HIT;
      one[0] = t.stop;
      sz = hitLabelSize(one);
      if (inRect(zoneBox(g, sz.w, sz.h, cx, L.yS, L.yS < L.yE), x, y)) return BODY_HIT;
      sz = hitLabelSize(t.stats);
      if (inRect(statsBox(g, L, sz.w, sz.h), x, y)) return BODY_HIT;
      if (x < l - tol || x > r + tol) return null;
      if (Math.abs(y - L.yE) <= tol + s.lineWidth / 2) return BODY_HIT;
      const lo = Math.min(L.yE, L.yT, L.yS);
      const hi = Math.max(L.yE, L.yT, L.yS);
      return x >= l && x <= r && y >= lo && y <= hi ? WEAK_BODY_HIT : null;
    },

    /** 0 entry, 1 target, 2 stop (left edge), 3 right edge (on the entry line). */
    handles(g) {
      const L = layout(g, side);
      if (!L) return [];
      return [
        { x: L.x0, y: L.yE, cursor: 'move' },
        { x: L.x0, y: L.yT, cursor: 'ns-resize' },
        { x: L.x0, y: L.yS, cursor: 'ns-resize' },
        { x: L.x1, y: L.yE, cursor: 'ew-resize' },
      ];
    },

    moveHandle({ start, handle, target }) {
      const [pE, pT, pS] = start;
      if (!pE || !pT || !pS) return start.map((p) => ({ ...p }));
      switch (handle) {
        case 0:
          return [target, { ...pT }, { ...pS }];
        case 1:
          return [{ ...pE }, withPrice(pT, target.price), { ...pS }];
        case 2:
          return [{ ...pE }, { ...pT }, withPrice(pS, target.price)];
        case 3:
          return [{ ...pE }, withTime(pT, target), withTime(pS, target)];
        default:
          return [{ ...pE }, { ...pT }, { ...pS }];
      }
    },

    completePoints(points, g) {
      const pE = points[0];
      if (!pE || points.length >= 3) return points.map((p) => ({ ...p }));
      const L = layout(g, side);
      if (!L) return points.map((p) => ({ ...p }));
      const right: DrawingPoint = g.toPoint(L.x1, L.yE);
      return [
        { ...pE },
        withPrice(withTime(pE, right), L.target),
        withPrice(withTime(pE, right), L.stop),
      ];
    },

    priceAxisLabels(d, s, state) {
      return axisPrices(d.points, s, state);
    },

    timeAxisLabels(d, s, state) {
      const [pE, pT] = d.points;
      if (!pE || !pT || (!state.selected && !state.editing)) return [];
      return [
        { value: pE.time, color: s.lineColor },
        { value: pT.time, color: s.lineColor },
      ];
    },

    isVisible(g) {
      const L = layout(g, side);
      return !!L && Math.max(L.x0, L.x1) >= -20 && Math.min(L.x0, L.x1) <= g.width + 20;
    },
  });
}

function axisPrices(
  points: readonly DrawingPoint[],
  s: PositionStyle,
  state: DrawingRenderState,
): DrawingAxisLabel[] {
  const [pE, pT, pS] = points;
  if (!pE || !pT || !pS || (!state.selected && !state.editing)) return [];
  return [
    { value: pE.price, color: s.lineColor },
    { value: pT.price, color: s.targetLabelColor },
    { value: pS.price, color: s.stopLabelColor },
  ];
}
