import { HANDLE_RADIUS } from './draw-utils';
import type { DrawingPane } from './geometry';
import { isPaneCoords, panePoint, pointAt, withPrice, withTime } from './geometry';
import {
  cloneDrawing,
  newDrawingId,
  TOUCH_EXTRA,
  type DrawingHit,
  type DrawingLayer,
} from './layer';
import { logicalToTime, timeToLogical, type AnchorTimeline } from './mapping';
import { getDrawingTool } from './registry';
import type {
  AnyDrawingToolDefinition,
  Drawing,
  DrawingChange,
  DrawingHitPart,
  DrawingPoint,
  DrawingStyle,
  DrawingToolOptions,
  PixelPoint,
} from './types';

/** Pointer travel (px) before a press becomes a drag. */
export const DRAG_SLOP = 3;
/** Min distance (px) between freehand samples. */
const FREEHAND_STEP = 3;
/** Weak magnet radius (px), the crosshair rule. */
const MAGNET_PX = 20;
/** `setActiveTool(ERASER_TOOL)`: click/drag over drawings removes them. */
export const ERASER_TOOL = 'eraser';
/** `setActiveTool(ZOOM_TOOL)`: drag a box to zoom the chart to it, then back to the cursor. */
export const ZOOM_TOOL = 'zoom-in';
/** `setActiveTool(MEASURE_TOOL)`: a transient date and price range, never stored (no drawing events). */
export const MEASURE_TOOL = 'measure';
/** `setActiveTool(PICK_TOOL)`: the next click reports `pointPicked` (bar time and price) and returns to the cursor. */
export const PICK_TOOL = 'pick-point';

export interface DrawingPointerMods {
  shift: boolean;
  alt: boolean;
  /** Ctrl, or Cmd on macOS. */
  mod: boolean;
}

/** Pane under the pointer and the drawing hit there (null: none). */
export interface DrawingPointerTarget {
  pane: DrawingPane;
  drawing: DrawingHit | null;
}

interface PointStart {
  points: DrawingPoint[];
  logical: number[];
  ys: number[];
}

type Gesture =
  | {
      kind: 'create';
      def: AnyDrawingToolDefinition;
      pane: DrawingPane;
      /** Anchors fixed so far (the last draft anchor follows the pointer). */
      placed: number;
      /** Pointer releases so far. */
      ups: number;
      pressed: boolean;
      dragged: boolean;
      downX: number;
      downY: number;
      /** Last freehand sample (root px). */
      lastX: number;
      lastY: number;
      /** Measure mode / quick measure: the result is shown, not stored. */
      transient?: boolean;
    }
  /** Pressed on a drawing, not yet moved past DRAG_SLOP. `toggleOff`: a
   * Shift-click on a selected drawing deselects it on release (not on drag). */
  | {
      kind: 'press';
      pane: DrawingPane;
      hit: DrawingHit;
      downX: number;
      downY: number;
      toggleOff: boolean;
      alt: boolean;
    }
  | {
      kind: 'move';
      pane: DrawingPane;
      ids: string[];
      start: Map<string, PointStart>;
      before: Drawing[];
      downX: number;
      downY: number;
      /** Alt+drag: `ids` are clones inserted at drag start; `prevSelection` restores on Esc. */
      clones: boolean;
      prevSelection: string[];
    }
  /** Eraser press/drag: drawings removed so far. */
  | { kind: 'erase'; pane: DrawingPane; removed: Drawing[] }
  /** Shift+drag on empty space: box select (root px); `base` = selection before. */
  | { kind: 'box'; pane: DrawingPane; downX: number; downY: number; base: string[] }
  /** Zoom-in mode: dragging the zoom box (root px). */
  | { kind: 'zoom'; pane: DrawingPane; downX: number; downY: number }
  | {
      kind: 'handle';
      pane: DrawingPane;
      id: string;
      index: number;
      cursor: string;
      start: DrawingPoint[];
      before: Drawing[];
    };

/**
 * Drawing pointer/keyboard state machine (docs/drawings.md §4). Coordinates
 * are chart-root CSS px; the InteractionController forwards events here first
 * and falls back to pan/zoom when a method returns false.
 */
export class DrawingInteraction {
  private tool: string | null = null;
  /** `setActiveTool` preset style, merged into every drawing the tool creates. */
  private toolStyle: DrawingStyle | undefined;
  private gesture: Gesture | null = null;

  constructor(private readonly layer: DrawingLayer) {}

  get activeTool(): string | null {
    return this.tool;
  }

  /** A press or creation is in progress. */
  get busy(): boolean {
    return this.gesture !== null;
  }

  setActiveTool(type: string | null, opts: DrawingToolOptions = {}): void {
    if (type !== null && !MODES.includes(type) && !getDrawingTool(type))
      throw new Error(`Unknown drawing tool: ${type}`);
    this.abort();
    if (type !== null) this.clearMeasure();
    this.tool = type;
    this.toolStyle = type !== null && opts.style ? structuredClone(opts.style) : undefined;
    this.layer.host.invalidate();
  }

  private clearMeasure(): void {
    if (!this.layer.measure) return;
    this.layer.measure = null;
    this.layer.host.invalidate();
  }

  /** Back to the cursor (the preset style goes with the tool). */
  private leaveTool(): void {
    this.tool = null;
    this.toolStyle = undefined;
  }

