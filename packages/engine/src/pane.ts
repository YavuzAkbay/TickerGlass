import { CanvasLayer } from './render/canvas';
import type { PaneSeries } from './render/series';
import { PriceScale } from './scale/price-scale';

let nextPaneId = 1;

/** One horizontal chart area with its own price scale and series. */
export class Pane {
  readonly id: string;
  readonly el: HTMLDivElement;
  readonly axisEl: HTMLDivElement;
  readonly legendEl: HTMLDivElement;
  readonly bg: CanvasLayer;
  readonly main: CanvasLayer;
  readonly overlay: CanvasLayer;
  readonly axisMain: CanvasLayer;
  readonly axisOverlay: CanvasLayer;
  readonly priceScale = new PriceScale();
  readonly series: PaneSeries[] = [];
  /** Relative height (stretch factor). */
  ratio: number;
  collapsed = false;
  /** Decimals for this pane's labels, derived from the current tick step. */
  labelDecimals = 2;
  // Layout result (CSS px, relative to chart root).
  top = 0;
  height = 0;

  constructor(root: HTMLElement, ratio: number, id?: string) {
    this.id = id ?? `pane-${nextPaneId++}`;
    this.ratio = ratio;
    this.el = div(root, 'io-pane');
    this.axisEl = div(root, 'io-axis io-price-axis');
    this.bg = new CanvasLayer(this.el, 1);
    this.main = new CanvasLayer(this.el, 2);
    this.overlay = new CanvasLayer(this.el, 3);
    this.axisMain = new CanvasLayer(this.axisEl, 1);
    this.axisOverlay = new CanvasLayer(this.axisEl, 2);
    this.legendEl = div(this.el, 'io-legend');
  }

  layout(left: number, top: number, width: number, height: number, axisWidth: number, dpr: number) {
    this.top = top;
    this.height = height;
    place(this.el, left, top, width, height);
    place(this.axisEl, left + width, top, axisWidth, height);
    for (const l of [this.bg, this.main, this.overlay]) l.resize(width, height, dpr);
    for (const l of [this.axisMain, this.axisOverlay]) l.resize(axisWidth, height, dpr);
    this.priceScale.height = height;
    const hidden = height <= 0;
    this.el.style.display = hidden ? 'none' : '';
    this.axisEl.style.display = hidden ? 'none' : '';
  }

  destroy(): void {
    this.el.remove();
    this.axisEl.remove();
  }
}

export function div(parent: HTMLElement, className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent.appendChild(el);
  return el;
}

export function place(el: HTMLElement, left: number, top: number, width: number, height: number) {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.max(0, width)}px`;
  el.style.height = `${Math.max(0, height)}px`;
}
