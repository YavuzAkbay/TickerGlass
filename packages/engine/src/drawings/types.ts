/**
 * Drawing contract — Phase 6. Design notes: docs/drawings.md.
 *
 * Model: a `Drawing` is plain JSON (persisted by the app, never by the
 * engine). Anchors are (time, price) pairs, so a drawing survives interval
 * changes, history prepends and reloads; the engine maps them to bar indices
 * and pixels on every frame (drawings/mapping.ts) and never rewrites stored
 * anchors unless the user edits the drawing.
 *
 * Tools are declarative (`DrawingToolDefinition`): the framework owns the
 * model, selection, gestures, handles and events; a tool only renders and
 * hit-tests its own geometry in pane pixels.
 *
 * Change this file additively only, and say so in the PR.
 */
import type { ChartTheme } from '../options';

// ------------------------------------------------------------------ model

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Tool style values by key (`lineColor`, `extendRight`, `levels`, ...). */
export type DrawingStyle = Record<string, JsonValue>;

export type DrawingLineStyle = 'solid' | 'dashed' | 'dotted';

/** One anchor. */
export interface DrawingPoint {
  /**
   * Unix seconds. Inside the data: the bar's open time. Past the last bar:
   * last bar time + k intervals (calendar months for M intervals); before the
   * first bar: first bar time - k intervals. See docs/drawings.md §3.
   * `coords: 'pane'` tools: x as a fraction (0..1) of the pane width.
   */
  time: number;
  /** In the pane's value units (price on the main pane, study units elsewhere).
   * `coords: 'pane'` tools: y as a fraction (0..1) of the pane height. */
  price: number;
  /**
   * Brick charts only (Renko, Kagi, ...): position inside a run of bricks that
   * share `time`. Omitted when 0; ignored on time-based chart types.
   */
  brick?: number;
}

export type DrawingVisibilityUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface DrawingVisibilityRange {
  enabled: boolean;
  min: number;
  max: number;
}

/** Same shape as the app's indicator `IntervalVisibility`. */
export type DrawingIntervalVisibility = Record<DrawingVisibilityUnit, DrawingVisibilityRange>;

/** 'symbol': shown on `symbol` only. 'all': synced, shown on every symbol. */
export type DrawingScope = 'symbol' | 'all';

export interface Drawing {
  /** Unique per chart. The engine generates `drw_*` ids for user-created drawings. */
  id: string;
  /** Tool type = `DrawingToolDefinition.type` = left-toolbar tool id, e.g. 'trend-line'. */
  type: string;
  points: DrawingPoint[];
  /** Full style: tool defaults merged with user edits at creation. Unknown keys are kept. */
  style: DrawingStyle;
  /** User text ('' = none); shown by tools with `text` support. */
  text: string;
  /** Cannot be moved or edited by pointer (still selectable and removable). */
  locked: boolean;
  /** Not drawn and not hit-testable. */
  hidden: boolean;
  /** Draw order within its pane; higher is on top. Ties keep insertion order. */
  zIndex: number;
  /** Per-interval visibility; null = all intervals. */
  visibility: DrawingIntervalVisibility | null;
  scope: DrawingScope;
  /** Symbol the drawing was made on (bucket key for scope 'symbol'). */
  symbol: string;
  /** Pane the drawing lives in. Drawings on a missing pane are kept but not drawn. */
  paneId: string;
}

/** `addDrawing` input: everything but `type`/`points` is optional (see `addDrawing`). */
export type DrawingInput = Pick<Drawing, 'type' | 'points'> &
  Partial<Omit<Drawing, 'type' | 'points' | 'style'>> & { style?: DrawingStyle };

/** `updateDrawing` patch. `style` is merged key by key; other fields are replaced.
 * `id` and `type` are ignored if present, so a full `Drawing` (undo) is a valid patch. */
export type DrawingPatch = Partial<Omit<Drawing, 'style'>> & { style?: DrawingStyle };

// ------------------------------------------------------------ geometry

export interface PixelPoint {
  x: number;
  y: number;
}

