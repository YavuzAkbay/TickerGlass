# Plan: user JS indicators in a sandboxed worker (Phase 12, optional item)

Working spec for implementation. Approved 2026-10-20. Delete once `docs/user-scripts.md` is written (step 10).

## 0. Existing facts relied on

- Definitions (`packages/indicators/src/types.ts`, `registry.ts`): plain object with metadata, `inputs`, `outputs`, `setup(ctx) => step(c)`. All running state goes through `ta` primitives so the runtime can snapshot/rewind (`instance.ts`). `defineIndicator` is identity. `IndicatorRegistry` has `register/get/list`, no `unregister`; `register` throws on duplicate id. `FromInputs` lets hline `value`, `offset`, VP fields and `warmup.bars` be functions.
- Worker: `apps/web/src/indicators/worker.ts` creates `WorkerCore` (`workerCore.ts`), which takes an optional `IndicatorRegistry`, never throws, posts `results / timeframes / symbols / resync / error`. Main thread talks only via `WorkerPort` (`post / listen / terminate`, `controller.ts`). `attach.ts` builds the port with `createIndicatorWorker()`. **This port is the seam.**
- Bars protocol: reset sends columnar transferred `Float64Array`s; live `{type:'bar', index, bar}`; results are transferred tail slices. Revision/resync rules: `docs/indicators.md` §5.
- Main thread uses `getIndicator(inst.type)` in controller, `model.ts` (`validateInstances`, `studyTitle`, `sourceRefOf`), `menu.ts` (`sourceOptions`), settings dialog, alerts `dialog/sources.ts`. Missing def → "Unknown indicator" error.
- `apps/web/src/dialogs/IndicatorsDialog.tsx` already has "My scripts" category with empty state.
- No CSP anywhere (nginx, vite, index.html). Web deps: react, zustand, lucide only.
- Persistence: user content in API tables with revisions (notes/watchlists are closest models). Settings LWW static key list (`persist/settingsSync.ts`). Export bundle has additive sections.
- Alerts: Node service evaluates with registry; `packages/alerts/src/validate.ts:checkRegistry` rejects unknown/repainting/symbol-input indicators.
- e2e runs against `vite dev`, `window.chart` exposed, API mocked in `e2e/persistence.ts`.

## 1. Authoring model — same `defineIndicator({...})` API as builtins

Script contract (apiVersion 1):
- Plain ES2022 JS, run as strict-mode function body. Must call `defineIndicator({...})` exactly once; return value ignored.
- Injected frozen params: `defineIndicator`, `NO_COLOR`, `PRICE_SOURCES`, `calendarPeriod`. No `import`.
- Script `id` ignored; registry id forced to `user:<scriptId>`. Persisted in `IndicatorState.type` — **never change format**.

`validateUserDefinition` restrictions (v1, relaxable later):
- Input kinds: `int float bool source color enum time` only (no `timeframe`/`symbol`).
- `source` defaults/values: price sources only.
- No functions in outputs or warmup (`offset`, hline `value`, VP fields, `warmup.bars`) — static only, so main thread holds pure-JSON manifest and never runs user code.
- ≤64 outputs, ≤64 inputs, strings ≤200 chars.
- Colors strict regex (hex, rgb(), rgba(), hsl(), hsla(), CSS named). Blocks `url(...)`.
- `repaints: true` and `setAt` allowed.

Manifest: JSON copy of definition without `setup` (`toManifest`), produced by sandbox. Main re-validates with `parseManifest` (strict whitelist, rejects unknown keys and `__proto__`). `definitionFromManifest` builds stub whose `setup` throws "user scripts run in their sandbox"; stub registered in main `defaultRegistry` so dialogs, legend, `resolveOutputs`, controller work unchanged.

## 2. Sandbox

Topology: one dedicated module worker per user-script instance. `MAX_SCRIPT_INSTANCES_PER_CHART = 8`. (Fallback if CSP fails in prod: opaque-origin `<iframe sandbox>` hosting worker.)

