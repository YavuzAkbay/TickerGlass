# User scripts

Write your own indicators in plain JavaScript. A script uses the same `defineIndicator({...})` API as the built-in
indicators (see [indicators.md](indicators.md) §1 and §2 for the full contract), runs in a locked-down sandbox, and
shows up in the chart, legend, Inspector settings, templates and saved layouts like any other indicator.

Script contract version: **apiVersion 1**. Type declarations for editors: [user-scripts.d.ts](user-scripts.d.ts).

## 1. Quick start

Open **Indicators → Custom → New script**, paste this, click **Save**, then **Add to chart**:

```js
// SMA cross: two moving averages and a marker where the fast one crosses the slow one.
defineIndicator({
  name: 'SMA Cross',
  shortName: 'SMA X',
  category: 'trend',
  overlay: true,
  inputs: {
    fast: { kind: 'int', label: 'Fast length', default: 9, min: 1, max: 500 },
    slow: { kind: 'int', label: 'Slow length', default: 21, min: 2, max: 500 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'plot', id: 'fast', title: 'Fast', kind: 'line', color: '#6E9BD6' },
    { type: 'plot', id: 'slow', title: 'Slow', kind: 'line', color: '#E0A93B' },
    {
      type: 'shape',
      id: 'up',
      title: 'Cross up',
      shape: 'triangleUp',
      location: 'belowBar',
      color: '#7FB069',
    },
    {
      type: 'shape',
      id: 'down',
      title: 'Cross down',
      shape: 'triangleDown',
      location: 'aboveBar',
      color: '#DE6A4F',
    },
  ],
  setup({ inputs, ta }) {
    const fast = ta.sma(inputs.fast);
    const slow = ta.sma(inputs.slow);
    // Anything carried from one bar to the next lives in ta.vars (or another ta primitive).
    const prev = ta.vars({ diff: NaN });
    return (c) => {
      const x = c.src.source[c.i];
      const f = fast.update(x);
      const s = slow.update(x);
      const diff = f - s;
      c.set('fast', f);
      c.set('slow', s);
      if (prev.diff <= 0 && diff > 0) c.set('up', c.low[c.i]);
      if (prev.diff >= 0 && diff < 0) c.set('down', c.high[c.i]);
      prev.diff = diff;
    };
  },
});
```

What it does: two simple moving averages plotted on the price pane, and a triangle on the bar where the fast one
crosses the slow one. Change the lengths in the indicator's settings like any other indicator.

The editor (a plain text area with line numbers, Tab inserts two spaces):

- **Custom** (in the Indicators dialog) lists your scripts; **New script** starts from a template, and each row
  has an edit icon. Rename, Duplicate and Delete are in the editor's script list.
- **Save** (button or Ctrl/Cmd+S) checks the syntax, loads the script in a throwaway sandbox, runs the live
  **Check** (section 5) and stores the script. Problems are listed under the editor; click one to jump to its
  line. Check warnings never block saving. A script that does not compile (syntax error, exception while
  loading, invalid definition) is still saved, as text without a manifest, and cannot run until fixed.
- **Check** (button) runs the same analysis without saving. It uses the default input values and the latest 5,000
  bars of the current chart; with fewer than 2 bars it is skipped. Its findings are warnings only.
- **Add to chart** saves unsaved changes first, then adds the saved script as an indicator. A script that does not
  compile cannot be added.
- Saving, renaming, deleting and Check need the server connection (scripts live in the API); without it the
  editor shows "Saving scripts needs the server connection". If the script was changed elsewhere (another tab or
  browser) the save fails with a 409 toast offering **Reload** (take the stored version) or **Overwrite** (store
  yours).
- On a chart, an indicator's legend "More" menu has **Edit script...**.

## 2. Script shape

- Plain ES2022 JavaScript, run as the body of a strict-mode function. There is no `import` or `export`.
- Call `defineIndicator({...})` **exactly once**, while the script loads (not later, not from `setup` or `step`).
  Its return value is ignored.
- Four names are injected as frozen values: `defineIndicator`, `NO_COLOR` (255), `PRICE_SOURCES` (the nine
  price source names) and `calendarPeriod(time, unit, tz, session)` (the period number VWAP-style indicators
  use, [indicators.md](indicators.md) §2).
- The `id` you give is ignored (and may be left out). The app registers the script as `user:<scriptId>` and saves
  that string in layouts. Never rely on it.
