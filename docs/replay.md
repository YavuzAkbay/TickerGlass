# Market replay (Phase 13)

Replay rewinds the chart to a bar you pick and then reveals the market one step at a time: bar by bar, or tick by
tick from a finer interval when Yahoo has it. Indicators, compare overlays and expressions follow because they read
the same feed. Replay is local to the browser: nothing is stored, and the server never sees it.

Code:

- `packages/engine/src/feed/replay-feed.ts`: `ReplayFeed`, `chooseTick`, `tickIntervals`.
- `apps/web/src/chart/feed.ts`: builds the feed stack and exports `replayFeed`.
- `apps/web/src/replay/`: `store.ts`, `controller.ts`, `commands.ts`, `attach.ts` + `tool.ts` (scissors picker),
  `ReplayBar.tsx`, `limits.ts`, `alerts.ts`, `paper.ts`, `trading.ts`, `ReplayTrading.tsx`, `instance.ts` (singleton and the `window.replay` hook in dev/e2e).
- Engine additions: `DrawingToolOptions.cursor` and `cutPreview` for the pick tool.

Limitations and their status: [LIMITATIONS.md](LIMITATIONS.md#replay).

## 1. Architecture

`ReplayFeed` is the outermost wrapper of the one feed the app shares:
`new ReplayFeed(new ExpressionFeed(new ResamplingFeed(new HttpDataFeed())))`. The chart, compare overlays,
higher-timeframe indicator series and external symbols all get this object, so clipping one place clips everything.
In live mode it is a pure passthrough. (Swapping the chart's feed would leave the controllers on the old feed, and
clipping inside the chart would miss them and intrabar data.)

**Clock.** `E` is the open time of the first unrevealed tick. A bar of any series is revealed only if its time is
`< E`. `start` sets `E` to the time of the chart bar after the picked one, so the picked bar is the last visible.
`step()` moves `E` by one tick and emits the newly visible bars to every subscription. When there is nothing left
before "now", `step()` resolves `'end'`.

**Ticks.** The tick is the chart symbol at the tick interval (the chart interval in whole-bar mode). A chart bar
without ticks counts as one clock step.

**Buffers.** A `ForwardBuffer` per symbol, interval and session pages forward with `getBars({to, limit: 2000})`
(span halved when a page comes back full) and refills when fewer than 500 bars remain after `E`. Buffers are shared
and reference counted.

**Visibility per subscription (symbol S, interval I, chart interval C):**

- Rule P (`I <= C`): partition by the native bars of `(S, I)`. With finer ticks the forming bar is the aggregate of
  the ticks revealed so far (first open, max high, min low, last close, summed volume); on rollover the finished
  native bar is emitted first (so it settles), then the first aggregate of the next bar. Without finer ticks a
  native bar appears when it has closed. Partitioning by native bar boundaries (not by `bucketStart`) keeps 60m
  bars anchored at :30 and non-midnight daily bars correct.
- Rule A (`I > C`, higher-timeframe indicator series): bucket the rule-P view of `(S, C)` with `bucketStart`, as
  `ResamplingFeed.subscribe` does.

**`getBars`** in replay waits for a pending `setPrimary`, requests `to: min(req.to, cutoff)` and always filters the
result to `time < cutoff` (`ExpressionFeed` asks legs for `to + 2d`). **`subscribe`** never reaches the inner feed
(no `/ws` traffic): it emits the current forming bar on a microtask and then follows the clock. Subscriptions
that existed at `start` are unsubscribed from the inner feed and muted.

**Epoch.** `replayFeed.epoch` increases on start, seek, stop and when `setPrimary` snaps the clock. Controllers that
cache fetched data (compare overlays, indicator timeframe series, external symbols) take `dataEpoch: () => number`
and refetch when it changed; the chart is reloaded once after start, seek and stop, never per step (a reload
cancels an unfinished drawing).

**Symbol or interval change** during replay: the controller listens to `symbolResolved` (emitted before `getBars`,
also for layouts) and calls `setPrimary`, which re-picks the tick and snaps `E` back to the newest new tick at or
before it, so nothing ahead is ever shown (at most one partial tick is lost).

## 2. Tick choice

Candidates, finest first: 1m, 2m, 5m, 15m, 30m, 1h, 1D (no 90m). A candidate `T` is valid for chart interval `C` if
`T < C`, `C / T <= 120`, and for intraday charts `T` is intraday and divides `C`. The tick is the first valid
candidate whose history reaches the start: `start >= now - lookback(T) + 1 day`. If none does, whole bars are
replayed and the bar shows a warning ("Intrabar data for 1m only covers the last 29 days; replaying whole bars.").
Before the first step an availability probe falls back to the next candidate when a tick page is empty.

Lookback (`limits.ts`, mirrors `api/src/investopen_api/intervals.py`, keep both in sync): 1m 29 days; 2m, 5m, 15m,
30m, 90m 59 days; 1h 729 days; daily and above unlimited. The synthetic feed has no limits.

| Chart | Start age | Tick       |
| ----- | --------- | ---------- |
| 1m    | any       | whole bars |
| 5m    | <= 28 d   | 1m         |
| 5m    | older     | whole bars |
| 15m   | <= 28 d   | 1m         |
| 15m   | <= 58 d   | 5m         |
| 1h    | <= 28 d   | 1m         |
| 1h    | <= 58 d   | 2m         |
| 4h    | <= 58 d   | 2m         |
| 4h    | <= 728 d  | 1h         |
| 1D    | <= 58 d   | 15m        |
| 1D    | <= 728 d  | 1h         |
| 1W    | any       | 1D         |
| 1M    | any       | 1D         |

Beyond the limits a warning replaces the tick. No OHLC path is invented between bars: without intrabar data replay
uses whole bars (the synthetic dev feed's intervals are unrelated random walks, so its forming bar jumps at the settle). The **Update** picker overrides the choice: Auto, Bars, or any valid interval from
`tickIntervals(chart)`; an interval that does not fit a new chart interval falls back to Auto.

## 3. UI, commands, state

- Top-bar **Replay** (active while replay is on) arms the scissors: pick-point mode with a scissors cursor and a
  cut preview (a vertical line at the bar under the pointer, the area to its right dimmed). Click starts replay (or
  moves it when already running); Escape or another tool cancels.
- **ReplayBar** floats at the bottom of the chart: Select bar, Play/Pause, Step, Speed (3 s, 1 s, 0.5 s, 0.3 s,
  0.1 s, 30 ms per step), Update, a warning badge, the clock date, Jump to realtime, Exit.
- The play loop awaits `step()` and then waits the speed delay, so a slow step never overlaps the next.
- Store (`useReplayStore`): `status` (`off`, `picking`, `loading`, `paused`, `playing`, `ended`), `last`, `next`,
  `tick`, `warning`, `speed`, `update`. Only `speed` and `update` persist (`localStorage` `investopen-replay`).
- Commands: `replay.toggle` Shift+Alt+R, `replay.selectBar`, `replay.playPause` Shift+Alt+Space, `replay.step`
  Shift+Alt+ArrowRight, `replay.realtime`, `replay.speedUp`, `replay.speedDown`, `replay.exit`. The engine lets
  Alt+arrows and Shift+Alt+R through to the app.
- A failing non-primary subscription (a compare overlay) during a step shows in the warning badge, not as a toast per
  step.
- Jump to realtime and Exit both call `ReplayFeed.stop()`: epoch bump, one chart reload, controllers refetch and
  resubscribe live.

## 4. Alerts in replay

Server alerts keep running in real time and are unaffected. While replay is on:

- Fire markers of the `alerts` group with a bar time at or after the clock are hidden and return on exit. Alert
  lines stay.
- `replay/alerts.ts` evaluates **price alerts** (`isPriceAlert`: a price operand against a constant) on the chart
  symbol locally. After each step the sample is `x = priceValue(field, forming bar)`, `y = the constant`, compared
  with the previous sample using the shared `evaluateCondition`. The bar is `ReplayFeed.revealedBar(symbol)`: the
  raw, untransformed last revealed bar of the chart symbol (the forming aggregate in intrabar mode), so Heikin Ashi
  and brick charts do not change it. A hit adds a marker to the `replay-alerts` group
  and a toast "Replay: {name}". Nothing is delivered or written to the alert log.
- At most one fire per alert and bar; `once` alerts fire once per replay session. The first sample after a start or
  seek is recorded without firing; start, seek and exit reset everything and clear the markers.
- Indicator, drawing and channel alerts are not evaluated.

## 5. Persistence and undo

Replay is never part of a layout or `getState()`. Saving a layout during replay saves the real state; loading one
keeps the replay clock (the symbol and interval change reach `setPrimary`). Replay actions are not undoable.
Drawings made during replay persist normally. Reloading the page leaves replay.

## 6. Paper trading

A practice account inside replay (`replay/paper.ts` pure, `trading.ts` store and chart drawing, `ReplayTrading.tsx`
panel). Nothing is stored or sent anywhere.

- Market orders only, with a quantity input (default 1). Buy, Sell and Close are in the ReplayBar. An order fills at
  the close of `revealedBar` (the raw last revealed bar of the chart symbol, whatever the chart type; without one the
  order is refused with a toast), and the fill time is the replay clock (`last`). No
  commissions, slippage, margin or limits; shorting is allowed.
- One net position per symbol with an average cost `avg`, `q` the signed quantity, `p` the fill price, `n` the order
  size:
  - same direction: `avg = (avg*|q| + p*n) / (|q| + n)`
  - opposite direction: `closed = min(n, |q|)`, `realized += (p - avg) * closed * sign(q)`; a remainder flips the
    position and its average is `p`; no remainder leaves it flat
  - `unrealized = (last - avg) * q`; total = realized + unrealized (marks: the last revealed close of each symbol)
- Chart: marker group `replay-trades` (arrow up below the bar for buys, arrow down above for sells) and price line
  group `replay-position` (average price, "Long 2 @ 100.50").
- The **Replay trading** panel (right icon bar, only while replaying; never saved or synced) shows position, average,
  last, unrealized, realized and total P&L and the trade list. The ReplayBar shows the total as a compact readout.
- Start and seek reset the account; exit shows a summary toast ("Replay finished: N trades, realized ..., total
  ...") and clears everything.

## 7. Request budget

Replay adds no `/ws` traffic and no polling. History comes from the same `/api/bars` endpoint in `limit: 2000`
pages bounded by `to`, one buffer per series in use (chart symbol, tick interval, each compare overlay), refilled
when fewer than 500 bars remain. Buffers are not trimmed while replay runs.

## 8. Testing

- Engine: `replay-feed.test.ts` (clipping, paging, rules P/A, muting, epoch, the "nothing at or after `E`"
  property, tick choice and aggregation), `interaction/controller.test.ts` (keys), `chart-drawings.test.ts` (cut
  preview and cursor).
- Web: `replay/controller.test.ts` (fake timers, backpressure, transitions, end), `replay/store.test.ts`,
  `replay/alerts.test.ts`, `replay/paper.test.ts` (average cost, reduce, flip, close, short, P&L),
  `replay/trading.test.ts`, epoch refetch cases in the compare and indicator controller tests.
- e2e: `e2e/replay.spec.ts` on the synthetic feed (independent random walks per interval, so it asserts structure
  and times, not prices).

## 9. Non-goals

Backward stepping, invented intrabar paths, replay prices in the watchlist or quotes, indicator/drawing/channel
alerts in replay, cross-chart replay sync (Phase 14), server-side replay.
