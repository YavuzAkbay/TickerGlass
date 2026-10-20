# Indicators (Phase 5 design)

Contract for the indicator framework. Source of truth for types:
`packages/indicators/src/types.ts` (definitions, runtime) and
`packages/engine/src/studies/types.ts` (display). Change either only additively, and say so in the PR.

## 1. Definition API (`@investopen/indicators`)

An indicator is a declarative object built with `defineIndicator` (it infers literal input keys and output
ids, so `step` is fully typed) and registered with `registerIndicator` / looked up with `getIndicator`,
`listIndicators`. Built-ins register themselves in `src/builtins/index.ts`: the pre-Phase-12 list plus one
array per Phase 12 group in `src/builtins/groups/{trend-ma,momentum,volume,volatility,other,external}.ts`
(each indicator in its own `src/builtins/<id>.ts`, imported, listed and exported by its group file).

```ts
export const SMA = defineIndicator({
  id: 'sma',
  name: 'Simple Moving Average',
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
  Additive (Phase 12): `repaints: true` (past values may change; required for `c.setAt`, see §2; not allowed
  together with a `timeframe` input; such indicators are rejected as alert operands) and `warmup`
  (`{ kind: 'cumulative' }` or `{ bars: n | (inputs) => n }`: history the alerts service loads, read before its
  built-in heuristics; cumulative = `ALERTS_MAX_BARS`).
- **Inputs** (`kind`): `int`, `float` (min/max/step), `bool`, `source`, `color`, `enum` (options, labels),
  `timeframe`, `time` (unix s, for Anchored VWAP; 0 = unset), `symbol` (Phase 12, type only until the external
  series runtime lands: another ticker, e.g. Correlation's; indicators with one are rejected by alerts).
  Common: `label`, `default`, `group`, `inline`, `tooltip`, `hideInTitle`. Key order = dialog order.
  `resolveInputs` fills defaults and clamps numbers.
- **Source values**: `open high low close volume hl2 hlc3 ohlc4 hlcc4`, or `{ instanceId, outputId }`.
  `instanceId` values starting with `sym:` (`EXTERNAL_SOURCE_PREFIX`, `isExternalRef`) are reserved for an
  external symbol's price column (`{ instanceId: 'sym:GOOG', outputId: 'close' }`).
- **Outputs** (array order = draw order): `plot` (kinds line/step/histogram/area/columns/circles/cross,
  `lineWidth`, `lineStyle`, `base`, `offset`, `showLastValue`), `hline` (`value` may be a function of inputs),
  `fill` (`between` two plots/hlines), `bgcolor`, `shape` (shape, location aboveBar/belowBar/absolute/top/bottom,
  size, static `text`); shapes and bgcolor take an `offset` like plots (additive; aboveBar/belowBar anchor to
  the bar at the drawn position). `color` is a string or a palette; with a palette the step picks an index per
  bar (`c.set(id, v, k)` / `c.setColor(id, k)`), e.g. MACD histogram, Supertrend, Ichimoku cloud. Index
  `NO_COLOR` (255, = engine `STUDY_COLOR_NONE`) means "no colour" for that bar (missing-value colour: the line
  segment ending there, the bar, mark, fill segment or background is not drawn); any other out-of-range index
  uses entry 0.
- Additive output options (Phase 12): plot `connectGaps` (line/step drawn straight across NaN bars, line vs broken-line style; default false); shape `textFromValue` (label text = the bar's value formatted
  with the indicator's format; with aboveBar/belowBar the value marks presence and gives the text); new output
  type `volumeProfile` (`mode: 'visible' | 'session'`, `rowsLayout: 'count' | 'size'`, `rows`, `rowSize`,
  `valueArea` %, `widthPercent`, `placement: 'left' | 'right'` — each may be a function of inputs — and
  `upColor`, `downColor`, `valueAreaUpColor`, `valueAreaDownColor`, `pocColor`). The engine computes and draws
  the profile from the chart bars; the output's values array marks period starts in session mode (non-NaN = a
  new period starts at that bar; all NaN in visible mode). Resolved as `ResolvedVolumeProfile` with
  `colors` in `VOLUME_PROFILE_COLOR_KEYS` order (a `colors` style override uses the same order). Value outputs
  (`isValueOutput`): plot, shape, bgcolor, volumeProfile.
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
18:00-17:00; weeks, months, quarters and years of such a session also start at the session open, so a Sunday
18:00 open begins the new week; weeks start Monday). Zone offsets are cached per 15 UTC minutes (half-hour
DST zones such as Australia/Lord_Howe). VWAP: anchors Session/Week/Month/Quarter/Year/Decade/Century in the
exchange timezone and "Hide VWAP on 1D or Above" (`env.intervalSeconds >= 1D`). OBV: "Smoothing" (None,
SMA, SMA + Bollinger Bands, EMA, SMMA (RMA), WMA, VWMA; length, BB StdDev). Unset outputs are NaN for the bar. All running state lives in `ta` primitives created in
`setup` (`sma ema rma wma vwma sum stdev dev highest lowest history vars series`; Phase 12 adds `cum()`,
`highestBars(n)` / `lowestBars(n)` (offset <= 0 of the extreme within the last n values, ties = most recent),
`change(n = 1)` (`x - x[n]`), `linreg(n, offset = 0)` (least squares over x = 0..n-1 oldest to newest,
value `a + b·(n-1-offset)`), `percentrank(n)` (% of the previous n values <= current), `correlation(n)`
(Pearson, `update(x, y)`), `swma()`, `alma(n, offset, sigma)`, `pivotHigh(left, right)` / `pivotLow(left,
right)` (on the confirming value, the center `right` values back if strictly beyond every other value of the
window, else NaN)); creating one inside `step` is an error. Lookbacks count values fed, not bars (NaN inputs
are skipped).

**Repainting (`setAt`, additive)**: definitions with `repaints: true` may call `c.setAt(id, j, v, color?)`
for `j <= i` to rewrite a past value (ZigZag pivot moves, regression channel windows); `c.isLast` is true
while stepping the last bar. Writes made while stepping the last bar go to an undo log: a live tick replays
it in reverse before re-running the bar (so a tick that moves a pivot and a later tick that moves it back
give the full-compute arrays), an append commits it. `computeLast` then reports the smallest past index whose
value or colour differs from what the host showed before the tick (else n-1), the runtime recomputes
dependents fully from such a change, and the worker / engine patch the tail from that index. The definition
must leave the same arrays as a full computation, e.g. clear what an earlier last-bar run drew (keep its
range in `vars`): in a full compute only bar n-1 runs with `isLast`, live every bar did when it was last.

Why per-bar: full compute and live update are the same code, so they cannot diverge; recursive indicators
(SAR, Supertrend) are natural; a tick costs O(1) per indicator. Conventions (TA-Lib): warm-up is NaN,
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
(the indicator "Timeframe" input). `''` = chart. The host's `resolveTimeframe(tf)` maps `'auto'` (Pivot Points:
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
   **Confirmed alignment** ("Wait for timeframe closes"): a definition names a `bool` input in
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

## 5a. User-script sandbox (apps/web, `indicators/sandbox/`)

User scripts (see [user-scripts.md](user-scripts.md)) run in sandbox workers, never in the indicator worker
or on the main thread. Registry type of a script instance is `user:<scriptId>` (`USER_SCRIPT_PREFIX`,
`scriptIdOf`). **The format is persisted in saved chart layouts and must never change.**

**Entry points.** `@investopen/indicators/core` exports everything except the built-in indicators (nothing is
registered in `defaultRegistry`); `@investopen/indicators` is core plus the built-ins. `sandbox-worker.ts`
and `SandboxCore` import only `/core`; the indicator `worker.ts` registers the built-ins explicitly with
`import '@investopen/indicators'`, and `WorkerCore` takes an `IndicatorRegistry`.

**Routing.** `attach.ts` wraps the indicator worker in a `ScriptRouterPort` (a `WorkerPort`; the controller
cannot tell the difference). Routing table:

| message                                                   | built-in (`inner` worker) | `user:` instance                                                    |
| --------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `add`                                                     | type without prefix       | spawn a sandbox; replay `load`, `context`, `bars`, `add`            |
| `setInputs` / `remove`                                    | id not a script instance  | to its sandbox (inputs coerced by the manifest stub) / terminate it |
| `bars` / `bar` / `context` / `clear`                      | always                    | also to every sandbox (`bars`: a fresh copy each)                   |
| `timeframeMap`, `tfBars`, `tfBar`, `extBars`, `extUpdate` | always                    | never (scripts read chart bars only)                                |

One sandbox per instance, at most 8 instances per chart (`MAX_SCRIPT_INSTANCES_PER_CHART`; the rest get an
`error` with the cap message). Router and controller count the same instances: those whose script can run (a
stopped instance of a deleted script, or one without a valid manifest, takes no slot). The cap also holds on
restarts: the router's `start()` refuses (cap `error`, no spawn) when 8 other sandboxes are running, and the
controller takes an instance whose definition came back off the chart (`remove`, cap status) when the running
instances already fill the cap; it is added afresh once there is room. Running instances keep their slot. A script with no saved manifest, or a manifest that does not parse, starts no
sandbox; the controller reports it. A stopped instance (watchdog, failure) stays known and restarts on
`setInputs` or `reloadScript`.

**SeriesMirror.** `bars` buffers are transferred to the indicator worker, so the router keeps a main-thread
copy (`SeriesMirror`: columns, series `revision`, `length`, growable capacity) taken before the transfer. It
replays the series to sandboxes spawned later and answers resyncs. `bar` applies when the revision matches
and the index is `<= length`; otherwise the mirror is `dirty` (not `valid`) until the next `bars`. `clear`
empties it.

**seq/ack and watchdog.** Each message to a sandbox is `{ seq, msg }`; the sandbox posts `{ type: 'ack', seq }`
after handling it and everything it caused (`SandboxCore.handle` never throws; failures are posted as
`error`/`compileError`). The router keeps the unacknowledged messages oldest first and one timer per sandbox.
Limits: 5 s per message, 10 s for `load`, `bars`, `check`. **The deadline starts when a message becomes the
oldest unacknowledged one** (its post when nothing was outstanding, otherwise the ack of its predecessor), so a
queue of cheap messages behind a slow one is not charged for the wait. Missing the deadline terminates the
sandbox and reports `Stopped: no response for N s (endless loop?)` on the instance. A sandbox with nothing
outstanding is pinged every 10 s (`ping`: acked only) with a **2 s** deadline (`PING_DEADLINE_MS`): an idle
sandbox answers at once, so this catches a script that hangs between messages or keeps the worker busy in the
background (best effort, see Lockdown). Pings are only sent to an idle queue, so slow but legitimate compute is
never charged against it. `onerror`/`onmessageerror` of the worker stop the instance with an `error` too (message
capped at 500 characters).

**Protocol limits.** Acks are cumulative and must name an outstanding message: an integer with
`pending[0].seq <= seq <= sb.seq`. Anything else (a forged huge seq, a repeat, an ack while idle) stops the
sandbox with "the script broke the sandbox protocol". Rate cap: between two acks a sandbox may post at most
`4 + 4 × (messages outstanding)` non-ack messages (one message legitimately causes at most 3: `results` or `error`,
`timeframes`, `symbols`); more stops it with "the script sent too many messages". Together these bound what a
sandbox can post by what the router sent it, so it cannot flood the main thread with toasts or status updates.
Backlog: a sandbox with 500 messages outstanding (`MAX_PENDING_MESSAGES`), or whose oldest unacknowledged
message was posted more than 30 s ago (`MAX_MESSAGE_AGE_MS`, whatever the per-message deadlines say), is stopped
with "the script cannot keep up with the chart".

**Coalescing.** At most one `setInputs` and one `bars` per sandbox is unacknowledged at a time. Newer ones wait:
on the ack, the router sends only the latest (the instance's current inputs; the mirror's current bars, with the
current context if any coalesced reset carried one). A held number spinner (about 20 `setInputs`/s) or quick
symbol changes therefore cost a slow script one recompute per ack instead of a growing backlog. Live `bar` ticks
of a newer revision reach the sandbox before its delayed `bars` and are ignored there (revision mismatch); the
mirror copy sent afterwards includes them. A `clear` drops a queued reset (the mirror is empty).

**Internal resync.** A `resync` from a sandbox (same RangeError rule as §5, `bars` = count of `bars` it
handled) is answered by the router from the mirror and never reaches the controller. Ignored when the router
has sent more `bars` since, or the revision is not the mirror's; at most 3 resends per revision, then one
"keeps falling out of sync" `error`.

**Untrusted results.** Nothing a sandbox posts is trusted. `results` are rebuilt from validated fields and
only the instance's own change survives, bounded by what the router sent: `revision` equal to the mirror's,
integer `length <= mirror.length`, integer `from <= length`, values (`Float64Array`) and colours (`Uint8Array`) of
exactly `length - from` elements keyed by output ids of the instance's definition (a change with any other key or
size is dropped), `status` reduced to a known state with message length capped (500). `error`
without `id` is relabelled with the instance id (the sandbox only runs that instance). `timeframes`,
`compileError` (reported by the `add` that follows) and `checkResult`/`probeResult` are dropped by the router.

**Manifest check.** The sandbox answers `load` with the manifest of the compiled source. The router compares
its canonical JSON (sorted keys) with the saved manifest the chart was set up with; a difference stops the
instance with "Script changed since it was saved". The controller's definition (outputs, inputs) therefore
always matches what the sandbox computes.

**reloadScript.** `attach.ts` runs `syncScriptDefinitions` for the scripts store, then `ctl.sync`, then
`port.reloadScript(id)` for each changed script. That restarts the script's instances unless their sandbox was
loaded with the same source and manifest, and stops them when the script is gone or has no manifest.

**Lockdown and CSP.** The real network boundary is the response CSP of the worker script
(`default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'`). `'unsafe-eval'` is
what compiling the script needs. Production: `docker/nginx.conf` (location `/assets/sandbox-worker-*.js`)
and `vite preview` send it with no `'self'`, so not even same-origin `import()` loads. Dev: `vite.config.ts`
`sandboxCsp()` serves the unbundled modules, so `script-src` adds `'self'`. Keep the three in sync. In JS,
`lockdown()` runs first in the worker:

- It captures `postMessage`, `Reflect.apply`, `Object.defineProperty` and the original `isTrusted` and
  `MessageEvent.prototype.data` getters, and registers the message listener as the first **capturing** listener:
  at the target, capturing listeners run first and in registration order, so no listener user code adds can see
  or rewrite `e.data` before it is handled. The listener ignores events with `isTrusted !== true` and reads `data`
  through the captured getter, so a script's `dispatchEvent(new MessageEvent(...))` or a redefined `data` getter
  cannot feed `SandboxCore` (which would answer through the captured post). `SandboxCore.handle` reads the message
  once, before any user code runs for it.
- The captured post calls `postMessage(message)` without options when there is nothing to transfer, and gives a
  non-empty transfer list its own iterator, so a replaced `Array.prototype[Symbol.iterator]` cannot make posting
  (an ack) fail.
- It pins `Error.prepareStackTrace` to `undefined` (non-writable, non-configurable): V8 call sites expose
  sloppy-mode functions through `getFunction()`. The default stack format stays, which `annotateError` parses.
- It removes `fetch`, XHR, sockets, `Request`/`Response`, `importScripts`, storage APIs, nested workers, message
  channels, timers, `WebAssembly`, `navigator` and others (`BLOCKED_GLOBALS`) from the scope and its prototype
  chain, plus the ways to schedule work in the background: `scheduler`, `AbortSignal.timeout`,
  `Atomics.waitAsync`, `FileReader(Sync)`, the `Blob` read methods, `crypto.subtle`, `createImageBitmap`,
  `OffscreenCanvas`, `fonts`/`FontFace`, `PerformanceObserver`, `ReportingObserver`, `FinalizationRegistry`,
  WebCodecs and the `onunhandledrejection`/`onrejectionhandled` handlers (`BLOCKED_MEMBERS` for members of objects
  that stay).
