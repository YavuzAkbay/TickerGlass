/**
 * Study (indicator display) contract — Phase 5.
 *
 * The engine draws indicator results but never computes them and never
 * imports @investopen/indicators. The output metadata below mirrors that
 * package's `ResolvedOutput` structurally; apps/web asserts the two stay
 * compatible at compile time (apps/web/src/indicators/contract.ts).
 *
 * Data model: every value array is aligned to the *displayed* series
 * (`chart.store`), index i = displayed bar i. For Heikin Ashi and brick types
 * that is the transformed series, so indicators run on bricks; use
 * `chart.sourceIndexOf(i)` to map back to time bars.
 */

export type StudyPlotKind =
  'line' | 'step' | 'histogram' | 'area' | 'columns' | 'circles' | 'cross';
export type StudyLineStyle = 'solid' | 'dashed' | 'dotted';
export type StudyShapeKind =
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
/** aboveBar/belowBar: at the displayed bar's high/low (value = presence only);
 * absolute: value is the price; top/bottom: pane edges. */
export type StudyShapeLocation = 'aboveBar' | 'belowBar' | 'absolute' | 'top' | 'bottom';
export type StudyShapeSize = 'tiny' | 'small' | 'normal' | 'large' | 'huge';
/** 'inherit' = the symbol's price format and precision. */
export type StudyValueFormat = 'inherit' | 'price' | 'volume' | 'percent';

/**
 * Colours: `colors` is a palette. Outputs with more than one entry receive a
 * per-bar palette index in `StudyData.colors[id]`; otherwise entry 0 is used.
 * Index `STUDY_COLOR_NONE` (255) means "no colour" for that bar (standard `na`
 * colour): the bar's segment/mark/fill/background is not drawn. Any other
 * out-of-range index falls back to entry 0.
 */
export const STUDY_COLOR_NONE = 255;

export interface StudyPlotMeta {
  type: 'plot';
  id: string;
  title: string;
  visible: boolean;
  kind: StudyPlotKind;
  colors: string[];
  lineWidth: number;
  lineStyle: StudyLineStyle;
  /** Histogram/columns/area base; null = pane bottom (area only). */
  base: number | null;
  /** Draw value[i] at bar i + offset (may extend past the last bar). */
  offset: number;
  /** Last-value label on the price axis. */
  showLastValue: boolean;
  /** Lines/steps/area skip NaN bars and join the neighbouring values (additive; default false = break). */
  connectGaps?: boolean;
}

export interface StudyHLineMeta {
  type: 'hline';
  id: string;
  title: string;
  visible: boolean;
  value: number;
  color: string;
  lineWidth: number;
  lineStyle: StudyLineStyle;
}

/** Filled band between two plots/hlines of the same study, where both are non-NaN. */
export interface StudyFillMeta {
  type: 'fill';
  id: string;
  title: string;
  visible: boolean;
  between: [string, string];
  colors: string[];
}

/** Full-height background per bar where `values[id][i]` is non-NaN. */
export interface StudyBgColorMeta {
  type: 'bgcolor';
  id: string;
  title: string;
  visible: boolean;
  colors: string[];
  /** Draw value[i] at bar i + offset (additive; default 0). */
  offset?: number;
}

export interface StudyShapeMeta {
  type: 'shape';
  id: string;
  title: string;
  visible: boolean;
  shape: StudyShapeKind;
  location: StudyShapeLocation;
  size: StudyShapeSize;
  colors: string[];
  text: string;
  /** Label text = the value formatted with the study's format/precision instead
   * of `text` (additive; default false). Labels and the text under other shapes. */
  textFromValue?: boolean;
  textColor: string;
  /** Draw value[i] at bar i + offset (additive; default 0). aboveBar/belowBar
   * anchor to the bar at the drawn position; past the last bar they are not drawn. */
  offset?: number;
}

/**
 * Volume profile computed by the engine from the displayed bars (never from
 * `values`). 'visible': one profile of the visible bars. 'session': one per
 * period overlapping the view; `values[id][i]` non-NaN marks the first bar of
 * a period. Not part of autoscale, legends, magnet or hit testing.
 */
