import type {
  ChartStyle,
  ChartType,
  OhlcvSource,
  PriceSource,
  TransformExtra,
} from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { drawOhlcBars } from './bars';
import { drawCandles, type CandleOptions } from './candles';
import { drawColumns, drawHighLow } from './columns';
import { sourceValue } from './common';
import { drawKagi } from './kagi';
import { drawArea, drawBaseline, drawHlcArea, drawLine } from './lines';
import { drawPointFigure, pfBoxCount, pfBoxSize } from './point-figure';

export { sourceValue } from './common';

export interface MainRenderArgs {
  rc: SeriesRenderContext;
  /** Already transformed (Heikin Ashi / bricks) by the caller. */
  data: OhlcvSource;
  type: ChartType;
  /** Full style object; the renderer uses `style[type]`. */
  style: ChartStyle;
  extra: TransformExtra;
}

const CANDLES: CandleOptions = { wicks: true, hollow: false, volume: false };
const HOLLOW: CandleOptions = { wicks: true, hollow: true, volume: false };
const VOLUME: CandleOptions = { wicks: true, hollow: false, volume: true };
const NO_WICKS: CandleOptions = { wicks: false, hollow: false, volume: false };

/** Draw the main series for `type` over the visible range of `rc`. */
export function drawMainSeries(args: MainRenderArgs): void {
  const { rc, data, type, style, extra } = args;
  if (data.length === 0 || rc.from > rc.to) return;
  switch (type) {
    case 'bars':
      return drawOhlcBars(rc, data, style.bars);
    case 'range':
      return drawOhlcBars(rc, data, style.range);
    case 'candles':
      return drawCandles(rc, data, style.candles, CANDLES);
    case 'heikinAshi':
      return drawCandles(rc, data, style.heikinAshi, CANDLES);
    case 'lineBreak':
      return drawCandles(rc, data, style.lineBreak, NO_WICKS);
    case 'renko':
      return drawCandles(rc, data, style.renko, style.renko.wicks ? CANDLES : NO_WICKS);
    case 'hollowCandles':
      return drawCandles(rc, data, style.hollowCandles, HOLLOW);
    case 'volumeCandles':
      return drawCandles(rc, data, style.volumeCandles, VOLUME);
    case 'line':
      return drawLine(rc, data, style.line, 'line');
    case 'lineMarkers':
      return drawLine(rc, data, style.lineMarkers, 'markers');
    case 'stepLine':
      return drawLine(rc, data, style.stepLine, 'step');
    case 'area':
      return drawArea(rc, data, style.area);
    case 'hlcArea':
      return drawHlcArea(rc, data, style.hlcArea);
    case 'baseline':
      return drawBaseline(rc, data, style.baseline);
    case 'columns':
      return drawColumns(rc, data, style.columns);
    case 'highLow':
      return drawHighLow(rc, data, style.highLow);
    case 'kagi':
      return drawKagi(rc, data, style.kagi, extra);
    case 'pointFigure':
      return drawPointFigure(rc, data, style.pointFigure, extra);
    default:
      return assertNever(type);
  }
}

function assertNever(type: never): never {
  throw new Error(`Unknown chart type: ${String(type)}`);
}

/** Source used by line-like types, or null for types drawn from OHLC. */
function lineSource(type: ChartType, style: ChartStyle): PriceSource | null {
  switch (type) {
    case 'line':
      return style.line.source;
    case 'lineMarkers':
      return style.lineMarkers.source;
    case 'stepLine':
      return style.stepLine.source;
    case 'area':
      return style.area.source;
    case 'baseline':
      return style.baseline.source;
    case 'columns':
      return style.columns.source;
    default:
      return null;
  }
}

/**
 * [min, max] price range of bars in [from, to] for autoscale. Line-like types use
 * their source only; renko includes open/close (full bricks) as well as high/low;
 * point & figure includes the top of the last box (pass the transform's `extra`
 * so its box size is used); everything else uses high/low.
 */
export function priceRangeFor(
  type: ChartType,
  data: OhlcvSource,
  style: ChartStyle,
  from: number,
  to: number,
  extra: TransformExtra = {},
): { min: number; max: number } | null {
  const lo = Math.max(0, from);
  const hi = Math.min(data.length - 1, to);
  let min = Infinity;
  let max = -Infinity;
  const src = lineSource(type, style);
  if (src !== null) {
    for (let i = lo; i <= hi; i++) {
      const v = sourceValue(data, i, src);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  } else {
    const box = type === 'pointFigure' ? pfBoxSize(style.pointFigure, extra) : 0;
    const bricks = type === 'renko';
    for (let i = lo; i <= hi; i++) {
      let l = data.low[i]!;
      let h = data.high[i]!;
      if (bricks) {
        l = Math.min(l, data.open[i]!, data.close[i]!);
        h = Math.max(h, data.open[i]!, data.close[i]!);
      } else if (box > 0) {
        h = Math.max(h, l + pfBoxCount(data, i, box) * box);
      }
      if (l < min) min = l;
      if (h > max) max = h;
    }
  }
  return min <= max ? { min, max } : null;
}

/** Values the crosshair magnet can snap to at bar i for this type. */
export function magnetValuesFor(
  type: ChartType,
  data: OhlcvSource,
  style: ChartStyle,
  i: number,
): number[] {
  if (i < 0 || i >= data.length) return [];
  const src = lineSource(type, style);
  if (src !== null) return [sourceValue(data, i, src)];
  switch (type) {
    case 'hlcArea':
      return [data.high[i]!, data.low[i]!, data.close[i]!];
    case 'highLow':
    case 'pointFigure':
      return [data.high[i]!, data.low[i]!];
    case 'kagi':
      return [data.open[i]!, data.close[i]!];
    default:
      return [data.open[i]!, data.high[i]!, data.low[i]!, data.close[i]!];
  }
}
