/**
 * Declarative indicator definitions (Phase 5 contract).
 *
 * An indicator is a plain object: metadata, an inputs schema (settings dialogs
 * are generated from it), an ordered list of outputs (plots, hlines, fills,
 * background colours, shapes) with default styles, and a `setup` function.
 *
 * Compute model: `setup` runs once per full computation and returns a per-bar
 * `step`. The runtime calls `step` for bars 0..n-1 in order. Running state
 * (moving-average sums, previous values, ...) lives only in primitives created
 * through `ta` in `setup`; the runtime snapshots them before the last bar so a
 * live tick can rewind and re-run that bar exactly. Why per-bar instead of
 * whole-array functions:
 *  - full compute and incremental update are the *same* code path, so they
 *    cannot drift apart (no per-indicator `update` to keep in sync);
 *  - recursive indicators (Parabolic SAR, Supertrend, Kagi-like state
 *    machines) are natural to write bar by bar;
 *  - a live tick costs O(1) per indicator instead of a tail-window recompute.
 *
 * Nothing here touches the DOM, so the same definitions run in the browser
 * worker and in the Node alerts service.
 */

// ------------------------------------------------------------------ inputs

/** Built-in price sources (columns of the chart's displayed series). */
export type PriceSource =
  'open' | 'high' | 'low' | 'close' | 'volume' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4';

export const PRICE_SOURCES: readonly PriceSource[] = [
  'open',
  'high',
  'low',
  'close',
  'volume',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
];

/** Indicator-on-indicator: an output of another instance in the same runtime. */
export interface OutputSourceRef {
  instanceId: string;
  outputId: string;
}

/** Value of a `source` input. JSON-serialisable. */
export type SourceValue = PriceSource | OutputSourceRef;

interface InputBase<V> {
  label: string;
  default: V;
  /** Section header in the settings dialog. */
  group?: string;
  /** Inputs sharing an `inline` key render on one row. */
  inline?: string;
  tooltip?: string;
  /** Leave this input out of the legend title ("RSI 14 close"). */
  hideInTitle?: boolean;
}

export interface IntInputDef extends InputBase<number> {
  kind: 'int';
  min?: number;
  max?: number;
  step?: number;
}

export interface FloatInputDef extends InputBase<number> {
  kind: 'float';
  min?: number;
  max?: number;
  step?: number;
}

export interface BoolInputDef extends InputBase<boolean> {
  kind: 'bool';
}

export interface SourceInputDef extends InputBase<PriceSource> {
  kind: 'source';
}

/** CSS colour string. Colours that only affect drawing belong in output styles. */
export interface ColorInputDef extends InputBase<string> {
  kind: 'color';
}

export interface EnumInputDef<O extends string = string> extends InputBase<O> {
  kind: 'enum';
  options: readonly O[];
  optionLabels?: Partial<Record<O, string>>;
}

/**
 * Resolution the *whole* indicator is computed on. '' = chart interval.
 * Other values use the engine's interval strings ("1h", "4h", "1D", "1W",
 * "1M") or 'auto' (resolved by the host, see RuntimeOptions.resolveTimeframe).
 * A definition may declare at most one timeframe input.
 */
export interface TimeframeInputDef extends InputBase<string> {
  kind: 'timeframe';
  /**
   * Key of a `bool` input in the same schema (a "wait for timeframe
   * close" switch, conventionally default true) that selects confirmed alignment:
   * every chart bar shows the last *closed* timeframe bar, so history matches
   * what was knowable in real time and live values never repaint. Without it
   * (or when false) chart bars show the timeframe bar containing them: on
   * history that is the bar's final value (lookahead), live it moves with each
   * tick. Indicators whose values are already known at the start of the
   * timeframe bar (Pivot Points use the previous bar) do not need it.
   */
  waitForCloseInput?: string;
}

/** Unix seconds (e.g. Anchored VWAP anchor). 0 = "not set"; the host may pick one. */
export interface TimeInputDef extends InputBase<number> {
  kind: 'time';
}

/**
 * Another symbol (ticker as the chart's DataFeed knows it, e.g. 'GOOG') whose
 * bars the host fetches and aligns to the chart bars (Correlation). Its
 * columns are read through `source` refs with instanceId `sym:<SYMBOL>`
 * (see EXTERNAL_SOURCE_PREFIX).
 */
export interface SymbolInputDef extends InputBase<string> {
  kind: 'symbol';
}