/** Display formatting for labels (price units of the drawing's pane). */
export interface DrawingFormat {
  price(v: number): string;
  /** "+1.25%" style. */
  percent(v: number): string;
  /** Crosshair-style date/time in the chart timezone. */
  time(t: number): string;
}

/**
 * Displayed bars (bricks on brick types): index = logical bar index. Read
 * [0, length) only; arrays may be longer and are replaced on reloads, so do
 * not keep references across calls.
 */
export interface DrawingBarData {
  readonly length: number;
  readonly time: ArrayLike<number>;
  readonly open: ArrayLike<number>;
  readonly high: ArrayLike<number>;
  readonly low: ArrayLike<number>;
  readonly close: ArrayLike<number>;
  readonly volume: ArrayLike<number>;
}

/**
 * A drawing mapped to its pane (CSS px, pane-local). Built by the framework
 * for every render and hit test; tools treat it as read-only. The `points`,
 * `logical` arrays and the object itself are reused between frames: do not
 * keep references across calls.
 */
export interface DrawingGeometry {
  readonly drawing: Readonly<Drawing>;
  /** One pixel point per anchor (x may lie outside the pane). NaN when unresolvable. */
  readonly points: readonly PixelPoint[];
  /** Fractional logical bar index per anchor (may be < 0 or past the last bar). */
  readonly logical: readonly number[];
  /** Pane size. */
  readonly width: number;
  readonly height: number;
  readonly barSpacing: number;
  /** Nominal seconds per bar of the chart interval. */
  readonly intervalSeconds: number;
  readonly format: DrawingFormat;
  /** Displayed bars (additive): e.g. volume of the measured range. Empty without data. */
  readonly bars: DrawingBarData;
  toPixel(p: DrawingPoint): PixelPoint;
  /** Pixel -> anchor, x snapped to the nearest bar slot. */
  toPoint(x: number, y: number): DrawingPoint;
  priceToY(price: number): number;
  yToPrice(y: number): number;
  logicalToX(logical: number): number;
  xToLogical(x: number): number;
}

/** Canvas and theme for `render`. `ctx` is in CSS px (dpr transform applied). */
export interface DrawingRenderContext {
  ctx: CanvasRenderingContext2D;
  dpr: number;
  theme: ChartTheme;
  /** Request another frame (additive), e.g. once an async image has decoded
   * (drawings/images.ts). Stable function: safe to keep as a callback. */
  invalidate(): void;
}

/** What a hit test found. Handles are hit-tested by the framework, tools return body/text. */
export type DrawingHitPart =
  /** `weak`: a background fill (fib zones, position zones). Weak hits lose to any
   * series line/bar/mark, but beat study fills (same rule as Phase 5 fills). */
  | { kind: 'body'; weak?: boolean }
  | { kind: 'text' }
  /** Index into the tool's `handles()` list. */
  | { kind: 'handle'; index: number };

export interface DrawingRenderState {
  selected: boolean;
  hovered: boolean;
  /** Being created (draft) or dragged. */
  editing: boolean;
}

/** Editing handle in pane pixels. */
export interface DrawingHandle extends PixelPoint {
  /** CSS cursor on hover (default 'pointer'). */
  cursor?: string;
}

export interface HandleMoveArgs<S extends DrawingStyle = DrawingStyle> {
  /** Anchors when the gesture started. */
  readonly start: readonly DrawingPoint[];
  /** Index into `handles()`. */
  readonly handle: number;
  /** Pointer as an anchor (snapped: bar slot, later magnet/Shift by the framework). */
  readonly target: DrawingPoint;
  /** Pointer in pane pixels (same snapping as `target`). */
  readonly x: number;
  readonly y: number;
  readonly geometry: DrawingGeometry;
  readonly style: S;
}

/** Price- or time-axis label (value = price, or unix time for the time axis). */
export interface DrawingAxisLabel {
  value: number;
  color: string;
  textColor?: string;
}

// ------------------------------------------------------------ tool definition

/** Left-toolbar group ids (apps/web/src/toolbar/tools.ts). */
export type DrawingToolGroup =
  'lines' | 'fib' | 'patterns' | 'forecasting' | 'shapes' | 'annotation' | 'measure';