export interface StudyVolumeProfileMeta {
  type: 'volumeProfile';
  id: string;
  title: string;
  visible: boolean;
  mode: 'visible' | 'session';
  rowsLayout: 'count' | 'size';
  rows: number;
  /** Row height in price units ('size' layout). */
  rowSize: number;
  /** Value area, % of the volume. */
  valueArea: number;
  /** Histogram width in % of the profile's width. */
  widthPercent: number;
  placement: 'left' | 'right';
  /** Up, down, value-area up, value-area down, POC. */
  colors: string[];
}

/** Draw order = array order (later on top). */
export type StudyOutputMeta =
  | StudyPlotMeta
  | StudyHLineMeta
  | StudyFillMeta
  | StudyBgColorMeta
  | StudyShapeMeta
  | StudyVolumeProfileMeta;

/** Where a study is drawn. */
export type StudyTarget =
  /** On an existing pane's price scale ('main' for price overlays, or the
   * pane of the source study for indicator-on-indicator). */
  | { paneId: string }
  /** A new pane below the others; `id` lets saved layouts restore pane ids.
   * If a pane with `id` already exists it is reused (`ratio` is ignored), so
   * re-adding a study to its own pane (undo, layout restore) is idempotent. */
  | { newPane: { id?: string; ratio?: number } };

export interface StudySpec {
  /** Unique per chart; must not be 'main', 'volume' or 'volume-pane'. */
  id: string;
  /** Legend title, e.g. "RSI 14 close". */
  title: string;
  target: StudyTarget;
  outputs: StudyOutputMeta[];
  format: StudyValueFormat;
  /** Decimals; null = inherit from the symbol. */
  precision: number | null;
  /** Fixed pane scale (e.g. RSI 0..100); null = auto-scale with the pane. */
  scaleRange: { min: number; max: number } | null;
  /**
   * 'pane' shares and auto-scales the pane's price scale. 'none' draws on an
   * implicit own scale excluded from auto-scale (like the volume overlay).
   * 'own' draws on a full-height implicit linear scale (pane margins),
   * auto-scaled to the study alone and excluded from the pane's auto-scale.
   */
  priceScale: 'pane' | 'none' | 'own';
  /**
   * Compare overlay ("same % scale"): values are rescaled so that the first
   * visible value meets the main series' base value there. Only with
   * priceScale 'pane' on the main pane; default false. Legends stay raw.
   */
  compare?: boolean;
  visible: boolean;
}

/** Legend containers of a pane: compare rows, then study rows. */
export type LegendSlotKind = 'studies' | 'compare';

/**
 * Computed values. Arrays may be longer than `length`; read [0, length).
 * The engine takes ownership: callers must not mutate arrays after passing
 * them (worker results are transferred, so this is natural).
 */
export interface StudyData {
  /** `chart.seriesRevision` the values were computed on. Data from an older
   * revision is not drawn (indices would not line up after a reset). */
  revision: number;
  length: number;
  /** Plots, shapes, bgcolor and volume profile (period starts) outputs by id; NaN = no value. */
  values: Record<string, Float64Array>;
  /** Per-bar palette index for outputs with a multi-colour palette (incl. fills). */
  colors: Record<string, Uint8Array>;
}

/**
 * Tail patch: arrays hold indices [from, length) only (index from at [0]).
 * Live ticks send from = length - 1; appends grow the stored arrays.
 */
export interface StudyDataPatch {
  revision: number;
  from: number;
  /** New total length. */
  length: number;
  values: Record<string, Float64Array>;
  colors: Record<string, Uint8Array>;
}

/** Style tweaks for one output (Style tab); unknown fields for the type are ignored. */
export interface StudyOutputStylePatch {
  visible?: boolean;
  kind?: StudyPlotKind;
  colors?: string[];
  color?: string;
  lineWidth?: number;
  lineStyle?: StudyLineStyle;
  size?: StudyShapeSize;
  textColor?: string;
}

export interface StudyInfo {
  id: string;
  paneId: string;
  title: string;
  visible: boolean;
}

/** One legend entry at a bar (offset already applied). */
export interface StudyLegendValue {
  outputId: string;
  title: string;
  /** NaN when there is no value at that bar. */
  value: number;
  /** Formatted with the study's format/precision; '' when NaN. */
  text: string;
  color: string;
}

