import type { ChartTheme } from './options';

/** Read-only OHLCV columns with an explicit length (arrays may be longer). */
export interface OhlcvSource {
  readonly time: ArrayLike<number>;
  readonly open: ArrayLike<number>;
  readonly high: ArrayLike<number>;
  readonly low: ArrayLike<number>;
  readonly close: ArrayLike<number>;
  readonly volume: ArrayLike<number>;
  readonly length: number;
}

export type ChartType =
  | 'bars'
  | 'candles'
  | 'hollowCandles'
  | 'volumeCandles'
  | 'line'
  | 'lineMarkers'
  | 'stepLine'
  | 'area'
  | 'hlcArea'
  | 'baseline'
  | 'columns'
  | 'highLow'
  | 'heikinAshi'
  | 'renko'
  | 'lineBreak'
  | 'kagi'
  | 'pointFigure'
  | 'range';

export const CHART_TYPES: ChartType[] = [
  'bars',
  'candles',
  'hollowCandles',
  'volumeCandles',
  'line',
  'lineMarkers',
  'stepLine',
  'area',
  'hlcArea',
  'baseline',
  'columns',
  'highLow',
  'heikinAshi',
  'renko',
  'lineBreak',
  'kagi',
  'pointFigure',
  'range',
];

/** Types whose bars are not 1:1 with time bars (built from price movement). */
export const BRICK_TYPES: ReadonlySet<ChartType> = new Set([
  'renko',
  'lineBreak',
  'kagi',
  'pointFigure',
  'range',
]);

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export interface CandleStyle {
  upColor: string;
  downColor: string;
  borderUpColor: string;
  borderDownColor: string;
  wickUpColor: string;
  wickDownColor: string;
  drawBody: boolean;
  drawBorder: boolean;
  drawWick: boolean;
}

export interface BarStyle {
  upColor: string;
  downColor: string;
  /** Hide the open tick (HLC bars). */
  hlcBars: boolean;
  thinBars: boolean;
  /** Colour by close vs previous close instead of close vs open. */
  colorByPrevClose: boolean;
}

export interface LineStyle {
  color: string;
  width: number;
  source: PriceSource;
}

export interface AreaStyle extends LineStyle {
  topFill: string;
  bottomFill: string;
}

export interface BaselineStyle {
  source: PriceSource;
  /** Base level as a percent of the visible price range from the bottom (0..100). */
  baseLevelPercent: number;
  width: number;
  topLineColor: string;
  topFill1: string;
  topFill2: string;
  bottomLineColor: string;
  bottomFill1: string;
  bottomFill2: string;
}

export interface HlcAreaStyle {
  width: number;
  highColor: string;
  lowColor: string;
  closeColor: string;
  highFill: string;
  lowFill: string;
}

export interface ColumnStyle {
  source: PriceSource;
  upColor: string;
  downColor: string;
  colorByPrevClose: boolean;
}

export interface HighLowStyle {
  color: string;
  borderColor: string;
  showLabels: boolean;
  labelColor: string;
}

export type BoxSizeMode = 'atr' | 'fixed';

export interface RenkoStyle extends CandleStyle {
  boxSizeMode: BoxSizeMode;
  atrLength: number;
  boxSize: number;
  /** 'close' builds bricks from closes, 'hl' from highs/lows. */
  source: 'close' | 'hl';
  wicks: boolean;
}

export interface LineBreakStyle extends CandleStyle {
  lines: number;
}

export interface KagiStyle {
  reversalMode: 'atr' | 'fixed' | 'percent';
  atrLength: number;
  reversal: number;
  source: 'close' | 'hl';
  yangColor: string;
  yinColor: string;
  yangWidth: number;
  yinWidth: number;
}

export interface PointFigureStyle {
  boxSizeMode: BoxSizeMode;
  atrLength: number;
  boxSize: number;
  reversal: number;
  source: 'close' | 'hl';
  upColor: string;
  downColor: string;
}

export interface RangeStyle extends BarStyle {
  rangeMode: BoxSizeMode;
  atrLength: number;
  range: number;
}

