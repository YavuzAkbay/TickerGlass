import { parseInterval } from '../feed/intervals';
import type { ChartTheme, MagnetMode } from '../options';
import type { Interval } from '../types';
import type { TimeScale } from '../scale/time-scale';
import { anchorsInView, colorOf, drawHandle, HANDLE_RADIUS, HIT_TOLERANCE } from './draw-utils';
import { Geometry, type DrawingPane, type GeometryView } from './geometry';
import type { AnchorTimeline } from './mapping';
import { getDrawingTool } from './registry';
import type {
  AnyDrawingToolDefinition,
  Drawing,
  DrawingAxisLabel,
  DrawingBounds,
  DrawingChange,
  DrawingEvents,
  DrawingFormat,
  DrawingHandle,
  DrawingHitPart,
  DrawingInput,
  DrawingIntervalVisibility,
  DrawingOptions,
  DrawingPatch,
  DrawingRenderContext,
  DrawingRenderState,
  PixelPoint,
} from './types';

/** What the drawing layer needs from its chart. */
export interface DrawingHost {
  readonly timeScale: TimeScale;
  readonly theme: ChartTheme;
  /** Pane width (CSS px, without the price axis). */
  readonly paneWidth: number;
  /** Current symbol (default `Drawing.symbol`). */
  readonly symbol: string;
  /** Current interval string, e.g. "1D" (interval visibility). */
  readonly interval: string;
  /** Crosshair magnet setting (anchor snapping, docs/drawings.md §7). Default 'off'. */
  readonly magnet?: MagnetMode;
  /** Values the magnet snaps to at displayed bar `index` of pane `paneId`
   * (OHLC of the displayed series on 'main'). Default: none. */
  magnetValues?(paneId: string, index: number): readonly number[];
  /** Displayed series for anchor mapping (may be refreshed in place). */
  timeline(): AnchorTimeline;
  pane(id: string): DrawingPane | null;
  /** Label formatting for drawings on pane `paneId`. */
  format(paneId: string): DrawingFormat;
  /** Request an overlay redraw. */
  invalidate(): void;
  emit<K extends keyof DrawingEvents>(event: K, payload: DrawingEvents[K]): void;
}

/** A drawing under the pointer. */
export interface DrawingHit {
  id: string;
  part: DrawingHitPart;
  /** CSS cursor for hovering this part. */
  cursor: string;
}

/** Hit-test result: strong hits beat series; weak ones (background fills) do not. */
export interface DrawingHitResult {
  strong: DrawingHit | null;
  weak: DrawingHit | null;
}

let seq = 0;

