// Shared rendering of Fixed range / Anchored volume profile: a horizontal
// histogram of the bars between two logical indices, POC and value area lines.
import { BODY_HIT, setLineStyle, WEAK_BODY_HIT } from '../draw-utils';
import type { DrawingGeometry, DrawingHitPart, DrawingLineStyle, DrawingProperty } from '../types';
import { cachedVolumeProfile, profileLevels, rowPrice, type VolumeProfile } from './volume-profile';

export const VP_DEFAULTS = {
  rowsLayout: 'count' as 'count' | 'size',
  /** Number of rows ('count' layout). */
  rows: 24,
  /** Row height in price units ('size' layout). */
  rowSize: 1,
  /** Value area, % of the range's volume. */
  valueArea: 70,
  /** Histogram width in % of the range width. */
  widthPercent: 30,
  placement: 'left' as 'left' | 'right',
  upColor: 'rgba(79, 107, 237, 0.3)',
  downColor: 'rgba(242, 169, 59, 0.3)',
  valueAreaUpColor: 'rgba(79, 107, 237, 0.7)',
  valueAreaDownColor: 'rgba(242, 169, 59, 0.7)',
  showPoc: true,
  pocColor: '#e5484d',
  pocWidth: 1,
  /** VAH/VAL lines; also the handle colour. */
  showValueAreaLines: true,
  lineColor: '#4f6bed',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  extendPoc: false,
  extendValueArea: false,
  showBackground: true,
  backgroundColor: 'rgba(79, 107, 237, 0.06)',
};

export type VpStyle = typeof VP_DEFAULTS;

