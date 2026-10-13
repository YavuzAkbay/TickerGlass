# Indicators (Phase 5 design)

Contract for the indicator framework. Source of truth for types:
`packages/indicators/src/types.ts` (definitions, runtime) and
`packages/engine/src/studies/types.ts` (display). Change either only additively, and say so in the PR.

## 1. Definition API (`@investopen/indicators`)

An indicator is a declarative object built with `defineIndicator` (it infers literal input keys and output
ids, so `step` is fully typed) and registered with `registerIndicator` / looked up with `getIndicator`,
`listIndicators`. Built-ins register themselves in `src/builtins/index.ts`.

```ts
export const SMA = defineIndicator({
  id: 'sma',
  name: 'Moving Average Simple',
  shortName: 'SMA',
  category: 'movingAverage',
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'ma',
      title: 'MA',
      kind: 'line',
      color: '#2962ff',
      offset: (i) => i.offset,
    },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    return (c) => c.set('ma', ma.update(c.src.source[c.i]!));
  },
});
```

- **Metadata**: `id` (stable, persisted), `name`, `shortName` (legend), `category`, `keywords`, `overlay`
  (price pane vs new pane), `format` (`inherit|price|volume|percent`), `precision`, `scaleRange` (e.g. RSI 0–100).
- **Inputs** (`kind`): `int`, `float` (min/max/step), `bool`, `source`, `color`, `enum` (options, labels),
  `timeframe`, `time` (unix s, for Anchored VWAP; 0 = unset). Common: `label`, `default`, `group`, `inline`,
  `tooltip`, `hideInTitle`. Key order = dialog order. `resolveInputs` fills defaults and clamps numbers.
- **Source values**: `open high low close volume hl2 hlc3 ohlc4 hlcc4`, or `{ instanceId, outputId }`.
- **Outputs** (array order = draw order): `plot` (kinds line/step/histogram/area/columns/circles/cross,
  `lineWidth`, `lineStyle`, `base`, `offset`, `showLastValue`), `hline` (`value` may be a function of inputs),
  `fill` (`between` two plots/hlines), `bgcolor`, `shape` (shape, location aboveBar/belowBar/absolute/top/bottom,
  size, static `text`); shapes and bgcolor take an `offset` like plots (additive; aboveBar/belowBar anchor to
  the bar at the drawn position). `color` is a string or a palette; with a palette the step picks an index per
  bar (`c.set(id, v, k)` / `c.setColor(id, k)`), e.g. MACD histogram, Supertrend, Ichimoku cloud. Index
  `NO_COLOR` (255, = engine `STUDY_COLOR_NONE`) means "no colour" for that bar (standard `na` colour: the line
  segment ending there, the bar, mark, fill segment or background is not drawn); any other out-of-range index
  uses entry 0.
- `resolveOutputs(def, inputs, overrides)` produces concrete `ResolvedOutput[]` (defaults + user style
  overrides + input-derived hline values and offsets). It is structurally the engine's `StudyOutputMeta`;
  `apps/web/src/indicators/contract.ts` fails typecheck if they drift.

## 2. Compute model and incremental semantics