  /** Cancel any gesture without events (API calls): drop the draft, undo a drag. */
  abort(): void {
    const g = this.gesture;
    this.gesture = null;
    this.layer.draft = null;
    this.layer.marquee = null;
    if (g?.kind === 'move' || g?.kind === 'handle') this.cancelDrag(g);
    else if (g?.kind === 'erase' && g.removed.length)
      // The removals already happened: report them rather than losing them.
      this.layer.host.emit('drawingsRemoved', { drawings: g.removed.map(cloneDrawing) });
    this.layer.host.invalidate();
  }

  // ------------------------------------------------------------ pointer

  pointerDown(
    target: DrawingPointerTarget | null,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): boolean {
    const g = this.gesture;
    this.clearMeasure();
    if (g?.kind === 'create') {
      // Next anchor of a click-click creation.
      if (!g.pressed) {
        g.pressed = true;
        g.dragged = false;
        g.downX = x;
        g.downY = y;
        this.updateDraft(x, y, mods);
      }
      return true;
    }
    if (g) return true;
    if (!target) return false;
    if (this.tool === ERASER_TOOL) {
      const erase: Gesture = { kind: 'erase', pane: target.pane, removed: [] };
      this.gesture = erase;
      if (target.drawing) this.eraseId(erase, target.drawing.id);
      return true;
    }
    if (this.tool === PICK_TOOL) {
      const p = this.pointer(target.pane, x, y, mods, null, false);
      this.leaveTool();
      if (Number.isFinite(p.time))
        this.layer.host.emit('pointPicked', {
          time: p.time,
          price: p.price,
          paneId: target.pane.id,
        });
      this.layer.host.invalidate();
      this.layer.host.emit('toolFinished', { type: PICK_TOOL, drawingId: null, active: false });
      return true;
    }
    if (this.tool === ZOOM_TOOL) {
      this.gesture = { kind: 'zoom', pane: target.pane, downX: x, downY: y };
      return true;
    }
    if (this.tool === MEASURE_TOOL)
      return this.startCreate('date-price-range', target.pane, x, y, mods, true);
    if (this.tool) return this.startCreate(this.tool, target.pane, x, y, mods);
    const hit = target.drawing;
    if (!hit) {
      if (!mods.shift) return false;
      // Shift+drag on empty space: box select (adds to the selection, like Shift-click).
      this.gesture = {
        kind: 'box',
        pane: target.pane,
        downX: x,
        downY: y,
        base: [...this.layer.selection],
      };
      return true;
    }
    const sel = this.layer.selection;
    let toggleOff = false;
    if (mods.shift) {
      if (sel.has(hit.id)) toggleOff = true;
      else this.layer.setSelection([...sel, hit.id]);
    } else if (!sel.has(hit.id)) this.layer.setSelection([hit.id]);
    this.gesture = {
      kind: 'press',
      pane: target.pane,
      hit,
      downX: x,
      downY: y,
      toggleOff,
      alt: mods.alt,
    };
    return true;
  }

  /** Pointer moved with the button down. Returns whether a drawing gesture consumed it. */
  pointerMove(x: number, y: number, mods: DrawingPointerMods): boolean {
    const g = this.gesture;
    if (!g) return false;
    switch (g.kind) {
      case 'create':
        if (g.pressed && Math.hypot(x - g.downX, y - g.downY) > DRAG_SLOP) g.dragged = true;
        this.updateDraft(x, y, mods);
        return true;
      case 'press':
        if (Math.hypot(x - g.downX, y - g.downY) > DRAG_SLOP) this.startDrag(g, x, y, mods);
        return true;
      case 'move':
        this.applyMove(g, x, y, mods);
        return true;
      case 'handle':
        this.applyHandle(g, x, y, mods);
        return true;
      case 'erase': {
        const h = this.layer.hitTest(g.pane, x, y - g.pane.top);
        const hit = h.strong ?? h.weak;
        if (hit) this.eraseId(g, hit.id);
        return true;
      }
      case 'box':
      case 'zoom':
        this.layer.marquee = this.boxRect(g, x, y);
        this.layer.host.invalidate();
        return true;
    }
  }

  /** Pane-local box from the press to (x, y), clamped to the pane. */
  private boxRect(g: Extract<Gesture, { kind: 'box' | 'zoom' }>, x: number, y: number) {
    const top = g.pane.top;
    const w = this.layer.host.paneWidth;
    const h = g.pane.height;
    const cx = (v: number) => Math.min(Math.max(v, 0), w);
    const cy = (v: number) => Math.min(Math.max(v - top, 0), h);
    return {
      paneId: g.pane.id,
      left: cx(Math.min(g.downX, x)),
      right: cx(Math.max(g.downX, x)),
      top: cy(Math.min(g.downY, y)),
      bottom: cy(Math.max(g.downY, y)),
    };
  }

  /** Last pointer type ('mouse' | 'pen' | 'touch'): touch widens hit tolerances. */
  setPointerType(type: string): void {
    this.layer.touch = type === 'touch';
  }

  /** Pointer moved with no button: hover highlight, or the floating anchor of a creation. */
  hover(target: DrawingPointerTarget | null, x: number, y: number, mods: DrawingPointerMods): void {
    const g = this.gesture;
    if (g?.kind === 'create' && !g.pressed) this.updateDraft(x, y, mods);
    // The eraser highlights what it would remove.
    const next = (this.tool && this.tool !== ERASER_TOOL) || g ? null : (target?.drawing ?? null);
    const prev = this.layer.hovered;
    if (sameHit(prev, next)) return;
    this.layer.hovered = next;
    this.layer.host.invalidate();
  }