- Anything else in the sandbox is the standard JavaScript language (`Math`, `Array`, `Number`, ...) minus what
  is blocked (section 9).

## 3. Metadata and inputs

Metadata is the same as for built-ins: `name`, `shortName`, `category`, `keywords`, `overlay`, `format`,
`precision` (0 to 16), `scaleRange` (`min` below `max`), `repaints`, `warmup` (accepted, currently unused).
`name`, `shortName`, `category`, `overlay`, `inputs` and `outputs` are required.

Inputs are declared as in [indicators.md](indicators.md) §1 and generate the Inspector settings; key order is display
order. Allowed kinds:

| `kind`   | Value in `inputs.<key>`  | Notes                                                         |
| -------- | ------------------------ | ------------------------------------------------------------- |
| `int`    | number                   | `min`, `max`, `step`; also `float`                            |
| `float`  | number                   |                                                               |
| `bool`   | boolean                  |                                                               |
| `source` | price source name        | `open high low close volume hl2 hlc3 ohlc4 hlcc4` only        |
| `color`  | CSS colour string        |                                                               |
| `enum`   | one of `options`         | `optionLabels` for display names; `default` must be an option |
| `time`   | unix seconds (0 = unset) |                                                               |

Not allowed: `timeframe` and `symbol` inputs, and `source` values that point at another indicator's output.
Every input has `label` and `default`; optional `group`, `inline`, `tooltip`, `hideInTitle`.

A `source` input becomes a price column: `c.src.<key>` (a `Float64Array`), see section 5.

## 4. Outputs

`outputs` is an ordered array (draw order): `plot`, `hline`, `fill`, `bgcolor`, `shape` (and `volumeProfile`)
with the fields of [indicators.md](indicators.md) §1. Output ids must be unique.

**Everything in an output is static.** In built-ins some fields can be functions of the inputs (an RSI band
level taken from an input); in scripts `value`, `offset`, `warmup.bars` and the volume profile fields must be plain
values. A function there is rejected with a message saying so. The reason: the app reads your script's outputs
without running your code, so only the sandbox ever runs it. To make something depend on an input, plot it
(`c.set`) instead of declaring it as an `hline`.

Colours are checked: hex (`#7FB069`, `#6E9BD680`), `rgb()`, `rgba()`, `hsl()`, `hsla()` or a CSS colour name.
Anything else (notably `url(...)`) is rejected.

**Palettes.** `color` may be an array. Then `c.set(id, value, k)` (or `c.setColor(id, k)` for fills) picks entry
`k` for that bar; users can edit every entry in the Style tab. `NO_COLOR` as the index hides that bar (the line
segment ending there, the column, the mark, the fill segment); any other out-of-range index uses entry 0. The
MACD example in section 10 uses a four-colour palette and `NO_COLOR` for the warm-up bars.

## 5. Compute model

`setup(ctx)` runs once per full computation and returns `step(c)`, which is called for bars `0..n-1` in order.
`ctx` has `inputs`, `ta` and `env`. It is the same model as built-ins ([indicators.md](indicators.md) §2).

### The step context `c`

One object is reused for every bar. Do not keep it. Arrays are valid for indices `0..c.i`.

| Member                                 | Meaning                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `c.i`                                  | Current bar index                                                                       |
| `c.time`                               | Bar open times, unix seconds (`Float64Array`)                                           |
| `c.open` `high` `low` `close` `volume` | Price and volume columns (`Float64Array`)                                               |
| `c.src.<key>`                          | Column for each `source` input                                                          |
| `c.inputs`                             | Input values (also `ctx.inputs` in `setup`)                                             |
| `c.env`                                | `{ timezone, session, intervalSeconds }` of the bars (`'UTC'`, `null`, 0 when unknown)  |
| `c.set(id, value, color?)`             | Value of a plot, shape or bgcolor for this bar; `NaN` = nothing. Optional palette index |
| `c.setColor(id, color)`                | Palette index for this bar only (for fills)                                             |
| `c.get(id, j)`                         | This script's own output at an earlier bar `j < i` (`NaN` if unset)                     |
| `c.setAt(id, j, value, color?)`        | Rewrite an output at bar `j <= i`. Only with `repaints: true`; throws otherwise         |
| `c.isLast`                             | True while stepping the last bar                                                        |