/** Style for every chart type, kept together so switching types keeps settings. */
export interface ChartStyle {
  bars: BarStyle;
  candles: CandleStyle;
  hollowCandles: CandleStyle;
  volumeCandles: CandleStyle;
  line: LineStyle;
  lineMarkers: LineStyle;
  stepLine: LineStyle;
  area: AreaStyle;
  hlcArea: HlcAreaStyle;
  baseline: BaselineStyle;
  columns: ColumnStyle;
  highLow: HighLowStyle;
  heikinAshi: CandleStyle;
  renko: RenkoStyle;
  lineBreak: LineBreakStyle;
  kagi: KagiStyle;
  pointFigure: PointFigureStyle;
  range: RangeStyle;
}

/** Extra per-bar info produced by brick transforms, needed by their renderers. */
export interface TransformExtra {
  /** Box / brick size used (renko, point & figure). */
  boxSize?: number;
  /** Kagi: 1 where the segment is yang (thick), 0 yin (thin). */
  kagiYang?: Uint8Array;
  /** Point & figure: 1 = X column, -1 = O column. */
  pfDirection?: Int8Array;
}

export interface TransformResult {
  bars: OhlcvSource;
  /** For each output bar, the index of the source bar that completed it. */
  sourceIndex: Int32Array;
  extra: TransformExtra;
}

const alpha = (hex: string, a: number): string => {
  const n = Math.round(a * 255)
    .toString(16)
    .padStart(2, '0');
  return hex.length === 7 ? `${hex}${n}` : hex;
};

/** Defaults derived from the theme's up/down colours. */
export function defaultChartStyle(theme: ChartTheme): ChartStyle {
  const up = theme.up;
  const down = theme.down;
  const blue = '#6E9BD6';
  const candle: CandleStyle = {
    upColor: up,
    downColor: down,
    borderUpColor: up,
    borderDownColor: down,
    wickUpColor: up,
    wickDownColor: down,
    drawBody: true,
    drawBorder: true,
    drawWick: true,
  };
  const bar: BarStyle = {
    upColor: up,
    downColor: down,
    hlcBars: false,
    thinBars: true,
    colorByPrevClose: false,
  };
  const line: LineStyle = { color: blue, width: 2, source: 'close' };
  return {
    bars: bar,
    candles: candle,
    hollowCandles: candle,
    volumeCandles: candle,
    line,
    lineMarkers: line,
    stepLine: line,
    area: { ...line, topFill: alpha(blue, 0.28), bottomFill: alpha(blue, 0.02) },
    hlcArea: {
      width: 2,
      highColor: up,
      lowColor: down,
      closeColor: '#868993',
      highFill: alpha(up, 0.2),
      lowFill: alpha(down, 0.2),
    },
    baseline: {
      source: 'close',
      baseLevelPercent: 50,
      width: 2,
      topLineColor: up,
      topFill1: alpha(up, 0.28),
      topFill2: alpha(up, 0.05),
      bottomLineColor: down,
      bottomFill1: alpha(down, 0.05),
      bottomFill2: alpha(down, 0.28),
    },
    columns: {
      source: 'close',
      upColor: alpha(up, 0.5),
      downColor: alpha(down, 0.5),
      colorByPrevClose: true,
    },
    highLow: { color: blue, borderColor: blue, showLabels: true, labelColor: blue },
    heikinAshi: candle,
    renko: {
      ...candle,
      boxSizeMode: 'atr',
      atrLength: 14,
      boxSize: 1,
      source: 'close',
      wicks: true,
    },
    lineBreak: { ...candle, lines: 3 },
    kagi: {
      reversalMode: 'atr',
      atrLength: 14,
      reversal: 1,
      source: 'close',
      yangColor: up,
      yinColor: down,
      yangWidth: 2,
      yinWidth: 1,
    },
    pointFigure: {
      boxSizeMode: 'atr',
      atrLength: 14,
      boxSize: 1,
      reversal: 3,
      source: 'hl',
      upColor: up,
      downColor: down,
    },
    range: { ...bar, rangeMode: 'atr', atrLength: 14, range: 1 },
  };
}
