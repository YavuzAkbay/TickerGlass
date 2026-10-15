# Drawings (Phase 6 design)

Contract for the drawing framework. Source of truth for types: `packages/engine/src/drawings/types.ts`
(exported from `@investopen/engine`). Change it only additively, and say so in the PR.

## 1. Model

A `Drawing` is plain JSON. The engine keeps it in memory but never persists it; the app does (§6).

```ts
interface Drawing {
  id: string; // 'drw_*' when created by the user
  type: string; // tool type = left-toolbar tool id ('trend-line')
  points: { time: number; price: number; brick?: number }[];
  style: Record<string, JsonValue>; // full style: tool defaults + user edits
  text: string; // '' = none
  locked: boolean; // no pointer move/edit (still selectable/removable via API)
  hidden: boolean;
  zIndex: number; // draw order within the pane, higher on top
  visibility: DrawingIntervalVisibility | null; // same shape as indicators' IntervalVisibility
  scope: 'symbol' | 'all'; // 'all' = synced across symbols
  symbol: string;
  paneId: string; // drawings on a missing pane are kept but not drawn
}
```

- `price` is in the pane's units (price on `main`, study values on study panes).
- Tools with `coords: 'pane'` (additive; screen-anchored text/notes) store `time`/`price` as the x/y fraction
  (0..1) of the pane instead: they ignore pan/zoom, bar snapping and the magnet, and are never culled.
- `style` keys are per tool; common names: `lineColor lineWidth lineStyle extendLeft extendRight textColor
fontSize bold italic`, `fillColor`, `levels` (`DrawingLevel[]`: `{ value, color, visible }`). The
  framework uses `lineColor` (fallback `#2962ff`) for handles and default axis labels.

## 2. Tool definition API

`defineDrawingTool({...})` (infers the style type from `defaults`), `registerDrawingTool`, `getDrawingTool`,
`listDrawingTools`. Built-ins register in `drawings/tools/index.ts`, imported by `chart.ts`.