export const VP_PROPERTIES: readonly DrawingProperty[] = [
  {
    kind: 'enum',
    key: 'rowsLayout',
    label: 'Rows layout',
    group: 'Inputs',
    options: ['count', 'size'],
    labels: ['Number of rows', 'Row size'],
  },
  { kind: 'number', key: 'rows', label: 'Rows', group: 'Inputs', min: 1, max: 1000, step: 1 },
  { kind: 'number', key: 'rowSize', label: 'Row size (price)', group: 'Inputs', min: 0 },
  {
    kind: 'number',
    key: 'valueArea',
    label: 'Value area volume %',
    group: 'Inputs',
    min: 1,
    max: 100,
    step: 1,
  },
  { kind: 'number', key: 'widthPercent', label: 'Width (% of range)', min: 1, max: 100, step: 1 },
  {
    kind: 'enum',
    key: 'placement',
    label: 'Placement',
    options: ['left', 'right'],
    labels: ['Left', 'Right'],
  },
  { kind: 'color', key: 'upColor', label: 'Up volume', inline: 'vol' },
  { kind: 'color', key: 'downColor', label: 'Down volume', inline: 'vol' },
  { kind: 'color', key: 'valueAreaUpColor', label: 'Value area up', inline: 'va' },
  { kind: 'color', key: 'valueAreaDownColor', label: 'Value area down', inline: 'va' },
  { kind: 'bool', key: 'showPoc', label: 'POC', inline: 'poc' },
  { kind: 'color', key: 'pocColor', label: 'Color', inline: 'poc' },
  { kind: 'lineWidth', key: 'pocWidth', label: 'Width', inline: 'poc' },
  { kind: 'bool', key: 'showValueAreaLines', label: 'VAH/VAL', inline: 'valines' },
  { kind: 'color', key: 'lineColor', label: 'Color', inline: 'valines' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'valines' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'valines' },
  { kind: 'bool', key: 'extendPoc', label: 'Extend POC right', inline: 'extend' },
  { kind: 'bool', key: 'extendValueArea', label: 'Extend VAH/VAL right', inline: 'extend' },
  { kind: 'bool', key: 'showBackground', label: 'Background', inline: 'bg' },
  { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
];

/** Profile of bars [from, to] memoised per drawing (null without data/volume). */
export function vpProfile(
  g: DrawingGeometry,
  s: VpStyle,
  from: number,
  to: number,
): VolumeProfile | null {
  if (g.bars.length === 0) return null;
  return cachedVolumeProfile(g.drawing.id, g.bars, from, to, s);
}

/** What laying out and rendering a profile reads of a geometry (studies pass their own). */
export type VpGeometry = Pick<
  DrawingGeometry,
  'width' | 'height' | 'barSpacing' | 'priceToY' | 'logicalToX'
>;

/** Pixel layout of a profile (shared object). */
export interface VpLayout {
  profile: VolumeProfile;
  /** Range box: x of the first/last bar, y of the highest high/lowest low. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Histogram base x and signed max bar length (negative grows leftwards). */
  baseX: number;
  length: number;
  pocY: number;
  vahY: number;
  valY: number;
}

const layout: VpLayout = {
  profile: null as unknown as VolumeProfile,
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  baseX: 0,
  length: 0,
  pocY: 0,
  vahY: 0,
  valY: 0,
};

/** Layout for bars [from, to], or null without a profile. */
export function vpLayout(
  g: DrawingGeometry,
  s: VpStyle,
  from: number,
  to: number,
): VpLayout | null {
  const p = vpProfile(g, s, from, to);
  return p ? vpLayoutOf(g, s, p) : null;
}

/** Layout of an already computed profile (shared object), or null when off-scale. */
export function vpLayoutOf(g: VpGeometry, s: VpStyle, p: VolumeProfile): VpLayout | null {
  const left = g.logicalToX(p.from);
  const right = g.logicalToX(p.to);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  const width = Math.max(right - left, g.barSpacing);
  const len = (width * Math.min(100, Math.max(1, s.widthPercent))) / 100;
  const lv = profileLevels(p);
  layout.profile = p;
  layout.left = left;
  layout.right = right;
  layout.top = g.priceToY(p.high);
  layout.bottom = g.priceToY(p.low);
  layout.baseX = s.placement === 'right' ? right : left;
  layout.length = s.placement === 'right' ? -len : len;
  layout.pocY = g.priceToY(lv.poc);
  layout.vahY = g.priceToY(lv.vah);
  layout.valY = g.priceToY(lv.val);
  return layout;
}

/** Row `r` top/bottom y (at least 1 px tall). */
function rowYs(g: VpGeometry, p: VolumeProfile, r: number): [number, number] {
  if (p.rowSize <= 0) {
    const y = g.priceToY(p.low);
    return [y - 1, y + 1];
  }
  const a = g.priceToY(rowPrice(p, r + 1));
  const b = g.priceToY(rowPrice(p, r));
  const top = Math.min(a, b);
  const bottom = Math.max(a, b);
  return bottom - top < 1 ? [top - 0.5, top + 0.5] : [top, bottom];
}

function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

export function renderVolumeProfile(
  { ctx }: { ctx: CanvasRenderingContext2D },
  g: VpGeometry,
  s: VpStyle,
  L: VpLayout,
): void {
  const p = L.profile;
  if (s.showBackground) {
    ctx.fillStyle = s.backgroundColor;
    ctx.fillRect(L.left, L.top, L.right - L.left, L.bottom - L.top);
  }
  const max = p.maxRow > 0 ? p.maxRow : 1;
  const dir = Math.sign(L.length) || 1;
  for (let r = 0; r < p.rows; r++) {
    const up = p.up[r]!;
    const down = p.down[r]!;
    if (up + down <= 0) continue;
    const [top, bottom] = rowYs(g, p, r);
    if (bottom < 0 || top > g.height) continue;
    // 1 px gap between rows when they are tall enough.
    const h = bottom - top > 3 ? bottom - top - 1 : bottom - top;
    const inVa = r >= p.val && r <= p.vah;
    const wUp = (Math.abs(L.length) * up) / max;
    const wDown = (Math.abs(L.length) * down) / max;
    ctx.fillStyle = inVa ? s.valueAreaUpColor : s.upColor;
    fillSpan(ctx, L.baseX, dir * wUp, top, h);
    ctx.fillStyle = inVa ? s.valueAreaDownColor : s.downColor;
    fillSpan(ctx, L.baseX + dir * wUp, dir * wDown, top, h);
  }
  const end = (extend: boolean) => (extend ? Math.max(g.width, L.right) : L.right);
  if (s.showValueAreaLines) {
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    hline(ctx, L.left, end(s.extendValueArea), L.vahY);
    hline(ctx, L.left, end(s.extendValueArea), L.valY);
  }
  if (s.showPoc) {
    setLineStyle(ctx, s.pocColor, s.pocWidth, 'solid');
    hline(ctx, L.left, end(s.extendPoc), L.pocY);
  }
}

function fillSpan(ctx: CanvasRenderingContext2D, x: number, w: number, y: number, h: number) {
  if (w === 0) return;
  ctx.fillRect(w < 0 ? x + w : x, y, Math.abs(w), h);
}

/** Histogram rows and lines strong, range background weak. */
export function hitVolumeProfile(
  g: DrawingGeometry,
  s: VpStyle,
  L: VpLayout,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const near = (yy: number, w: number, extend: boolean) =>
    Math.abs(y - yy) <= tol + w / 2 &&
    x >= L.left - tol &&
    x <= (extend ? Math.max(g.width, L.right) : L.right) + tol;
  if (s.showPoc && near(L.pocY, s.pocWidth, s.extendPoc)) return BODY_HIT;
  if (
    s.showValueAreaLines &&
    (near(L.vahY, s.lineWidth, s.extendValueArea) || near(L.valY, s.lineWidth, s.extendValueArea))
  )
    return BODY_HIT;
  const p = L.profile;
  const max = p.maxRow > 0 ? p.maxRow : 1;
  const dir = Math.sign(L.length) || 1;
  const dx = (x - L.baseX) * dir;
  if (dx >= -tol && dx <= Math.abs(L.length) + tol) {
    for (let r = 0; r < p.rows; r++) {
      const [top, bottom] = rowYs(g, p, r);
      if (y < top || y > bottom) continue;
      const w = (Math.abs(L.length) * (p.up[r]! + p.down[r]!)) / max;
      if (w > 0 && dx <= w + tol) return BODY_HIT;
    }
  }
  if (s.showBackground && x >= L.left && x <= L.right && y >= L.top && y <= L.bottom)
    return WEAK_BODY_HIT;
  return null;
}

/** Range box (or extended lines) overlaps the pane. */
export function vpInView(g: DrawingGeometry, s: VpStyle, L: VpLayout): boolean {
  const extended = (s.showPoc && s.extendPoc) || (s.showValueAreaLines && s.extendValueArea);
  const r = extended ? Infinity : Math.max(L.right, L.baseX + L.length);
  const l = Math.min(L.left, L.baseX + L.length);
  return r >= -20 && l <= g.width + 20 && L.bottom >= -20 && L.top <= g.height + 20;
}