/** `OutputSourceRef.instanceId` prefix of an external symbol's price column. */
export const EXTERNAL_SOURCE_PREFIX = 'sym:';

export type InputDef =
  | IntInputDef
  | FloatInputDef
  | BoolInputDef
  | SourceInputDef
  | ColorInputDef
  | EnumInputDef
  | TimeframeInputDef
  | TimeInputDef
  | SymbolInputDef;

export type InputKind = InputDef['kind'];

/** Input key -> definition. Object key order is the dialog order. */
export type InputsSchema = Record<string, InputDef>;

/** Runtime value type of one input definition. */
export type InputValue<D extends InputDef = InputDef> = D extends
  IntInputDef | FloatInputDef | TimeInputDef
  ? number
  : D extends BoolInputDef
    ? boolean
    : D extends SourceInputDef
      ? SourceValue
      : D extends EnumInputDef<infer O>
        ? O
        : string;

export type InputValues<S extends InputsSchema> = { [K in keyof S]: InputValue<S[K]> };

/** Untyped input values as stored/serialised by hosts. */
export type InputValueMap = Record<string, number | boolean | string | OutputSourceRef>;

/** Keys of `source` inputs in a schema. */
export type SourceKeys<S extends InputsSchema> = {
  [K in keyof S]: S[K] extends SourceInputDef ? K : never;
}[keyof S] &
  string;

/** Keys of `symbol` inputs in a schema. */
export type SymbolKeys<S extends InputsSchema> = {
  [K in keyof S]: S[K] extends SymbolInputDef ? K : never;
}[keyof S] &
  string;

/** Chart-aligned price columns of an external symbol (arrays may be longer than the chart). */
export type ExternalColumns = { readonly [P in PriceSource]: Float64Array };

// ----------------------------------------------------------------- outputs

export type PlotKind = 'line' | 'step' | 'histogram' | 'area' | 'columns' | 'circles' | 'cross';
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type ShapeKind =
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
 * aboveBar/belowBar: anchored to the displayed bar's high/low; value only marks
 * presence (non-NaN). absolute: value is the price. top/bottom: pane edges.
 */
export type ShapeLocation = 'aboveBar' | 'belowBar' | 'absolute' | 'top' | 'bottom';
export type ShapeSize = 'tiny' | 'small' | 'normal' | 'large' | 'huge';

/**
 * A colour or a palette. With a palette the step picks an index per bar
 * (`ctx.set(id, v, colorIndex)`), e.g. MACD histogram rising/falling colours.
 * Users edit each palette entry in the Style tab. `NO_COLOR` as the index
 * hides that bar (missing-value colour); other out-of-range indices use entry 0.
 */
export type ColorSpec = string | readonly string[];

/** Palette index meaning "no colour" for the bar (same value as the engine's STUDY_COLOR_NONE). */
export const NO_COLOR = 255;

/** Static value or a function of the inputs (e.g. RSI upper band = input). The
 * method-signature form keeps typed definitions assignable to the erased
 * registry type (bivariant parameter). */
export type FromInputs<S extends InputsSchema, T> =
  T | { fromInputs(inputs: InputValues<S>): T }['fromInputs'];

interface OutputBase<O extends string> {
  id: O;
  /** Style tab / legend label. */
  title: string;
  /** Default visibility. */
  visible?: boolean;
}

export interface PlotDef<
  O extends string = string,
  S extends InputsSchema = InputsSchema,
> extends OutputBase<O> {
  type: 'plot';
  kind: PlotKind;
  color: ColorSpec;
  /** CSS px, default 1. */
  lineWidth?: number;
  lineStyle?: LineStyle;
  /** Base value for histogram/columns/area, default 0 (area: pane bottom if null). */
  base?: number | null;
  /** Shift by N bars when drawn (positive = into the future), e.g. Ichimoku. */
  offset?: FromInputs<S, number>;
  /** Show the last-value label on the price axis. Default true. */
  showLastValue?: boolean;
  /**
   * Line/step kinds: draw straight across NaN bars instead of breaking the
   * line (line vs line-with-breaks style), e.g. ZigZag pivots
   * written sparsely. Default false.
   */
  connectGaps?: boolean;
}

export interface HLineDef<
  O extends string = string,
  S extends InputsSchema = InputsSchema,