- It throws (no user code runs) if any of these is still reachable.

**Background CPU is not bounded.** Removing these APIs does not stop a script from pinning a core: some task
sources cannot be removed in JS (a rejected `import()` under the CSP, `addEventListener('unhandledrejection')`,
`securitypolicyviolation`). A loop like `const spin = () => { busy(1 ms); import('x:').catch(spin); }` yields to
the task queue between iterations, so it answers every ping in time and keeps one core busy for as long as the
instance exists, one core per instance (up to 8). The 2 s ping deadline only catches a single spin longer than
that. Removing the indicator (or reloading the page) is the only remedy.

**Probes.** `probe` messages (`window.sandboxProbe`, dev/e2e) are accepted only when the worker is built for dev
or with `VITE_E2E=1` (`SandboxCore` option `probes`, a build-time constant in `sandbox-worker.ts`); a production
sandbox answers them as an unknown message. A probe's async completion uses `await`, never a promise's `then`
(user code may have replaced `Promise.prototype.then`), its result is rebuilt field by field, and only one probe
runs at a time: acks of messages handled meanwhile are held and posted after the probe's own, so acks stay in seq
order.

Strict mode: user code is compiled with `"use strict"`, the worker is spawned with `type: 'module'` (always strict;
`createSandboxWorker` must keep it), and the built file starts with a `"use strict";` prologue as well.