  pointerUp(x: number, y: number, mods: DrawingPointerMods): boolean {
    const g = this.gesture;
    if (!g) return false;
    switch (g.kind) {
      case 'create':
        this.createUp(g, x, y, mods);
        return true;
      case 'press':
        this.gesture = null;
        if (g.toggleOff)
          this.layer.setSelection([...this.layer.selection].filter((id) => id !== g.hit.id));
        return true;
      case 'move':
        this.gesture = null;
        if (g.clones) this.endClone(g);
        else this.endDrag(g.before);
        return true;
      case 'handle':
        this.gesture = null;
        this.endDrag(g.before);
        return true;
      case 'erase':
        this.gesture = null;
        if (g.removed.length)
          this.layer.host.emit('drawingsRemoved', { drawings: g.removed.map(cloneDrawing) });
        return true;
      case 'box': {
        this.gesture = null;
        this.layer.marquee = null;
        this.layer.host.invalidate();
        // A Shift-click (no drag) on empty space starts a quick measurement
        // (the selection stays); the next click finishes it. Not while a
        // selection exists: there Shift-click is part of multi-select.
        if (Math.hypot(x - g.downX, y - g.downY) <= DRAG_SLOP) {
          if (
            !this.layer.selection.size &&
            this.startCreate('date-price-range', g.pane, g.downX, g.downY, mods, true)
          ) {
            const c = this.gesture as Gesture | null;
            if (c?.kind === 'create') this.createUp(c, x, y, mods);
          }
          return true;
        }
        const r = this.boxRect(g, x, y);
        const ids = this.layer.idsInRect(g.pane, r.left, r.top, r.right, r.bottom);
        const next = [...new Set([...g.base, ...ids])];
        if (
          next.length !== this.layer.selection.size ||
          next.some((id) => !this.layer.selection.has(id))
        )
          this.layer.setSelection(next);
        return true;
      }
      case 'zoom':
        this.endZoom(g, x, y);
        return true;
    }
  }

  /** Zoom-in release: zoom to the dragged box (a plain click keeps the mode) and return to the cursor. */
  private endZoom(g: Extract<Gesture, { kind: 'zoom' }>, x: number, y: number): void {
    this.gesture = null;
    this.layer.marquee = null;
    this.layer.host.invalidate();
    if (Math.hypot(x - g.downX, y - g.downY) <= DRAG_SLOP) return;
    const r = this.boxRect(g, x, y);
    const ts = this.layer.host.timeScale;
    const from = ts.xToLogical(r.left);
    const to = ts.xToLogical(r.right);
    if (!(to > from)) return;
    const ps = g.pane.priceScale;
    const a = ps.yToPrice(r.top);
    const b = ps.yToPrice(r.bottom);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const priced = r.bottom - r.top >= DRAG_SLOP && hi > lo;
    this.layer.host.zoomTo?.(g.pane.id, from, to, priced ? lo : undefined, priced ? hi : undefined);
    this.leaveTool();
    this.layer.host.emit('toolFinished', { type: ZOOM_TOOL, drawingId: null, active: false });
  }

  /** Click (no drag) on empty chart space: clears the selection. */
  clickEmpty(): void {
    if (!this.tool && this.layer.selection.size) this.layer.setSelection([]);
  }

  /** Right-click: cancels a creation (multi-point: finishes with >= min anchors), or opens the drawing menu. */
  contextMenu(target: DrawingPointerTarget | null, clientX: number, clientY: number): boolean {
    if (this.gesture?.kind === 'create') {
      this.endMulti(this.gesture, true);
      return true;
    }
    const hit = target?.drawing;
    if (!target || !hit) return false;
    if (!this.layer.selection.has(hit.id)) this.layer.setSelection([hit.id]);
    this.layer.host.emit('drawingContextMenu', {
      id: hit.id,
      part: hit.part,
      paneId: target.pane.id,
      clientX,
      clientY,
    });
    return true;
  }

  doubleClick(target: DrawingPointerTarget | null, clientX: number, clientY: number): boolean {
    // A double-click finishes a multi-point creation.
    const g = this.gesture;
    if (g?.kind === 'create' && g.def.creation.kind === 'multi') {
      this.endMulti(g, false, true);
      return true;
    }
    // Clicks that place anchors also produce dblclick events: swallow them.
    if (this.tool || g) return true;
    const hit = target?.drawing;
    if (!target || !hit) return false;
    this.layer.host.emit('drawingDoubleClick', {
      id: hit.id,
      part: hit.part,
      paneId: target.pane.id,
      clientX,
      clientY,
    });
    return true;
  }

