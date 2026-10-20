/**
 * Type declarations for InvestOpen user scripts (apiVersion 1).
 *
 * Optional: put this file next to your script in an editor that understands
 * TypeScript declarations (VS Code, WebStorm) and start the script with
 * `// @ts-check` to get completion and type errors while you write it.
 * InvestOpen itself runs plain JavaScript and ignores this file.
 *
 * Derived from packages/indicators/src/{types,user-script}.ts. Reference:
 * docs/user-scripts.md.
 */

// ------------------------------------------------------------ injected names

/** Declares the indicator. Call it exactly once, while the script loads. Returns its argument. */
declare function defineIndicator<const S extends InputsSchema, const O extends string>(
  def: IndicatorDefinition<S, O>,
): IndicatorDefinition<S, O>;

/** Palette index meaning "draw nothing for this bar" (255). */
declare const NO_COLOR: 255;

/** Every value a `source` input can take. */
declare const PRICE_SOURCES: readonly PriceSource[];

/**
 * Period number of bar time `time` (unix seconds) for `unit`, in IANA timezone `tz`
 * ('UTC' by default). Consecutive bars with the same number are in the same period.
 * Pass `c.env.timezone` and `c.env.session`. Weeks start on Monday.
 */
declare function calendarPeriod(
  time: number,
  unit: CalendarUnit,
  tz?: string,
  session?: string | null,
): number;

type CalendarUnit = 'session' | 'week' | 'month' | 'quarter' | 'year' | 'decade' | 'century';

// ------------------------------------------------------------------- inputs

type PriceSource =
  'open' | 'high' | 'low' | 'close' | 'volume' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4';

interface InputBase<V> {
  /** Label in the settings dialog. */
  label: string;
  default: V;
  /** Section header in the settings dialog. */
  group?: string;
  /** Inputs sharing an `inline` key share one row. */
  inline?: string;
  tooltip?: string;
  /** Leave this input out of the legend title. */
  hideInTitle?: boolean;
}

interface IntInputDef extends InputBase<number> {
  kind: 'int';
  min?: number;
  max?: number;
  step?: number;
}

interface FloatInputDef extends InputBase<number> {
  kind: 'float';
  min?: number;
  max?: number;
  step?: number;
}

interface BoolInputDef extends InputBase<boolean> {
  kind: 'bool';
}

/** Price sources only (no other indicators' outputs). */
interface SourceInputDef extends InputBase<PriceSource> {
  kind: 'source';
}

/** CSS colour: hex, rgb(), rgba(), hsl(), hsla() or a CSS colour name. */
interface ColorInputDef extends InputBase<string> {
  kind: 'color';
}

interface EnumInputDef<O extends string = string> extends InputBase<O> {
  kind: 'enum';
  options: readonly O[];
  optionLabels?: Partial<Record<O, string>>;
}

/** Unix seconds. 0 = not set. */
interface TimeInputDef extends InputBase<number> {
  kind: 'time';
}

/** There are no `timeframe` or `symbol` inputs in user scripts. */
type InputDef =
  | IntInputDef
  | FloatInputDef
  | BoolInputDef
  | SourceInputDef
  | ColorInputDef
  | EnumInputDef
  | TimeInputDef;

/** Input key -> definition. Key order is the order in the settings dialog. */
type InputsSchema = Record<string, InputDef>;

type InputValue<D extends InputDef> = D extends IntInputDef | FloatInputDef | TimeInputDef
  ? number
  : D extends BoolInputDef
    ? boolean
    : D extends SourceInputDef
      ? PriceSource
      : D extends EnumInputDef<infer O>
        ? O
        : string;

type InputValues<S extends InputsSchema> = { [K in keyof S]: InputValue<S[K]> };

type SourceKeys<S extends InputsSchema> = {
  [K in keyof S]: S[K] extends SourceInputDef ? K : never;
}[keyof S] &
  string;

// ------------------------------------------------------------------ outputs

/**
 * A colour or a palette. With a palette, `c.set(id, value, index)` /
 * `c.setColor(id, index)` pick the entry per bar; `NO_COLOR` hides the bar and
 * any other out-of-range index uses entry 0.
 */
type ColorSpec = string | readonly string[];

type LineStyle = 'solid' | 'dashed' | 'dotted';

interface OutputBase<O extends string> {
  /** Unique within the script; used in `c.set`, `c.get`, `c.setAt` and `fill.between`. */
  id: O;
  /** Style tab and legend label. */
  title: string;
  /** Default visibility. */
  visible?: boolean;
}