**Single-file build guard.** Because the production CSP allows no script loads, `vite.config.ts` builds the
worker as one IIFE and fails the build if the sandbox worker entry has imports, dynamic imports, emits any
other file or does not start with `"use strict";` (`sandboxWorkerSelfContained`, which also adds that prologue), or
if the emitted worker file mentions another emitted file (`sandboxWorkerNoAssetRefs`).

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
candle, so the main series keeps its context menu over Bollinger/Keltner/Ichimoku/Supertrend fills. Studies with
`priceScale: 'none'` (Volume in the price pane) are drawn behind the price series, so their marks are tested
after candles, price-scale studies and weak drawing parts (before fill interiors).
Rules: values align to `chart.store` indices; data with a stale revision is not drawn; plot `offset` draws
past the last bar (Ichimoku); `scaleRange` fixes the pane scale (also while the study has no current data);
`priceScale: 'none'` draws on an own scale in the bottom 20% of the pane. Auto-scale uses visible plots and hlines, plus hidden
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

Volume is an ordinary indicator (`volume` built-in), not the engine's built-in volume (`setVolumeMode`, kept
for API compatibility, default `'hidden'`; the app never turns it on). New charts start with a Volume
instance (`DEFAULT_VOLUME_ID`, placement `main`). The controller gives a study `priceScale: 'none'` when it
is in the price pane and has `format: 'volume'` (or plots such a study through its source), else `'pane'`,
and updates it when the study moves (legend "More" > Move to). Older state with built-in volume
(`chartSettings.volume` / `investopen-app` `volume`) becomes a Volume instance once (docs/persistence.md §5).

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
- Target semantics are standard textbook conventions (Wilder RMA, SMA-seeded EMA). Use TA-Lib where its output matches them including warm-up (SMA, EMA,
  WMA, RSI, Bollinger, Williams %R, CCI, MFI); otherwise (VWAP, Anchored VWAP, VWMA, HMA, Keltner, Donchian,
  Ichimoku, Supertrend, SAR, MACD/Stoch/ADX/ATR/OBV seeding, pivots) write plain pandas/numpy versions of the
  textbook formulas and record `ref: numpy`. Where TA-Lib and the numpy reference differ only during warm-up,
  note it in the script.