Lockdown:
1. **Worker response CSP** (real boundary). Page gains no CSP.
   - Prod (nginx) and `vite preview`: `default-src 'none'; script-src 'unsafe-eval'; connect-src 'none'; worker-src 'none'` (no `'self'`: blocks every script load incl. same-origin `import()`).
   - `vite dev`: same but `script-src 'self' 'unsafe-eval'` (Vite dev serves the worker as separate same-origin modules).
   - Dev/preview: Vite plugin `sandboxCsp()` in `apps/web/vite.config.ts` (`configureServer` middleware for `/src/indicators/sandbox/sandbox-worker.ts`, `configurePreviewServer` middleware for `/assets/sandbox-worker-<hash>.js`).
   - Prod: entry `sandbox-worker.ts` → `assets/sandbox-worker-<hash>.js`; `docker/nginx.conf`: `location ~ ^/assets/sandbox-worker-[^/]+\.js$ { add_header Content-Security-Policy "…" always; try_files $uri =404; }`.
   - Build guard (required by the no-`'self'` policy): `worker.format: 'iife'`; worker plugin `sandboxWorkerSelfContained()` fails the build if the sandbox worker bundle has chunk imports/dynamic imports or emits any other file; app plugin `sandboxWorkerNoAssetRefs()` fails it if the emitted worker file names any other emitted file.
2. **JS lockdown** (`sandbox/lockdown.ts`, before user code): capture `post = self.postMessage.bind(self)`, register `message` listener; then make undefined on `self` (defineProperty non-writable non-configurable) and delete from `DedicatedWorkerGlobalScope.prototype` / `WorkerGlobalScope.prototype` where configurable: `fetch XMLHttpRequest WebSocket WebSocketStream WebTransport EventSource importScripts indexedDB caches Worker SharedWorker BroadcastChannel MessageChannel postMessage Notification WebAssembly setTimeout setInterval queueMicrotask requestAnimationFrame navigator`.
3. **Main side validates everything**: port accepts only `results` for its own instance id with `Float64Array`/`Uint8Array` values; manifests via `parseManifest`.

Compile + line numbers:
- `new Function('defineIndicator','NO_COLOR','PRICE_SOURCES','calendarPeriod', '"use strict";\n' + source + '\n//# sourceURL=user-script.js')`.
- At boot, compile probe via same wrapper (`throw new Error()` on body line 1) → `lineOffset`.
- Sandbox wraps `setup` and returned `step` in try/catch, rethrows `annotate(err)` → `TypeError: x is undefined (line 12:5)`. Stack regex `/user-script\.js:(\d+):(\d+)/` (Chrome + Firefox). `instance.ts fail()` keeps `err.message` so line flows through.
- Syntax errors: editor parses first with **acorn** (lazy, editor chunk only, `ecmaVersion:'latest', allowReturnOutsideFunction:true`). Sandbox message is fallback.

Watchdog (main thread, in port):
- Messages to sandbox wrapped `{seq, msg}`; sandbox posts `{type:'ack', seq}` after handling.
- Deadline from post time of oldest unacked: 10 s for `load`, `bars`, `check`; 5 s otherwise. Idle `ping` every 10 s.
- Miss → `terminate()`, instance error `"Stopped: no response for N s (endless loop?)"` with `killed` flag. No auto restart; new `setInputs`, re-save, or reload respawns.
- Worker `onerror` → error on that instance id, never fatal for controller.

Memory: no per-worker cap in browsers; documented Inherent.

## 3. Data protocol: `ScriptRouterPort implements WorkerPort`

`apps/web/src/indicators/sandbox/port.ts`, wraps real indicator worker port. `attach.ts`: `worker: new ScriptRouterPort(createIndicatorWorker(), deps)`. Controller nearly untouched.

`post(msg, transfer)` routing:
- `add` with `user:` type: spawn sandbox, send `load {source, apiVersion, scriptId}`, replay stored `context` + copy of **SeriesMirror**, then `add` with `coerceInputs(def, inputs)`. Else forward to inner.
- `setInputs`, `remove`: route by instance id.
- `bars`: copy into mirror first (`SeriesMirror.reset`; buffers detach after transfer), post to inner with transfer, then post mirror copies to each sandbox (structured clone).
- `bar`: apply to mirror (update/append; mismatch → mirror dirty until next `bars`), broadcast.
- `context`: store + broadcast. `clear`: reset mirror + broadcast.
- `timeframeMap`, `tfBars`, `tfBar`, `extBars`, `extUpdate`: inner only.

From sandbox:
- `results`: filter to own id, pass through.
- `error` without id → rewrite to `{id}`.
- `timeframes`, `symbols`: drop.
- `resync`: handled inside port by re-posting mirror to that sandbox, ≤3 per revision; never forwarded.
- `loaded {manifest}`: compare with stored manifest via canonical JSON; mismatch → error "Script changed since it was saved – open the editor and save again".

Other: `reloadScript(scriptId)` terminates/respawns all instances of script + replay. `terminate()` kills all.