| Field                                    | Meaning                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`, `name`, `group`                  | `group` = left-toolbar group id (`lines fib patterns forecasting shapes annotation measure`)                                                                                                                                                                                             |
| `creation`                               | `{kind:'click'}` one anchor · `{kind:'points',count}` click-click (count 2 also press-drag-release) · `{kind:'freehand'}` · `{kind:'multi',min,max?}` (additive) variable anchor count, see §4                                                                                           |
| `defaults`, `properties`                 | complete default style; Style/Text tab fields (`color lineWidth lineStyle bool number enum fontSize levels`, additive `string {maxLength?}` and `image` (data URL, `''` = none), `tab`, `group`, `inline`)                                                                               |
| `coords`                                 | additive, `'chart'` (default) / `'pane'`: anchors are pane fractions (§1); drags and nudges move in px, kept inside the pane; paste ignores `offset`/`at`; no default axis labels                                                                                                        |
| `panes`                                  | additive, `'any'` (default) / `'main'`: creation on study panes is refused (tools that read `g.bars`; they must render nothing when `g.bars.length` is 0)                                                                                                                                |
| `text`                                   | `{ default, multiline }`: the Text tab edits `Drawing.text`                                                                                                                                                                                                                              |
| `axes`                                   | `'price'` (horizontal line) / `'time'` (vertical line): drags keep the other coordinate; the Coordinates tab hides it                                                                                                                                                                    |
| `render(rc, g, style, state)`            | draw in pane CSS px (`rc.ctx` has the dpr transform; `ctx.save/restore` is done for you). Never draw handles. `rc.invalidate()` (additive) requests another frame, e.g. `drawingImage(src, rc.invalidate)` (`drawings/images.ts`, LRU decode cache, null until decoded or without a DOM) |
| `hitTest(g, style, x, y, tol)`           | `{kind:'body', weak?}` / `{kind:'text'}` / null. Add `lineWidth/2` to `tol` yourself                                                                                                                                                                                                     |
| `handles(g, style)` + `moveHandle(args)` | editing handles (default: anchors). Derived handles (rect edge midpoints, channel width) map back to anchors in `moveHandle`                                                                                                                                                             |
| `completePoints(points, g, style)`       | normalise/expand anchors when creation finishes (one-click Long position derives target/stop)                                                                                                                                                                                            |
| `priceAxisLabels` / `timeAxisLabels`     | default: each anchor while selected; return `[]` to suppress                                                                                                                                                                                                                             |
| `isVisible(g, style)`                    | culling; default `anchorsInView`. Tools drawing past their anchors (rays, extended lines, H/V lines) must override                                                                                                                                                                       |

`DrawingGeometry` (`g`): `points` (px per anchor), `logical` (fractional bar index per anchor), `width`,
`height`, `barSpacing`, `intervalSeconds`, `format` (`price percent time`), `bars` (additive:
`DrawingBarData` = the displayed bars, index = logical bar index, `{ length, time, open, high, low, close,
volume }`; empty without data; measure tools sum `volume` over the measured bars), and mappers `toPixel toPoint
priceToY yToPrice logicalToX xToLogical`. It is reused between frames: never keep references.
Hit testing has no canvas: `approxTextWidth(text, size, bold, italic)` measures with a shared offscreen
canvas in the font family of the last render (cached; 0.6 em per char only where no canvas exists, e.g.
tests), and `hitLabelSize(lines)` sizes info labels with the last rendered theme, so labels (Info line stats,
position target/stop/stats boxes) are strong body hits. Line tools cull with `segmentInView` (the possibly
extended segment clipped against the pane plus 50 px), not with the anchors' x span. Brush end handles
stretch the stroke (samples move by the handle offset scaled by path length from the fixed end). The
parallel channel's width is a pixel offset (`channelOffsetPx`), so it stays parallel on log scales.
Helpers for tools: `drawings/draw-utils.ts` (`setLineStyle extendSegment lineDistance infoLabel
formatDuration hitRotatedText anchorsInView BODY_HIT WEAK_BODY_HIT TEXT_HIT`) and `drawings/shape-utils.ts`
(additive: `polylineDistance pointInPolygon quadBezierPoint quadBezierDistance cubicBezierDistance
ellipseDistance circleThrough3 arcDistance rotate linearRegression strokePolyline tracePolyline`; canvas
angles, y down). Shared tool modules (`drawings/tools/`): `pitchfork-common` (pitchfork variants, pitchfan, rays to the pane
edge), `fan-common` (fan rays and bands, box grids), `fib-common` (price, time and arc levels), `gann-common`,
`pattern-common` (labelled zigzag patterns, Elliott degrees, ratio labels), `shape-common` (border/fill props,
filled polygons), `annotation-common` (wrapped text, bubbles, boxes), `volume-profile` / `vp-common`. Reference tools:
`tools/trend-line.ts` (2 points, extend, middle-point derived handle, text, stats label) and
`tools/horizontal-line.ts` (single click, `axes:'price'`, always-on price label).

## 3. Coordinate mapping and interval changes (`drawings/mapping.ts`)

Anchors are stored as times and mapped to logical bar indices on every frame; stored anchors change only
when the user edits the drawing. So a drawing survives interval changes, chart-type changes, history prepends
and reloads without migration. `timeToLogical(timeline, point)`:

- **Inside the data**: the bar containing `time` (`open <= time < open + interval`); a time in a gap (weekend,
  overnight, a daily midnight anchor on an intraday chart) maps to the next bar. Switching 1h -> 1D puts
  a Wed 16:30 anchor on Wednesday's bar; switching back puts it exactly where it was made.
- **Past the last bar**: `last + slots(endTime, time)` where `endTime` = newest raw bar. Slots come from the
  timeline's `calendar` (`AnchorTimeline.calendar`, additive; `buildTradingCalendar(time, n, interval, tz,
session?)`), in the exchange timezone: weekends are skipped unless the newest 2000 raw bars have weekend bars
  (crypto). Intraday slots cover the regular `symbolInfo.session` when known and extended hours are off;
  otherwise the typical day of those bars (modal first and last bar time of day, at least two full days
  matching it, else plain steps), so odd after-hours prints and partial days do not change it. The chart
  builds it once per load / history prepend, not per live bar, so future anchors keep their slots as bars
  arrive. Slot times lie on the bar grid from the day's first slot (intervals that do not divide a day, e.g.
  7m, restart the grid each day). A bar in a gap (an odd print) sits before the next day's first slot. A time
  in a non-trading gap maps to the next slot, like gaps inside the data. Round-the-clock intraday data, weekly
  and monthly intervals step plain intervals (months by calendar month). Exchange holidays are not known
  (they count as slots). Anchors created in the future area are whole slots.
- **Before the first bar**: extrapolated back from the first bar; resolves exactly once history loads.
- **Brick types** (Renko, Kagi, Line break, P&F, Range): the run of bricks at the last brick time `<= time`,
  offset by `brick` (position within bricks sharing a time). Up to `endTime` (newest raw bar) maps to the
  last brick; beyond extrapolates by the raw interval. Anchors from time charts land on the brick current
  at that time.
- `logicalToTime` is the inverse (rounds to a bar slot). Prices map through the pane's `PriceScale`, so
  log/percent/indexed/inverted scales just work; body drags move in pixels (shape kept on log scales).

## 4. Interaction state machine (`drawings/interaction.ts`)

The `InteractionController` forwards pointer/key events to `chart.drawingInput` first and pans/zooms only
when it declines. Coordinates are chart-root px; anchors snap to bar slots (`snap()`).

- **idle**: hover sets `layer.hovered` (handles shown on hover); press on a drawing selects it (keeps an
  existing multi-selection) -> `press`; press on empty space pans; a click (<= 3 px) on empty space clears
  the selection. Handles of unlocked drawings are hit before any stroke.
- **box select**: Shift + drag on empty chart space draws a marquee in that pane; on release every shown
  drawing of the pane whose extent (anchors and handles; full width for price-only tools such as horizontal
  lines, full height for time-only tools) meets the box is added to the selection (Shift semantics, like
  Shift-click). A Shift-click without drag keeps the selection; Esc cancels. Plain drag still pans.
- **touch**: `drawingInput.setPointerType(e.pointerType)` (called by the controller on every press/hover):
  with a finger the stroke tolerance is `TOUCH_HIT_TOLERANCE` (10 px instead of 4) and handles reach 8 px
  past their radius (2 px for mouse/pen).
- **press -> move** (body) or **handle** after 3 px: live preview mutates the model, `drawingDrag start`;
  on release one `drawingChanged` with all moved drawings (`before`/`after`), `drawingDrag end`. Locked
  drawings stay a press. Esc during a drag restores `before` (no change event).
- **create** (tool active, press in a pane): draft drawn on top, not in `getDrawings()`. `click`: release
  finishes. `points`: first release fixes anchor 2 only if it ended a drag, else anchor 2 follows the
  pointer until the next click; each click fixes one. `freehand`: samples every 3 px, release finishes
  (< 2 points cancels). `multi` (additive): like `points`, each click fixes one anchor; double-click (its
  second click's duplicate anchor is dropped), Enter, reaching `max`, or a click within handle reach of the
  first anchor (with >= 2 fixed; the last anchor is then an exact copy of anchor 0, so closed shapes can
  detect it) finish; double-click/Enter below `min` keep creating; Esc/right-click finish with >= `min`
  anchors, else cancel. Finish: `completePoints`, insert, `drawingCreated`, select, `toolFinished`; the
  tool is cleared unless `stayInDrawingMode`. Esc or right-click cancels (`toolFinished`, `drawingId: null`).
  `setActiveTool(type, { style })` (additive) merges `style` over the tool defaults of every drawing created
  until the tool changes (sticker presets).
- **modes** (additive, like the eraser; set with `setActiveTool`; Esc or `setActiveTool(null)` leaves them,
  `toolFinished {drawingId:null, active:false}` when one finishes): `ZOOM_TOOL` (`'zoom-in'`) drags a box in a
  pane, then returns to the cursor; it sets the visible logical range (`setVisibleLogicalRange`) and, on the boxed pane, a manual price range
  (`PriceScale.setManualRange`; the app host may implement `DrawingHost.zoomTo`); bar-spacing limits clamp it.
  `MEASURE_TOOL` (`'measure'`) shows a transient date-price-range (created like a two-point tool): it is
  never inserted, emits no drawing events, is not selectable or persisted, and clears on the next click or Esc. **Shift + click**
  on empty chart space starts the same quick measure (click, click; Shift + drag stays box select).
  `PICK_TOOL` (`'pick-point'`) emits `pointPicked {time, price, paneId}` for one click, then returns to the cursor; the
  toolbar's Anchored VWAP uses it to add the indicator anchored at that bar.
- **keys** (chart focused): Esc = cancel creation / drag / tool / selection, in that order; Delete and
  Backspace remove selected _unlocked_ drawings (`drawingsRemoved`). Handled keys are `preventDefault`ed,
  so app-level shortcuts skip them.
- **cursor**: `crosshair` with a tool, `pointer` over drawings, handle cursor (`ns-resize`, `move`), `grabbing`.
- **hit order** (`chart.hitTest`): drawings (handles, strong parts) > series lines/bars/marks > weak drawing
  parts (background fills) > study fills (Phase 5 rule). `HitTarget.drawing = { id, part, cursor }`;
  `ChartPoint.drawingId`.

## 5. Chart API, events and the undo contract

`DrawingApi` on `Chart`: `setActiveTool(type|null)`, `getActiveTool`, `setDrawingOptions({stayInDrawingMode,
lockAll, hideAll})`, `getDrawingOptions`, `addDrawing(input)` (fills id/defaults; throws on unknown type or
duplicate id), `updateDrawing(id, patch)` (style merged per key; `id`/`type` ignored, so a full `Drawing` is a
valid patch), `removeDrawings`, `getDrawings` (copies, draw order), `getDrawing`, `setDrawings` (bulk replace;
unknown types kept), `selectDrawings(ids, {add})`, `getSelection`. Magnet reuses `options.magnet`.

Editing API (B, exact signatures):

- `selectAllDrawings(): void` — selects every drawing shown on the current symbol/interval.
- `copyDrawings(ids: readonly string[]): string` — JSON `{ version: 1, drawings: Drawing[] }` (draw order).
- `pasteDrawings(json: string, opts?: { offset?: number; at?: { time: number; price: number } }): Drawing[]`
  — a user gesture: inserts copies with new ids on top, current symbol (scope `'symbol'`), selects them and
  emits one `drawingCreated` per drawing. `offset` shifts every anchor by whole bars (default 0); `at` moves
  the earliest anchor of the group to that time (+ price delta for drawings on the same pane as that anchor).
  Throws on malformed JSON; unknown tool types are skipped. A drawing whose `paneId` does not exist on this
  chart (a study pane) is pasted on `main`.
- `getAnchorTimeline(): AnchorTimeline` (additive) — the timeline drawings use (bricks, `endTime`,
  `calendar`). A new object per call, but `time` is the live column (no copy): read-only, valid while
  `chart.seriesRevision` is unchanged; call again rather than keeping it. With `timeToLogical`/`logicalToTime` it gives bar numbers that match the chart on every chart
  type (the Coordinates tab's Bar #).
- `setActiveTool(type|null, opts?: { style?: Record<string, JsonValue> })` (additive) — `style` is merged over the
  tool defaults of every drawing created until the tool changes. Unknown keys are kept (`icon` `glyph`).
- `setVisibleLogicalRange(from: number, to: number): void` (additive) — sets the time scale's visible range
  (bar indices, clamped by the bar-spacing limits); price scales are not touched. `TimeScale.setVisibleLogicalRange`
  returns whether the range changed; `PriceScale.setManualRange(min, max)` switches a scale to a fixed range.
- `ZOOM_TOOL`, `MEASURE_TOOL`, `PICK_TOOL` (exported constants): see §4 modes. Event `pointPicked {time, price,
paneId}` (additive); optional `DrawingHost.zoomTo(paneId, from, to, minPrice?, maxPrice?)` lets the host
  perform the zoom itself.
- `bringToFront(ids)`, `sendToBack(ids)`, `bringForward(ids)`, `sendBackward(ids)`: `(ids: readonly
string[]) => DrawingChange[]` — within each drawing's pane; no events (app edit), the returned changes are
  the app's undo entry (`[]` = nothing moved).
- `setActiveTool(ERASER_TOOL)` (`'eraser'`, exported constant): eraser mode. Press/drag over drawings removes
  every unlocked drawing touched; one `drawingsRemoved` per gesture. Stays active until Esc /
  `setActiveTool(null)` (Esc emits `toolFinished {type:'eraser', drawingId:null, active:false}`).
- `replaceDrawing(d: Drawing): void` (additive) — replaces the drawing with id `d.id` wholesale: style keys
  missing from `d` are dropped (`updateDrawing` merges them, so removed keys would never leave the engine).
  No events; unknown ids ignored; an ongoing drag of it is cancelled. The app's store sync and the settings
  dialog preview use it.
- `getDrawingBounds(ids: readonly string[]): DrawingBounds | null` (additive) — `{ left, top, right, bottom }`
  around the shown drawings' anchors and editing handles (padded by the handle radius), in CSS px relative to
  the chart root element `chart.root` (add `root.getBoundingClientRect()` for viewport px). Same mapping as
  rendering (brick charts, the future area); may extend past the visible area. `null` when none of `ids` is
  shown/mappable. The app positions the floating mini-toolbar with it (no engine internals).
- Pointer cancel (`pointercancel` / `lostpointercapture` during a gesture) aborts it like Esc: a drag is
  restored, a creation dropped, no events; a pan just stops.
- Keys (chart focused, selection, no gesture): ArrowLeft/Right move the selection one bar, ArrowUp/Down
  one px (Shift: 10 bars / 10 px) -> one `drawingChanged` per key press.

Events (`DrawingEvents`, copies): `drawingCreated {drawing}`, `drawingChanged {changes:[{before,after}]}`,
`drawingsRemoved {drawings}`, `selectionChanged {ids}`, `drawingDrag {ids, phase}`, `drawingContextMenu`,
`drawingDoubleClick` (`{id, part, paneId, clientX, clientY}`; a drawing right-click does not emit
`contextMenu`), `toolFinished {type, drawingId|null, active}`.

**Undo is app-owned.** Only user gestures emit mutation events; API calls never do (selection changes always
emit). The app records each event as one command-bus/`useHistory` entry: created -> undo `removeDrawings([id])`,
redo `addDrawing(drawing)`; changed -> undo `updateDrawing(before.id, before)` for each change, redo with
`after`; removed -> undo `addDrawing` each, redo `removeDrawings`. App edits (properties dialog, toolbar,
z-order, lock) go through commands that call the API and push their own entry. The engine has no history.

## 6. Persistence

The web store keeps `{ bySymbol: { [symbol]: Drawing[] }, synced: Drawing[] }` buckets; scope `'all'`
drawings live in `synced`. Symbols are upper case (the app normalizes like `Chart.setSymbol`). On symbol
change: `setDrawings([...bySymbol[sym], ...synced])`; afterwards only store objects that changed are
reconciled (`replaceDrawing`).

Server (Phase 7, `docs/persistence.md`): drawings are stored **globally, one row per drawing** (table
`drawings`: `id` = `Drawing.id`, `symbol` upper case or **null for synced** (`scope: 'all'`), `pane_id`, `z`,
`data` = the whole `Drawing` JSON, `schema_version`, `revision`). They are not keyed by layout (per-layout
drawings are deferred). The server derives `symbol`/`pane_id`/`z` from `data`, which maps 1:1 onto the store's
`apply(upserts, removeIds)`: the client diffs the store against the last saved state and sends a debounced
`POST /drawings/batch` (`upserts` with `baseRevision`, `deletes`; a revision mismatch returns per-id
conflicts). `GET /drawings?symbol=` returns that symbol's drawings plus the synced ones. localStorage
`investopen-drawings` (`{ version: 1, bySymbol, synced }`, backup-on-unreadable and cross-tab merge rules)
stays as the offline cache and is imported into `drawings` on first run (migration plan:
`docs/persistence.md` §6). Drawing templates (per-tool named styles)
live in `drawing_templates` (at most one default per tool).

"Sync new drawings" (left toolbar toggle, `useUiStore.syncNewDrawings`, persisted UI pref): drawings created
with a tool start with `scope: 'all'` (applied in the `drawingCreated` handler via `replaceDrawing`, inside
the same undo step). Clones and pastes keep their source's scope.

The engine also filters by scope/symbol (B), so a stale list never shows another symbol's drawings.

## 7. Magnet and Shift constraints (B)

Implemented in `DrawingInteraction.snap()` and applied to creation and handle drags (not to body drags):

- Magnet `options.magnet`: `weak` snaps y to the nearest O/H/L/C of the bar under the pointer within 20 px
  (the crosshair rule); `strong` always snaps to the nearest OHLC. Holding Ctrl/Cmd (`mods.mod`) inverts
  off <-> weak while drawing. Main pane only (study panes: nearest series value, as `magnetY`).
- Shift while placing/dragging an anchor of a 2-point line: constrain the segment from the other anchor
  to multiples of 45° in pixel space (horizontal, vertical, diagonal); Shift on body drag locks to the
  dominant axis. Tools opt in/out with `shiftConstraint: 'angle' | 'none'` (default `'angle'` for
  `{kind:'points', count:2}` tools with `axes` `'both'`, else `'none'`); with `'angle'`, creation constrains
  the floating anchor against the previous one, handle drags of anchor i against anchor 1 (i = 0) or i - 1.
  Freehand tools get neither magnet nor Shift.
- Shift-click on a drawing toggles it in the selection (deselect happens on release if no drag followed);
  Alt+drag on a selected/pressed unlocked drawing clones the pressed selection: clones are inserted and
  dragged, originals stay unchanged, one `drawingCreated` per clone at gesture end (Esc removes them,
  no events).

## 7b. Shown drawings (B)

`DrawingLayer.isShown(d)`: not `hidden`, not `hideAll`, `scope === 'all' || symbol === chart symbol`, and
`visibility` matches the chart interval (same rule as the app's `visibleOnInterval`: "60m" counts as 1h).
Not-shown drawings are neither drawn, hit, dragged, nudged, selected by `selectAllDrawings` nor erased. Hiding
a drawing (API `hidden: true` or `hideAll`) drops it from the selection.

## 7c. Phase 11 tools (86 types)

Types = toolbar ids (`tools/index.ts` registers them in toolbar order). Added on top of the 20 core tools:

- **Lines**: `trend-angle` (angle arc and label), `regression-trend` (close regression, +-k stdev bands, Pearson r),
  `flat-top-bottom` (3 anchors), `disjoint-channel` (3 clicks, `completePoints` derives the 4th anchor)
- **Pitchforks**: `pitchfork`, `schiff-pitchfork`, `modified-schiff-pitchfork`, `inside-pitchfork`, `pitchfan`
- **Fib**: `fib-channel`, `fib-time-zone`, `fib-speed-fan`, `fib-trend-time`, `fib-circles`, `fib-spiral`,
  `fib-speed-arcs`, `fib-wedge`
- **Gann**: `gann-box`, `gann-square-fixed`, `gann-square`, `gann-fan`
- **Patterns**: `xabcd`, `cypher`, `head-shoulders`, `abcd`, `triangle-pattern`, `three-drives`; Elliott
  `elliott-impulse`, `elliott-correction`, `elliott-triangle`, `elliott-double-combo`, `elliott-triple-combo`;
  cycles `cyclic-lines`, `time-cycles`, `sine-line`
- **Forecasting / volume** (`panes: 'main'`): `forecast`, `bars-pattern`, `ghost-feed` (multi), `projection`,
  `fixed-range-vp`, `anchored-vp`
- **Shapes**: `highlighter` (freehand), `arrow-marker`, `arrow-mark-up`, `arrow-mark-down`, `rotated-rectangle`,
  `path` and `polyline` (multi), `circle`, `ellipse`, `triangle`, `arc`, `curve`, `double-curve`
- **Annotations**: `anchored-text`, `anchored-note` (`coords: 'pane'`), `note` (pin, hover tooltip), `callout`,
  `comment`, `price-label`, `price-note`, `signpost`, `flag-mark`, `table` (rows by newline, cells by tab or `|`),
  `image` (data URL only), `icon` (stickers: the web maps `emoji-*`, `sticker-*`, `icon-*` ids to it with a `glyph`)
- **Modes**: `zoom-in`, `measure`, `pick-point` (Anchored VWAP); see §4.

Pixel-space tools: circle/arc radii, fib circles, spiral and speed arcs, wedge, Gann and time-cycle arcs,
trend-angle, projection, channel widths and curve bows are computed in screen px, so their shape changes with zoom
(by convention). Flat top/bottom and Disjoint channel are alert channel sources (`docs/alerts.md` §2.6).

Semantics we could not verify against reference (documented choices, revisit in the Phase 15 parity sweep):

- Inside pitchfork: handle = midpoint(p1, p2) -> p3; the median is parallel to the line from midpoint(p2, p3).
- Fib circles: centre = midpoint of the two anchors (level 1 has the anchors as diameter). Fib speed arcs:
  centre p0, half circle on p1's side (`fullCircles` option).
- Gann square fixed: the price/bar ratio is carried by the anchors (`completePoints` squares it on screen, drags keep
  |dprice|/|dbars|). Square arcs are quarter ellipses with radii .25..1; cycles repeat only in p1's direction.
- Volume profile: each bar's volume is spread evenly over [low, high], up/down by close >= open. POC ties: nearest
  the middle of the range, then lower. Value area: from the POC add the larger of the next two rows above or below
  (ties above); it may overshoot the target by one pair. Row size is in price units, not ticks.
- Cypher and Three drives ratio sets, Gann default colors, arc = ends + through-point, curve = auto midpoint.

## 8. Work split (follow-up agents)

| Agent        | Owns (create/modify)                                                                                                                                                            | Must not touch                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **A** tools  | `packages/engine/src/drawings/tools/**` (one file per tool, registered in `tools/index.ts` in toolbar order), additive helpers in `draw-utils.ts`, tool tests `tools/*.test.ts` | `types.ts` (request additive changes), layer/interaction, chart, apps/web |
| **B** engine | rest of `packages/engine/**`: `layer.ts`, `interaction.ts`, `geometry.ts`, `mapping.ts`, `chart.ts`, `interaction/controller.ts`, engine tests; `types.ts` additive only        | `drawings/tools/**`, apps/web                                             |
| **C** web    | `apps/web/**` + `e2e/**`                                                                                                                                                        | packages/**                                                               |

**A**: Ray, Extended line, Info line, Horizontal ray, Vertical line, Cross line, Parallel channel, Fib
retracement, Trend-based fib extension, Rectangle, Text, Arrow, Brush, Long/Short position, Price range,
Date range, Date & price range. Types = toolbar ids: `ray extended-line info-line horizontal-ray
vertical-line cross-line parallel-channel fib-retracement fib-extension rectangle text arrow-line brush
long-position short-position price-range date-range date-price-range`. Shape interiors you can grab
(rectangle) are strong hits; decorative zones (fib backgrounds, position zones) are `WEAK_BODY_HIT`.
Text tool: `click` creation; C opens the text editor on `drawingCreated` when `text` is empty.

**B**: multi-select (Shift-click toggles in `pointerDown`; optional box select), clone (Alt+drag: copy the
pressed selection, emit `drawingCreated` per clone and drag the clones), copy/paste API
(`copyDrawings(ids)` -> JSON, `pasteDrawings(json, {offset})`, pasted = user gesture -> `drawingCreated`),
z-order API (`bringToFront/sendToBack/bringForward/sendBackward` returning `DrawingChange[]` for the app's undo),
magnet + Shift (§7), per-interval `visibility` and scope/symbol filtering in `DrawingLayer.isShown`, eraser
mode (`setActiveTool('eraser')`-style: click removes -> `drawingsRemoved`), keyboard nudge (arrows move the
selection one bar/px -> one `drawingChanged`), lock/hide-all polish, perf (100 drawings at 60 fps while
panning; geometry cache), touch (bigger tolerance). Already in core: per-drawing `locked/hidden`, `lockAll`,
`hideAll`, `stayInDrawingMode`, multi-drag of an existing multi-selection.

**C**: drawing store (`apps/web/src/drawings/`) + localStorage (§6) + sync to the engine; command-bus
undo/redo (§5); wire the left toolbar (`activeTool` -> `setActiveTool` for registered types, `null` for
cursors; `toolFinished` -> back to cursor unless `active`; magnet/stay/lock/hide/remove-all ->
`applyOptions`/`setDrawingOptions`/`removeDrawings`; hide mode 'drawings'/'all' -> `hideAll`); floating
mini-toolbar on `selectionChanged` (color, width, style, settings, lock, delete; hidden during
`drawingDrag`); context menus for drawings (settings, clone, copy, z-order, visibility, lock, hide, remove,
template) and the chart/scale/pane entries per roadmap; properties dialog generated from `properties`
(Style/Text tabs) + Coordinates (anchors, honour `axes`) + Visibility (reuse the indicator visibility
editor) with per-tool templates (Save as / Apply default); object tree (list per pane, reorder via
`zIndex`, hide/lock/delete); drop drawings of panes listed in `paneRemoved` with the studies' undo step; e2e:
draw, drag, undo, reload persistence. Until B lands, C develops against the core (no multi-select/clone).