  /** Esc cancels (creation, drag, tool, selection); Delete/Backspace removes the
   * selected unlocked drawings; arrows nudge the selection (one `drawingChanged`
   * per key). Returns whether the key was handled. */
  key(key: string, mods: DrawingPointerMods = NO_MODS): boolean {
    const g = this.gesture;
    if (key === 'Enter' && g?.kind === 'create' && g.def.creation.kind === 'multi') {
      this.endMulti(g, false);
      return true;
    }
    if (key === 'Escape') {
      if (g?.kind === 'create') this.endMulti(g, true);
      else if (g?.kind === 'box' || g?.kind === 'zoom') this.abort();
      else if (g?.kind === 'move' || g?.kind === 'handle') {
        this.gesture = null;
        this.cancelDrag(g);
      } else if (this.layer.measure) this.clearMeasure();
      else if (this.tool) {
        const type = this.tool;
        this.leaveTool();
        this.layer.host.emit('toolFinished', { type, drawingId: null, active: false });
      } else if (this.layer.selection.size) this.layer.setSelection([]);
      else return false;
      return true;
    }
    if ((key === 'Delete' || key === 'Backspace') && !g && this.layer.selection.size) {
      const ids = this.editable([...this.layer.selection]).map((d) => d.id);
      const removed = this.layer.remove(ids);
      if (removed.length)
        this.layer.host.emit('drawingsRemoved', { drawings: removed.map(cloneDrawing) });
      return true;
    }
    if (key in NUDGE && !g) return this.nudge(NUDGE[key]!, mods.shift ? 10 : 1);
    return false;
  }

  /** Shown, unlocked drawings among `ids`. */
  private editable(ids: Iterable<string>): Drawing[] {
    const out: Drawing[] = [];
    for (const id of ids) {
      const d = this.layer.items.get(id);
      if (d && this.layer.isShown(d) && !this.layer.isLocked(d)) out.push(d);
    }
    return out;
  }

  /** Arrow keys: move the editable selection by whole bars / pixels. */
  private nudge([bx, py]: readonly [number, number], step: number): boolean {
    const layer = this.layer;
    const list = this.editable(layer.selection);
    if (!list.length) return false;
    const tl = layer.refreshView().timeline;
    const changes: DrawingChange[] = [];
    for (const d of list) {
      const pane = layer.host.pane(d.paneId);
      if (!pane) continue;
      const before = cloneDrawing(d);
      const s = startOf(d, tl, pane);
      // Pane-coordinate drawings move by px in both directions.
      d.points = movePoints(d, s, bx * step, bx * step, py * step, tl, pane, layer.host.paneWidth);
      if (JSON.stringify(d.points) !== JSON.stringify(before.points))
        changes.push({ before, after: cloneDrawing(d) });
    }
    layer.host.invalidate();
    if (changes.length) layer.host.emit('drawingChanged', { changes });
    return true;
  }

  /** Eraser: remove `id` if it is shown and unlocked. */
  private eraseId(g: Extract<Gesture, { kind: 'erase' }>, id: string): void {
    const d = this.layer.items.get(id);
    if (!d || !this.layer.isShown(d) || this.layer.isLocked(d)) return;
    g.removed.push(...this.layer.remove([id]));
  }

  /** Cursor override for the pointer over `target`, or null for the default. */
  cursor(target: DrawingPointerTarget | null): string | null {
    const g = this.gesture;
    if (g?.kind === 'move') return 'grabbing';
    if (g?.kind === 'handle') return g.cursor;
    if (g?.kind === 'box' || g?.kind === 'zoom') return 'crosshair';
    if (this.tool === ZOOM_TOOL || this.tool === PICK_TOOL) return target ? 'crosshair' : null;
    if (this.tool === ERASER_TOOL || g?.kind === 'erase')
      return target ? (target.drawing ? 'pointer' : 'crosshair') : null;
    if (this.tool || g?.kind === 'create') return target ? 'crosshair' : null;
    return target?.drawing?.cursor ?? null;
  }

  // ----------------------------------------------------------- creation

  private startCreate(
    type: string,
    pane: DrawingPane,
    x: number,
    y: number,
    mods: DrawingPointerMods,
    transient = false,
  ): boolean {
    const def = getDrawingTool(type);
    if (!def) return false;
    // Tools that read price data cannot be drawn on study panes.
    if (def.panes === 'main' && pane.id !== 'main') return true;
    const p = this.anchor(def, pane, x, y, mods, null, def.creation.kind !== 'freehand');
    if (!Number.isFinite(p.time)) return true; // no bars yet
    const c = def.creation;
    const points =
      (c.kind === 'points' && c.count >= 2) || c.kind === 'multi' ? [p, { ...p }] : [p];
    this.layer.draft = this.layer.build({
      type,
      points,
      paneId: pane.id,
      style: this.toolStyle ?? {},
    });
    this.gesture = {
      kind: 'create',
      def,
      pane,
      placed: 1,
      ups: 0,
      pressed: true,
      dragged: false,
      downX: x,
      downY: y,
      lastX: x,
      lastY: y,
      ...(transient ? { transient } : {}),
    };
    this.layer.host.invalidate();
    return true;
  }

  /** Move the floating anchor (or sample a freehand point) to the pointer. */
  private updateDraft(x: number, y: number, mods: DrawingPointerMods): void {
    const g = this.gesture;
    const d = this.layer.draft;
    if (g?.kind !== 'create' || !d) return;
    const freehand = g.def.creation.kind === 'freehand';
    const n = d.points.length;
    const from =
      !freehand && mods.shift && n >= 2 && angleConstraint(g.def)
        ? this.anchorPixel(g.pane, d.points[n - 2]!)
        : null;
    const p = this.anchor(g.def, g.pane, x, y, mods, from, !freehand);
    if (!Number.isFinite(p.time)) return;
    if (freehand) {
      if (!g.pressed || Math.hypot(x - g.lastX, y - g.lastY) < FREEHAND_STEP) return;
      g.lastX = x;
      g.lastY = y;
      // Freehand keeps the raw pointer price/time (no bar snapping in y).
      d.points.push(p);
    } else d.points[d.points.length - 1] = p;
    this.layer.host.invalidate();
  }