`sandbox/protocol.ts`:
```ts
type ToSandbox = { seq: number; msg:
  | Extract<ToWorker, { type: 'context' | 'add' | 'setInputs' | 'remove' | 'bars' | 'bar' | 'clear' }>
  | { type: 'load'; source: string; apiVersion: 1; scriptId: string }
  | { type: 'ping' }
  | { type: 'check'; bars: BarColumns; context: RuntimeContext; inputs: InputValueMap; liveBars: number } };
type FromSandbox =
  | FromWorker
  | { type: 'ack'; seq: number }
  | { type: 'loaded'; manifest: UserScriptManifest }
  | { type: 'compileError'; message: string; line?: number; col?: number }
  | { type: 'checkResult'; ok: boolean; mismatch?: { outputId: string; index: number; full: number; live: number } };
```
Inside worker, `SandboxCore` (testable in-process like `WorkerCore`) compiles script, registers in **private** `IndicatorRegistry`, delegates `ToWorker` subset to `new WorkerCore(post, registry)`.

## 4. Live-consistency Check

`check`: full compute on n bars vs compute on n−K bars then last K bars via `updateBar` (each first gets a perturbed `update` tick, then final value). K=50. Compare `|a−b| <= 1e-9·max(1,|b|)`, NaN==NaN. Report first mismatching output + index. Editor runs it on Save on current chart bars; warns, doesn't block.

## 5. Storage — new `user_scripts` table