> extends OutputBase<O> {
  type: 'hline';
  value: FromInputs<S, number>;
  color: string;
  lineWidth?: number;
  /** Default 'dashed'. */
  lineStyle?: LineStyle;
}

/** Fill between two plots, two hlines, or a plot and an hline. */
export interface FillDef<O extends string = string> extends OutputBase<O> {
  type: 'fill';
  between: readonly [O, O];
  /** Use translucent colours; with a palette, `ctx.setColor(id, k)` per bar. */
  color: ColorSpec;
}

/** Per-bar background colour; drawn where the value is non-NaN. */
export interface BgColorDef<
  O extends string = string,
  S extends InputsSchema = InputsSchema,
> extends OutputBase<O> {
  type: 'bgcolor';
  color: ColorSpec;
  /** Shift by N bars when drawn (like PlotDef.offset). */
  offset?: FromInputs<S, number>;
}

/** Per-bar marker; drawn where the value is non-NaN (see ShapeLocation). */
export interface ShapeDef<
  O extends string = string,
  S extends InputsSchema = InputsSchema,
> extends OutputBase<O> {
  type: 'shape';
  shape: ShapeKind;
  location: ShapeLocation;
  size?: ShapeSize;
  color: ColorSpec;
  /** Static label text drawn with the shape. */
  text?: string;
  /**
   * Label text is the bar's value formatted with the indicator's format
   * (Pivots High/Low prices) instead of `text`. With aboveBar/belowBar the
   * value then both marks presence and supplies the text. Default false.
   */
  textFromValue?: boolean;
  textColor?: string;
  /** Shift by N bars when drawn (aboveBar/belowBar use the bar at the drawn position). */
  offset?: FromInputs<S, number>;
}

/** 'visible': one profile of the bars in view; 'session': one per session period. */
export type VolumeProfileMode = 'visible' | 'session';
/** Same values as the engine's volume profile drawings: row count or row size in price. */
export type VolumeProfileRowsLayout = 'count' | 'size';
export type VolumeProfilePlacement = 'left' | 'right';

/**
 * Volume profile computed and drawn by the engine from the chart's own bars
 * (visible-bars / session volume profile). Its values array marks period
 * starts in 'session' mode (non-NaN = a new period begins at that bar) and is
 * unused (all NaN) in 'visible' mode. Not autoscaled, no legend value, not an
 * alert operand. Numeric settings may come from inputs (like hline values).
 */
export interface VolumeProfileDef<
  O extends string = string,
  S extends InputsSchema = InputsSchema,
> extends OutputBase<O> {
  type: 'volumeProfile';
  mode: VolumeProfileMode;
  rowsLayout: FromInputs<S, VolumeProfileRowsLayout>;
  /** Number of rows ('count' layout). */
  rows: FromInputs<S, number>;
  /** Row height in price units ('size' layout). */
  rowSize: FromInputs<S, number>;
  /** Value area, % of the profile's volume. */
  valueArea: FromInputs<S, number>;
  /** Histogram width in % of the profile's range (session) or pane (visible). */
  widthPercent: FromInputs<S, number>;
  placement: FromInputs<S, VolumeProfilePlacement>;
  upColor: string;
  downColor: string;
  valueAreaUpColor: string;
  valueAreaDownColor: string;
  pocColor: string;
}

export type OutputDef<O extends string = string, S extends InputsSchema = InputsSchema> =
  | PlotDef<O, S>
  | HLineDef<O, S>
  | FillDef<O>
  | BgColorDef<O, S>
  | ShapeDef<O, S>
  | VolumeProfileDef<O, S>;

export type OutputType = OutputDef['type'];

// --------------------------------------------- resolved outputs (to engine)
// These mirror `StudyOutputMeta` in @tickerglass/engine structurally (the
// engine must not import this package). apps/web asserts compatibility.

export interface ResolvedPlot {
  type: 'plot';
  id: string;
  title: string;
  visible: boolean;
  kind: PlotKind;
  colors: string[];
  lineWidth: number;
  lineStyle: LineStyle;
  base: number | null;
  offset: number;
  showLastValue: boolean;
  connectGaps: boolean;
}

export interface ResolvedHLine {
  type: 'hline';
  id: string;
  title: string;
  visible: boolean;
  value: number;
  color: string;
  lineWidth: number;
  lineStyle: LineStyle;
}

export interface ResolvedFill {
  type: 'fill';
  id: string;
  title: string;
  visible: boolean;
  between: [string, string];
  colors: string[];
}

