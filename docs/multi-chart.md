# Multi-chart layouts (Phase 14)

A layout shows 1 to 16 charts in a grid. Every chart has its own symbol, interval, indicators, compares and undo
history; optional sync flags mirror symbol, interval, crosshair, time position, date range and drawings between
them. One chart is active: the toolbar, command bar, dock panels and shortcuts act on it.

Code:

- `apps/web/src/chart/session.ts`, `facade.ts`: `ChartSession` and the active-chart facades.
- `apps/web/src/layout/`: `grid.ts` (tree model), `templates.ts`, `splitter.ts`, `geometry.ts`, `store.ts`,
  `actions.ts`, `focus.ts`, `sync.ts` (`SyncBus`), `ChartGrid.tsx`, `ChartCell.tsx`, `SplitHandle.tsx`, `commands.ts`.
- `apps/web/src/persist/layoutState.ts`: schema v5 (`docs/persistence.md` §5).
- `packages/engine/src/sync/time-map.ts`: `mapSyncTime`. `packages/engine/src/feed/coalescing-feed.ts`.
- Engine additions to `Chart`: `setSyncedCrosshair`, `getVisibleTimeRange`, `setRightEdgeTime`, and the
  `viewChange` event (`cause: 'user' | 'api' | 'data'`).

Limitations and their status: [LIMITATIONS.md](LIMITATIONS.md#app--ui).

## 1. Model: sessions and facades

Each chart is a `ChartSession`: the engine chart plus its own zustand stores (view = symbol, interval, chart type,
style and timezone; indicators and preview; compares; history; chart info; drawing runtime). The sessions live in
`useChartStore.sessions`; `activeId` says which one is focused and `getChart()` returns the active chart.

Code that existed before multi-chart reads global stores (`useIndicatorStore`, `useCompareStore`, `useHistory`,
`useChartView`, about 50 call sites). These exports are now **facades** (`createActiveFacade`): bound stores with the
same API that delegate to the active session, rebind when the active chart changes and notify once. UI call
sites did not change. Controllers (`attach*`, `controller.ts`) never use a facade: they get their session's own stores
explicitly, because they must keep serving their chart while another one is focused. ESLint
(`no-restricted-imports` on `**/attach.ts`, `**/controller.ts` and `chart/**`) enforces this. Callbacks that
originate from a chart that may not be focused run inside `runInSession(id, fn)`, so their store writes and undo
steps land on that chart.

Focus follows `pointerdown` (capture phase) in a cell; `layout.chart.next` / `layout.chart.prev` (Alt+] / Alt+[)
cycle it. The active cell gets an accent outline (theme token) when more than one chart is shown. Screenshots
capture the active chart only.

## 2. Grid and templates

The layout stores a resolved tree (`GridNode`): leaves hold chart ids, splits hold a direction (`row` places children
side by side, `col` stacks them), child `sizes` (fractions summing to exactly 1) and an `aligned` flag. Directions
alternate with depth (the normaliser enforces it on parse). The template id is only the label in the picker.

Templates (`layout/templates.ts`), named `Nc` (N columns), `Nr` (N rows), `AxB` (A columns by B rows), `A+B`
(a row of A above a row of B), `1L+N` (one large chart left, N right), `2+1B` (two above one):

`1, 2c, 2r, 3c, 3r, 1L+2, 2+1B, 2x2, 4c, 1L+3, 3+2, 1L+4, 3x2, 2x3, 4+3, 4x2, 2x4, 3x3, 5x2, 4x3, 3x4, 4x4`

Why: they cover every count from 1 to 16 with landscape cells (charts need width), include focus layouts (one
main chart with context charts beside it) and the uniform grids people expect. Any other count (up to 16) gets
generated balanced rows: `rows = ceil(sqrt(n))` with the charts spread so rows differ by at most one (11 is
4, 4, 3; 13 is 5, 4, 4; 14 is 5, 5, 4; 15 is 5, 5, 5). Uniform grids are `aligned`.

Changing the template keeps existing charts in leaf order. Extra leaves get new charts that copy the active chart's
symbol, interval and settings, without indicators. Charts that no longer fit are removed after a confirmation.
"Open in new chart" in the watchlist adds one chart (the template for n + 1) with the symbol; it is disabled at 16.

## 3. Splitters

Pure numerics in `layout/splitter.ts`. A cell is at least 180 x 120 px; a splitter is 4 px wide with an 8 px hit area.

- `minExtent(node, axis)`: along the node's own direction it is the sum of the children's minimums plus the splitters
  between them; across it, the largest child minimum; a leaf is the cell minimum.
- `dragSplitter(sizes, k, dxPx, lenPx, mins)`: moves boundary k by `dxPx / lenPx`. Only the two neighbours change,
  each clamped to its minimum, and the last size absorbs rounding so the sum is exactly 1. If the two cannot both fit
  their minimums the sizes are unchanged.
- Minimums apply while dragging only. When the window is too small to honour them, rendering shrinks all cells
  proportionally instead of overflowing.
- Aligned (uniform) grids: dragging a column splitter in one row applies the same fractions to sibling rows with the
  same child count, so columns stay lined up. Other templates size each split independently.
- Double-click equalises the split (aligned siblings follow).

## 4. Sync

Flags (`SyncFlags`, saved with the layout; defaults: crosshair and drawings on, the rest off). `SyncBus`
(`layout/sync.ts`) is the only place that mirrors state between charts; it reacts to entry points, and everything it
writes uses a cause it ignores, so there are no echo loops.

- **Symbol / interval**: with the flag on, the change is written to every chart's view; off, to the active chart only.
- **Crosshair**: on `crosshairMove` the other charts get `setSyncedCrosshair` (it emits no event). The price line is
  drawn only when the symbols are equal; otherwise only the vertical line. `null` clears. At most one broadcast per
  animation frame. The mirrored crosshair is drawn from a stored logical index and recomputed on view changes.
- **Time**: only `viewChange` with cause `'user'` (drag, wheel zoom) is broadcast; targets call `setRightEdgeTime`
  (cause `'api'`, loads history if needed) and keep their own bar spacing.
- **Date range**: at command level. Range presets, Go to date and Show all history call `bus.range` / `bus.goTo`;
  with the flag on every chart shows the same time range. The preset's interval applies to the source chart only.
- **Drawings**: new drawings are unbound (all charts of the symbol) when on; bound to the active chart when off
  (`docs/drawings.md` §6).

### Time mapping

`mapSyncTime(src: SyncTimeRef, dst: AnchorTimeline, dstTimezone)` returns the logical bar index on the target chart
for a source bar (`NaN` when the target has no bars). `SyncTimeRef` is the bar's open time, the source interval and
its exchange timezone. Rules:

1. Both intervals daily or longer: match by calendar date, each side in its own exchange timezone (the compare
   alignment keys), so a Tokyo and a New York daily bar of one date line up. Otherwise match by instant.
2. Target interval >= source interval: the target bar containing the time (the last bar opening at or before it; a
   weekend maps to Friday).
3. Target interval < source interval: the first target bar opening at or after the time, if it opens before the source
   bar ends; otherwise rule 2.
4. Outside the loaded bars: extrapolate with `timeToLogical` (calendar-aware into the future, plain interval steps into
   the past), then snap to a whole slot by rules 2 and 3.

Brick charts have no fixed time per slot: they take the first brick at or before the instant.

## 5. Request budget

All charts share one feed: `ExpressionFeed(ResamplingFeed(CoalescingFeed(HttpDataFeed)))` under the replay layer.
`CoalescingFeed` joins identical in-flight `getBars` calls and reuses the last result for 10 s (key: symbol,
interval, limit, `to`, adjusted, extended hours; 64 entries, least recently used dropped; failures are not kept). Opening a
16-chart layout of one symbol and interval therefore sends one `/api/bars` request, and `HttpDataFeed` already
reference-counts `/ws` subscriptions per symbol and interval. Results are shared by reference and must be treated as
read-only. Indicator workers are not shared: there is one per chart.

## 6. Replay

One replay clock per layout; the chart active at the start is the replay chart and the others are clipped by the
same feed (`docs/replay.md` §3).

## 7. Tests

`apps/web/src/layout/*.test.ts` (grid, templates, splitter, geometry, focus, sync bus), `packages/engine`
(`sync/time-map`, `feed/coalescing-feed`), `apps/web/src/replay/controller.test.ts`; e2e: `e2e/multichart.spec.ts`
(including the request count of a 4-chart layout) and the two-chart case in `e2e/replay.spec.ts`.
