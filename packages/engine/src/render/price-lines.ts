import { dashedLine, labelBox } from './draw';
import { drawGlyph } from './markers';

export type ChartPriceLineStyle = 'solid' | 'dashed' | 'dotted';

/** A horizontal line at a price on one pane, optionally labelled on the price axis. */
export interface ChartPriceLine {
  id: string;
  paneId: string;
  price: number;
  color: string;
  lineStyle: ChartPriceLineStyle;
  /** Text drawn at the right end of the line inside the pane. */
  label?: string;
  /** Draw a bell + price label on the price axis. */
  axisLabel: boolean;
}

export const PRICE_LINE_HIT = 4;
export const AXIS_LABEL_H = 20;

const DASH: Record<ChartPriceLineStyle, number[]> = {
  solid: [],
  dashed: [6, 4],
  dotted: [2, 3],
};

/** A price line resolved to pane coordinates (CSS px, pane-relative). */
export interface PlacedPriceLine {
  group: string;
  line: ChartPriceLine;
  y: number;
}

/** Lines of `paneId` whose y lies inside the pane (culled otherwise). */
export function layoutPriceLines(
  groups: ReadonlyMap<string, readonly ChartPriceLine[]>,
  paneId: string,
  paneHeight: number,
  priceToY: (price: number) => number,
): PlacedPriceLine[] {
  const out: PlacedPriceLine[] = [];
  for (const [group, list] of groups) {
    for (const line of list) {
      if (line.paneId !== paneId) continue;
      const y = priceToY(line.price);
      if (!(y >= 0 && y <= paneHeight)) continue;
      out.push({ group, line, y });
    }
  }
  return out;
}

function axisLabelTop(y: number, paneHeight: number): number {
  return Math.max(0, Math.min(paneHeight - AXIS_LABEL_H, y - AXIS_LABEL_H / 2));
}

/** Topmost line whose stroke (x < paneWidth) or axis label (x >= paneWidth) is under (x, y). */
export function hitPriceLine(
  placed: readonly PlacedPriceLine[],
  x: number,
  y: number,
  paneWidth: number,
  paneHeight: number,
): PlacedPriceLine | null {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    if (x < paneWidth) {
      if (Math.abs(p.y - y) <= PRICE_LINE_HIT) return p;
    } else if (p.line.axisLabel) {
      const top = axisLabelTop(p.y, paneHeight);
      if (y >= top && y < top + AXIS_LABEL_H) return p;
    }
  }
  return null;
}

export function drawPriceLines(
  ctx: CanvasRenderingContext2D,
  placed: readonly PlacedPriceLine[],
  paneWidth: number,
  dpr: number,
  fontStr: string,
): void {
  for (const p of placed) {
    ctx.strokeStyle = p.line.color;
    dashedLine(ctx, 0, p.y, paneWidth, p.y, dpr, DASH[p.line.lineStyle]);
    if (p.line.label) {
      ctx.font = fontStr;
      ctx.fillStyle = p.line.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(p.line.label, paneWidth - 6, p.y - 3);
    }
  }
}

export function drawPriceLineAxisLabels(
  ax: CanvasRenderingContext2D,
  placed: readonly PlacedPriceLine[],
  axisWidth: number,
  paneHeight: number,
  format: (price: number) => string,
  fontStr: string,
): void {
  for (const p of placed) {
    if (!p.line.axisLabel) continue;
    const top = axisLabelTop(p.y, paneHeight);
    labelBox(
      ax,
      format(p.line.price),
      1,
      top,
      axisWidth - 2,
      AXIS_LABEL_H,
      p.line.color,
      '#ffffff',
      fontStr,
      'left',
      20,
    );
    drawGlyph(ax, 'bell', 11, top + AXIS_LABEL_H / 2, 12, '#ffffff');
  }
}