An output you do not `set` on a bar is `NaN` for that bar. For `aboveBar` / `belowBar` shapes any non-`NaN` value
means "show a mark here"; `absolute` shapes use the value as the price.

### `ta`: stateful primitives

Create these in `setup` (creating one in `step` throws). Each call to `update` takes the value for the next
bar and returns the result for it. Warm-up results are `NaN`. A leading `NaN` input is skipped; a later `NaN`
returns `NaN` and leaves the state unchanged. `ema` and `rma` seed with the SMA of the first `length` values and
`stdev` is the population standard deviation (TA-Lib convention).

| Call                                                | Returns / use                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ta.sma(n)` `ema(n)` `wma(n)`                       | Moving averages: `.update(x)`                                                                                                                             |
| `ta.rma(n)`                                         | Wilder's moving average (alpha = 1/n): RSI, ATR, ADX                                                                                                      |
| `ta.vwma(n)`                                        | Volume weighted: `.update(x, volume)`                                                                                                                     |
| `ta.sum(n)` `stdev(n)` `dev(n)`                     | Rolling sum, standard deviation, mean absolute deviation                                                                                                  |
| `ta.highest(n)` `lowest(n)`                         | Rolling max / min                                                                                                                                         |
| `ta.highestBars(n)` `lowestBars(n)`                 | Offset (`<= 0`) of the extreme within the last `n` values; ties pick the most recent                                                                      |
| `ta.cum()`                                          | Running total of every value fed                                                                                                                          |
| `ta.change(n = 1)`                                  | `x - x[n]`                                                                                                                                                |
| `ta.linreg(n, offset = 0)`                          | Least-squares line over the last `n` values; offset 0 = fitted value at the current bar                                                                   |
| `ta.percentrank(n)`                                 | % (0..100) of the previous `n` values that are `<=` the current one                                                                                       |
| `ta.correlation(n)`                                 | Pearson correlation: `.update(x, y)`                                                                                                                      |
| `ta.swma()`                                         | `(x[3] + 2 x[2] + 2 x[1] + x) / 6`                                                                                                                        |
| `ta.alma(n, offset, sigma)`                         | Arnaud Legoux moving average                                                                                                                              |
| `ta.pivotHigh(left, right)` `pivotLow(left, right)` | On the confirming value: the value `right` back if strictly higher (lower) than the `left` before and `right` after it, else `NaN`. Ties are never pivots |
| `ta.history(n)`                                     | `.push(x)`, `.get(k)`: the last `n` pushed values, `k = 0` newest, `NaN` if not available                                                                 |
| `ta.vars({ a: 0, b: NaN })`                         | Object of numbers carried across bars (persistent variable); read and write its fields                                                                    |
| `ta.series()`                                       | Scratch series: `.get(i)`, `.set(i, v)`; re-running a bar overwrites its slot                                                                             |

Lookbacks count values fed, not bars.

### State rules, live ticks and Check

Full computation and live ticks run the **same** `step`. On every live tick the app rewinds every `ta` primitive to
the state before the last bar and runs that bar again. So:

- Keep **all** state that lives from one bar to the next in `ta` primitives (`ta.vars`, `ta.series`,
  `ta.history`, `ta.sma`, ...). A plain variable such as `let last = 0` declared in `setup` or at the top of the
  script is **not** rewound: after a few ticks of the same bar it holds the wrong value and the live values stop
  matching what a reload would show.
- `c.get(id, j)` and `c.setAt` are safe: they work on the output arrays, which the app handles.
- Do not use `Math.random()`, `Date.now()` or anything else that differs between runs.

**Check** catches the first mistake. It computes the indicator twice on the chart's current bars: once in one go,
and once as 50 fewer bars followed by the last 50 bars fed one at a time as live ticks (each first as a tick where
high, low and close equal the open and the volume is 10%, then as the final bar). It compares every output value and
palette index (tolerance `1e-9 * max(1, |value|)`, `NaN` equals `NaN`) and reports the first output and bar index
that differ, with both values. A mismatch almost always means state kept outside `ta`. A script that throws during
Check reports `Check (full): <error>` or `Check (live): <error>`.

### Repainting

Set `repaints: true` if the script rewrites past bars with `c.setAt`, such as a ZigZag pivot that moves back in
time when a further extreme appears. The rules:

- Writes made while stepping the last bar are undone when a live tick re-runs it. The script must leave the same
  arrays as a full computation would, so clear what an earlier last-bar run drew (remember its bar in
  `ta.vars`). The ZigZag example in section 10 does this for its provisional end point.
- Writing `NaN` with `setAt` clears a value.

## 6. Errors and limits

**Errors in your code.** A script that throws (while loading, in `setup` or in `step`) turns the indicator's
legend status into an error and its outputs into nothing; other indicators keep working. The message carries the
line in **your** source, counted from 1:

```
TypeError: x is undefined (line 12:5)
```

The `Error` prefix is left off for plain `Error`s; messages are cut at 500 characters. Syntax errors are reported by
the editor with line and column before the script is saved. Mistakes in the definition itself read like
`Invalid indicator definition: definition.outputs[1].color must be a colour (hex, rgb(a), hsl(a) or CSS name)`.
Line numbers rely on the browser's error stacks and are verified in Chromium only; in other browsers the line may
be missing or off.

**Time.** Every script instance runs in its own worker. Each message the app sends it (load, bars, a live tick,
changed inputs, Check) must be acknowledged in time: **10 s** for load, bars and Check, **5 s** for everything else.
The clock for a message starts when it becomes the oldest unacknowledged one, so cheap messages queued behind a
slow one are not charged for the wait. An idle worker is pinged every **10 s** and must answer within **2 s**,
which catches a script that hangs between messages or keeps working in the background. On a miss the worker is
stopped and the legend shows `Stopped: no response for N s (endless loop?)`. A worker that falls ever further
behind (500 messages waiting, or one waiting for over **30 s**) is stopped with
`Stopped: the script cannot keep up with the chart`. It is not restarted automatically: change a setting, save the
script again or reload the page. A heavy but legitimate script on a very long history can hit these limits.
Rapid changes (holding a number spinner, switching symbols quickly) do not pile up: while the worker is busy, only
the latest inputs and the latest bars are sent once it is done.

A script that loops forever while loading (at the top level) cannot be compiled: Save waits 10 s, then stores it
without a definition and reports `Script did not finish loading within 10 s (endless loop?)`.

**Not available inside scripts.** Network (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `Request`,
`Response`, ...), storage (`indexedDB`, `caches`), other workers and channels, timers and schedulers (`setTimeout`,
`setInterval`, `queueMicrotask`, `requestAnimationFrame`, `scheduler`, `AbortSignal.timeout`, `Atomics.waitAsync`),
asynchronous readers and decoders (`FileReader`, `Blob` `text`/`arrayBuffer`/`bytes`/`stream`, `crypto.subtle`,
`createImageBitmap`, `OffscreenCanvas`, `fonts`/`FontFace`, `PerformanceObserver`, `FinalizationRegistry`,
WebCodecs), `onunhandledrejection`/`onrejectionhandled`, `postMessage`,
`WebAssembly`, `navigator`, notifications, and `Error.prepareStackTrace` (fixed to `undefined`). Reading any of
them gives `undefined`, so calling one throws. A script is synchronous code: it cannot wait for anything.

**Sizes.**

| Limit                                                  | Value                      |
| ------------------------------------------------------ | -------------------------- |
| Script source                                          | 200,000 characters         |
| Script name                                            | 1 to 100 characters        |
| Compiled manifest stored with the script               | 64 KB                      |
| Inputs / outputs per script                            | 64 each                    |
| Any string in the definition (names, labels, ids, ...) | 200 characters             |
| Keywords, enum options, palette entries                | 64 each                    |
| Running script indicators on one chart                 | 8 (the 9th shows an error) |

Memory is not limited per script (browsers offer no per-worker cap); the instance limit and the 64-output cap keep
it bounded in practice.

## 7. Not supported

- Calling another indicator, reading another script's outputs, or having another indicator read a script's: script
  `source` inputs offer price sources only, and "Add indicator on..." is disabled for script indicators.
- Other timeframes and other symbols: no `timeframe` or `symbol` inputs, no `c.ext`.
- Alerts on scripts: the alerts service runs on a Node server that has no sandbox. Script indicators are not offered
  as alert sources, and "Add alert..." on a script indicator is disabled (tooltip "Not available for scripts").
- Output fields that depend on inputs (section 4).
- TypeScript, other scripting languages, strategies, backtesting, drawings or tables from scripts, `import`, version history,
  sharing or a script library. See [LIMITATIONS.md](LIMITATIONS.md) for which of these are planned.

## 8. Saved charts

- A chart stores `user:<scriptId>` plus the input values and style overrides, not the code. Scripts live on the
  server (the API), so they follow you across browsers. Offline, the browser's cached copy is read-only: existing
  charts keep working, but saving, renaming and deleting need the API.
- **Edit** a script and every instance of it on every chart is recomputed with the new code. Input values that are
  still valid are kept (the stored values are coerced against the new definition), invalid or removed ones fall
  back to the new defaults. Style overrides are matched by output
  id, so renaming or removing an output loses its style (unknown ones are ignored). Keep ids stable.
- **Rename** only changes the list name.
- **Delete** a script: the dialog lists the instances on the current chart and has an "Also remove them from the
  chart" checkbox. Instances left in place, and those in other layouts, show `Script deleted`; if a script with that id appears again (for example from
  an import) they work again.
- A script that has never compiled shows `Script has errors – open it in the editor`.
- Starred indicators, templates and "Save as default" work unchanged (they key on the type).
- **Export / import** (the settings backup) carries scripts in an extra `userScripts` section. Importing merges by
  script id; replacing empties the scripts only when the file has that section. Older backups import as before.

## 9. Security model

User code is untrusted code that runs in your browser, so it runs in a sandbox with these layers.

What the sandbox **guarantees**:

- **No network.** The worker file is served with its own `Content-Security-Policy` response header:
  `default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'`. `'unsafe-eval'` is there only
  because compiling your script needs `new Function`. There is no `'self'`: the production worker is one
  self-contained file, so the browser refuses every script load, including a same-origin `import()` (the build fails
  if the worker ever needs another file). `connect-src 'none'` blocks `fetch`, XHR and WebSocket connections.