export interface ResolvedBgColor {
  type: 'bgcolor';
  id: string;
  title: string;
  visible: boolean;
  colors: string[];
  offset: number;
}

export interface ResolvedShape {
  type: 'shape';
  id: string;
  title: string;
  visible: boolean;
  shape: ShapeKind;
  location: ShapeLocation;
  size: ShapeSize;
  colors: string[];
  text: string;
  textFromValue: boolean;
  textColor: string;
  offset: number;
}

/** Order of `ResolvedVolumeProfile.colors` (and of a `colors` style override). */
export const VOLUME_PROFILE_COLOR_KEYS = [
  'upColor',
  'downColor',
  'valueAreaUpColor',
  'valueAreaDownColor',
  'pocColor',
] as const;

export interface ResolvedVolumeProfile {
  type: 'volumeProfile';
  id: string;
  title: string;
  visible: boolean;
  mode: VolumeProfileMode;
  rowsLayout: VolumeProfileRowsLayout;
  rows: number;
  rowSize: number;
  valueArea: number;
  widthPercent: number;
  placement: VolumeProfilePlacement;
  /** Up, down, value-area up, value-area down, POC (VOLUME_PROFILE_COLOR_KEYS). */
  colors: string[];
}

export type ResolvedOutput =
  | ResolvedPlot
  | ResolvedHLine
  | ResolvedFill
  | ResolvedBgColor
  | ResolvedShape
  | ResolvedVolumeProfile;

/** User style override for one output (Style tab, "Save as default"). Fields
 * that do not apply to the output type are ignored. */
export interface OutputStyleOverride {
  visible?: boolean;
  /** Plots only: users may switch e.g. line -> histogram. */
  kind?: PlotKind;
  /** Plots, fills, bgcolor, shapes: full palette. Volume profiles: VOLUME_PROFILE_COLOR_KEYS order. */
  colors?: string[];
  /** HLines only. */
  color?: string;
  lineWidth?: number;
  lineStyle?: LineStyle;
  size?: ShapeSize;
  textColor?: string;
}

export type OutputStyleOverrides = Record<string, OutputStyleOverride>;

// ------------------------------------------------------------- definition

export type IndicatorCategory =
  'movingAverage' | 'trend' | 'momentum' | 'volatility' | 'volume' | 'bands' | 'other';

/** How values are formatted on the axis and legend. 'inherit' = symbol price format. */
export type ValueFormat = 'inherit' | 'price' | 'volume' | 'percent';

export interface IndicatorDefinition<
  S extends InputsSchema = InputsSchema,
  O extends string = string,
> {
  /** Stable registry key, persisted in layouts. Never rename. */
  id: string;
  /** Full name for the Indicators dialog, e.g. "Relative Strength Index". */
  name: string;
  /** Legend prefix, e.g. "RSI". */
  shortName: string;
  category: IndicatorCategory;
  /** Extra search terms for the dialog. */
  keywords?: readonly string[];
  /** true: drawn on the price pane; false: new pane below. */
  overlay: boolean;
  format?: ValueFormat;
  /** Decimals; omit to inherit the symbol's price precision. */
  precision?: number;
  /** Fixed pane scale, e.g. RSI {min: 0, max: 100}. Omit for auto-scale. */
  scaleRange?: { min: number; max: number };
  inputs: S;
  /** Draw order = array order (later on top). */
  outputs: readonly OutputDef<O, S>[];
  /**
   * Values of past bars may change after they were first computed (ZigZag,
   * regression channel). Required to use `StepContext.setAt`; such definitions
   * cannot have a timeframe input and cannot be used as alert operands.
   */
  repaints?: true;
  /**
   * Bars of history the values need before they are trustworthy, for hosts
   * that compute on a bounded window (alerts service). 'cumulative': values
   * depend on all history (OBV, A/D), so no window is enough. Omit to let the
   * host derive it from the inputs.
   */
  warmup?: IndicatorWarmup<S>;
  /**
   * The values read `env.events` (VWAP's Earnings/Dividends/Splits anchors).
   * Only such instances receive the chart symbol's events, and only they
   * recompute when the events change. Omit for false.
   */
  usesEvents?: FromInputs<S, boolean>;
  /**
   * Called once per full computation. Create every stateful primitive here
   * through `ctx.ta`; never keep mutable state in closure variables (it would
   * not be rewound when the last bar is re-run). Returns the per-bar step.
   */
  setup(ctx: SetupContext<S>): StepFn<S, O>;
}