interface PlotDef<O extends string = string> extends OutputBase<O> {
  type: 'plot';
  kind: 'line' | 'step' | 'histogram' | 'area' | 'columns' | 'circles' | 'cross';
  color: ColorSpec;
  /** CSS px, default 1. */
  lineWidth?: number;
  lineStyle?: LineStyle;
  /** Base value of histogram/columns/area, default 0. */
  base?: number | null;
  /** Shift by N bars when drawn (positive = into the future). A fixed integer. */
  offset?: number;
  /** Last-value label on the price axis, default true. */
  showLastValue?: boolean;
  /** Draw lines straight across NaN bars instead of breaking them. Default false. */
  connectGaps?: boolean;
}

interface HLineDef<O extends string = string> extends OutputBase<O> {
  type: 'hline';
  /** A fixed number (cannot depend on inputs). */
  value: number;
  color: string;
  lineWidth?: number;
  /** Default 'dashed'. */
  lineStyle?: LineStyle;
}

/** Fill between two plots, two hlines, or a plot and an hline. */
interface FillDef<O extends string = string> extends OutputBase<O> {
  type: 'fill';
  between: readonly [O, O];
  /** Use translucent colours. */
  color: ColorSpec;
}

/** Per-bar background colour, drawn where the value is not NaN. */
interface BgColorDef<O extends string = string> extends OutputBase<O> {
  type: 'bgcolor';
  color: ColorSpec;
  offset?: number;
}

/** Per-bar marker, drawn where the value is not NaN. */
interface ShapeDef<O extends string = string> extends OutputBase<O> {
  type: 'shape';
  shape:
    | 'triangleUp'
    | 'triangleDown'
    | 'arrowUp'
    | 'arrowDown'
    | 'circle'
    | 'cross'
    | 'xcross'
    | 'diamond'
    | 'square'
    | 'flag'
    | 'labelUp'
    | 'labelDown';
  /**
   * aboveBar / belowBar: next to the bar; any non-NaN value means "show".
   * absolute: the value is the price. top / bottom: edge of the pane.
   */
  location: 'aboveBar' | 'belowBar' | 'absolute' | 'top' | 'bottom';
  size?: 'tiny' | 'small' | 'normal' | 'large' | 'huge';
  color: ColorSpec;
  /** Static label text. */
  text?: string;
  /** Label text is the bar's value instead of `text`. Default false. */
  textFromValue?: boolean;
  textColor?: string;
  offset?: number;
}

/**
 * Volume profile drawn by the chart from its own bars. Every field is required
 * and fixed. Not covered by the guide's examples.
 */
interface VolumeProfileDef<O extends string = string> extends OutputBase<O> {
  type: 'volumeProfile';
  mode: 'visible' | 'session';
  rowsLayout: 'count' | 'size';
  rows: number;
  rowSize: number;
  valueArea: number;
  widthPercent: number;
  placement: 'left' | 'right';
  upColor: string;
  downColor: string;
  valueAreaUpColor: string;
  valueAreaDownColor: string;
  pocColor: string;
}

type OutputDef<O extends string = string> =
  PlotDef<O> | HLineDef<O> | FillDef<O> | BgColorDef<O> | ShapeDef<O> | VolumeProfileDef<O>;

// --------------------------------------------------------------- definition

interface IndicatorDefinition<S extends InputsSchema = InputsSchema, O extends string = string> {
  /** Ignored: the script's id is assigned by InvestOpen. May be left out. */
  id?: string;
  /** Full name in the Indicators dialog. */
  name: string;
  /** Legend prefix. */
  shortName: string;
  category: 'movingAverage' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'bands' | 'other';
  /** Extra search terms for the dialog. */
  keywords?: readonly string[];
  /** true: drawn on the price pane; false: in a new pane below. */
  overlay: boolean;
  format?: 'inherit' | 'price' | 'volume' | 'percent';
  /** Decimals, 0 to 16. Omit to inherit the symbol's price precision. */
  precision?: number;
  /** Fixed pane scale (min below max), e.g. { min: 0, max: 100 }. Omit to auto-scale. */
  scaleRange?: { min: number; max: number };
  inputs: S;
  /** Draw order = array order (later on top). */
  outputs: readonly OutputDef<O>[];
  /** Set to true if the script rewrites past bars with `c.setAt`. */
  repaints?: true;
  /** Accepted, currently unused (it only matters to hosts that compute on a bounded window). */
  warmup?: { kind: 'cumulative' } | { bars: number };
  /**
   * Called once per full computation. Create every `ta` primitive here and keep
   * running state only in them. Returns the per-bar `step` function.
   */
  setup(ctx: SetupContext<S>): StepFn<S, O>;
}

/** Facts about the bars, provided by the app. */
interface BarsEnv {
  /** IANA exchange timezone, 'UTC' when unknown. */
  timezone: string;
  /** Regular session "HHMM-HHMM" in exchange time, or null when unknown. */
  session: string | null;
  /** Bar interval in seconds, 0 = unknown. */
  intervalSeconds: number;
}