export type DrawingCreation =
  /** One anchor: press places it, dragging adjusts it, release finishes. */
  | { kind: 'click' }
  /** `count` anchors, one per click; the next anchor follows the pointer. With
   * count 2, press-drag-release also works (release places anchor 2). */
  | { kind: 'points'; count: number }
  /** Press, drag (anchors sampled every few px), release. */
  | { kind: 'freehand' }
  /**
   * Additive. A variable number of anchors, one per click; the next anchor
   * follows the pointer. Finishes on double-click, Enter, reaching `max`, or a
   * click on the first anchor when `closable` and >= 3 anchors are placed (then
   * the last anchor is an exact copy of anchor 0: tools that draw closed shapes
   * detect it; otherwise that click just appends). Esc/right-click finish with
   * >= `min` anchors, else cancel. Anchors cannot be added or removed later.
   */
  | { kind: 'multi'; min: number; max?: number; closable?: boolean };

/** Anchor space (additive). 'chart' (default): time/price. 'pane': screen-anchored,
 * `time`/`price` hold the x/y fraction (0..1) of the pane; no bar snapping or magnet,
 * drags and nudges move in px, always visible, ignores paste `offset`/`at`. */
export type DrawingCoords = 'chart' | 'pane';

/** Properties dialog tab of a property ('style' by default). Coordinates and
 * Visibility tabs are generated from the anchors and `visibility`. */
export type DrawingPropertyTab = 'style' | 'text';

interface PropertyBase {
  /** Key in `Drawing.style`. */
  key: string;
  label: string;
  tab?: DrawingPropertyTab;
  /** Section title in the tab. */
  group?: string;
  /** Properties with the same `inline` id share a row. */
  inline?: string;
}

export type DrawingProperty =
  | (PropertyBase & { kind: 'color' })
  /** 1..4 px. */
  | (PropertyBase & { kind: 'lineWidth' })
  | (PropertyBase & { kind: 'lineStyle' })
  | (PropertyBase & { kind: 'bool' })
  | (PropertyBase & { kind: 'number'; min?: number; max?: number; step?: number })
  | (PropertyBase & { kind: 'enum'; options: readonly string[]; labels?: readonly string[] })
  | (PropertyBase & { kind: 'fontSize' })
  /** `DrawingLevel[]` (fib levels). */
  | (PropertyBase & { kind: 'levels' })
  /** Single-line text (additive). */
  | (PropertyBase & { kind: 'string'; maxLength?: number })
  /** Image as a data URL string, '' = none (additive). Decode with drawings/images.ts. */
  | (PropertyBase & { kind: 'image' });

/** One fib-style level. */
export type DrawingLevel = { value: number; color: string; visible: boolean };

/** Which coordinates of an anchor matter (Coordinates tab, body/handle drags). */
export type DrawingAxes = 'both' | 'price' | 'time';