- **No reach into the page.** A worker has no DOM, cookies or `localStorage`; the page's data (your layouts, API
  access) is unreachable. In addition `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`,
  `Worker` and the other names in section 6 are removed before your code runs, and the sandbox refuses to start
  if any of them is still reachable.
- **Narrow channel.** The worker only takes messages the browser delivered from the page (`isTrusted`; events a
  script dispatches itself are ignored), and handles each one before any listener your code adds could see or
  change it. The page only accepts numeric result arrays for the script's own
  instance, sized to the chart's bars and keyed by the script's own output ids, and re-validates the definition
  (strict whitelist, no unknown keys, no `__proto__`, colours checked) before using it. Acknowledgements must match
  messages the page sent, and a worker posting more than its messages explain is stopped, so a script cannot
  flood the page. The page never runs your code.

What it does **not** guarantee:

- **CPU and memory.** A script can allocate memory, and it **can keep a CPU core busy for as long as it is on the
  chart** (one core per script indicator, up to 8). The watchdog only stops a worker that fails to answer (5 s /
  10 s, 2 s for an idle ping). Timers and other scheduling APIs are removed, but a script can still alternate
  short busy spins with waits on things that cannot be removed (for example a failing `import()`), answering every
  check in between. Removing the indicator (or reloading the page) is the only remedy.
