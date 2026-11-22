# Design: alerts on user scripts (roadmap v2 · 1.3)

Status: `done` (v1).

Today a [user script](../user-scripts.md) runs only in the browser, in a locked-down Web Worker. The
alerts service (`services/alerts`, Node 24) has no definition for `user:<id>` types, so
`validateAlert` → `checkRegistry` reports `unknown_indicator`, and the web dialog hides script
indicators on purpose (`apps/web/src/alerts/dialog/sources.ts` `indicatorOptions`). This item lets a
script's outputs be alert operands, evaluated server-side with the same results as on the chart.

## Decisions

1. **Isolation: `isolated-vm`.** One V8 isolate per script id (shared by every series/alert that uses
   it). `node:vm` is not a security boundary, and Node's permission model can't block network.
   Inside the isolate there is no `process`, `require`, `fetch`, timers, or host object: only what we
   copy in. Limits:
   - heap: `memoryLimit` 128 MB per isolate (`ALERTS_SCRIPT_MEMORY_MB`). It does not count resizable
     `ArrayBuffer`s, growable `SharedArrayBuffer`s or `WebAssembly.Memory`: the isolate entry removes
     `WebAssembly` and `SharedArrayBuffer` and wraps `ArrayBuffer` so no resizable buffer can be made
     (`hardening.ts`), and compose caps the container (`mem_limit: 1280m`);
   - time: load + first full compute 10 s (`ALERTS_SCRIPT_LOAD_MS`), per update call 250 ms
     (`ALERTS_SCRIPT_TICK_MS`);
   - CPU: live updates only (`isolate.cpuTime`): over a sliding 5 minutes an isolate may use
     `ALERTS_SCRIPT_CPU_PCT` (20 %) of one CPU and all isolates together `ALERTS_SCRIPT_CPU_TOTAL_PCT`
     (50 %; the one that used most is faulted), judged once 30 s of history exist;
   - `Intl` and the ICU-backed `toLocale*` / `localeCompare` / `normalize` methods are removed in the
     isolate (ICU memory is outside the heap limit); the calendar keeps a captured, bounded
     `Intl.DateTimeFormat`;
   - **calls**: every call is an asynchronous IPC request to the script child process, so no script work
     runs in the service's process or blocks its event loop; a live update is kept per series and sent
     when the isolate has nothing queued (tick limit);
   - **process isolation**: the isolates live in a child process because `isolated-vm`'s memory limit is a
     guideline (unbounded `Set` / object / `WeakRef` growth makes V8 abort its process). The service pings
     it (5 s / 10 s), caps its resident memory (`ALERTS_SCRIPT_PROCESS_MB`), faults the scripts that had a
     call in flight when it died (only when sole in flight, in flight at 2 of the last 3 deaths, or the
     largest isolate when killed for memory; others get a short uncounted hold), holds everything after 3
     unattributed crashes in 10 min, gives up the least recently used idle isolate (or refuses new ones)
     over 85 % of the cap, and restarts it
     with a 1 s to 30 s back-off; fault state and result validation stay in the service;
   - **results are untrusted**: every isolate result is validated on the host before use (envelope,
     instance hash among the series' own, `from` an integer in `[0, bars]`, values `Float64Array` of a
     declared plot, length at most the bars after `from`, manifest re-parsed); violations are script
     errors, not crashes. The entry catches everything a script throws and answers with an envelope, so
     errors that escape a call are the isolate's own (timeout, death) and are classified by
     `isolate.isDisposed` and the measured call time, never by message text;
   - **faults** (load/compute timeout, OOM, isolate death, CPU budget; a live-update timeout is a strike
     affecting only its series, 3 within 10 min are a fault): dispose the isolate and hold the script for 5 min (doubling per repeat, up to
     1 h; the count resets after an hour without a fault). A fault is **not** an alert error: the alerts
     keep their status, are detached with their state (previous sample cleared, like a script edit) and
     re-attached when the hold ends (2 to 10 s spread). `status: error` is posted only for deterministic problems or for the
     second consecutive fault at the 1 h cap.
2. **The runtime runs inside the isolate.** A build step bundles an isolate entry (`compileUserScript`
   - `IndicatorRuntime` + `ta` from `@tickerglass/indicators` core, IIFE, no Node APIs) into a string
     the service evaluates in each new isolate. The host only crosses the boundary per series per bar:
     `setBars(seriesKey, bars)` / `updateBar(seriesKey, bar)` return the values of the requested outputs
     for the affected bars (Float64Array copies). Per-bar `step` calls never cross.