- `test/golden.test.ts` loads each CSV, runs the instance via `IndicatorRuntime.setBars`, compares with
  `|a-b| <= 1e-8 * max(1, |b|)` (NaN must match NaN), and repeats via incremental `updateBar` from bar 500
  to assert identical arrays. Golden tests live outside `src` and need `@types/node`; add a
  `test/tsconfig.json` (types: node) and include it in the package `typecheck` script.
- Phase 12 layout: shared bars/primitives/`Cases` collector in `scripts/golden_common.py`; `golden.py` keeps
  the earlier cases and imports `golden_{trend_ma,momentum,volume,volatility,other,external}.py`, each exposing
  `cases()`. Bar series: `bars.csv` (hourly, default) and `bars-daily.csv` (~6 years of seeded weekday daily
  bars, numpy seed 6, from 2019-01-02). A case on another series adds ` bars: <file>` to its header
  (`# inputs: {...} ref: numpy bars: bars-daily.csv`), and a second aligned series (external symbol) adds
  ` extra: <file>`; series files are `bars*.csv` without a header line. The test sets the runtime context
  `intervalSeconds` to the series' smallest time step (`timeframeSeconds['1D'] = 86400`). Every built-in
  needs at least one case.
- `test/incremental.test.ts` runs every registered id live vs full on 400 random 15m bars; per-group
  overrides live in `test/fixtures/<group>.ts` (`bars`, `context`, `inputs`, `liveFrom`, `sparse`: some
  value anywhere instead of at the last bar, `noValues`: all NaN expected).
- `test/repaint.test.ts` covers `setAt` with a test-only ZigZag (ticks moving pivots back and forth,
  appends, `Change.from`, dependents).

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