- **Correct-looking output.** A script can draw whatever it likes, including misleading levels or marks.
- **A page-wide CSP.** The app page itself has no CSP (a separate hardening item), so the guarantees above rest on the
  worker's own header. Only the nginx image in `docker/`, `vite dev` and `vite preview` set it. If you put another
  proxy or a CDN in front, make sure it passes `Content-Security-Policy` through unchanged for
  `/assets/sandbox-worker-*.js`; without it only the JavaScript lockdown remains and a dynamic `import()` is open.
- **Dev server.** Under `vite dev` the worker's policy keeps `'self'` (Vite serves it as separate modules), so a
  script can make same-origin GET requests through `import('/...')`. The response is not readable and nothing leaves
  your origin. `vite preview` and production do not allow it.

Be careful with pasted code all the same: the sandbox limits the damage a script can do, it does not make a script
worth running because a stranger wrote it. Read it first.

## 10. Examples

These are trimmed versions of scripts that the indicators package tests against the built-in RSI, MACD and ZigZag
golden references (`packages/indicators/test/user-scripts/`, which also has SMA and Bollinger Bands versions).

### RSI with levels and a shaded zone

`hline` levels are fixed here (70 and 30); to let users change them, plot constant lines with `c.set` instead.

```js
// RSI (Wilder) with 70 / 30 lines and a shaded zone between them.
defineIndicator({
  name: 'My RSI',
  shortName: 'MyRSI',
  category: 'momentum',
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'hline', id: 'upper', title: 'Upper band', value: 70, color: '#A39E8F' },
    { type: 'hline', id: 'lower', title: 'Lower band', value: 30, color: '#A39E8F' },
    {
      type: 'fill',
      id: 'zone',
      title: 'Zone',
      between: ['upper', 'lower'],
      color: 'rgba(142, 92, 246, 0.1)',
    },
    { type: 'plot', id: 'rsi', title: 'RSI', kind: 'line', color: '#8e5cf6' },
  ],
  setup({ inputs, ta }) {
    const diff = ta.change();
    const avgGain = ta.rma(inputs.length);
    const avgLoss = ta.rma(inputs.length);
    return (c) => {
      const ch = diff.update(c.src.source[c.i]);
      const up = avgGain.update(Math.max(ch, 0));
      const down = avgLoss.update(-Math.min(ch, 0));
      c.set('rsi', down === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / down));
    };
  },
});
```