- Columns: `id` (client UUID, `[A-Za-z0-9_-]{1,36}`), `name` (1–100, not unique), `source` (text ≤200,000 chars), `manifest` (JSON or null if last save didn't compile, ≤64 KB), `api_version` int, `revision`, `created_at`, `updated_at`.
- Endpoints: `GET /api/user-scripts` (full list incl. sources), `POST` (409 with `current` if id taken), `GET/PUT {name, source, manifest, apiVersion, revision?}` (409 on stale revision) / `DELETE` on `/api/user-scripts/{id}`.
- Bundle: additive `userScripts` section; `merge` by id; `replace` empties table only when key present. `BUNDLE_VERSION` stays 1.

Web client: load at bootstrap; cache in localStorage `investopen-user-scripts` (read-only offline copy). Mutations require API. Explicit save only (button, Ctrl/Cmd+S). Confirm on close with unsaved changes. 409 → toast "Reload"/"Overwrite".

References/lifecycle:
- `IndicatorState.type = 'user:<scriptId>'`. `newInstanceId` replaces chars outside `[A-Za-z0-9_-]` with `_` (no effect on builtins). Favorites, "Save as default", templates key on type → work unchanged.
- Script change: register new stub → `ctl.sync` (controller `outputsKey` diff calls `updateStudySpec`) → `port.reloadScript(id)`. Inputs via `coerceInputs(def, given)` (keeps valid, defaults invalid, never throws); `validateInstances` and settings dialog use it for `user:` types. Style overrides keyed by output id; unknown ignored.
- Script deleted (confirm dialog lists instances in current layout, offers removal): instances remain, show "Script deleted"; return if script reappears. Manifest null → "Script has errors – open it in the editor". Controller unknown-type branch uses `userScriptProblem(type)`.

## 6. Isolation rules (helper `isUserScriptType(type)` in indicators package)

- `menu.ts sourceOptions`: user instances get price sources only; builtins never list user-script outputs.
- `validateInstances`: reject cross user/builtin references.
- Legend menu: "Add indicator on…" and "Add alert…" disabled for user instances with tooltip.
- `IndicatorsDialog`: when `sourceOf` set, filter out user defs.
- Alerts `dialog/sources.ts indicatorOptions` and `firstOutputId`: skip `user:`.

## 7. UI

- `apps/web/src/dialogs/ScriptEditorDialog.tsx`, lazy via `DialogHost.tsx` key `scriptEditor`. Left: script list (New from template, Rename, Duplicate, Delete). Main: `<textarea>` + synced line-number gutter, Tab inserts 2 spaces, monospace. Toolbar: Save, "Add to chart", Check. Bottom: diagnostics (acorn, compile, Check); click → `setSelectionRange`.
- Save flow: acorn parse → throwaway sandbox `load` → `check` on `copyColumns(chart.store)` → persist `{source, manifest|null}`.
- IndicatorsDialog "My scripts": defs with `user:` ids, "New script" button, Edit icon per row; re-render on scripts store change.
- Legend "More" menu: "Edit script…" for user instances.
- Runtime errors reuse legend error status (now with line number).

## 8. Tests

- `packages/indicators/src/user-script.test.ts`: validateUserDefinition rejections (function outputs, tf/symbol inputs, too many outputs, bad colors incl `url(`); manifest round-trip; parseManifest rejects `__proto__`/unknown keys; coerceInputs; compileUserScript (0 or 2 defineIndicator calls, line annotation with probe offset, strict mode).
- Golden reuse: `packages/indicators/test/user-scripts/{sma,rsi,macd,bollinger,zigzag}.js` + `test/user-scripts.test.ts`: compile in Node, compare to existing `test/golden/*.csv` same tolerance; incremental==full (as `test/incremental.test.ts`); zigzag repaint-tick sequence.
- Web: `sandbox/mirror.test.ts`; `sandbox/port.test.ts` (fake workers + timers: routing/broadcast, inner gets transferred / sandboxes copies, internal resync, id-less error → id'd, watchdog 5/10 s + ping, reloadScript replay, instance cap, spoofed results dropped); `sandbox/sandboxCore.test.ts` (compile errors with lines, determinism, check flags closure-state script and passes correct one); `sandbox/lockdown.test.ts` (fake global). Isolation in `indicators.test.ts`, `controller.test.ts`.
- API: `api/tests/test_userdata.py` CRUD, 409s, size limits, bundle merge/replace, migration head.
- e2e `e2e/sandbox.spec.ts` via dev hook `window.sandboxProbe(code)`: fetch, XHR, WebSocket, `import('https://example.com/x.js')`, `import('data:text/javascript,')` fail; `new Function` works; terminate stops `while(true){}`; line offset correct.
- e2e `e2e/user-scripts.spec.ts`: (1) create/save/add → legend value + mock recorded POST; (2) throw on line 7 → legend error has "line 7"; (3) `while(true){}` in step → "Stopped…" within ~7 s and builtin SMA still updates; (4) `fetch('/api/layouts')` → mock records no request; (5) reload restores; (6) delete → "Script deleted". Mock `/api/user-scripts*` in `e2e/persistence.ts`.

## 9. Ordered steps (each committable)

1. **[careful] Spike: worker CSP + lockdown.** `sandbox/sandbox-worker.ts` (minimal: lockdown, eval-probe, ack), `sandbox/lockdown.ts` + test, `vite.config.ts` `sandboxCsp()`, `docker/nginx.conf`, dev hook `window.sandboxProbe` in `apps/web/src/chart/ChartView.tsx` next to `window.chart` (DEV or e2e flag), `e2e/sandbox.spec.ts`. Done: e2e passes Chromium; Firefox manual; docker build `curl -I` on hashed asset. If Chromium doesn't apply worker response CSP in Vite dev: enforce in build/nginx only, keep JS lockdown, record dev-only import() exposure in LIMITATIONS. If fails in prod too: STOP, escalate (option D iframe).
2. **[careful] Indicators package core.** New `packages/indicators/src/user-script.ts` (`USER_SCRIPT_PREFIX`, `isUserScriptType`, `scriptIdOf`, `USER_SCRIPT_API_VERSION`, `validateUserDefinition`, `toManifest`, `parseManifest`, `definitionFromManifest`, `compileUserScript(source, {lineOffset})`, `annotateError`). `resolve.ts` `coerceInputs`. `registry.ts` `unregister(id)`. New `src/core.ts` (all but builtins) + package export `"./core"`. Exports in `index.ts`. Test `user-script.test.ts`. Additive changes.
3. **[careful, math] Golden reuse.** `test/user-scripts/*.js`, `test/user-scripts.test.ts`. Public API only: RSI via `ta.rma`, MACD histogram palette with `NO_COLOR`, Bollinger with fill, ZigZag with `setAt`. Done: matches golden CSVs; incremental==full.
4. **[careful] SandboxCore + real entry.** `sandbox/protocol.ts`, `sandbox/sandboxCore.ts` + test, finish `sandbox-worker.ts`. `workerCore.ts` imports from `@investopen/indicators/core`; `worker.ts` adds `import '@investopen/indicators'` so builtins stay registered there and sandbox bundle stays small.
5. **[careful] SeriesMirror, ScriptRouterPort, watchdog.** `sandbox/mirror.ts` + test, `sandbox/port.ts` + test, `createSandboxWorker()` modelled on `createIndicatorWorker`. Wire in `attach.ts` with stub `getScript` returning nothing.
6. **[routine, backend; parallel after 1]** `api/src/investopen_api/models.py` `UserScript`, Alembic migration, `userdata/schemas.py`, `routes/user_scripts.py`, `app.py` include, bundle section in `userdata/store.py`, `api/tests/test_userdata.py`, `docs/persistence.md` §1/§2/§4.
7. **[routine] Web data layer.** `apps/web/src/api/persistence.ts`, `api/types.ts`; new `apps/web/src/scripts/store.ts` (zustand: scripts, loaded), `scripts/definitions.ts` (diff stubs in/out of `defaultRegistry`), `persist/userScripts.ts` (load, cache, save, delete with revisions); `persist/bootstrap.ts`; `e2e/persistence.ts` mock. `attach.ts`: subscribe to scripts store → register stubs → `ctl.sync()` → `port.reloadScript(id)` per changed script.
8. **[routine] Isolation + messages.** `indicators/model.ts`, `indicators/menu.ts`, `dialogs/IndicatorsDialog.tsx`, `alerts/dialog/sources.ts`, `indicators/controller.ts` (`userScriptProblem`, instance cap error), `dialogs/IndicatorSettingsDialog.tsx`. Tests in `indicators.test.ts`, `controller.test.ts`.
9. **[routine UI] Editor.** `dialogs/ScriptEditorDialog.tsx` + CSS, `DialogHost.tsx`, "My scripts" list/New/Edit in `IndicatorsDialog.tsx`, "Edit script…" in `indicators/menu.ts`. Add `acorn` to `apps/web/package.json` (dynamic import, editor only).
10. **[routine] Docs.** New `docs/user-scripts.md` (§10). `docs/indicators.md` new §5a sandbox port protocol + `core` export + `user:` prefix. LIMITATIONS rows (§11). Tick ROADMAP item. Delete this plan file.
11. **[routine] e2e** `e2e/user-scripts.spec.ts`.

## 10. `docs/user-scripts.md` outline

1 Quick start (SMA cross with shapes, from "My scripts"). 2 Script shape (defineIndicator once, injected names, strict, ES2022, no imports, id ignored, apiVersion 1). 3 Metadata/inputs (allowed kinds, link indicators.md §1). 4 Outputs (static only), palettes, NO_COLOR. 5 Compute model: setup/step, context `c` (`i`, OHLCV, `src`, `inputs`, `env`, `set`, `setColor`, `get`, `setAt`, `isLast`), `ta` reference with signatures, state rules (`ta.vars`, `series`, `history`; closure state breaks live; Check), repainting. 6 Errors/limits (line numbers, 5/10 s, no network/storage/timers, sizes, 8/chart, memory). 7 Not supported. 8 Saved charts (edit/rename/delete effects, export/import). 9 Security model (guarantees vs not; warning on pasted code). 10 Examples (RSI hlines+fill, palette histogram, ZigZag repaint) + downloadable `user-scripts.d.ts`.

## 11. LIMITATIONS rows (new "User scripts" subsection under Indicators)

- No scripts in alerts (Node service has no sandbox). Planned/proposal: `node:vm` in separate process with timeout, or `isolated-vm`.
- No indicator-on-indicator to/from scripts; no timeframe/other-symbol inputs. Planned: forward `tfBars`, `extBars`, results through port.
- Output fields can't depend on inputs (JSON manifest). Inherent v1. Workaround: plot.
- Memory not capped. Inherent; instance cap + output limits mitigate.
- Slow legit script on long history can be stopped by 5/10 s watchdog. Inherent heuristic.
- Live vs reloaded values differ if state kept outside `ta`. Inherent; Check detects.
- Line numbers depend on engine stack formats (Chromium + Firefox verified).
- Network isolation relies on CSP header from Vite/bundled nginx; custom proxies/CDNs must keep it, else only JS lockdown (dynamic import() open). Page has no CSP (separate hardening item).
- Dev server only: worker CSP keeps `script-src 'self'`, so user code can send same-origin GET requests via `import('/…')` (response not readable, nothing leaves the origin). Prod/preview block it (no `'self'`). Inherent to Vite dev module serving.
- No version history; no TypeScript/standard.

## 12. Non-goals

TS/standard; CodeMirror; sharing/community library; version history; scripts in alerts; scripts reading other indicators/scripts/timeframes/symbols; input-dependent outputs; strategies/backtesting; drawings/tables from scripts; page-wide CSP; CPU/memory DoS protection beyond watchdog; multi-user/auth.

## 13. Hard to change later

`user:<scriptId>` type format; `defineIndicator` script contract + `apiVersion`; `user_scripts` table + bundle section. Rest is internal.