  private createUp(
    g: Extract<Gesture, { kind: 'create' }>,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const d = this.layer.draft;
    if (!d) {
      this.gesture = null;
      return;
    }
    if (g.pressed) this.updateDraft(x, y, mods);
    g.pressed = false;
    const c = g.def.creation;
    if (c.kind === 'click') return this.finishCreate(g);
    if (c.kind === 'freehand')
      return d.points.length >= 2 ? this.finishCreate(g) : this.cancelCreate();
    if (c.kind === 'multi') return this.multiUp(g, d, x, y, c);
    // points: the first release only fixes anchor 2 when it ended a drag.
    if (g.ups++ === 0) {
      if (g.dragged) g.placed++;
    } else g.placed++;
    if (g.placed >= c.count) return this.finishCreate(g);
    if (g.placed >= d.points.length) d.points.push({ ...d.points[d.points.length - 1]! });
  }

  /** Release of a multi-point creation: fix the floating anchor, close on the
   * first anchor, or finish at `max`. Anchors [0, placed) are fixed, the last
   * draft anchor floats. */
  private multiUp(
    g: Extract<Gesture, { kind: 'create' }>,
    d: Drawing,
    x: number,
    y: number,
    c: { min: number; max?: number; closable?: boolean },
  ): void {
    // Like 'points': the first release only fixes anchor 2 when it ended a drag.
    if (g.ups++ === 0 && !g.dragged) return;
    if (c.closable && g.placed >= 3 && this.onFirstAnchor(g, d, x, y)) {
      // Closed: the last anchor is an exact copy of anchor 0.
      d.points.length = g.placed;
      d.points.push({ ...d.points[0]! });
      return this.finishCreate(g);
    }
    g.placed++;
    if (c.max !== undefined && g.placed >= c.max) {
      d.points.length = g.placed;
      return this.finishCreate(g);
    }
    d.points.push({ ...d.points[d.points.length - 1]! });
  }

  /** Root-px pointer within handle reach of the draft's first anchor. */
  private onFirstAnchor(
    g: Extract<Gesture, { kind: 'create' }>,
    d: Drawing,
    x: number,
    y: number,
  ): boolean {
    this.layer.refreshView();
    const p = this.layer.geometry(d, g.pane)?.points[0];
    if (!p) return false;
    const reach = HANDLE_RADIUS + (this.layer.touch ? TOUCH_EXTRA : 2);
    return Math.hypot(p.x - x, p.y - (y - g.pane.top)) <= reach;
  }

  /**
   * End a creation early (Esc, right-click: `cancel`; double-click, Enter).
   * Multi-point tools keep the fixed anchors when there are at least `min`
   * (`dedupe` drops the extra anchor a double-click's second click placed);
   * otherwise Esc/right-click cancel and double-click/Enter keep creating.
   * Other creation kinds just cancel.
   */
  private endMulti(g: Extract<Gesture, { kind: 'create' }>, cancel: boolean, dedupe = false): void {
    const c = g.def.creation;
    const d = this.layer.draft;
    if (c.kind !== 'multi' || !d) return this.cancelCreate();
    const fixed = d.points.slice(0, g.placed);
    if (dedupe) {
      // The second click of a double-click lands within a few px of the first.
      this.layer.refreshView();
      const px = this.layer.geometry(d, g.pane)?.points ?? [];
      while (fixed.length >= 2) {
        const a = px[fixed.length - 1];
        const b = px[fixed.length - 2];
        const near = a && b && Math.hypot(a.x - b.x, a.y - b.y) <= DRAG_SLOP;
        if (!near && !samePoint(fixed[fixed.length - 1]!, fixed[fixed.length - 2]!)) break;
        fixed.pop();
      }
    }
    if (fixed.length >= c.min) {
      d.points = fixed;
      return this.finishCreate(g);
    }
    if (cancel) return this.cancelCreate();
    // Keep creating from the remaining anchors, the last one floating again.
    g.placed = fixed.length;
    d.points = [...fixed, { ...d.points[d.points.length - 1]! }];
    this.layer.host.invalidate();
  }

  private finishCreate(g: Extract<Gesture, { kind: 'create' }>): void {
    const layer = this.layer;
    const d = layer.draft;
    this.gesture = null;
    if (!d) return;
    if (g.def.completePoints) {
      layer.refreshView();
      const geo = layer.geometry(d, g.pane);
      if (geo) d.points = g.def.completePoints(d.points, geo, d.style);
    }
    layer.draft = null;
    if (g.transient) {
      // Measurement: shown until the next click or Esc, no drawing events.
      // A quick measure (started from the cursor) never touched the tool.
      const modal = this.tool === MEASURE_TOOL;
      layer.measure = d;
      this.leaveTool();
      layer.host.invalidate();
      if (modal)
        layer.host.emit('toolFinished', { type: MEASURE_TOOL, drawingId: null, active: false });
      return;
    }
    layer.insert(d);
    layer.host.emit('drawingCreated', { drawing: cloneDrawing(d) });
    layer.setSelection([d.id]);
    const stay = layer.options.stayInDrawingMode;
    if (!stay) this.leaveTool();
    layer.host.emit('toolFinished', { type: d.type, drawingId: d.id, active: stay });
  }