/** New unique drawing id. */
export function newDrawingId(): string {
  seq = (seq + 1) % 1e6;
  return `drw_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function cloneDrawing(d: Readonly<Drawing>): Drawing {
  return structuredClone(d) as Drawing;
}

/**
 * Drawings of one chart: model, z-order, selection, rendering and hit
 * testing. Pointer gestures live in DrawingInteraction.
 */
export class DrawingLayer {
  /** By id, insertion ordered. Internal objects: hand out copies. */
  readonly items = new Map<string, Drawing>();
  readonly selection = new Set<string>();
  hovered: DrawingHit | null = null;
  options: DrawingOptions = { stayInDrawingMode: false, lockAll: false, hideAll: false };
  /** Drawing being created: drawn on top of its pane, not in `items`. */
  draft: Drawing | null = null;
  /** Ids being dragged (render state `editing`). */
  readonly editing = new Set<string>();
  private sorted: Drawing[] | null = null;
  private readonly geoms = new Map<string, Geometry>();
  private readonly draftGeom = new Geometry();
  private readonly view: GeometryView;
  private readonly rc: DrawingRenderContext;
  private readonly state: DrawingRenderState = { selected: false, hovered: false, editing: false };

  constructor(readonly host: DrawingHost) {
    this.view = { timeline: host.timeline(), timeScale: host.timeScale, width: 0 };
    this.rc = { ctx: null as unknown as CanvasRenderingContext2D, dpr: 1, theme: host.theme };
  }

  // ------------------------------------------------------------ model

  /** Complete `input` into a drawing (not stored). Throws for an unknown tool. */
  build(input: DrawingInput): Drawing {
    const def = getDrawingTool(input.type);
    if (!def) throw new Error(`Unknown drawing tool: ${input.type}`);
    return {
      id: input.id ?? newDrawingId(),
      type: input.type,
      points: input.points.map((p) => ({ ...p })),
      style: { ...structuredClone(def.defaults), ...structuredClone(input.style ?? {}) },
      text: input.text ?? def.text?.default ?? '',
      locked: input.locked ?? false,
      hidden: input.hidden ?? false,
      zIndex: input.zIndex ?? this.topZ() + 1,
      visibility: input.visibility ? structuredClone(input.visibility) : null,
      scope: input.scope ?? 'symbol',
      symbol: input.symbol ?? this.host.symbol,
      paneId: input.paneId ?? 'main',
    };
  }

  /** Store a complete drawing (internal object, not copied). Throws on a duplicate id. */
  insert(d: Drawing): Drawing {
    if (this.items.has(d.id)) throw new Error(`Drawing already exists: ${d.id}`);
    this.items.set(d.id, d);
    this.sorted = null;
    this.host.invalidate();
    return d;
  }

  update(id: string, patch: DrawingPatch): boolean {
    const d = this.items.get(id);
    if (!d) return false;
    const { id: _id, type: _type, style, ...rest } = patch;
    Object.assign(d, structuredClone(rest));
    if (style) Object.assign(d.style, structuredClone(style));
    if (rest.zIndex !== undefined) this.sorted = null;
    this.host.invalidate();
    return true;
  }

  /**
   * Replace a stored drawing wholesale (style keys absent from `d` are
   * dropped, unlike `update`). Keeps the internal object (gestures hold it).
   */
  replace(d: Readonly<Drawing>): boolean {
    const cur = this.items.get(d.id);
    if (!cur) return false;
    const next = cloneDrawing(d);
    const target = cur as unknown as Record<string, unknown>;
    for (const k of Object.keys(target)) if (!(k in next)) delete target[k];
    Object.assign(cur, next);
    this.sorted = null;
    this.host.invalidate();
    return true;
  }

  /** Remove ids; returns the removed drawings (internal objects). */
  remove(ids: Iterable<string>): Drawing[] {
    const out: Drawing[] = [];
    for (const id of ids) {
      const d = this.items.get(id);
      if (!d) continue;
      this.items.delete(id);
      this.geoms.delete(id);
      this.editing.delete(id);
      if (this.hovered?.id === id) this.hovered = null;
      out.push(d);
    }
    if (out.length) {
      this.sorted = null;
      this.dropFromSelection(out.map((d) => d.id));
      this.host.invalidate();
    }
    return out;
  }

  replaceAll(list: readonly Drawing[]): void {
    this.items.clear();
    this.geoms.clear();
    this.editing.clear();
    this.hovered = null;
    for (const d of list) this.items.set(d.id, cloneDrawing(d));
    this.sorted = null;
    this.setSelection([]);
    this.host.invalidate();
  }

  /** Stored drawings in draw order (internal objects). */
  list(): readonly Drawing[] {
    if (!this.sorted) this.sorted = [...this.items.values()].sort((a, b) => a.zIndex - b.zIndex);
    return this.sorted;
  }

  topZ(): number {
    let z = 0;
    for (const d of this.items.values()) z = Math.max(z, d.zIndex);
    return z;
  }

  // ---------------------------------------------------------- z-order

  /**
   * Reorder `ids` within their panes; returns the changes (before/after copies).
   * front/back: above/below everything else in the pane; forward/backward: one
   * step past the next unmoved drawing of the pane.
   */
  reorder(ids: readonly string[], op: 'front' | 'back' | 'forward' | 'backward'): DrawingChange[] {
    const moving = new Set(ids.filter((id) => this.items.has(id)));
    if (!moving.size) return [];
    const before = new Map<string, Drawing>();
    const setZ = (d: Drawing, z: number) => {
      if (d.zIndex === z) return;
      if (!before.has(d.id)) before.set(d.id, cloneDrawing(d));
      d.zIndex = z;
    };
    const panes = new Set([...moving].map((id) => this.items.get(id)!.paneId));
    for (const paneId of panes) {
      const list = this.list().filter((d) => d.paneId === paneId);
      const sel = list.filter((d) => moving.has(d.id));
      const rest = list.filter((d) => !moving.has(d.id));
      if (op === 'front' || op === 'back') {
        // Already there (moving drawings are the top/bottom run): nothing to do.
        const run =
          op === 'front' ? list.slice(list.length - sel.length) : list.slice(0, sel.length);
        if (run.every((d) => moving.has(d.id))) continue;
        if (op === 'front') {
          const top = rest.reduce((z, d) => Math.max(z, d.zIndex), -Infinity);
          sel.forEach((d, i) => setZ(d, top + 1 + i));
        } else {
          const bottom = rest.reduce((z, d) => Math.min(z, d.zIndex), Infinity);
          sel.forEach((d, i) => setZ(d, bottom - sel.length + i));
        }
        continue;
      }
      const order = list.slice();
      if (op === 'forward') {
        for (let i = order.length - 2; i >= 0; i--)
          if (moving.has(order[i]!.id) && !moving.has(order[i + 1]!.id))
            [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
      } else {
        for (let i = 1; i < order.length; i++)
          if (moving.has(order[i]!.id) && !moving.has(order[i - 1]!.id))
            [order[i], order[i - 1]] = [order[i - 1]!, order[i]!];
      }
      // Reuse the pane's zIndex values in the new order (a swap changes two
      // drawings); ties cannot express an order, so renumber from the lowest.
      const zs = list.map((d) => d.zIndex);
      const distinct = new Set(zs).size === zs.length;
      order.forEach((d, i) => setZ(d, distinct ? zs[i]! : zs[0]! + i));
    }
    if (!before.size) return [];
    this.sorted = null;
    this.host.invalidate();
    return [...before.values()].map((b) => ({
      before: b,
      after: cloneDrawing(this.items.get(b.id)!),
    }));
  }

  // -------------------------------------------------------- selection

  /** Replace the selection; emits selectionChanged when it changed. */
  setSelection(ids: Iterable<string>): void {
    const next = new Set<string>();
    for (const id of ids) if (this.items.has(id)) next.add(id);
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id)))
      return;
    this.selection.clear();
    for (const id of next) this.selection.add(id);
    this.host.invalidate();
    this.host.emit('selectionChanged', { ids: [...this.selection] });
  }

  private dropFromSelection(ids: readonly string[]): void {
    if (ids.some((id) => this.selection.has(id)))
      this.setSelection([...this.selection].filter((id) => !ids.includes(id)));
  }

  /** Drop drawings that are no longer shown (hidden, other symbol/interval) from the selection. */
  pruneSelection(): void {
    const drop = [...this.selection].filter((id) => {
      const d = this.items.get(id);
      return !d || !this.isShown(d);
    });
    if (drop.length) this.dropFromSelection(drop);
    if (this.hovered) {
      const h = this.items.get(this.hovered.id);
      if (!h || !this.isShown(h)) this.hovered = null;
    }
  }

  // ------------------------------------------------------- predicates

  /**
   * Drawn and hit-testable: not hidden (nor `hideAll`), on the current symbol
   * (scope 'all' is everywhere) and visible on the current interval.
   */
  isShown(d: Readonly<Drawing>): boolean {
    if (d.hidden || this.options.hideAll) return false;
    if (d.scope !== 'all' && d.symbol !== this.host.symbol) return false;
    return !d.visibility || visibleOn(d.visibility, this.currentInterval());
  }

  private ivKey = '';
  private iv: Interval | null = null;

  /** Parsed `host.interval` (cached by string); null when unparsable. */
  private currentInterval(): Interval | null {
    const s = this.host.interval;
    if (s !== this.ivKey) {
      this.ivKey = s;
      try {
        this.iv = parseInterval(s);
      } catch {
        this.iv = null; // unknown interval string: visibility rules do not apply
      }
    }
    return this.iv;
  }

  isLocked(d: Readonly<Drawing>): boolean {
    return d.locked || this.options.lockAll;
  }

  // --------------------------------------------------------- geometry

  /** Refresh the shared view (call once per render/hit-test pass). */
  refreshView(): GeometryView {
    this.view.timeline = this.host.timeline();
    this.view.timeScale = this.host.timeScale;
    this.view.width = this.host.paneWidth;
    return this.view;
  }

  /** Geometry of `d` in `pane` for the current view (reused object), or null without bars. */
  geometry(d: Readonly<Drawing>, pane: DrawingPane): Geometry | null {
    let g: Geometry | undefined;
    if (d === this.draft) g = this.draftGeom;
    else {
      g = this.geoms.get(d.id);
      if (!g) {
        g = new Geometry();
        this.geoms.set(d.id, g);
      }
    }
    return g.update(d, pane, this.view, this.host.format(pane.id)) ? g : null;
  }

  handlesOf(def: AnyDrawingToolDefinition, d: Readonly<Drawing>, g: Geometry): DrawingHandle[] {
    return def.handles ? def.handles(g, d.style) : (g.points as PixelPoint[]);
  }

  renderState(d: Readonly<Drawing>): DrawingRenderState {
    const s = this.state;
    s.selected = this.selection.has(d.id);
    s.hovered = this.hovered?.id === d.id;
    s.editing = d === this.draft || this.editing.has(d.id);
    return s;
  }

  // -------------------------------------------------------- rendering

  /** Draw the pane's drawings (and the draft) on `ctx` (CSS px transform). */
  render(pane: DrawingPane, ctx: CanvasRenderingContext2D, dpr: number): void {
    if (pane.height <= 0 || (!this.items.size && !this.draft)) return;
    this.refreshView();
    const rc = this.rc;
    rc.ctx = ctx;
    rc.dpr = dpr;
    rc.theme = this.host.theme;
    for (const d of this.list())
      if (d.paneId === pane.id && this.isShown(d)) this.renderOne(d, pane);
    if (this.draft?.paneId === pane.id) this.renderOne(this.draft, pane);
  }

  private renderOne(d: Drawing, pane: DrawingPane): void {
    const def = getDrawingTool(d.type);
    if (!def) return;
    const g = this.geometry(d, pane);
    if (!g) return;
    if (!(def.isVisible ? def.isVisible(g, d.style) : anchorsInView(g))) return;
    const state = this.renderState(d);
    const { ctx, theme } = this.rc;
    ctx.save();
    def.render(this.rc, g, d.style, state);
    ctx.restore();
    const showHandles = state.selected || state.editing || (state.hovered && !this.isLocked(d));
    if (!showHandles) return;
    const color = colorOf(d.style);
    const hs = this.handlesOf(def, d, g);
    const hp = this.hovered?.id === d.id ? this.hovered.part : null;
    const hot = hp?.kind === 'handle' ? hp.index : -1;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i]!;
      if (h.x !== h.x || h.y !== h.y) continue;
      drawHandle(ctx, h.x, h.y, color, theme, hot === i);
    }
  }

  /**
   * Axis labels: price labels of `pane`'s drawings, or time labels of all
   * panes' drawings (`axis` 'time', pane ignored). Appends to `out`.
   */
  axisLabels(axis: 'price' | 'time', pane: DrawingPane | null, out: DrawingAxisLabel[]): void {
    const add = (d: Drawing) => {
      if (axis === 'price' && d.paneId !== pane?.id) return;
      const def = getDrawingTool(d.type);
      if (!def) return;
      const state = this.renderState(d);
      const fn = axis === 'price' ? def.priceAxisLabels : def.timeAxisLabels;
      if (fn) {
        for (const l of fn(d, d.style, state)) out.push(l);
        return;
      }
      if (!state.selected && !state.editing) return;
      const color = colorOf(d.style);
      for (const p of d.points) out.push({ value: axis === 'price' ? p.price : p.time, color });
    };
    for (const d of this.list()) if (this.isShown(d)) add(d);
    if (this.draft) add(this.draft);
  }

  /**
   * Box around the shown drawings `ids` (anchors and handles, padded by the
   * handle radius) in chart-root CSS px, or null when none is shown/mappable.
   * Uses the same mapping as rendering (bricks, future area).
   */
  bounds(ids: readonly string[]): DrawingBounds | null {
    const want = new Set(ids);
    if (!want.size || !this.items.size) return null;
    this.refreshView();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const add = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    };
    for (const d of this.list()) {
      if (!want.has(d.id) || !this.isShown(d)) continue;
      const def = getDrawingTool(d.type);
      const pane = this.host.pane(d.paneId);
      if (!def || !pane || pane.height <= 0) continue;
      const g = this.geometry(d, pane);
      if (!g) continue;
      for (const p of g.points) add(p.x, pane.top + p.y);
      for (const h of this.handlesOf(def, d, g)) add(h.x, pane.top + h.y);
    }
    if (left > right) return null;
    const r = HANDLE_RADIUS;
    return { left: left - r, top: top - r, right: right + r, bottom: bottom + r };
  }

  // ------------------------------------------------------ hit testing

  /** Topmost drawing part at pane-local (x, y). Handles of unlocked drawings come first. */
  hitTest(pane: DrawingPane, x: number, y: number): DrawingHitResult {
    const res: DrawingHitResult = { strong: null, weak: null };
    if (!this.items.size || pane.height <= 0) return res;
    this.refreshView();
    const list = this.list();
    for (let k = list.length - 1; k >= 0; k--) {
      const d = list[k]!;
      if (d.paneId !== pane.id || !this.isShown(d)) continue;
      const def = getDrawingTool(d.type);
      const g = def ? this.geometry(d, pane) : null;
      if (!def || !g) continue;
      // Culled drawings (off screen) are not drawn, so they cannot be hit.
      if (!(def.isVisible ? def.isVisible(g, d.style) : anchorsInView(g))) continue;
      if (!this.isLocked(d)) {
        const hs = this.handlesOf(def, d, g);
        for (let i = 0; i < hs.length; i++) {
          const h = hs[i]!;
          if (Math.hypot(h.x - x, h.y - y) <= HANDLE_RADIUS + 2)
            return {
              strong: {
                id: d.id,
                part: { kind: 'handle', index: i },
                cursor: h.cursor ?? 'pointer',
              },
              weak: null,
            };
        }
      }
      const part = def.hitTest(g, d.style, x, y, HIT_TOLERANCE);
      if (!part) continue;
      const hit = { id: d.id, part, cursor: 'pointer' };
      if (part.kind === 'body' && part.weak) {
        res.weak ??= hit;
        continue;
      }
      res.strong = hit;
      return res;
    }
    return res;
  }
}

const VIS_UNIT: Record<Interval['unit'], keyof DrawingIntervalVisibility> = {
  minute: 'minutes',
  hour: 'hours',
  day: 'days',
  week: 'weeks',
  month: 'months',
};

/** Same rule as the app's `visibleOnInterval` ("60m" counts as 1 hour). */
export function visibleOn(vis: DrawingIntervalVisibility, iv: Interval | null): boolean {
  if (!iv) return true;
  const n =
    iv.unit === 'minute' && iv.count % 60 === 0
      ? { unit: 'hour' as const, count: iv.count / 60 }
      : iv;
  const r = vis[VIS_UNIT[n.unit]];
  return !r || (r.enabled && n.count >= r.min && n.count <= r.max);
}