export type IndicatorWarmup<S extends InputsSchema = InputsSchema> =
  { kind: 'cumulative' } | { bars: FromInputs<S, number> };

/**
 * Facts about the bars an instance runs on, provided by the host
 * (`IndicatorRuntime.setContext`). Changing them recomputes every instance
 * (events: only instances that use them).
 */
export interface BarsEnv {
  /** IANA exchange timezone for calendar periods (VWAP anchors); 'UTC' when unknown. */
  timezone: string;
  /** Regular session "HHMM-HHMM" in exchange time, or null when unknown. */
  session: string | null;
  /**
   * Interval of the bars in seconds (chart interval for chart instances, the
   * timeframe for timeframe instances); 0 = unknown. Brick charts report the
   * interval of the time bars they were built from.
   */
  intervalSeconds: number;
  /**
   * Corporate event times of the symbol (unix seconds, sorted ascending, same
   * unit as bar times), only for definitions that declare `usesEvents`.
   * Absent = unknown (no events loaded, or a host without them).
   */
  events?: BarsEvents;
}

/** Event times by kind (unix seconds, sorted ascending). */
export interface BarsEvents {
  readonly dividends: readonly number[];
  readonly splits: readonly number[];
  readonly earnings: readonly number[];
}

export interface SetupContext<S extends InputsSchema> {
  readonly inputs: InputValues<S>;
  readonly ta: Ta;
  readonly env: Readonly<BarsEnv>;
}

/** Per-bar function (method-signature form: bivariant, see FromInputs). */
export type StepFn<S extends InputsSchema = InputsSchema, O extends string = string> = {
  step(ctx: StepContext<S, O>): void;
}['step'];

/**
 * Per-bar context. One object is reused for every bar (no allocation); do not
 * keep references to it. Arrays are valid for indices 0..i (reading j > i is
 * undefined behaviour: on the live bar those slots do not exist yet).
 */
export interface StepContext<S extends InputsSchema = InputsSchema, O extends string = string> {
  /** Current bar index (into the series the indicator runs on). */
  readonly i: number;
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  /** Resolved `source` inputs (price columns or another indicator's output). */
  readonly src: { readonly [K in SourceKeys<S>]: Float64Array };
  /** Aligned price columns of the symbol chosen in each `symbol` input (NaN where it has no bar). */
  readonly ext: { readonly [K in SymbolKeys<S>]: ExternalColumns };
  readonly inputs: InputValues<S>;
  readonly env: Readonly<BarsEnv>;
  /**
   * Value of a plot/shape/bgcolor at bar i (NaN = none). `color` is a palette
   * index (default 0; `NO_COLOR` hides the bar). Unset outputs are NaN for this bar.
   */
  set(id: O, value: number, color?: number): void;
  /** Palette index for bar i only (fills, or plots set elsewhere). */
  setColor(id: O, color: number): void;
  /** This indicator's own output at an earlier bar j < i (NaN if none). */
  get(id: O, j: number): number;
  /**
   * Retroactive write: value (and palette index) of a plot/shape/bgcolor at
   * bar j <= i, e.g. moving a ZigZag pivot or redrawing a regression window.
   * `color` defaults to palette index 0.
   * Only for definitions with `repaints: true` (throws otherwise). Writes made
   * while stepping the last bar are undone when a live tick re-runs it, and
   * the change reported to the host starts at the smallest index touched.
   * The definition must leave the same arrays after any tick sequence as a
   * full computation would (e.g. clear what an earlier last-bar run drew).
   */
  setAt(id: O, j: number, value: number, color?: number): void;
  /** True while stepping the last bar of the series (i === length - 1). */
  readonly isLast: boolean;
}

// ---------------------------------------------------------- ta primitives

/** A streaming calculation fed one value per bar. */
export interface Streaming {
  /**
   * Feed the value for the next bar and get the result for it. NaN inputs:
   * leading NaNs are skipped (warm-up starts at the first real value); a NaN
   * after that returns NaN and leaves the state unchanged.
   */
  update(x: number): number;
}

/** A streaming calculation fed a value and a weight (e.g. volume) per bar. */
export interface WeightedStreaming {
  /** NaN in either argument: NaN, state unchanged (see Streaming). */
  update(x: number, weight: number): number;
}

