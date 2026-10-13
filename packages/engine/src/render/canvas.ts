/** One HiDPI canvas stacked absolutely inside a parent element. */
export class CanvasLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;

  constructor(parent: HTMLElement, zIndex: number) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      zIndex: String(zIndex),
      pointerEvents: 'none',
    });
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas not supported');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    width = Math.max(0, Math.floor(width));
    height = Math.max(0, Math.floor(height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Clear and switch to CSS-pixel coordinates. */
  begin(): CanvasRenderingContext2D {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  /** Device-pixel coordinates (for crisp bars and lines). */
  device(): CanvasRenderingContext2D {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    return this.ctx;
  }

  css(): CanvasRenderingContext2D {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return this.ctx;
  }

  destroy(): void {
    this.canvas.remove();
  }
}
