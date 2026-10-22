import type { Chart, HitTarget } from '../chart';
import type { DrawingPointerMods } from '../drawings/interaction';
import type { Pane } from '../pane';

const VERTICAL_PAN_THRESHOLD = 10;
/** Max pointer travel (px) for a press to count as a click. */
const CLICK_SLOP = 3;
const KINETIC_MIN_VELOCITY = 0.25; // px/ms
const KINETIC_STOP_VELOCITY = 0.02;
const KINETIC_DECAY = 0.94; // per 16ms
/** Touch: hold this long without moving to inspect (crosshair) or open the context menu. */
export const LONG_PRESS_MS = 500;
/** Touch: finger travel (px) that still counts as holding still / tapping. */
const TOUCH_SLOP = 8;
/** Touch: second tap within this time (ms) and distance (px) is a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DIST = 30;

/** Where and when a touch press started (taps, long-press, double-tap). */
interface Press {
  id: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  /** Largest distance from the start so far. */
  moved: number;
}

type Drag =
  | {
      kind: 'pan';
      pane: Pane;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      totalDy: number;
      verticalPan: boolean;
      samples: { t: number; x: number }[];
    }
  | { kind: 'priceAxis'; pane: Pane; lastY: number; startY: number; line: boolean }
  /** Press on the price label's "+" (a click fires `priceAxisPlus`; no scaling). */
  | { kind: 'plus'; pane: Pane }
  | { kind: 'timeAxis'; lastX: number }
  | { kind: 'separator'; index: number; lastY: number }
  /** Two-finger pinch: zooms the time axis around the fingers' midpoint and pans with it. */
  | { kind: 'pinch'; pane: Pane; lastDist: number; lastMid: number }
  /** Touch long-press on a pane: the finger drives the crosshair; released in place, the menu opens. */
  | { kind: 'inspect'; moved: boolean }
  /** Touch long-press on a drawing: its menu opens on release. */
  | { kind: 'held' }
  /** A drawing gesture owns the pointer (creation, select press, drag). */
  | { kind: 'drawing' };

/** A built-in chart-navigation key (handled by the chart when it has focus). */
export interface KeyBinding {
  /** Display label, e.g. "Left / Right". */
  key: string;
  description: string;
  group: string;
}

interface NavKey extends KeyBinding {
  /** KeyboardEvent.key values that trigger it. */
  keys: readonly string[];
  /** Only plain Alt+key (Shift+Alt+R is an app shortcut: replay). */
  noAlt?: boolean;
  run(chart: Chart, shift: boolean): void;
}

const NAV_GROUP = 'Chart navigation';
const panStep = (chart: Chart, shift: boolean) => chart.timeScale.barSpacing * (shift ? 10 : 1);

/** The single source of truth for the keys below; the shortcuts help lists `KEY_BINDINGS`. */
const NAV_KEYS: readonly NavKey[] = [
  {
    keys: ['ArrowLeft'],
    key: 'Left',
    description: 'Scroll back one bar (Shift: ten bars)',
    group: NAV_GROUP,
    run: (c, shift) => c.timeScale.pan(panStep(c, shift)),
  },
  {
    keys: ['ArrowRight'],
    key: 'Right',
    description: 'Scroll forward one bar (Shift: ten bars)',
    group: NAV_GROUP,
    run: (c, shift) => c.timeScale.pan(-panStep(c, shift)),
  },
  {
    keys: ['ArrowUp', '+', '='],
    key: 'Up or +',
    description: 'Zoom in',
    group: NAV_GROUP,
    run: (c) => c.timeScale.zoom(c.paneWidth, 1.2),
  },
  {
    keys: ['ArrowDown', '-'],
    key: 'Down or -',
    description: 'Zoom out',
    group: NAV_GROUP,
    run: (c) => c.timeScale.zoom(c.paneWidth, 1 / 1.2),
  },
  {
    keys: ['End'],
    key: 'End',
    description: 'Jump to the latest bar',
    group: NAV_GROUP,
    run: (c) => c.scrollToRealtime(),
  },
  {
    keys: ['r', 'R'],
    key: 'Alt+R',
    description: 'Reset the chart view',
    group: NAV_GROUP,
    noAlt: true,
    run: (c) => c.resetView(),
  },
];