  /** Drop the draft and leave the tool (Esc, right-click). */
  private cancelCreate(): void {
    const g = this.gesture;
    const transient = g?.kind === 'create' && g.transient;
    const modal = this.tool === MEASURE_TOOL;
    const type = transient ? MEASURE_TOOL : (this.layer.draft?.type ?? this.tool ?? '');
    this.gesture = null;
    this.layer.draft = null;
    this.leaveTool();
    this.layer.host.invalidate();
    // A cancelled quick measure (started from the cursor) leaves the tool alone.
    if (transient && !modal) return;
    this.layer.host.emit('toolFinished', { type, drawingId: null, active: false });
  }

  // ---------------------------------------------------------------- drag

  private startDrag(
    g: Extract<Gesture, { kind: 'press' }>,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const layer = this.layer;
    const d = layer.items.get(g.hit.id);
    if (!d || layer.isLocked(d)) return; // stays a press: locked drawings do not move
    g.toggleOff = false; // Shift+drag moves the selection instead of deselecting
    const part = g.hit.part;
    if (g.alt || mods.alt) {
      this.startClone(g, x, y, mods);
      return;
    }
    if (part.kind === 'handle') {
      this.gesture = {
        kind: 'handle',
        pane: g.pane,
        id: d.id,
        index: part.index,
        cursor: g.hit.cursor,
        start: d.points.map((p) => ({ ...p })),
        before: [cloneDrawing(d)],
      };
      this.beginDrag([d.id]);
      this.applyHandle(this.gesture, x, y, mods);
      return;
    }
    const ids = this.paneSelection(g.pane);
    this.startMove(g, ids, false, [], x, y, mods);
  }

  /** Editable selected drawings on `pane`, in draw order. */
  private paneSelection(pane: DrawingPane): string[] {
    return this.layer
      .list()
      .filter(
        (s) =>
          this.layer.selection.has(s.id) &&
          s.paneId === pane.id &&
          !this.layer.isLocked(s) &&
          this.layer.isShown(s),
      )
      .map((s) => s.id);
  }

  private startMove(
    g: Extract<Gesture, { kind: 'press' }>,
    ids: string[],
    clones: boolean,
    prevSelection: string[],
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const layer = this.layer;
    const tl = layer.refreshView().timeline;
    const before: Drawing[] = [];
    const start = new Map<string, PointStart>();
    for (const id of ids) {
      const s = layer.items.get(id)!;
      before.push(cloneDrawing(s));
      start.set(id, startOf(s, tl, g.pane));
    }
    this.gesture = {
      kind: 'move',
      pane: g.pane,
      ids,
      start,
      before,
      downX: g.downX,
      downY: g.downY,
      clones,
      prevSelection,
    };
    this.beginDrag(ids);
    this.applyMove(this.gesture, x, y, mods);
  }

  /** Alt+drag: insert copies of the pressed selection on top and drag them. */
  private startClone(
    g: Extract<Gesture, { kind: 'press' }>,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const layer = this.layer;
    const prevSelection = [...layer.selection];
    let z = layer.topZ();
    const ids: string[] = [];
    for (const id of this.paneSelection(g.pane)) {
      const c = cloneDrawing(layer.items.get(id)!);
      c.id = newDrawingId();
      c.zIndex = ++z;
      layer.insert(c);
      ids.push(c.id);
    }
    layer.setSelection(ids);
    this.startMove(g, ids, true, prevSelection, x, y, mods);
  }

  /** Clone drag ended: one drawingCreated per clone. */
  private endClone(g: Extract<Gesture, { kind: 'move' }>): void {
    const layer = this.layer;
    for (const id of g.ids) layer.editing.delete(id);
    layer.host.invalidate();
    layer.host.emit('drawingDrag', { ids: g.ids, phase: 'end' });
    for (const id of g.ids) {
      const d = layer.items.get(id);
      if (d) layer.host.emit('drawingCreated', { drawing: cloneDrawing(d) });
    }
  }

  private beginDrag(ids: string[]): void {
    for (const id of ids) this.layer.editing.add(id);
    this.layer.host.emit('drawingDrag', { ids, phase: 'start' });
  }

