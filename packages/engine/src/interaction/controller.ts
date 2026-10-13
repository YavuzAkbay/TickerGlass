import type { Chart, HitTarget } from '../chart';
import type { Pane } from '../pane';

const VERTICAL_PAN_THRESHOLD = 10;
/** Max pointer travel (px) for a press to count as a click. */
const CLICK_SLOP = 3;
const KINETIC_MIN_VELOCITY = 0.25; // px/ms
const KINETIC_STOP_VELOCITY = 0.02;
const KINETIC_DECAY = 0.94; // per 16ms

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
  | { kind: 'priceAxis'; pane: Pane; lastY: number }
  | { kind: 'timeAxis'; lastX: number }
  | { kind: 'separator'; index: number; lastY: number }
  | { kind: 'pinch'; pane: Pane; lastDist: number };

/** Mouse, touch, wheel and keyboard handling for a Chart. */
export class InteractionController {
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private kineticFrame = 0;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly el: HTMLElement;
  private readonly abort = new AbortController();

  constructor(private readonly chart: Chart) {
    this.el = chart.root;
    const opts = { signal: this.abort.signal };
    this.el.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    this.el.addEventListener('pointermove', (e) => this.onMove(e), opts);
    this.el.addEventListener('pointerup', (e) => this.onUp(e), opts);
    this.el.addEventListener('pointercancel', (e) => this.onUp(e), opts);
    this.el.addEventListener('pointerleave', () => this.onLeave(), opts);
    this.el.addEventListener('dblclick', (e) => this.onDoubleClick(e), opts);
    this.el.addEventListener('wheel', (e) => this.onWheel(e), { ...opts, passive: false });
    this.el.addEventListener('keydown', (e) => this.onKey(e), opts);
    this.el.addEventListener(
      'contextmenu',
      (e) => {
        if (inLegendSlot(e)) return;
        e.preventDefault();
        this.drag = null;
        this.chart.events.emit('contextMenu', this.chart.describePoint(e.clientX, e.clientY));
      },
      opts,
    );
  }

  destroy(): void {
    this.abort.abort();
    cancelAnimationFrame(this.kineticFrame);
    clearTimeout(this.settleTimer);
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
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.el.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2 && this.drag?.kind === 'pan') {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      this.drag = {
        kind: 'pinch',
        pane: this.drag.pane,
        lastDist: Math.hypot(a.x - b.x, a.y - b.y),
      };
      return;
    }