export const KEY_BINDINGS: readonly KeyBinding[] = NAV_KEYS.map(({ key, description, group }) => ({
  key,
  description,
  group,
}));

/** Mouse, touch, wheel and keyboard handling for a Chart. */
export class InteractionController {
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private kineticFrame = 0;
  /** Wheel zoom still to apply (log of the factor) around `x`, eased in over a few frames. */
  private zoomEase: { x: number; rest: number; frame: number } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pointer type of the last press: touch synthesizes its own dblclick/contextmenu. */
  private lastPointerType = '';
  private press: Press | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private readonly el: HTMLElement;
  private readonly abort = new AbortController();

  constructor(private readonly chart: Chart) {
    this.el = chart.root;
    const opts = { signal: this.abort.signal };
    this.el.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    this.el.addEventListener('pointermove', (e) => this.onMove(e), opts);
    this.el.addEventListener('pointerup', (e) => this.onUp(e), opts);
    this.el.addEventListener('pointercancel', (e) => this.onCancel(e), opts);
    this.el.addEventListener('lostpointercapture', (e) => this.onCancel(e), opts);
    this.el.addEventListener('pointerleave', (e) => this.onLeave(e), opts);
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e), opts);
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { ...opts, passive: false });
    this.el.addEventListener('keydown', (e) => this.onKey(e), opts);
    this.el.addEventListener(
      'contextmenu',
      (e) => {
        if (inLegendSlot(e)) return;
        e.preventDefault();
        // Touch long-presses are handled by the controller (Android also fires contextmenu).
        if (this.lastPointerType === 'touch') return;
        this.drag = null;
        this.openContextMenu(e.clientX, e.clientY);
      },
      opts,
    );
  }

  destroy(): void {
    this.abort.abort();
    cancelAnimationFrame(this.kineticFrame);
    if (this.zoomEase) cancelAnimationFrame(this.zoomEase.frame);
    clearTimeout(this.settleTimer);
    clearTimeout(this.holdTimer);
  }

  private openContextMenu(clientX: number, clientY: number): void {
    const p = this.local({ clientX, clientY });
    const target = this.chart.drawingTarget(this.chart.hitTest(p.x, p.y));
    if (this.chart.drawingInput.contextMenu(target, clientX, clientY)) return;
    this.chart.events.emit('contextMenu', this.chart.describePoint(clientX, clientY));
  }

  private cancelHold(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
  }

  /** The finger stayed put for LONG_PRESS_MS. */
  private onHold(): void {
    this.holdTimer = undefined;
    const pr = this.press;
    const d = this.drag;
    if (!pr || this.pointers.size !== 1) return;
    if (d?.kind === 'drawing') {
      if (!this.chart.drawingInput.holdPress()) return;
      this.drag = { kind: 'held' };
    } else if (d?.kind === 'pan') {
      this.drag = { kind: 'inspect', moved: false };
      const hit = this.chart.hitTest(pr.x, pr.y);
      if (hit.kind === 'pane') {
        this.chart.hoverStudy(hit);
        this.chart.setCrosshair(hit.pane, hit.x, hit.y);
      }
    } else return;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function')
      navigator.vibrate(10);
  }

  private panDrag(pane: Pane, p: { x: number; y: number }, t: number): Drag {
    return {
      kind: 'pan',
      pane,
      startX: p.x,
      startY: p.y,
      lastX: p.x,
      lastY: p.y,
      totalDy: 0,
      verticalPan: !pane.priceScale.autoScale,
      samples: [{ t, x: p.x }],
    };
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // App-owned legend rows (buttons) keep their own pointer handling.
    if (inLegendSlot(e)) return;
    this.el.focus({ preventScroll: true });
    this.stopKinetic();
    this.lastPointerType = e.pointerType;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.el.setPointerCapture(e.pointerId);
    this.cancelHold();
    this.press = null;

    if (this.pointers.size === 2 && this.drag?.kind === 'pan') {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      this.lastTap = null;
      this.drag = {
        kind: 'pinch',
        pane: this.drag.pane,
        lastDist: Math.hypot(a.x - b.x, a.y - b.y),
        lastMid: (a.x + b.x) / 2,
      };
      return;
    }
    if (e.pointerType === 'touch' && this.pointers.size === 1)
      this.press = {
        id: e.pointerId,
        x: p.x,
        y: p.y,
        clientX: e.clientX,
        clientY: e.clientY,
        moved: 0,
      };

    this.chart.drawingInput.setPointerType(e.pointerType);
    const hit = this.chart.hitTest(p.x, p.y);
    if (this.chart.drawingInput.pointerDown(this.chart.drawingTarget(hit), p.x, p.y, mods(e))) {
      this.drag = { kind: 'drawing' };
      this.updateCursor(hit);
      if (this.press) this.holdTimer = setTimeout(() => this.onHold(), LONG_PRESS_MS);
      return;
    }
    switch (hit.kind) {
      case 'pane':
        this.drag = this.panDrag(hit.pane, p, e.timeStamp);
        if (e.pointerType !== 'mouse') this.chart.setCrosshair(null, 0, 0);
        if (this.press) this.holdTimer = setTimeout(() => this.onHold(), LONG_PRESS_MS);
        break;
      case 'priceAxis':
        this.drag = hit.plus
          ? { kind: 'plus', pane: hit.pane }
          : { kind: 'priceAxis', pane: hit.pane, lastY: p.y, startY: p.y, line: !!hit.priceLine };
        break;
      case 'timeAxis':
        this.drag = { kind: 'timeAxis', lastX: p.x };
        break;
      case 'separator':
        this.drag = { kind: 'separator', index: hit.index, lastY: p.y };
        break;
      default:
        this.drag = null;
    }
    this.updateCursor(hit);
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    const pr = this.press;
    if (pr?.id === e.pointerId) {
      pr.moved = Math.max(pr.moved, Math.hypot(p.x - pr.x, p.y - pr.y));
      if (pr.moved > TOUCH_SLOP) this.cancelHold();
    }
    const d = this.drag;
    const chart = this.chart;

    if (!d || d.kind === 'drawing') {
      if (!d) chart.drawingInput.setPointerType(e.pointerType);
      if (d) chart.drawingInput.pointerMove(p.x, p.y, mods(e));
      const hit = chart.hitTest(p.x, p.y);
      if (!d) chart.drawingInput.hover(chart.drawingTarget(hit), p.x, p.y, mods(e));
      this.updateCursor(hit);
      chart.hoverStudy(hit);
      if (hit.kind === 'pane') chart.setCrosshair(hit.pane, hit.x, hit.y);
      else chart.setCrosshair(null, 0, 0);
      if (hit.kind === 'priceAxis') chart.setAxisHover(hit.pane, hit.y);
      else chart.setAxisHover(null, 0);
      return;
    }

    switch (d.kind) {
      case 'pan': {
        const dx = p.x - d.lastX;
        const dy = p.y - d.lastY;
        d.lastX = p.x;
        d.lastY = p.y;
        d.totalDy += Math.abs(dy);
        chart.timeScale.pan(dx);
        if (!d.verticalPan && d.totalDy > VERTICAL_PAN_THRESHOLD) d.verticalPan = true;
        if (d.verticalPan && dy) d.pane.priceScale.panBy(dy);
        d.samples.push({ t: e.timeStamp, x: p.x });
        if (d.samples.length > 5) d.samples.shift();
        this.el.style.cursor = 'grabbing';
        chart.viewChanged('user');
        if (e.pointerType === 'mouse') chart.setCrosshair(d.pane, p.x, p.y - d.pane.top);
        break;
      }
      case 'priceAxis': {
        const dy = p.y - d.lastY;
        d.lastY = p.y;
        d.pane.priceScale.scaleBy(Math.exp(dy * 0.005));
        chart.viewChanged('price');
        break;
      }
      case 'plus':
        break;
      case 'timeAxis': {
        const dx = p.x - d.lastX;
        d.lastX = p.x;
        chart.timeScale.zoom(chart.paneWidth, Math.exp(dx * 0.006));
        chart.viewChanged('user');
        break;
      }
      case 'separator': {
        chart.resizeSeparator(d.index, p.y - d.lastY);
        d.lastY = p.y;
        break;
      }
      case 'pinch': {
        const pts = [...this.pointers.values()];
        if (pts.length < 2) break;
        const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = (a.x + b.x) / 2;
        // Follow the midpoint (two-finger pan), then spread/pinch zooms around it.
        if (mid !== d.lastMid) chart.timeScale.pan(mid - d.lastMid);
        if (d.lastDist > 0 && dist > 0) chart.timeScale.zoom(mid, dist / d.lastDist);
        d.lastDist = dist;
        d.lastMid = mid;
        chart.viewChanged('user');
        break;
      }
      case 'inspect': {
        if (pr && pr.moved > TOUCH_SLOP) d.moved = true;
        const hit = chart.hitTest(p.x, p.y);
        if (hit.kind !== 'pane') break;
        chart.hoverStudy(hit);
        chart.setCrosshair(hit.pane, hit.x, hit.y);
        break;
      }
      case 'held':
        break;
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    const pr = this.press?.id === e.pointerId ? this.press : null;
    if (pr) this.press = null;
    this.cancelHold();
    const d = this.drag;
    if (d?.kind === 'pinch') {
      // The finger still down carries on panning (no crosshair, no click).
      const rest = [...this.pointers.values()][0];
      this.drag = rest ? this.panDrag(d.pane, rest, e.timeStamp) : null;
      this.chart.viewSettled();
      return;
    }
    if (d?.kind === 'inspect' || d?.kind === 'held') {
      // The crosshair stays where the finger left it (the next touch clears it).
      this.drag = null;
      if (pr && (d.kind === 'held' || !d.moved)) {
        this.openContextMenu(pr.clientX, pr.clientY);
        swallowNextClick();
      }
      return;
    }
    this.drag = null;
    const p = this.local(e);
    // A touch tap that follows another one closely is a double-tap (dblclick for touch).
    const tap = pr && d && pr.moved <= TOUCH_SLOP ? { t: e.timeStamp, x: p.x, y: p.y } : null;
    const prev = this.lastTap;
    const doubleTap =
      !!tap &&
      !!prev &&
      tap.t - prev.t <= DOUBLE_TAP_MS &&
      Math.hypot(tap.x - prev.x, tap.y - prev.y) <= DOUBLE_TAP_DIST;
    this.lastTap = doubleTap ? null : tap;
    if (d?.kind === 'drawing') {
      this.chart.drawingInput.pointerUp(p.x, p.y, mods(e));
      this.updateCursor(this.chart.hitTest(p.x, p.y));
      if (doubleTap) this.doubleClickAt(e.clientX, e.clientY);
      return;
    }
    const hit = this.chart.hitTest(p.x, p.y);
    const slop = e.pointerType === 'touch' ? TOUCH_SLOP : CLICK_SLOP;
    if (d?.kind === 'pan' && Math.hypot(p.x - d.startX, p.y - d.startY) <= slop) {
      this.chart.drawingInput.clickEmpty();
      if (!this.chart.emitOverlayClick(hit))
        this.chart.emitStudyPointer('studyClick', hit, e.clientX, e.clientY);
    } else if (d?.kind === 'plus') {
      if (hit.kind === 'priceAxis' && hit.plus) this.chart.firePriceAxisPlus(d.pane);
    } else if (d?.kind === 'priceAxis') {
      if (d.line && Math.abs(p.y - d.startY) <= CLICK_SLOP) this.chart.emitOverlayClick(hit);
    } else if (d?.kind === 'pan') this.startKinetic(d.samples, e.timeStamp);
    if (d) this.chart.viewSettled();
    this.updateCursor(hit);
    if (doubleTap) this.doubleClickAt(e.clientX, e.clientY);
  }

  /**
   * The browser took the pointer away (pointercancel, capture lost): abandon
   * the gesture instead of committing it. A drawing drag is restored and a
   * creation dropped (no events); a pan just stops (no click, no kinetics).
   * After a normal pointerup the pointer is already gone, so this is a no-op.
   */
  private onCancel(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    this.cancelHold();
    this.press = null;
    this.lastTap = null;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'drawing') this.chart.drawingInput.abort();
    else if (d) this.chart.viewSettled();
    this.el.style.cursor = '';
  }

  private onLeave(e: PointerEvent): void {
    this.chart.hoverStudy(null);
    if (!this.drag) this.chart.drawingInput.hover(null, 0, 0, NO_MODS);
    // Touch: a crosshair from a long-press stays after the finger lifts (the next touch clears it).
    if (!this.drag && e.pointerType !== 'touch') this.chart.setCrosshair(null, 0, 0);
    if (!this.drag) this.chart.setAxisHover(null, 0);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (inLegendSlot(e)) return;
    // Touch double-taps are detected in onUp (browsers differ on synthesizing dblclick).
    if (this.lastPointerType === 'touch') return;
    this.doubleClickAt(e.clientX, e.clientY);
  }

  private doubleClickAt(clientX: number, clientY: number): void {
    const p = this.local({ clientX, clientY });
    const hit = this.chart.hitTest(p.x, p.y);
    if (this.chart.drawingInput.doubleClick(this.chart.drawingTarget(hit), clientX, clientY))
      return;
    if (hit.kind === 'priceAxis') this.chart.setAutoScale(hit.pane.id, true);
    else if (hit.kind === 'timeAxis') this.chart.resetView();
    else this.chart.emitStudyPointer('studyDoubleClick', hit, clientX, clientY);
  }

  private onWheel(e: WheelEvent): void {
    const p = this.local(e);
    const hit = this.chart.hitTest(p.x, p.y);
    if (hit.kind === 'none' || hit.kind === 'separator') return;
    e.preventDefault();
    this.stopKinetic();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    const ts = this.chart.timeScale;

    if (hit.kind === 'priceAxis') {
      hit.pane.priceScale.scaleBy(Math.exp(dy * 0.002));
    } else if (e.ctrlKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      ts.zoom(hit.kind === 'pane' ? p.x : this.chart.paneWidth, Math.exp(-dy * 0.01));
    } else if (Math.abs(dx) > Math.abs(dy)) {
      ts.pan(-dx);
    } else {
      const x = hit.kind === 'pane' ? p.x : this.chart.paneWidth;
      // Mouse wheels step in notches: ease those in. Trackpad deltas are smooth already.
      if (e.deltaMode !== 0 || Math.abs(dy) >= 40) this.easeZoom(x, -dy * 0.0015);
      else ts.zoom(x, Math.exp(-dy * 0.0015));
    }
    this.chart.viewChanged(hit.kind === 'priceAxis' ? 'price' : 'user');
    if (hit.kind === 'pane') this.chart.setCrosshair(hit.pane, p.x, hit.y);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.chart.viewSettled(), 250);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.chart.drawingInput.key(e.key, mods(e))) {
      e.preventDefault();
      return;
    }
    // Alt+arrows belong to the app (e.g. replay shortcuts), not to panning/zooming.
    if (e.altKey && e.key.startsWith('Arrow')) return;
    const binding = NAV_KEYS.find((k) => k.keys.includes(e.key));
    if (!binding) return;
    if (binding.noAlt && (!e.altKey || e.shiftKey)) return;
    binding.run(this.chart, e.shiftKey);
    e.preventDefault();
    this.chart.viewChanged('user');
    this.chart.viewSettled();
  }

  private startKinetic(samples: { t: number; x: number }[], now: number): void {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last || now - last.t > 60 || last.t === first.t) return;
    let v = (last.x - first.x) / (last.t - first.t);
    if (Math.abs(v) < KINETIC_MIN_VELOCITY) return;
    let prev = performance.now();
    const step = (t: number) => {
      const dt = t - prev;
      prev = t;
      this.chart.timeScale.pan(v * dt);
      this.chart.viewChanged('user');
      v *= KINETIC_DECAY ** (dt / 16);
      if (Math.abs(v) > KINETIC_STOP_VELOCITY) this.kineticFrame = requestAnimationFrame(step);
      else {
        this.kineticFrame = 0;
        this.chart.viewSettled();
      }
    };
    this.kineticFrame = requestAnimationFrame(step);
  }

  /** Zoom by `exp(log)` around `x`: part now, the rest over the next frames (none with reduced motion). */
  private easeZoom(x: number, log: number): void {
    const ts = this.chart.timeScale;
    const prev = this.zoomEase;
    if (prev) cancelAnimationFrame(prev.frame);
    let rest = log + (prev && Math.abs(prev.x - x) < 1 ? prev.rest : 0);
    if (prev && Math.abs(prev.x - x) >= 1) ts.zoom(prev.x, Math.exp(prev.rest));
    this.zoomEase = null;
    const animate = typeof requestAnimationFrame === 'function' && !prefersReducedMotion();
    const step = (share: number) => {
      const now = Math.abs(rest) < 0.004 ? rest : rest * share;
      ts.zoom(x, Math.exp(now));
      rest -= now;
    };
    step(animate ? 0.45 : 1);
    if (!animate || rest === 0) return;
    const frame = () => {
      step(0.4);
      this.chart.viewChanged('user');
      if (rest === 0) this.zoomEase = null;
      else this.zoomEase = { x, rest, frame: requestAnimationFrame(frame) };
    };
    this.zoomEase = { x, rest, frame: requestAnimationFrame(frame) };
  }

  private stopKinetic(): void {
    if (this.kineticFrame) cancelAnimationFrame(this.kineticFrame);
    this.kineticFrame = 0;
  }

  private updateCursor(hit: HitTarget): void {
    const dc = this.chart.drawingInput.cursor(this.chart.drawingTarget(hit));
    if (dc) {
      this.el.style.cursor = dc;
      return;
    }
    let cursor = 'default';
    switch (hit.kind) {
      case 'pane':
        cursor =
          (this.chart.isStudy(hit.seriesId) && !hit.fill) || hit.marker || hit.priceLine
            ? 'pointer'
            : this.chart.options.crosshair === 'cross'
              ? 'crosshair'
              : this.chart.options.crosshair === 'dot'
                ? 'none'
                : 'default';
        break;
      case 'priceAxis':
        cursor = hit.plus || hit.priceLine ? 'pointer' : 'ns-resize';
        break;
      case 'timeAxis':
        cursor = 'ew-resize';
        break;
      case 'separator':
        cursor = 'row-resize';
        break;
    }
    this.el.style.cursor = cursor;
  }
}

/** Event started inside a pane's app-owned legend slot or header. */
function inLegendSlot(e: Event): boolean {
  return (
    e.target instanceof Element && e.target.closest('.io-legend-slot, .io-legend-header') !== null
  );
}

/**
 * The click the browser synthesizes after a touch release would land on the menu just
 * opened under the finger (or its backdrop) and close it: drop that one click.
 */
function swallowNextClick(): void {
  if (typeof window === 'undefined') return;
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, true), 400);
}

const NO_MODS: DrawingPointerMods = { shift: false, alt: false, mod: false };

function mods(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  return { shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey };
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