3. **Scripts are leaves.** As in the browser, scripts get only the series' own OHLCV; they can't read
   other indicators and other indicators can't read them (LIMITATIONS). The validator rejects an
   indicator instance whose source is a script output. So user instances live in a separate
   per-series runtime inside the isolate; the built-in `IndicatorRuntime` in `series.ts` is unchanged
   and `env.indicator(hash, out, i)` routes `user:` hashes to the script host's cached results.
4. **Follow the latest saved version.** There is no script version history to pin to. The service
   loads `GET /api/user-scripts` (source + manifest + revision) at every sync (60 s, `X-Alerts-Token`
   already allows GETs). When a script's revision changes: recompile, recompute from history, and
   **warm-restart** the affected alerts (previous sample cleared, so an edit can't cause a crossing
   fire). Unsaved editor changes are never used.
   - Script deleted → alert `status: error`, "script was deleted".
   - Script has no manifest (compile error) → error with the compile message.
   - The manifest the isolate compiled (repaints, plot ids, input ids and kinds) differs from the stored one
     → error "saved manifest is out of date — open and re-save the script". Alerts and validation trust
     the stored manifest, so it must describe what runs.
   - The alert's resolved inputs no longer match the manifest (input removed / kind changed) → error
     "script inputs changed — edit the alert". New inputs get their defaults.
   - Output id used by the alert no longer exists → error.
5. **Same Check semantics.** On load the host runs the existing Check (full compute on n−K bars, then
   K=50 live updates, compare with the full compute on n bars). A script that fails Check would give
   different live values than on a reload, so its alerts go to `status: error` with the first
   mismatch ("keep state in `ta`; see Check"). The check logic moves from
   `apps/web/src/indicators/sandbox/sandboxCore.ts` into `@tickerglass/indicators` so both use it.
6. **Validation without running code.** `validateAlert` gets a registry = built-ins + stubs from each
   script's stored manifest (`definitionFromManifest`, same as the web's `syncScriptDefinitions`).
   Existing `checkRegistry` rules apply unchanged: `repaints: true` scripts are refused
   (`unsupported_indicator`) because alerts can't use repainting values.
7. **Web.** The alert dialog offers script instances on the chart (same "chart symbol only" rule as
   built-ins), except repainting scripts and scripts without a manifest, which are listed disabled
   with the reason. The dialog says "Uses the script's latest saved version." The alert spec format is
   unchanged (`IndicatorRefInstance.type = "user:<id>"`).
8. **Packaging.** `isolated-vm` is a native addon: an `external` in the esbuild bundle, a production
   dependency of `services/alerts`, installed in the Docker alerts stage (build tools in the builder
   stage if no prebuilt binary matches; Node 24, the `isolated-vm` 7 binaries). The isolate bundle ships as
   `dist/isolate.js`; dev and tests build it on demand with esbuild. `isolated-vm` needs
   `--no-node-snapshot` on Node 20+: the image's `CMD`, the package's `start`/`dev` scripts and the vitest
   config pass it.

## Threat model

Single-owner self-hosted app; scripts are the owner's, possibly pasted from elsewhere. Goal is parity
with the browser sandbox: a script can't read data, reach the network, or touch the host; it can only
burn CPU up to its budget and memory up to its cap. Documented in LIMITATIONS.

## Tests

- Host: SMA/RSI/MACD golden scripts (`packages/indicators/test/user-scripts/*.js`) give the same values
  in the isolate as the built-ins, full and incremental; `while(true){}` → timeout → hold and the
  isolate is replaced; big allocation → OOM handled; resizable `ArrayBuffer` / `SharedArrayBuffer` /
  `WebAssembly.Memory` allocation loops error without growing the host; builtin overrides (`Math.min`,
  `Float64Array.prototype.slice`, `Map.prototype.get`) and hostile results (fake length, other script's
  hash, bad range) cannot crash the host or spoof another script; strikes, back-off, final fault, the
  one-hour reset and the CPU budget; the event loop keeps ticking during a slow compute and a result
  that arrives after an edit is dropped; `typeof process/require/fetch/globalThis.*` host leaks are all
  absent; Check failure detected.
- Service: crossing alert on a script plot fires; script edit → recompute, no spurious fire; deleted
  script → error; input mismatch → error; repaint script refused by the validator.
- Web: dialog lists script outputs; repainting / no-manifest scripts are disabled with the reason.

## Later

A CPU budget per series (today it is per script isolate, across its series), scripts reading other indicators, other-symbol/timeframe
inputs, pinning alerts to a script version (needs version history).