    const hit = this.chart.hitTest(p.x, p.y);
    switch (hit.kind) {
      case 'pane':
        this.drag = {
          kind: 'pan',
          pane: hit.pane,
          startX: p.x,
          startY: p.y,
          lastX: p.x,
          lastY: p.y,
          totalDy: 0,
          verticalPan: !hit.pane.priceScale.autoScale,
          samples: [{ t: e.timeStamp, x: p.x }],
        };
        if (e.pointerType !== 'mouse') this.chart.setCrosshair(null, 0, 0);
        break;
      case 'priceAxis':
        this.drag = { kind: 'priceAxis', pane: hit.pane, lastY: p.y };
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
    const d = this.drag;
    const chart = this.chart;

    if (!d) {
      const hit = chart.hitTest(p.x, p.y);
      this.updateCursor(hit);
      chart.hoverStudy(hit);
      if (hit.kind === 'pane') chart.setCrosshair(hit.pane, hit.x, hit.y);
      else chart.setCrosshair(null, 0, 0);
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
        chart.viewChanged();
        if (e.pointerType === 'mouse') chart.setCrosshair(d.pane, p.x, p.y - d.pane.top);
        break;
      }
      case 'priceAxis': {
        const dy = p.y - d.lastY;
        d.lastY = p.y;
        d.pane.priceScale.scaleBy(Math.exp(dy * 0.005));
        chart.viewChanged();
        break;
      }
      case 'timeAxis': {
        const dx = p.x - d.lastX;
        d.lastX = p.x;
        chart.timeScale.zoom(chart.paneWidth, Math.exp(dx * 0.006));
        chart.viewChanged();
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
        if (d.lastDist > 0) chart.timeScale.zoom((a.x + b.x) / 2, dist / d.lastDist);
        d.lastDist = dist;
        chart.viewChanged();
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    const d = this.drag;
    if (d?.kind === 'pinch') {
      // Lifting one finger of a pinch ends the gesture entirely.
      this.drag = null;
      this.chart.viewSettled();
      return;
    }
    this.drag = null;
    const p = this.local(e);
    const hit = this.chart.hitTest(p.x, p.y);
    if (d?.kind === 'pan' && Math.hypot(p.x - d.startX, p.y - d.startY) <= CLICK_SLOP)
      this.chart.emitStudyPointer('studyClick', hit, e.clientX, e.clientY);
    else if (d?.kind === 'pan') this.startKinetic(d.samples, e.timeStamp);
    if (d) this.chart.viewSettled();
    this.updateCursor(hit);
  }

  private onLeave(): void {
    this.chart.hoverStudy(null);
    if (!this.drag) this.chart.setCrosshair(null, 0, 0);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (inLegendSlot(e)) return;
    const p = this.local(e);
    const hit = this.chart.hitTest(p.x, p.y);
    if (hit.kind === 'priceAxis') this.chart.setAutoScale(hit.pane.id, true);
    else if (hit.kind === 'timeAxis') this.chart.resetView();
    else this.chart.emitStudyPointer('studyDoubleClick', hit, e.clientX, e.clientY);
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
      ts.zoom(hit.kind === 'pane' ? p.x : this.chart.paneWidth, Math.exp(-dy * 0.0015));
    }
    this.chart.viewChanged();
    if (hit.kind === 'pane') this.chart.setCrosshair(hit.pane, p.x, hit.y);
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.chart.viewSettled(), 250);
  }

  private onKey(e: KeyboardEvent): void {
    const ts = this.chart.timeScale;
    const step = ts.barSpacing * (e.shiftKey ? 10 : 1);
    switch (e.key) {
      case 'ArrowLeft':
        ts.pan(step);
        break;
      case 'ArrowRight':
        ts.pan(-step);
        break;
      case 'ArrowUp':
      case '+':
      case '=':
        ts.zoom(this.chart.paneWidth, 1.2);
        break;
      case 'ArrowDown':
      case '-':
        ts.zoom(this.chart.paneWidth, 1 / 1.2);
        break;
      case 'End':
        this.chart.scrollToRealtime();
        break;
      case 'r':
      case 'R':
        if (!e.altKey) return;
        this.chart.resetView();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.chart.viewChanged();
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
      this.chart.viewChanged();
      v *= KINETIC_DECAY ** (dt / 16);
      if (Math.abs(v) > KINETIC_STOP_VELOCITY) this.kineticFrame = requestAnimationFrame(step);
      else {
        this.kineticFrame = 0;
        this.chart.viewSettled();
      }
    };
    this.kineticFrame = requestAnimationFrame(step);
  }

  private stopKinetic(): void {
    if (this.kineticFrame) cancelAnimationFrame(this.kineticFrame);
    this.kineticFrame = 0;
  }

  private updateCursor(hit: HitTarget): void {
    let cursor = 'default';
    switch (hit.kind) {
      case 'pane':
        cursor =
          this.chart.isStudy(hit.seriesId) && !hit.fill
            ? 'pointer'
            : this.chart.options.crosshair === 'cross'
              ? 'crosshair'
              : this.chart.options.crosshair === 'dot'
                ? 'none'
                : 'default';
        break;
      case 'priceAxis':
        cursor = 'ns-resize';
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

/** Event started inside a pane's app-owned legend slot. */
function inLegendSlot(e: Event): boolean {
  return e.target instanceof Element && e.target.closest('.io-legend-slot') !== null;
}