/** A streaming calculation fed two aligned values per bar (e.g. correlation). */
export interface PairStreaming {
  /** NaN in either argument: NaN, state unchanged (see Streaming). */
  update(x: number, y: number): number;
}

/** Last N values (newest first), for lookbacks like `x[k]`. */
export interface History {
  push(x: number): void;
  /** k = 0 is the newest pushed value; NaN if not available. */
  get(k: number): number;
}

/** Per-bar scratch series aligned to bar indices; re-running a bar just overwrites. */
export interface SeriesVar {
  get(i: number): number;
  set(i: number, v: number): void;
}

/**
 * Factory for stateful primitives. Everything created here is snapshotted and
 * restored by the runtime. Only callable inside `setup`.
 * Conventions (TA-Lib compatible): warm-up outputs are NaN; ema/rma
 * seed with the SMA of the first `length` values; stdev is population (biased).
 */
export interface Ta {
  sma(length: number): Streaming;
  ema(length: number): Streaming;
  /** Wilder's moving average (alpha = 1/length), used by RSI/ATR/ADX. */
  rma(length: number): Streaming;
  /** Linearly weighted moving average. */
  wma(length: number): Streaming;
  /** Volume-weighted moving average: update(x, volume). */
  vwma(length: number): WeightedStreaming;
  /** Rolling sum over `length` values. */
  sum(length: number): Streaming;
  stdev(length: number): Streaming;
  /** Mean absolute deviation from the window mean. */
  dev(length: number): Streaming;
  highest(length: number): Streaming;
  lowest(length: number): Streaming;
  /**
   * Offset (<= 0, in values fed) of the highest of the last `length` values
   * from the current one; ties pick the most recent.
   */
  highestBars(length: number): Streaming;
  /** Like `highestBars` for the lowest value. */
  lowestBars(length: number): Streaming;
  /** Running total of every value fed. */
  cum(): Streaming;
  /** `x - x[length]`, default length 1. */
  change(length?: number): Streaming;
  /**
   * Least-squares line over the last `length` values with x = 0..length-1
   * oldest to newest: a + b * (length - 1 - offset),
   * offset 0 = the fitted value at the current bar, TA-Lib LINEARREG).
   */
  linreg(length: number, offset?: number): Streaming;
  /**
   * Percentage (0..100) of the previous `length` values that are <= the
   * current one (needs length + 1 values).
   */
  percentrank(length: number): Streaming;
  /** Pearson correlation of x and y over `length` pairs. */
  correlation(length: number): PairStreaming;
  /** Symmetrically weighted MA of 4 values: (x[3] + 2x[2] + 2x[1] + x) / 6. */
  swma(): Streaming;
  /**
   * Arnaud Legoux MA: gaussian weights centred at
   * offset * (length - 1) from the oldest value, width length / sigma.
   */
  alma(length: number, offset: number, sigma: number): Streaming;
  /**
   * Pivot high: on the value that confirms
   * it, the value `right` values back if it is strictly greater than the
   * `left` values before and `right` values after it; NaN otherwise.
   */
  pivotHigh(left: number, right: number): Streaming;
  /** Pivot low: like `pivotHigh` with strictly lower. */
  pivotLow(left: number, right: number): Streaming;
  history(length: number): History;
  /** Record of numbers carried across bars (persistent variable), e.g. SAR state. */
  vars<T extends Record<string, number>>(init: T): T;
  series(): SeriesVar;
}

// --------------------------------------------------------------- results

export type InstanceStatus =
  | { state: 'ok' }
  /** Waiting for timeframe bars (MTF) or an external symbol's aligned bars (`symbol`) from the host. */
  | { state: 'waiting'; timeframe: string; symbol?: string }
  | { state: 'error'; message: string };

/**
 * Output arrays of one instance on chart bars. Arrays may be longer than
 * `length` (spare capacity); read [0, length). Arrays may be reallocated on
 * the next compute, so do not hold them across calls.
 */
export interface IndicatorResult {
  length: number;
  /** Plots, shapes and bgcolor outputs (NaN = no value). */
  values: Record<string, Float64Array>;
  /** Palette index per bar for outputs whose colour is a palette (incl. fills). */
  colors: Record<string, Uint8Array>;
  status: InstanceStatus;
}

/** Columnar bars (same shape as the engine's BarColumns / SeriesStore). */
export interface BarArrays {
  time: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  volume: ArrayLike<number>;
}

export interface BarInput {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
