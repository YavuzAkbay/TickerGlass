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
   * Key of a `bool` input in the same schema (the common "Wait for timeframe
   * closes", conventionally default true) that selects confirmed alignment:
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

export type InputDef =
  | IntInputDef
  | FloatInputDef
  | BoolInputDef
  | SourceInputDef
  | ColorInputDef
  | EnumInputDef
  | TimeframeInputDef
  | TimeInputDef;

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
 * hides that bar (standard `na` colour); other out-of-range indices use entry 0.
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
  textColor?: string;
  /** Shift by N bars when drawn (aboveBar/belowBar use the bar at the drawn position). */
  offset?: FromInputs<S, number>;
}

export type OutputDef<O extends string = string, S extends InputsSchema = InputsSchema> =
  PlotDef<O, S> | HLineDef<O, S> | FillDef<O> | BgColorDef<O, S> | ShapeDef<O, S>;

export type OutputType = OutputDef['type'];

// --------------------------------------------- resolved outputs (to engine)
// These mirror `StudyOutputMeta` in @investopen/engine structurally (the
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
  textColor: string;
  offset: number;
}

export type ResolvedOutput =
  ResolvedPlot | ResolvedHLine | ResolvedFill | ResolvedBgColor | ResolvedShape;

/** User style override for one output (Style tab, "Save as default"). Fields
 * that do not apply to the output type are ignored. */
export interface OutputStyleOverride {
  visible?: boolean;
  /** Plots only: users may switch e.g. line -> histogram. */
  kind?: PlotKind;
  /** Plots, fills, bgcolor, shapes: full palette. */
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
   * Called once per full computation. Create every stateful primitive here
   * through `ctx.ta`; never keep mutable state in closure variables (it would
   * not be rewound when the last bar is re-run). Returns the per-bar step.
   */
  setup(ctx: SetupContext<S>): StepFn<S, O>;
}

/**
 * Facts about the bars an instance runs on, provided by the host
 * (`IndicatorRuntime.setContext`). Changing them recomputes every instance.
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
 * Conventions (standard / TA-Lib compatible): warm-up outputs are NaN; ema/rma
 * seed with the SMA of the first `length` values; stdev is population (biased).
 */
export interface Ta {
  sma(length: number): Streaming;
  ema(length: number): Streaming;
  /** Wilder's moving average (alpha = 1/length), used by RSI/ATR/ADX. */
  rma(length: number): Streaming;
  /** Linearly weighted moving average (standard `ta.wma`). */
  wma(length: number): Streaming;
  /** Volume-weighted moving average (standard `ta.vwma`): update(x, volume). */
  vwma(length: number): WeightedStreaming;
  /** Rolling sum over `length` values. */
  sum(length: number): Streaming;
  stdev(length: number): Streaming;
  /** Mean absolute deviation from the window mean (standard `ta.dev`). */
  dev(length: number): Streaming;
  highest(length: number): Streaming;
  lowest(length: number): Streaming;
  history(length: number): History;
  /** Record of numbers carried across bars (standard `var`), e.g. SAR state. */
  vars<T extends Record<string, number>>(init: T): T;
  series(): SeriesVar;
}

// --------------------------------------------------------------- results

export type InstanceStatus =
  | { state: 'ok' }
  /** Waiting for timeframe bars from the host (MTF). */
  | { state: 'waiting'; timeframe: string }
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