export interface DrawingToolDefinition<S extends DrawingStyle = DrawingStyle> {
  /** Stable, persisted; equals the left-toolbar tool id. */
  type: string;
  name: string;
  group: DrawingToolGroup;
  creation: DrawingCreation;
  /** Complete default style; every key the tool reads must be here. */
  defaults: S;
  /** Style/Text tab fields, in dialog order. */
  properties: readonly DrawingProperty[];
  /** Text support: the Text tab shows an editor for `Drawing.text`. */
  text?: { default: string; multiline: boolean };
  /** Anchors whose time/price is ignored (horizontal line: 'price', vertical line: 'time').
   * Drags keep the ignored coordinate; the Coordinates tab hides it. Default 'both'. */
  axes?: DrawingAxes;
  /** Draw in pane pixels. Called only for drawings that pass `isVisible`. Must not
   * draw handles (the framework does) and should not allocate per call where avoidable. */
  render(rc: DrawingRenderContext, g: DrawingGeometry, style: S, state: DrawingRenderState): void;
  /** Body/text under (x, y) within `tol` px, or null. */
  hitTest(g: DrawingGeometry, style: S, x: number, y: number, tol: number): DrawingHitPart | null;
  /** Editing handles; default: one per anchor. May add derived handles
   * (rectangle edge midpoints, channel width) mapped back by `moveHandle`. */
  handles?(g: DrawingGeometry, style: S): DrawingHandle[];
  /** New anchors for a handle drag; default: handle i (< points.length) moves anchor i. */
  moveHandle?(args: HandleMoveArgs<S>): DrawingPoint[];
  /** Normalise or expand anchors when creation finishes (e.g. a one-click
   * Long position derives its target/stop anchors). Default: unchanged. */
  completePoints?(points: readonly DrawingPoint[], g: DrawingGeometry, style: S): DrawingPoint[];
  /** Price-axis labels. Default: each anchor's price while selected. */
  priceAxisLabels?(d: Readonly<Drawing>, style: S, state: DrawingRenderState): DrawingAxisLabel[];
  /** Time-axis labels. Default: each anchor's time while selected. */
  timeAxisLabels?(d: Readonly<Drawing>, style: S, state: DrawingRenderState): DrawingAxisLabel[];
  /** Culling. Default: the anchors' x span (plus 50 px) overlaps the pane. Tools
   * that extend beyond their anchors (rays, horizontal lines) must override. */
  isVisible?(g: DrawingGeometry, style: S): boolean;
  /** Shift while placing/dragging an anchor: 'angle' constrains the segment from
   * the other anchor to multiples of 45° (docs/drawings.md §7). Default 'angle'
   * for `{kind:'points', count: 2}` tools with `axes` 'both', else 'none'. */
  shiftConstraint?: 'angle' | 'none';
  /** Anchor space (additive), default 'chart'. See `DrawingCoords`. */
  coords?: DrawingCoords;
  /** Panes the tool can be created on (additive), default 'any'. 'main': tools
   * that read `g.bars` (price data); creation on study panes is refused. Such
   * tools must render nothing when `g.bars.length` is 0. */
  panes?: 'main' | 'any';
}

/** A definition with its style type erased (registry entries). */
export type AnyDrawingToolDefinition = DrawingToolDefinition<DrawingStyle>;

// ------------------------------------------------------------ chart API

export interface DrawingOptions {
  /** Keep the active tool after a drawing is finished. */
  stayInDrawingMode: boolean;
  /** No drawing can be moved or edited by pointer. */
  lockAll: boolean;
  /** No drawing is drawn or hit-testable. */
  hideAll: boolean;
}

export interface DrawingPointerEvent {
  id: string;
  part: DrawingHitPart;
  paneId: string;
  clientX: number;
  clientY: number;
}

export interface DrawingChange {
  before: Drawing;
  after: Drawing;
}

/**
 * Merged into ChartEvents. Only user gestures emit the mutation events
 * (`drawingCreated`, `drawingChanged`, `drawingsRemoved`); API calls never do,
 * so the app can apply undo/redo through the API without feedback loops.
 * Payloads are copies.
 */
export interface DrawingEvents {
  /** A user finished creating a drawing (it is already on the chart and selected). */
  drawingCreated: { drawing: Drawing };
  /** One per gesture (drag end, keyboard nudge, ...), never during a drag. */
  drawingChanged: { changes: DrawingChange[] };
  /** Removed by the user (Delete/Backspace, eraser). */
  drawingsRemoved: { drawings: Drawing[] };
  /** Any selection change, including ones caused by API calls. */
  selectionChanged: { ids: string[] };
  /** A drawing drag started/ended (e.g. hide the floating toolbar meanwhile). */
  drawingDrag: { ids: string[]; phase: 'start' | 'end' };
  /** Right-click on a drawing (it is selected first). Not followed by `contextMenu`. */
  drawingContextMenu: DrawingPointerEvent;
  /** Opens the properties dialog (or the text editor for part 'text'). */
  drawingDoubleClick: DrawingPointerEvent;
  /**
   * Creation ended: `drawingId` is the new drawing, or null when cancelled
   * (Esc, right-click). `active` = the tool is still active (stay in drawing
   * mode); otherwise the engine is back to the cursor (`getActiveTool()` null).
   */
  toolFinished: { type: string; drawingId: string | null; active: boolean };
  /** A click while the pick-point mode (`PICK_TOOL`) was active: bar time and price under the pointer. */
  pointPicked: { time: number; price: number; paneId: string };
}