### MACD with a palette histogram

```js
// MACD with a four-colour histogram: grows / falls, above / below zero.
defineIndicator({
  name: 'My MACD',
  shortName: 'MyMACD',
  category: 'momentum',
  overlay: false,
  inputs: {
    fast: { kind: 'int', label: 'Fast length', default: 12, min: 1 },
    slow: { kind: 'int', label: 'Slow length', default: 26, min: 1 },
    signal: { kind: 'int', label: 'Signal smoothing', default: 9, min: 1, max: 50 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero line', value: 0, color: 'rgba(154, 164, 178, 0.5)' },
    {
      type: 'plot',
      id: 'hist',
      title: 'Histogram',
      kind: 'columns',
      // Palette: index 0..3 below, chosen per bar in step().
      color: ['#7FB069', '#b2dfdb', '#ffcdd2', '#DE6A4F'],
    },
    { type: 'plot', id: 'macd', title: 'MACD', kind: 'line', color: '#6E9BD6' },
    { type: 'plot', id: 'signal', title: 'Signal', kind: 'line', color: '#E0A93B' },
  ],
  setup({ inputs, ta }) {
    const GROW_ABOVE = 0;
    const FALL_ABOVE = 1;
    const GROW_BELOW = 2;
    const FALL_BELOW = 3;
    const fastMa = ta.ema(inputs.fast);
    const slowMa = ta.ema(inputs.slow);
    const signalMa = ta.ema(inputs.signal);
    return (c) => {
      const x = c.src.source[c.i];
      const macd = fastMa.update(x) - slowMa.update(x);
      const signal = signalMa.update(macd);
      const hist = macd - signal;
      // c.get reads this script's own output at an earlier bar.
      const prev = c.i > 0 ? c.get('hist', c.i - 1) : NaN;
      let color;
      if (Number.isNaN(hist))
        color = NO_COLOR; // warm-up: draw nothing
      else if (hist >= 0) color = prev < hist ? GROW_ABOVE : FALL_ABOVE;
      else color = prev < hist ? GROW_BELOW : FALL_BELOW;
      c.set('hist', hist, color);
      c.set('macd', macd);
      c.set('signal', signal);
    };
  },
});
```

### ZigZag (repainting)

Pivots over `depth / 2` bars on each side are confirmed that many bars late; a further extreme in the same
direction moves the last pivot back in time with `c.setAt`, so the script declares `repaints: true`. All
carried state is in `ta.vars`, so live ticks rewind correctly. The tie rules (the oldest of equal extremes wins)
follow the ZigZag library semantics below and are not `ta.pivotHigh`'s.