  /** Body drag: whole bars in x, pixels in y (so log/percent scales keep the
   * shape). Shift locks the move to the dominant axis. */
  private applyMove(
    g: Extract<Gesture, { kind: 'move' }>,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const layer = this.layer;
    const tl = layer.refreshView().timeline;
    let dx = x - g.downX;
    let dy = y - g.downY;
    if (mods.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    const dl = Math.round(dx / layer.host.timeScale.barSpacing);
    const w = layer.host.paneWidth;
    for (const id of g.ids) {
      const d = layer.items.get(id);
      const s = g.start.get(id);
      if (!d || !s) continue;
      d.points = movePoints(d, s, dl, dx, dy, tl, g.pane, w);
    }
    layer.host.invalidate();
  }

  private applyHandle(
    g: Extract<Gesture, { kind: 'handle' }>,
    x: number,
    y: number,
    mods: DrawingPointerMods,
  ): void {
    const layer = this.layer;
    const d = layer.items.get(g.id);
    const def = d ? getDrawingTool(d.type) : undefined;
    if (!d || !def) return;
    layer.refreshView();
    const geo = layer.geometry(d, g.pane);
    if (!geo) return;
    const n = g.start.length;
    const other = g.index === 0 ? 1 : g.index - 1;
    const from =
      mods.shift && g.index < n && other < n && angleConstraint(def) && def.coords !== 'pane'
        ? this.anchorPixel(g.pane, g.start[other]!)
        : null;
    // Pane-coordinate anchors follow the raw pointer (no bar slot, magnet or Shift).
    const s: Snapped =
      def.coords === 'pane'
        ? { x, y: y - g.pane.top }
        : this.snap(g.pane, x, y - g.pane.top, mods, from);
    let target = geo.toPoint(s.x, s.y);
    if (s.price !== undefined) target = withPrice(target, s.price);
    if (!Number.isFinite(target.time)) return;
    if (def.moveHandle) {
      d.points = def.moveHandle({
        start: g.start,
        handle: g.index,
        target,
        x: s.x,
        y: s.y,
        geometry: geo,
        style: d.style,
      });
    } else if (g.index < g.start.length) {
      const axes = def.axes ?? 'both';
      const old = g.start[g.index]!;
      const pts = g.start.map((p) => ({ ...p }));
      pts[g.index] =
        axes === 'price'
          ? withPrice(old, target.price)
          : axes === 'time'
            ? withTime(old, target)
            : target;
      d.points = pts;
    }
    layer.host.invalidate();
  }

  /** Drag ended: one drawingChanged for everything that moved. */
  private endDrag(before: Drawing[]): void {
    const layer = this.layer;
    const changes: DrawingChange[] = [];
    for (const b of before) {
      const after = layer.items.get(b.id);
      if (after && JSON.stringify(after.points) !== JSON.stringify(b.points))
        changes.push({ before: b, after: cloneDrawing(after) });
    }
    const ids = before.map((b) => b.id);
    for (const id of ids) layer.editing.delete(id);
    layer.host.invalidate();
    layer.host.emit('drawingDrag', { ids, phase: 'end' });
    if (changes.length) layer.host.emit('drawingChanged', { changes });
  }

  /** Undo a drag in progress without change events (Esc, abort). Clones are removed. */
  private cancelDrag(g: Extract<Gesture, { kind: 'move' | 'handle' }>): void {
    if (g.kind === 'move' && g.clones) {
      for (const id of g.ids) this.layer.editing.delete(id);
      this.layer.remove(g.ids);
      this.layer.setSelection(g.prevSelection);
      this.layer.host.emit('drawingDrag', { ids: g.ids, phase: 'end' });
      return;
    }
    this.restore(g.before, g.kind === 'move' ? g.ids : [g.id]);
  }

  /** Put dragged drawings back (Esc, abort). */
  private restore(before: Drawing[], ids: string[]): void {
    for (const b of before) {
      const d = this.layer.items.get(b.id);
      if (d) d.points = b.points.map((p) => ({ ...p }));
    }
    for (const id of ids) this.layer.editing.delete(id);
    this.layer.host.invalidate();
    this.layer.host.emit('drawingDrag', { ids, phase: 'end' });
  }

  // ------------------------------------------------------------- snapping

  /**
   * Snap a pane-local pointer position for anchors (docs/drawings.md §7): x to
   * the nearest bar slot; y to the magnet values of that bar (`options.magnet`:
   * weak within MAGNET_PX, strong always; Ctrl/Cmd toggles off <-> weak); with
   * Shift and `from` (the other anchor, pane px), the segment from `from` to
   * multiples of 45°.
   */
  snap(
    pane: DrawingPane,
    x: number,
    y: number,
    mods: DrawingPointerMods,
    from: PixelPoint | null = null,
    magnet = true,
  ): Snapped {
    const host = this.layer.host;
    const ts = host.timeScale;
    const index = Math.round(ts.xToLogical(x));
    const sx = ts.indexToX(index);
    let sy = y;
    let price: number | undefined;
    let mode = host.magnet ?? 'off';
    if (mods.mod) mode = mode === 'off' ? 'weak' : 'off';
    if (magnet && mode !== 'off' && host.magnetValues) {
      const ps = pane.priceScale;
      let best = NaN;
      let bestDist = Infinity;
      for (const v of host.magnetValues(pane.id, index)) {
        const dist = Math.abs(ps.priceToY(v) - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = v;
        }
      }
      if (best === best && (mode === 'strong' || bestDist <= MAGNET_PX)) {
        price = best; // exact value, not a pixel round trip
        sy = ps.priceToY(best);
      }
    }
    if (!from || !mods.shift || from.x !== from.x || from.y !== from.y)
      return price === undefined ? { x: sx, y: sy } : { x: sx, y: sy, price };
    const c = constrain45(from, sx, sy);
    // Vertical segments keep the magnet price; other directions dictate y.
    return price !== undefined && c.y === sy ? { ...c, price } : c;
  }

  /** Pane-local pixel of an anchor. */
  private anchorPixel(pane: DrawingPane, p: DrawingPoint): PixelPoint {
    const tl = this.layer.refreshView().timeline;
    return {
      x: this.layer.host.timeScale.indexToX(timeToLogical(tl, p)),
      y: pane.priceScale.priceToY(p.price),
    };
  }

  /** Anchor under a root-relative pointer position in `pane`. */
  private pointer(
    pane: DrawingPane,
    x: number,
    y: number,
    mods: DrawingPointerMods,
    from: PixelPoint | null = null,
    magnet = true,
  ): DrawingPoint {
    const s = this.snap(pane, x, y - pane.top, mods, from, magnet);
    const tl = this.layer.refreshView().timeline;
    const p = pointAt(tl, this.layer.host.timeScale, pane.priceScale, s.x, s.y);
    return s.price === undefined ? p : withPrice(p, s.price);
  }

  /** `pointer()` for a tool: pane fractions (unsnapped) for `coords: 'pane'`. */
  private anchor(
    def: AnyDrawingToolDefinition,
    pane: DrawingPane,
    x: number,
    y: number,
    mods: DrawingPointerMods,
    from: PixelPoint | null,
    magnet: boolean,
  ): DrawingPoint {
    if (def.coords === 'pane')
      return panePoint(x, y - pane.top, this.layer.host.paneWidth, pane.height);
    return this.pointer(pane, x, y, mods, from, magnet);
  }
}

/** Snapped pane-local pointer; `price` = exact magnet value when snapped to one. */
interface Snapped {
  x: number;
  y: number;
  price?: number;
}

const MODES: readonly string[] = [ERASER_TOOL, ZOOM_TOOL, MEASURE_TOOL, PICK_TOOL];
const NO_MODS: DrawingPointerMods = { shift: false, alt: false, mod: false };

/** Arrow key -> [bars, px] direction. */
const NUDGE: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Anchors of `d` with their logical indices and pixel ys in `pane`. */
function startOf(d: Readonly<Drawing>, tl: AnchorTimeline, pane: DrawingPane): PointStart {
  const ps = pane.priceScale;
  return {
    points: d.points.map((p) => ({ ...p })),
    logical: d.points.map((p) => timeToLogical(tl, p)),
    ys: d.points.map((p) => ps.priceToY(p.price)),
  };
}

/**
 * `s` moved by `dl` whole bars and `dy` px, honouring the tool's `axes`.
 * Pane-coordinate drawings move by (`dx`, `dy`) px instead, as a whole, kept
 * inside the pane (`width` = pane width).
 */
function movePoints(
  d: Readonly<Drawing>,
  s: PointStart,
  dl: number,
  dx: number,
  dy: number,
  tl: AnchorTimeline,
  pane: DrawingPane,
  width: number,
): DrawingPoint[] {
  if (isPaneCoords(d.type)) return movePanePoints(s.points, dx, dy, width, pane.height);
  const axes = getDrawingTool(d.type)?.axes ?? 'both';
  const ps = pane.priceScale;
  return s.points.map((p, i) => {
    let q = p;
    if (axes !== 'price' && dl !== 0) {
      const t = logicalToTime(tl, s.logical[i]! + dl);
      if (t) q = withTime(q, t);
    }
    if (axes !== 'time' && dy !== 0) q = withPrice(q, ps.yToPrice(s.ys[i]! + dy));
    return q;
  });
}

/** Pane-fraction anchors moved by (dx, dy) px; the delta is limited so every
 * anchor stays in 0..1 (the shape does not deform at the pane edges). */
function movePanePoints(
  pts: readonly DrawingPoint[],
  dx: number,
  dy: number,
  width: number,
  height: number,
): DrawingPoint[] {
  const limit = (delta: number, vs: number[]) =>
    Math.min(1 - Math.max(...vs), Math.max(-Math.min(...vs), delta));
  const fx =
    width > 0 && pts.length
      ? limit(
          dx / width,
          pts.map((p) => p.time),
        )
      : 0;
  const fy =
    height > 0 && pts.length
      ? limit(
          dy / height,
          pts.map((p) => p.price),
        )
      : 0;
  return pts.map((p) => ({ time: p.time + fx, price: p.price + fy }));
}

function samePoint(a: DrawingPoint, b: DrawingPoint): boolean {
  return a.time === b.time && a.price === b.price && (a.brick ?? 0) === (b.brick ?? 0);
}

/** Whether Shift constrains anchors of `def` to 45° steps (docs/drawings.md §7). */
function angleConstraint(def: AnyDrawingToolDefinition): boolean {
  if (def.coords === 'pane') return false;
  if (def.shiftConstraint) return def.shiftConstraint === 'angle';
  const c = def.creation;
  return c.kind === 'points' && c.count === 2 && (def.axes ?? 'both') === 'both';
}

/** (x, y) constrained to the nearest 45° ray from `from`; x stays on its bar slot
 * except for vertical segments (x = from.x). */
function constrain45(from: PixelPoint, x: number, y: number): { x: number; y: number } {
  const dx = x - from.x;
  const dy = y - from.y;
  if (!dx && !dy) return { x, y };
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // -4..4
  if (k === 0 || k === 4 || k === -4) return { x, y: from.y };
  if (k === 2 || k === -2) return { x: from.x, y };
  const sign = k === 1 || k === -3 ? 1 : -1;
  return { x, y: from.y + sign * dx };
}

function sameHit(a: DrawingHit | null, b: DrawingHit | null): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && samePart(a.part, b.part);
}

function samePart(a: DrawingHitPart, b: DrawingHitPart): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'handle' || a.index === (b as { index: number }).index;
}