/** Methods `Chart` implements for drawings. */
export interface DrawingApi {
  /** Start drawing with a registered tool; null = cursor. Cancels a draft
   * silently (no `toolFinished`). Throws for an unknown type. `opts.style`
   * (additive) is merged over the tool defaults of every drawing created until
   * the tool changes (sticker presets). */
  setActiveTool(type: string | null, opts?: DrawingToolOptions): void;
  getActiveTool(): string | null;
  setDrawingOptions(patch: Partial<DrawingOptions>): void;
  getDrawingOptions(): DrawingOptions;
  /**
   * Adds a drawing; returns the stored copy. Missing fields: id generated,
   * style = tool defaults + `style`, text = tool default, locked/hidden false,
   * zIndex = top, visibility null, scope 'symbol', symbol = current, paneId 'main'.
   * Throws for an unknown tool type or a duplicate id.
   */
  addDrawing(input: DrawingInput): Drawing;
  /** Unknown ids are ignored. */
  updateDrawing(id: string, patch: DrawingPatch): void;
  /** Replace a drawing wholesale by `d.id` (style keys missing from `d` are
   * dropped; `updateDrawing` merges them). No events. Unknown ids are ignored. */
  replaceDrawing(d: Drawing): void;
  /** Unknown ids are ignored. Selection drops removed ids. */
  removeDrawings(ids: readonly string[]): void;
  /** Copies, in draw order (pane order is not considered). */
  getDrawings(): Drawing[];
  getDrawing(id: string): Drawing | null;
  /** Replace everything (symbol switch, layout load). Cancels any gesture, clears
   * the selection. Drawings of unregistered types are kept but not drawn. */
  setDrawings(list: readonly Drawing[]): void;
  /** Replace the selection (`add`: extend it). Unknown ids are ignored. */
  selectDrawings(ids: readonly string[], opts?: { add?: boolean }): void;
  getSelection(): string[];
  /** Select every drawing shown on the current symbol and interval. */
  selectAllDrawings(): void;
  /** Clipboard JSON (`DrawingClipboard`) of `ids` in draw order. Unknown ids are ignored. */
  copyDrawings(ids: readonly string[]): string;
  /**
   * Paste `copyDrawings` JSON as a user gesture: copies get new ids, the top
   * zIndex and the current symbol (scope 'symbol'); they are selected and one
   * `drawingCreated` is emitted per drawing. Returns the pasted drawings.
   * Throws on malformed JSON; drawings of unknown tool types are skipped.
   */
  pasteDrawings(json: string, opts?: DrawingPasteOptions): Drawing[];
  /** Z-order within each drawing's pane. No events: the returned changes are
   * the app's undo entry ([] when nothing moved). */
  bringToFront(ids: readonly string[]): DrawingChange[];
  sendToBack(ids: readonly string[]): DrawingChange[];
  /** One step up/down past the next drawing of the same pane. */
  bringForward(ids: readonly string[]): DrawingChange[];
  sendBackward(ids: readonly string[]): DrawingChange[];
  /**
   * Box around the shown drawings `ids` (anchors and editing handles, padded by
   * the handle radius) in CSS px relative to the chart root element
   * (`chart.root`, top-left = 0,0); add `root.getBoundingClientRect()` for
   * viewport coordinates. Same mapping as rendering (bricks, future area); may
   * extend past the visible area. Null when none of `ids` is shown or mappable
   * (hidden, other symbol/interval, missing pane, no bars).
   */
  getDrawingBounds(ids: readonly string[]): DrawingBounds | null;
}

/** `setActiveTool` options (additive). */
export interface DrawingToolOptions {
  /** Preset style keys for drawings created with this tool. */
  style?: DrawingStyle;
}

/** `getDrawingBounds` result (chart-root CSS px). */
export interface DrawingBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `copyDrawings` output. */
export interface DrawingClipboard {
  version: 1;
  drawings: Drawing[];
}

export interface DrawingPasteOptions {
  /** Shift every anchor by whole bars (default 0). */
  offset?: number;
  /** Move the earliest anchor of the group to this time; the price delta applies
   * to drawings on the same pane as that anchor. Applied before `offset`. */
  at?: { time: number; price: number };
}