`setup` runs once per full computation and returns `step(c)`, called for bars `0..n-1` in order with one
reused context: `c.i`, OHLCV arrays, `c.src.<sourceInput>`, `c.inputs`, `c.env`, `c.set`, `c.setColor`,
`c.get(id, j<i)` (own earlier outputs). `env` (also in `setup`'s context, additive) is the host's `BarsEnv`:
`timezone` (IANA exchange zone, `'UTC'` when unknown), `session` (`"HHMM-HHMM"` or null) and
`intervalSeconds` (0 = unknown; timeframe instances get their timeframe's seconds). Period-anchored
indicators use `calendarPeriod(time, unit, tz, session)` (`session|week|month|quarter|year|decade|century`;
`session` = exchange calendar day, or the trading day of a session that wraps midnight, e.g. futures
18:00-17:00; weeks start Monday). VWAP: anchors Session/Week/Month/Quarter/Year/Decade/Century in the
exchange timezone and "Hide VWAP on 1D or Above" (`env.intervalSeconds >= 1D`). OBV: reference "Smoothing" (None,
SMA, SMA + Bollinger Bands, EMA, SMMA (RMA), WMA, VWMA; length, BB StdDev). Unset outputs are NaN for the bar. All running state lives in `ta` primitives created in
`setup` (`sma ema rma sum stdev highest lowest history vars series`); creating one inside `step` is an error.

Why per-bar: full compute and live update are the same code, so they cannot diverge; recursive indicators
(SAR, Supertrend) are natural; a tick costs O(1) per indicator. Conventions (standard/TA-Lib): warm-up is NaN,
`ema`/`rma` seed with the SMA of the first `length` values, `stdev` is population. NaN inputs: leading NaNs are
skipped (warm-up starts at the first value), later NaNs return NaN without changing state.

`IndicatorInstance` (one indicator on one `BarStore`):

- `computeAll(bars)`: new `setup`, step all bars; snapshot (`save`) all primitives right before the last bar.
- `computeLast(bars, 'update')`: `restore` the snapshot, re-run bar n-1 (live tick, exact).
- `computeLast(bars, 'append')`: `save`, then step the new bar n-1. Count mismatch falls back to `computeAll`.
- An exception in `setup`/`step` sets `status = { state: 'error', message }` and all outputs NaN.

`IndicatorRuntime` (all instances of one chart; pure, no DOM; also used by the alerts service):
`add(spec)`, `setInputs(id, inputs)`, `remove(id)`, `setBars(cols)`, `updateBar(index, bar)`, `clearData()`,
`requiredTimeframes()`, `setTimeframeBars(tf, cols)`, `updateTimeframeBar(tf, bar)`, `setResolveTimeframe(fn)`,
`setContext({ timezone?, session?, intervalSeconds?, timeframeSeconds? })` (additive; also
`RuntimeOptions.context`; recomputes only instances whose env changed), `result(id)`, `status(id)`, `ids()`. Mutators return `Change[] = { id, from }` (outputs changed for chart
indices `>= from`). `updateBar` is **index based** (brick bars can share a time): `index = length-1` updates,
`index = length` appends, anything else throws `RangeError` and the host must call `setBars`.
`IndicatorResult` arrays may be longer than `length` and may be reallocated by the next call.

## 3. Indicator-on-indicator

A `source` input set to `{ instanceId, outputId }` reads that instance's chart-aligned values (unshifted:
plot `offset` is display only). The runtime keeps a topological order; `add`/`setInputs` throw on a cycle
(state unchanged). If upstream changed only at the last bar, dependents run `computeLast`; if it changed
earlier, dependents recompute fully. Removing an upstream puts dependents in the error state (the app offers to
remove them). The engine places the dependent on the source study's pane by default (`target: { paneId }`).

## 4. Multi-timeframe inputs

A definition may declare one `timeframe` input; its value is the resolution of the **whole** indicator
(the common indicator "Timeframe"). `''` = chart. The host's `resolveTimeframe(tf)` maps `'auto'` (Pivot Points:
intraday -> 1D, 1D -> 1W, above -> 12M) and returns `''` when tf equals or is below the chart interval.

1. The instance reports `waiting` and its tf appears in `requiredTimeframes()`.
2. The host fetches that series with the chart's `DataFeed` (`getBars` for the chart's time span plus the
   indicator's warm-up, `subscribe` for live) and calls `setTimeframeBars` / `updateTimeframeBar`.