/**
 * How the displayed series changed. The web app forwards these to the
 * indicator worker: 'reset' and 'prepend' -> send all bars, 'update'/'append'
 * -> send the bar at `index`. Emitted after the chart has applied the change.
 */
export type SeriesChange =
  /** Load, chart type or brick-style change, clear, brick history prepends,
   * and live brick rebuilds that changed more than the last brick. */
  | { kind: 'reset'; revision: number; length: number }
  /**
   * History prepend (plain and Heikin Ashi): `added` bars were inserted before
   * index 0, so old index i is now i + added. Like 'reset' it starts a new
   * revision and consumers must recompute from all bars; meanwhile the engine
   * keeps drawing each study's previous data shifted by `added` (it is
   * re-stamped with the new revision, so a full `setStudyData` replaces it).
   */
  | { kind: 'prepend'; revision: number; length: number; added: number }
  | { kind: 'update'; revision: number; index: number }
  | { kind: 'append'; revision: number; index: number };

export interface StudyPointerEvent {
  id: string;
  /** Output under the pointer, if resolvable. */
  outputId: string | null;
  clientX: number;
  clientY: number;
}

/** Merged into ChartEvents. */
export interface StudyEvents {
  seriesChange: SeriesChange;
  /** Pointer enters/leaves a study (id null on leave). */
  studyHover: { id: string | null; outputId: string | null };
  studyClick: StudyPointerEvent;
  /** Opens the settings dialog in the app. */
  studyDoubleClick: StudyPointerEvent;
  /**
   * A pane holding studies was removed (`removePane`, incl. from the app's pane
   * menu; `studyIds` = the studies dropped with it), or a pane was removed
   * because its last study was removed or moved away (`studyIds` empty).
   * Emitted once per pane, after the chart has applied the change.
   */
  paneRemoved: { paneId: string; studyIds: string[] };
  /**
   * `setState` dropped every study (it recreates panes). Emitted after the
   * panes are restored; the app re-adds the listed studies.
   */
  studiesCleared: { ids: string[] };
}

/**
 * Methods `Chart` implements for studies (agent B). Right-clicking a study
 * emits the existing `contextMenu` event with `seriesId` = study id.
 */
export interface StudyApi {
  /** Increments on every 'reset' SeriesChange. */
  readonly seriesRevision: number;
  /** Adds the study (creating a pane for `newPane`, or reusing the pane with
   * that id); returns its pane id. Throws if the study id exists or a
   * `paneId` target does not. */
  addStudy(spec: StudySpec): string;
  /** Removes the study; a non-main pane left without studies or other
   * series is removed too (emits paneRemoved). Unknown ids are ignored. */
  removeStudy(id: string): void;
  /** Moves to another pane / a new pane; returns the new pane id. A no-op
   * when the target resolves to the study's current pane. */
  moveStudy(id: string, target: StudyTarget): string;
  getStudies(): StudyInfo[];
  /** Replaces all values (full compute). */
  setStudyData(id: string, data: StudyData): void;
  /** Patches the tail (live tick, append, timeframe re-align). Ignored when
   * the revision is stale; a gap (from > stored length) is ignored too. */
  updateStudyData(id: string, patch: StudyDataPatch): void;
  setStudyVisible(id: string, visible: boolean): void;
  /** Title, outputs (style or input-derived hline/offset changes), format,
   * precision, scale range, price scale mode. */
  updateStudySpec(id: string, patch: Partial<Omit<StudySpec, 'id' | 'target'>>): void;
  setStudyStyle(id: string, outputId: string, style: StudyOutputStylePatch): void;
  /** Values of visible plots at displayed bar `index` (crosshair or last bar). */
  getStudyValues(id: string, index: number): StudyLegendValue[];
  /** DOM container in the pane's legend that the app renders study legend
   * rows ('studies', default) or compare overlay rows ('compare', above the
   * study rows) into (the engine never writes to it). Null for an unknown pane. */
  getLegendSlot(paneId: string, kind?: LegendSlotKind): HTMLElement | null;
}