```js
// ZigZag (library semantics): swing pivots over `legs` bars
// on each side, confirmed `legs` bars late, joined by a line. A further
// extreme in the same direction moves the last pivot back in time, so past
// values repaint (setAt).
defineIndicator({
  name: 'My ZigZag',
  shortName: 'MyZZ',
  category: 'other',
  overlay: true,
  repaints: true,
  inputs: {
    deviation: {
      kind: 'float',
      label: 'Price deviation for reversals (%)',
      default: 5,
      min: 0.00001,
      max: 100,
      step: 0.5,
    },
    depth: { kind: 'int', label: 'Pivot legs', default: 10, min: 2, max: 500 },
    extendToLastBar: { kind: 'bool', label: 'Extend to last bar', default: true },
    showPrice: { kind: 'bool', label: 'Display reversal price', default: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'zz',
      title: 'ZigZag',
      kind: 'line',
      color: '#6E9BD6',
      lineWidth: 2,
      connectGaps: true,
      showLastValue: false,
    },
    {
      type: 'shape',
      id: 'hiLbl',
      title: 'High Label',
      shape: 'labelDown',
      location: 'absolute',
      color: '#6E9BD6',
      textColor: '#ffffff',
      textFromValue: true,
    },
    {
      type: 'shape',
      id: 'loLbl',
      title: 'Low Label',
      shape: 'labelUp',
      location: 'absolute',
      color: '#6E9BD6',
      textColor: '#ffffff',
      textFromValue: true,
    },
  ],
  setup({ inputs, ta }) {
    const legs = Math.max(2, Math.floor(inputs.depth / 2));
    const { deviation, showPrice, extendToLastBar } = inputs;
    // All state carried across bars lives in ta.vars so live ticks can rewind it.
    // dir: 1 last pivot is a high, -1 a low, 0 none yet.
    const st = ta.vars({ dir: 0, bar: -1, price: NaN, prevBar: -1, prevPrice: NaN, extBar: -1 });

    // Value `legs` bars back if no newer bar of the window goes beyond it and
    // no older bar reaches it (the oldest of equal extremes wins); else NaN.
    function swing(values, i, isHigh) {
      if (i < 2 * legs) return NaN;
      const p = values[i - legs];
      if (Number.isNaN(p)) return NaN;
      for (let k = i - legs + 1; k <= i; k++) {
        if (isHigh ? values[k] > p : values[k] < p) return NaN;
      }
      for (let k = i - 2 * legs; k < i - legs; k++) {
        if (isHigh ? values[k] >= p : values[k] <= p) return NaN;
      }
      return p;
    }

    function draw(c, bar, price, isHigh) {
      c.setAt('zz', bar, price);
      if (showPrice) c.setAt(isHigh ? 'hiLbl' : 'loLbl', bar, price);
    }

    function erase(c, bar, isHigh) {
      c.setAt('zz', bar, NaN);
      if (showPrice) c.setAt(isHigh ? 'hiLbl' : 'loLbl', bar, NaN);
    }

    function candidate(c, bar, price, dir) {
      const isHigh = dir > 0;
      if (st.dir === dir) {
        // Same direction: only a further extreme moves the last pivot.
        if (isHigh ? !(price > st.price) : !(price < st.price)) return;
        erase(c, st.bar, isHigh);
        // The bar also held the opposite pivot: show that one again.
        if (st.prevBar === st.bar) draw(c, st.prevBar, st.prevPrice, !isHigh);
        st.bar = bar;
        st.price = price;
        draw(c, bar, price, isHigh);
        return;
      }
      if (st.dir !== 0) {
        const pct = (100 * (price - st.price)) / Math.abs(st.price);
        const reversal = isHigh ? pct >= deviation : pct <= -deviation;
        if (!reversal) return;
      }
      st.prevBar = st.bar;
      st.prevPrice = st.price;
      st.dir = dir;
      st.bar = bar;
      st.price = price;
      draw(c, bar, price, isHigh);
    }

    return (c) => {
      // Drop the provisional end point drawn on an earlier last bar.
      if (st.extBar >= 0 && st.extBar < c.i) {
        c.setAt('zz', st.extBar, NaN);
        st.extBar = -1;
      }
      const hi = swing(c.high, c.i, true);
      if (!Number.isNaN(hi)) candidate(c, c.i - legs, hi, 1);
      const lo = swing(c.low, c.i, false);
      if (!Number.isNaN(lo)) candidate(c, c.i - legs, lo, -1);
      if (extendToLastBar && c.isLast && st.bar >= 0) {
        c.set('zz', c.close[c.i]);
        st.extBar = c.i;
      }
    };
  },
});
```

### Type declarations

[`user-scripts.d.ts`](user-scripts.d.ts) declares `defineIndicator`, `NO_COLOR`, `PRICE_SOURCES`, `calendarPeriod`,
`ta` and the step context. Save it next to your script in your own editor (VS Code, WebStorm) and start the
script with `// @ts-check` for completion and type errors. It is optional: the app runs plain JavaScript and never
reads it.