interface SetupContext<S extends InputsSchema> {
  readonly inputs: InputValues<S>;
  readonly ta: Ta;
  readonly env: Readonly<BarsEnv>;
}

type StepFn<S extends InputsSchema = InputsSchema, O extends string = string> = {
  step(c: StepContext<S, O>): void;
}['step'];

/**
 * The per-bar context. One object is reused for every bar: do not keep references
 * to it. Arrays are valid for indices 0..i only.
 */
interface StepContext<S extends InputsSchema = InputsSchema, O extends string = string> {
  /** Current bar index. */
  readonly i: number;
  /** Bar open times, unix seconds. */
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  /** One column per `source` input, by input key. */
  readonly src: { readonly [K in SourceKeys<S>]: Float64Array };
  readonly inputs: InputValues<S>;
  readonly env: Readonly<BarsEnv>;
  /** Value of a plot / shape / bgcolor for this bar (NaN = none), with an optional palette index. */
  set(id: O, value: number, color?: number): void;
  /** Palette index for this bar only (for fills, or plots set elsewhere). */
  setColor(id: O, color: number): void;
  /** This script's own output at an earlier bar j < i (NaN if none). */
  get(id: O, j: number): number;
  /**
   * Rewrites a plot / shape / bgcolor value at bar j <= i. Only with `repaints: true`
   * (throws otherwise). `color` defaults to palette index 0.
   */
  setAt(id: O, j: number, value: number, color?: number): void;
  /** True while stepping the last bar of the series. */
  readonly isLast: boolean;
}

// ----------------------------------------------------------- ta primitives

/** Takes one value per bar. Leading NaNs are skipped; a later NaN returns NaN, state unchanged. */
interface Streaming {
  update(x: number): number;
}

/** Takes a value and a weight per bar (volume). */
interface WeightedStreaming {
  update(x: number, weight: number): number;
}

/** Takes two aligned values per bar. */
interface PairStreaming {
  update(x: number, y: number): number;
}

/** The last N values pushed, newest first. */
interface History {
  push(x: number): void;
  /** k = 0 is the newest pushed value; NaN if not available. */
  get(k: number): number;
}

/** A per-bar scratch series. Re-running a bar overwrites its slot. */
interface SeriesVar {
  get(i: number): number;
  set(i: number, v: number): void;
}

/**
 * Stateful primitives. Create them in `setup` only (creating one in `step` throws).
 * Warm-up values are NaN. ema/rma seed with the SMA of the first `length` values;
 * stdev is the population standard deviation.
 */
interface Ta {
  sma(length: number): Streaming;
  ema(length: number): Streaming;
  /** Wilder's moving average (alpha = 1 / length); RSI, ATR, ADX. */
  rma(length: number): Streaming;
  wma(length: number): Streaming;
  /** Volume-weighted moving average: update(x, volume). */
  vwma(length: number): WeightedStreaming;
  /** Rolling sum. */
  sum(length: number): Streaming;
  stdev(length: number): Streaming;
  /** Mean absolute deviation from the window mean. */
  dev(length: number): Streaming;
  highest(length: number): Streaming;
  lowest(length: number): Streaming;
  /** Offset (<= 0) of the highest of the last `length` values; ties pick the most recent. */
  highestBars(length: number): Streaming;
  lowestBars(length: number): Streaming;
  /** Running total of every value fed. */
  cum(): Streaming;
  /** x - x[length], default length 1. */
  change(length?: number): Streaming;
  /** Least-squares line over the last `length` values; offset 0 = the fitted value at the current bar. */
  linreg(length: number, offset?: number): Streaming;
  /** Percentage (0..100) of the previous `length` values that are <= the current one. */
  percentrank(length: number): Streaming;
  /** Pearson correlation of x and y over `length` pairs. */
  correlation(length: number): PairStreaming;
  /** (x[3] + 2 * x[2] + 2 * x[1] + x) / 6. */
  swma(): Streaming;
  /** Arnaud Legoux moving average. */
  alma(length: number, offset: number, sigma: number): Streaming;
  /**
   * On the value that confirms it, the value `right` values back if it is strictly
   * greater than the `left` values before and the `right` values after it; else NaN.
   */
  pivotHigh(left: number, right: number): Streaming;
  /** Like pivotHigh with strictly lower. */
  pivotLow(left: number, right: number): Streaming;
  history(length: number): History;
  /** Numbers carried across bars (persistent variable). Read and write the fields of the returned object. */
  vars<T extends Record<string, number>>(init: T): T;
  series(): SeriesVar;
}
