import type { ChartTheme } from '../options';

export function font(theme: ChartTheme, size = theme.fontSize, weight = ''): string {
  return `${weight} ${size}px ${theme.fontFamily}`.trim();
}

/** Horizontal 1-device-pixel line in device coordinates. */
export function hLine(
  ctx: CanvasRenderingContext2D,
  yCss: number,
  x0Css: number,
  x1Css: number,
  dpr: number,
): void {
  const y = Math.round(yCss * dpr);
  ctx.fillRect(
    Math.round(x0Css * dpr),
    y,
    Math.round((x1Css - x0Css) * dpr),
    Math.max(1, Math.floor(dpr)),
  );
}

/** Vertical 1-device-pixel line in device coordinates. */
export function vLine(
  ctx: CanvasRenderingContext2D,
  xCss: number,
  y0Css: number,
  y1Css: number,
  dpr: number,
): void {
  const x = Math.round(xCss * dpr);
  ctx.fillRect(
    x,
    Math.round(y0Css * dpr),
    Math.max(1, Math.floor(dpr)),
    Math.round((y1Css - y0Css) * dpr),
  );
}

/** Dashed line in CSS coordinates, aligned to device pixels. */
export function dashedLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dpr: number,
  dash: number[],
): void {
  const align = (v: number) => (Math.round(v * dpr) + 0.5) / dpr;
  ctx.save();
  ctx.lineWidth = 1 / dpr;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x0 === x1 ? align(x0) : x0, y0 === y1 ? align(y0) : y0);
  ctx.lineTo(x1 === x0 ? align(x1) : x1, y1 === y0 ? align(y1) : y1);
  ctx.stroke();
  ctx.restore();
}

/** Filled label box with centred text (axis labels). CSS coordinates. */
export function labelBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  bg: string,
  fg: string,
  fontStr: string,
  align: 'left' | 'center' = 'left',
  padX = 6,
): void {
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, h, 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = fontStr;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  ctx.fillText(text, align === 'center' ? x + w / 2 : x + padX, y + h / 2 + 0.5);
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