3. The indicator runs on the timeframe bars; chart bar j takes the value of timeframe bar
   k = last bar with `time <= chartTime[j]` (the bar containing it). Plots and fill colours fill every chart
   bar of k; shapes and bgcolor mark only the first one. A live timeframe tick re-aligns all chart bars of the
   last timeframe bar (`Change.from` = its first chart bar). Historical values are final timeframe values.
   This is lookahead: on history, every chart bar inside a timeframe bar shows that bar's _closing_ value
   (e.g. a daily chart bar on Monday already shows the week's final value), while on the live edge the value
   moves until the timeframe bar closes. Backtests or alert replays over history therefore see values that
   were not knowable at the time; alerts evaluated live only fire on what was known.
   **Confirmed alignment** (reference "Wait for timeframe closes"): a definition names a `bool` input in
   `TimeframeInputDef.waitForCloseInput` (conventionally default true). When it is on, chart bars inside
   timeframe bar k show bar k-1 (the last closed one), on history and live alike: no lookahead, no repainting,
   at the cost of one timeframe bar of lag; alerts on such values behave the same in replay and live. Pivot
   Points need neither (their bar k already holds levels of k-1). A live tick re-aligns and propagates only
   the chart bars whose aligned values actually changed, so ticks of a forming bar under confirmed alignment
   (or Pivot Points) do not recompute dependents.
4. A timeframe instance may only use price sources (no indicator-on-indicator across timeframes).

## 5. Worker protocol (apps/web)

One worker per chart owns one `IndicatorRuntime` (definitions imported in the worker; the main thread imports
the same package for metadata, dialogs and `resolveOutputs`). Bars come from `chart.store` (displayed series).

```ts
type ToWorker =
  | { type: 'timeframeMap'; map: Record<string, string> } // raw tf value -> resolved ('' = chart)
  | { type: 'context'; context: RuntimeContext } // exchange tz/session, interval seconds (additive)
  | { type: 'add'; spec: InstanceSpec }
  | { type: 'setInputs'; id: string; inputs: InputValueMap }
  | { type: 'remove'; id: string }
  | { type: 'bars'; revision: number; bars: BarColumns } // 'reset'/'prepend', resync (transfer copies)
  | { type: 'bar'; revision: number; index: number; bar: Bar } // 'update' / 'append'
  | { type: 'tfBars'; tf: string; bars: BarColumns }
  | { type: 'tfBar'; tf: string; bar: Bar }
  | { type: 'clear' }; // symbol change
type ResultChange = {
  id: string;
  from: number;
  status: InstanceStatus;
  values: Record<string, Float64Array>; // slices [from, length)
  colors: Record<string, Uint8Array>;
};
type FromWorker =
  | { type: 'results'; revision: number; length: number; changes: ResultChange[] }
  | { type: 'timeframes'; timeframes: string[] } // after add/setInputs/timeframeMap
  | { type: 'resync'; revision: number; bars: number } // `bar` index mismatch (RangeError)
  | { type: 'error'; id?: string; message: string }; // id: add/setInputs; no id: fatal
```

`WorkerCore.handle` never throws. A `bar` whose index does not fit (`updateBar` RangeError) answers
`resync` with `bars` = number of `bars` messages the worker had handled; the host ignores it when it has
posted more `bars` since (a resend is already in flight, so a burst of bad bars causes one resend) and gives
up after 3 resyncs of one revision without a cleanly applied live bar. Any other exception in any handler,
and worker load/runtime failures (`onerror`, `onmessageerror`), are posted as an `error` without `id`:
fatal, reported once, no further resyncs (a later chart reset still posts `bars`).

The main thread sends `context` (symbol `timezone`/`session` from `chart.symbolInfo`, i.e. `/api/symbols/{s}`,
chart and timeframe interval seconds) at start and, when it changed, before the `bars` of every reset, so
period-anchored indicators compute once with the right timezone. It sends `timeframeMap` before any
`add`/`setInputs` that uses a tf value and on interval change; the worker's resolver is a lookup in it (`setResolveTimeframe`), so interval maths stays on the main
thread (engine `parseInterval`/`intervalSeconds`).
Main thread: drop `results` whose revision is not `chart.seriesRevision`; `from === 0` -> `setStudyData`,
otherwise `updateStudyData`. Coalesce `bar` messages per animation frame (latest wins per index). Errors from
`add`/`setInputs` (cycle, invalid input) surface as toasts and the change is not applied in the app store.
A timeframe request that returns no bars is dropped (the instance stays `waiting`) and retried on the next
series reset. Studies the engine drops with a pane (`paneRemoved.studyIds`) are removed from the app store in
one update and one undo step; after `studiesCleared` the controller re-adds the listed instances.

The settings dialog previews edits through a transient, non-persisted override store
(`useIndicatorPreview`) merged over the persisted instances for the chart and legends; it never enters the
undo history. Ok commits the override as one undo step, Cancel/close drops it.

## 6. Engine study API (`@investopen/engine`, `StudyApi`)

`addStudy(spec)` -> paneId (`target: { paneId }` or `{ newPane: { id?, ratio? } }`; a `newPane.id` that
already exists is reused, so re-adding to an own pane after undo or `setState` works), `removeStudy`,
`moveStudy` (no-op when the target resolves to the current pane),
`getStudies`, `setStudyData(id, { revision, length, values, colors })`, `updateStudyData(id, patch)` (tail
`[from, length)`, also for appends and timeframe re-aligns), `setStudyVisible`, `updateStudySpec`,
`setStudyStyle(id, outputId, patch)`, `getStudyValues(id, index)` (legend values, offset applied, formatted),
`getLegendSlot(paneId)` (DOM node the app renders legend rows into; the engine never writes it),
`seriesRevision`. Events (merged into `ChartEvents`): `seriesChange`, `studyHover`, `studyClick`,
`studyDoubleClick`, `paneRemoved` (`{ paneId, studyIds }`: emitted once per pane, by `removePane` when the
pane held studies, or when a study's removal/move emptied it with `studyIds: []`), `studiesCleared`
(`{ ids }`, from `setState` after its panes are restored); right-click uses the existing `contextMenu` with
`seriesId` = study id. Hit testing checks lines, marks and bars of every series of a pane (top-down) before
any study fill interior; a fill-only hit is weak (`HitTarget.fill`: no pointer cursor) and never beats a
candle, so the main series keeps its context menu over Bollinger/Keltner/Ichimoku/Supertrend fills.
Rules: values align to `chart.store` indices; data with a stale revision is not drawn; plot `offset` draws
past the last bar (Ichimoku); `scaleRange` fixes the pane scale (also while the study has no current data);
`priceScale: 'none'` behaves like the volume overlay. Auto-scale uses visible plots and hlines, plus hidden
plots/hlines that bound a visible fill (e.g. Bollinger bands hidden, background kept), so fills are not
clipped. A history prepend on plain/Heikin Ashi charts emits
`SeriesChange` `{ kind: 'prepend', revision, length, added }` (new revision, consumers resend all bars like
`reset`); the engine shifts each study's current data right by `added` and re-stamps it with the new
revision, so studies keep drawing (and patches apply) until the recomputed `setStudyData` arrives. Brick
types still emit `reset` on prepend (bricks are rebuilt from the first bar). A live brick rebuild that emits
`reset` keeps each study's data for the leading bricks that did not change (`commonPrefix` of the old tail
snapshot and the new series), re-stamped with the new revision; indicators are causal, so those values equal
the recomputed ones and only the changed tail is blank until `setStudyData` arrives. Study panes are ordinary panes, so `getState/setState` keep their ids/ratios; `setState` drops all
studies and emits `studiesCleared`, on which the app re-adds them from its own persisted instance list.

## 7. Heikin Ashi and brick chart types

Indicators run on the displayed series (Phase 4 note), so on Renko an SMA averages brick closes and on HA it
uses HA values. `sourceIndexOf(i)` maps a brick to its time bar (data window, alerts). Brick views are rebuilt
on every live tick; the engine emits `update`/`append` only when it can tell that just the last brick changed
or one was added, otherwise `reset` (bricks are few, so a full recompute is cheap). The comparison covers only
the tail (the last 17 bricks before the tick, `TAIL_WINDOW`) plus the length, not the whole series. Volume on bricks is the
transform's volume column. Timeframe alignment uses brick times (non-decreasing), which stays well defined.

## 8. Golden tests

- `packages/indicators/scripts/golden.py` writes `packages/indicators/test/golden/`: `bars.csv` (1000 seeded
  random-walk OHLCV bars, numpy seed 42, columns `time,open,high,low,close,volume`) and one
  `<id>[-<variant>].csv` per case: first line `# inputs: {json} ref: talib|numpy`, then `time,<outputId>...`,
  empty cell = NaN, floats as `repr`.
- Run without touching the API project:
  `uv run --no-project --python 3.11 --with ta-lib --with pandas --with numpy packages/indicators/scripts/golden.py`.
  Checked: TA-Lib 0.8.2 installs from wheels (numpy 2.4, pandas 3); pandas-ta 0.4.71b0 needs Python >= 3.12
  (`--python 3.12 --with pandas-ta` works), so it is optional cross-checking only.
- Target semantics are reference/standard. Use TA-Lib where its output matches standard including warm-up (SMA, EMA,
  WMA, RSI, Bollinger, Williams %R, CCI, MFI); otherwise (VWAP, Anchored VWAP, VWMA, HMA, Keltner, Donchian,
  Ichimoku, Supertrend, SAR, MACD/Stoch/ADX/ATR/OBV seeding, pivots) write plain pandas/numpy versions of the
  textbook formulas and record `ref: numpy`. Where TA-Lib and the numpy reference differ only during warm-up,
  note it in the script.
- `test/golden.test.ts` loads each CSV, runs the instance via `IndicatorRuntime.setBars`, compares with
  `|a-b| <= 1e-8 * max(1, |b|)` (NaN must match NaN), and repeats via incremental `updateBar` from bar 500
  to assert identical arrays. Golden tests live outside `src` and need `@types/node`; add a
  `test/tsconfig.json` (types: node) and include it in the package `typecheck` script.

## 9. Work split (follow-up agents)

| Agent            | Owns (create/modify)                                                                                                                                                                                                                                                                                                                                                                                                         | Must not touch                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **A** indicators | `packages/indicators/src/builtins/**` (one file per indicator, registered in `builtins/index.ts`), `src/ta.ts` and the `Ta` interface (add primitives, e.g. `wma`, `vwma`, `change`, `atr`, `crossover`), `scripts/golden.py`, `test/**`, package `package.json`/tsconfig for tests                                                                                                                                          | runtime/instance semantics, engine, apps/web |
| **B** engine     | `packages/engine/src/studies/**` (renderers, study store, hit testing; `types.ts` additive only), `chart.ts` (StudyApi, `seriesRevision`, `seriesChange` emission incl. brick/HA logic, legend slot, offsets past the last bar, study autoscale/scaleRange), `pane.ts`, `render/**` as needed, engine tests                                                                                                                  | indicators package, apps/web                 |
| **C** web        | `apps/web/src/indicators/**` (worker, client, results cache, tf fetching/subscriptions, auto-tf table, `contract.ts`), `dialogs/IndicatorsDialog.tsx` (search, categories, favorites), new settings dialog (Inputs / Style / Visibility-per-interval tabs generated from the schema, defaults, "Save as default"), legend row (eye/settings/source/remove/more) via `getLegendSlot`, store/commands/context-menu wiring, e2e | engine and indicators internals              |

Core 25 (A): SMA, EMA, WMA, VWMA, HMA, VWAP, Anchored VWAP, Bollinger, Keltner, Donchian, Ichimoku, Parabolic
SAR, Supertrend, RSI, MACD, Stochastic, Stoch RSI, CCI, ATR, ADX/DMI, OBV, MFI, Williams %R, Volume, Pivot
Points Standard (`timeframe` input, default `'auto'`). Until B lands, C can develop against a stub that logs
`StudyApi` calls; until A lands, C uses SMA/EMA.
