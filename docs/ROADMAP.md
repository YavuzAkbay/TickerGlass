# InvestOpen Roadmap

Open-source (AGPL-3.0), self-hosted, single-user charting platform with reference-class features. Data source: yFinance. Tick items off as they land.

Known limitations (what you see, why, and Fixed / Planned / Inherent status): **[docs/LIMITATIONS.md](LIMITATIONS.md)**.

Decisions: AGPL-3.0 · custom Canvas2D chart engine · self-hosted single user (docker compose, no auth). Local-AI screen analysis is built separately; Phase 16 reserves its integration point.

## Architecture (recommended approach)

| Layer             | Choice                                                                                                                             | Why                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Data API          | Python 3.11 + FastAPI + uvicorn + yfinance + pandas                                                                                | yfinance is Python-only. FastAPI gives async, WebSockets, and OpenAPI out of the box.           |
| Storage           | SQLAlchemy 2 + Alembic. SQLite by default; Postgres via `DATABASE_URL` (compose profile)                                           | Single user, so SQLite is enough. Postgres stays optional, since `.env.example` already has it. |
| Market data cache | OHLCV table keyed by (symbol, interval, ts) + in-memory TTL cache; incremental fetch                                               | Stays under Yahoo rate limits and makes reloads instant                                         |
| Live prices       | yfinance `AsyncWebSocket` relayed to the browser over our own `/ws`; polling fallback                                              | Live last price for chart and watchlist                                                         |
| Frontend          | TypeScript + Vite + React (app UI only) + Zustand                                                                                  | React handles dialogs and panels. The chart stays framework-free for speed.                     |
| Chart engine      | Its own pure-TS package: layered Canvas2D, typed-array columns, index-based time axis                                              | Full control over drawings, Renko-type axes, replay, and the AI snapshot                        |
| Indicators        | Pure-TS package, run in a Web Worker on the client                                                                                 | One implementation, shared with the alert service                                               |
| Alerts service    | Small Node worker that reuses the TS indicator package, reads bars from the Data API, and evaluates server-side                    | Alerts fire with the browser closed, without re-implementing indicators in Python               |
| Monorepo          | pnpm workspaces + uv (Python)                                                                                                      | Packages: engine, indicators, web app, alerts service, API                                      |
| Tests             | Vitest (engine and indicators, golden values), Playwright (interaction and visual regression), pytest + recorded yfinance fixtures |                                                                                                 |
| Icons/UI          | Own design system; Lucide/Tabler (MIT) icons. **No reference name, logos, or icon assets**                                       | Trademark safety                                                                                |

Key design rules that make later phases cheap:

1. **DataFeed interface** (`getBars`, `subscribe`, `resolveSymbol`) in phase 2. Replay, compare, spread symbols (`AAPL/MSFT`), and custom intervals are all feed wrappers.
2. **Declarative drawing tool definitions** (anchors, render, hitTest, property schema, defaults). Once the framework exists, each of the ~90 tools takes a few hours.
3. **Declarative indicator definitions** (inputs schema, plots/fills/hlines/shapes outputs, incremental `update`). Settings dialogs are generated from the schema.
4. **Serializable chart state** (JSON). This one format drives layouts, templates, undo/redo, multi-chart sync, and the AI snapshot.
5. **Command bus** for every user action. It gives undo/redo, keyboard shortcuts, context menus, and the command palette from a single registry.

yfinance constraints to design around:

- Intraday history limits: 1m covers about 7 days per request and 30 days total; 2m–90m cover 60 days; 1h covers 730 days. Daily and above have full history.
- Native intervals: 1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo. Anything else (3m, 4h, 2D, …) is resampled client-side from the nearest lower native interval.
- Unofficial API, so expect breakage. Isolate it behind a single `providers/yahoo` adapter, and add retries/backoff plus a pinned version.
- Yahoo terms allow personal use only. The README needs a disclaimer: not affiliated, personal use, each user runs their own instance.

---

## Implementation checklist

### Phase 0: Foundations

- [x] `git init`, AGPL-3.0 `LICENSE`, README (scope, disclaimer: not affiliated with reference/Yahoo, personal use)
- [x] pnpm workspace + TS strict config, ESLint, Prettier; uv + ruff + mypy for Python
- [x] Vite + React app skeleton, Zustand store skeleton, theme tokens (dark/light)
- [x] FastAPI skeleton with `/health`; settings from env (`DATABASE_URL`, ports)
- [x] docker compose: `api`, `web` (nginx serving the built app and proxying `/api` + `/ws`), optional `postgres` profile, `alerts`
- [x] CI (GitHub Actions): lint, typecheck, unit tests, build
- [x] CONTRIBUTING.md (DCO sign-off), code of conduct

### Phase 1: Data backend (yfinance)

- [x] Yahoo provider adapter: history(symbol, interval, start/end, prepost), with retries, backoff, and a request rate limiter
- [x] OHLCV cache tables + Alembic migration; incremental fetch (only missing ranges); split/dividend adjustment flag
- [x] Respect per-interval range limits; chunk 1m requests into 7-day windows
- [x] `GET /api/bars` (symbol, interval, from, to, adjusted, prepost): columnar JSON or Arrow/msgpack for speed
- [x] `GET /api/symbols/search` (yf.Search), `GET /api/symbols/{s}` (meta: exchange, tz, session, currency, type, min tick)
- [x] `GET /api/quotes?symbols=` (batch snapshot for watchlists)
- [x] `/ws` live relay: client subscribe/unsubscribe → shared yfinance AsyncWebSocket; fan-out; polling fallback
- [x] `GET /api/events/{s}` (dividends, splits, earnings), `GET /api/news/{s}`, `GET /api/fundamentals/{s}` (info + financials)
- [x] pytest with recorded fixtures; contract tests for the bar format

Phase 1 notes (yfinance 1.7.0 quirks, revisit on upgrades):

- `Ticker.get_news()` returns nothing (upstream endpoint 404); news falls back to `yf.Search(...).news`.
- The live relay reads Yahoo's stream with yfinance private internals (`_connect`, `_ws`, `_decode_message`) because `AsyncWebSocket.listen` never returns on disconnect.
- Quotes report `currency` only once it is cached from a bars/symbol request; the frontend should take currency from `/api/symbols/{s}`.
- `dividendYield` from `/api/fundamentals` is already a percentage.

### Phase 2: Chart engine core (MVP chart)

- [x] DataFeed interface + HTTP/WS implementation; client resampler for non-native intervals
- [x] Columnar series store (Float64Array) with append/update-last-bar
- [x] Time scale: index-based (removes weekend/session gaps), bar spacing, right offset, visible range, smart time labels per zoom level, timezone support
- [x] Price scale: auto-scale, linear/log/percent/indexed-to-100, invert, left/right/overlay scales, tick-size-aware labels, last-price label + countdown to bar close
- [x] Layered canvases per pane (background/grid, series, overlay for drawings and crosshair); HiDPI; rAF render loop with dirty flags; render only the visible range
- [x] Panes: add/remove/resize/reorder/maximize/collapse
- [x] Interactions: drag pan, wheel zoom, axis drag scaling, double-click axis reset, kinetic scroll, pinch/touch, keyboard (arrows, +/-)
- [x] Crosshair (cross/dot/arrow), magnet modes (weak/strong), status line (OHLC + change under the symbol), legend
- [x] Lazy history loading on scroll-left; live bar updates
- [x] Hit-testing infrastructure (series, drawings, scales, panes) + cursor management
- [x] Engine public API + event emitter; `chart.getState()/setState()` JSON
- [x] Benchmark: 100k bars at 60fps pan/zoom; Vitest for scales and math

Phase 2 notes:

- Benchmark (`pnpm e2e`): 100k bars fully zoomed out, pan+zoom every frame: p50 16.7ms, p95 16.8ms (vsync-locked 60fps).
- `?feed=synthetic` runs the app on an offline random-walk feed (used by e2e tests).
- Pane resize/reorder/maximize/collapse exist in the engine API; UI controls arrive with Phase 3 context menus.

### Phase 3: App shell (standard layout)

- [x] Top toolbar: symbol button/search dialog (keyboard-first, type anywhere to search), interval picker + favorites + custom intervals, chart type menu, indicators button, compare, alert, replay, layout menu, undo/redo, settings, screenshot, fullscreen
- [x] Left drawing toolbar with grouped flyouts, favorites bar, magnet, stay-in-drawing-mode, lock all, hide all, remove all
- [x] Right sidebar: watchlist, alerts, object tree/data window, details, news, notes; resizable
- [x] Bottom panel: date range presets (1D 5D 1M 3M 6M YTD 1Y 5Y All), go-to-date, timezone, session toggle (ETH/RTH), %/log/auto toggles
- [x] Command bus + keyboard shortcut registry + command palette
- [x] Generic context-menu system (shared by chart, scales, drawings, indicators, watchlist rows)
- [x] Toasts, modals, settings dialog shell; themes

Phase 3 notes:

- Shell entries for later phases are present but inert, with a phase hint: chart types (4), indicators (5), drawing tools are selectable state only (6), layouts (7), compare (9), alerts (10), replay (13).
- Watchlist panel was a basic recent-symbols list in this phase; the full version landed in Phase 8.
- Settings dialog: Symbol, Canvas, and Scales tabs work; others are placeholders until Phase 15.

### Phase 4: Chart types

- [x] Bars, Candles, Hollow candles, Volume candles, Line, Line with markers, Step line, Area, HLC area, Baseline, Columns, High-Low
- [x] Heikin Ashi (transform)
- [x] Brick-type transforms on a non-time index: Renko (box size: ATR/fixed, wicks), Line Break, Kagi, Point & Figure, Range bars
- [x] Volume overlay/pane; extended-hours shading; price-line + bid/ask-style lines
- [x] Per-type style settings in the settings dialog (Symbol tab)

Phase 4 notes:

- Bid/ask lines and other data limitations: see [LIMITATIONS.md](LIMITATIONS.md#data-yahoo--yfinance).
- Brick types (Renko, Line break, Kagi, P&F, Range) size ATR-based boxes once per load, so bricks stay stable during live updates. Their indices are not time bars; indicators in Phase 5 should run on the displayed series (`chart.store`), with `chart.sourceIndexOf(i)` mapping back to time bars.

### Phase 5: Indicator framework + core set

- [x] Indicator definition API: inputs (int/float/bool/source/color/enum/timeframe), outputs (line/histogram/area/columns/circles/cross/step, hlines, fills, bgcolor, shapes/labels), overlay vs pane, precision
- [x] Worker runtime with incremental update on the last bar; recompute on data change
- [x] Indicator-on-indicator (source = other output); multi-timeframe inputs
- [x] Indicators dialog (search, categories, favorites); legend row with eye/settings/source/remove/more menu
- [x] Auto-generated settings dialog: Inputs / Style / Visibility (per-interval) tabs; defaults; "Save as default"
- [x] Core 25 with golden tests vs a reference (TA-Lib / pandas-ta CSVs): SMA, EMA, WMA, VWMA, HMA, VWAP, Anchored VWAP, Bollinger, Keltner, Donchian, Ichimoku, Parabolic SAR, Supertrend, RSI, MACD, Stochastic, Stoch RSI, CCI, ATR, ADX/DMI, OBV, MFI, Williams %R, Volume, Pivot Points Standard

Phase 5 notes:

- Design and worker protocol: `docs/indicators.md`. Golden references are regenerated with `uv run --no-project --python 3.11 --with ta-lib --with pandas --with numpy packages/indicators/scripts/golden.py` (synthetic 1000-bar input; TA-Lib where its warm-up matches standard, numpy otherwise).
- Indicator limitations (VWAP timezone/anchors, pivot types, MTF lookahead, ...): see [LIMITATIONS.md](LIMITATIONS.md#indicators). Bars context (exchange timezone, session, interval) and confirmed MTF alignment: `docs/indicators.md` §2/§4.
- Studies are not part of `chart.getState()`; the app re-adds them on `studiesCleared`. Phase 7 moves indicator persistence from localStorage to the API.

### Phase 6: Drawing framework + core tools

- [x] Drawing model: anchors in (time, price) space mapped to bar index; survives interval changes; per-symbol storage, or synced across all symbols
- [x] Create/select/drag/anchor-edit/multi-select/clone (Alt+drag)/copy-paste/lock/hide/z-order
- [x] Magnet snap to OHLC; Shift-constrain angles; floating mini-toolbar on select (color, width, style, settings, lock, delete)
- [x] Right-click menus for drawings (and the chart, scales, panes): settings, clone, copy, z-order, visibility per interval, lock, hide, remove, template
- [x] Properties dialog generated from the schema: Style / Text / Coordinates / Visibility tabs; per-tool style templates ("Save as… / Apply default")
- [x] Undo/redo via the command bus
- [x] Core tools: Trend line, Ray, Extended line, Info line, Horizontal line/ray, Vertical line, Cross line, Parallel channel, Fib retracement, Trend-based fib extension, Rectangle, Text, Arrow, Brush, Long/Short position, Price range, Date range, Date & price range (measure)
- [x] Object tree panel (list, reorder, hide/lock, delete)

Phase 6 notes:

- Design, tool definition API, and undo/persistence contract: `docs/drawings.md`.
- 20 core tools registered; toolbar entries without a definition are dimmed until Phase 11.
- Drawing limitations and their status (session-aware extrapolation, measure volume, box select, ...): see [LIMITATIONS.md](LIMITATIONS.md#drawings).
- Drawings persist to localStorage (`investopen-drawings`, per-symbol + synced buckets, backup on unreadable data, cross-tab merge); since Phase 7 that is the offline cache of the API (one row per drawing, see `docs/drawings.md` §6).

### Phase 7: Persistence, layouts, templates

- [x] API + DB: layouts, drawings, indicator templates, drawing templates, chart templates/themes, settings, notes
- [x] Autosave the chart layout (debounced); named layouts: save/save-as/rename/load/delete; restore on startup
- [x] Indicator templates (sets of indicators + settings); chart color/style templates
- [x] Import/export of layouts and templates as JSON

Phase 7 notes:

- Server and wire format: `docs/persistence.md`. Web side: `apps/web/src/persist/` (`bootstrap.ts` wires it up).
- Startup: one-time localStorage import (setting `migration.localStorage`, idempotent, originals kept plus `<key>.premigration` copies), then the last-used layout (or a new "Untitled"), drawings, settings, drawing templates and notes. API down: the browser copy is used, a toast says so, edits are kept (dirty flags in localStorage) and pushed on reconnect (every 15 s, `online` event, tab focus).
- Layout state = `chart.getState()` + indicator instances + chart settings; autosaved (1 s debounce) with revision checks. A 409 shows "Reload" / "Overwrite". The top-bar layout menu has save (Ctrl/Cmd+S), save as, rename, make a copy, load (searchable list with last-modified), delete, per-layout export/import, export all data / import data (dry-run preview, merge or replace with confirmation). The button shows unsaved / offline state.
- Drawings: store changes are batched to `POST /drawings/batch` with base revisions; conflicts load the saved version (toast). Refetch on symbol switch and tab focus.
- Indicator templates: top-bar button (save, apply = replace or add, rename, delete). Chart templates: Settings dialog "Template" menu. Drawing templates/defaults, favorites (intervals, indicators, drawing tools), indicator defaults and UI prefs sync through `/settings` and `/drawing-templates`. Notes: per symbol and general, revision-checked.
- e2e uses an in-test mock of the user-data API (`e2e/persistence.ts`), never a real database. Remaining limitations: [LIMITATIONS.md](LIMITATIONS.md#persistence).

### Phase 8: Watchlists

- [x] Multiple named watchlists; create/rename/delete/duplicate; sections/separators; drag reorder
- [x] Columns: last, change, change %, volume, ext-hours; sort; customizable columns
- [x] Live updates via `/ws`; price tick flash
- [x] Color flags (standard flag lists); right-click row menu (add alert, flag, remove, move to list, open in new chart)
- [x] Import/export `.txt`; add the current chart symbol; keyboard navigation (↑/↓ changes the chart symbol)
- [x] Details panel (key stats, performance, earnings date), news panel

Phase 8 notes:

- Server and wire format: `docs/persistence.md` (tables `watchlists` and `symbol_flags` in §1, endpoints in §2, conflicts in §3, bundle sections in §4, cache keys and the `watchlist.prefs` setting in §6). Market-data additions: `GET /api/quotes/extended`, `GET /api/performance/{symbol}`, `GET /api/news?symbols=`.
- Live quotes: `apps/web/src/quotes/` is one shared `/ws` client per tab (reference-counted subscriptions, 200-symbol cap, backoff, fallback polling of `/api/quotes` every 15 s while the socket is down, extended quotes every 60 s). Watchlist and Details read the same `useLiveQuotes` / `useLiveQuote` store.
- Watchlist data layer: `apps/web/src/watchlist/` (`store.ts` lists and flags, `prefs.ts` active list / columns / sort, `model.ts` rows, sorting, `.txt` parse and format, `commands.ts`); sync in `apps/web/src/persist/watchlists.ts`. A list is saved whole with a revision check (409 shows a toast with "Keep mine"); flags are global per symbol and last writer wins. The active list, columns and sort are the setting `watchlist.prefs`.
- Lists can be created offline (client-chosen ids). Flag colors appear as virtual lists under "Flagged" in the list switcher. The `.txt` import maps reference prefixes to Yahoo symbols and reports the ones it can't map.
- e2e: `e2e/persistence.ts` mocks the new endpoints; `e2e/market.ts` is an opt-in mock for quotes, performance and the `/ws` stream (`mockMarket`); `e2e/watchlist.spec.ts` covers the panel.
- Deferred: "Open in new chart" (Phase 14: a second tab would clobber the shared last-used layout), drag between lists and multi-select (Phase 15). Remaining limitations: [LIMITATIONS.md](LIMITATIONS.md#watchlists).

### Phase 9: Compare & symbol math

- [x] Compare dialog: add overlay symbols (same scale, new scale, new pane); auto-switch to percent scale
- [x] Symbol expressions: spread/ratio/arithmetic (`AAPL/MSFT`, `(A+B)/2`) through an expression feed wrapper
- [x] Time alignment across symbols with different sessions

Phase 9 notes:

- Design, grammar, OHLC and alignment math, paging and persistence: `docs/compare.md`. Code: `apps/web/src/compare/` (store, controller, actions, attach, legend, menu) and `packages/engine/src/feed/expression/` (lexer, parser, printer, evaluation, alignment) plus `packages/engine/src/feed/expression-feed.ts`.
- Overlays are engine studies whose data the app owns, like indicators. Each overlay has a placement: same percent scale as the main series, its own price scale, or a new pane. The first "same scale" overlay switches the main pane to percent mode (one undo step) and removing the last one (hiding does not) restores the previous mode.
- Grammar: `+ - * / ( )`, numbers and symbols, at most 8 distinct symbols. A hyphen inside a symbol run is part of the symbol when a letter or digit follows and the run already contains a letter, so `BRK-B`, `BTC-USD` and `AAPL-MSFT` are single symbols. A spread needs spaces: `AAPL - MSFT`. Quote a symbol to include other characters: `"BRK/B"` (quotes stay in the canonical form).
- Time axis: the first symbol is the primary leg and sets the bar times; other legs are joined as of each primary bar. Intraday intervals match on the UTC open time. Daily and higher intervals match on the calendar date in each leg's own exchange timezone. A leg is forward-filled for a limited time (4 days intraday, 10 days daily, 21 weekly, 93 monthly) and then leaves a gap.
- Expression bars: open and close are exact, high and low are an envelope and approximate; volume is always 0. See [LIMITATIONS.md](LIMITATIONS.md#compare--symbol-expressions).
- Watchlists reject expressions. The daily bar stamp assumption (00:00 local in the exchange timezone) was verified against the live API.
- Layout schema is now v3 (`compares`, with an upgrade step from v2); see `docs/persistence.md` §5/§6. Compares are not part of indicator or chart templates.
- e2e: `?feed=synthetic-multi` gives each symbol its own synthetic series; `e2e/compare.spec.ts` (4 tests) covers the dialog, placements, undo, reload and expressions as the main symbol.

### Phase 10: Alerts

- [x] Alert model: condition (crossing, crossing up/down, greater/less, entering/exiting channel, moving up/down %), sources (price, indicator output, drawing line/channel), trigger (once, once per bar, once per bar close, every time), expiry, message templates
- [x] Create from the toolbar, a drawing's right-click menu, the price-scale "+" button, or a watchlist row
- [x] Node alerts service: loads alerts, subscribes to live prices / polls bars, evaluates with the shared indicator package, writes the alert log
- [x] Notifications: in-app toast + sound, browser Notification API (via `/ws`), optional webhook/Telegram/email
- [x] Alerts panel: list, edit, pause, restart, clone, delete; alert log; markers on the chart

Phase 10 notes:

- Design, wire format, evaluation semantics, service, notifications and tests: `docs/alerts.md`. Code: `packages/alerts/` (spec validation, condition and trigger evaluator, drawing levels, templates), `services/alerts/src/` (Node evaluation service), `api/src/investopen_api/` (`routes/alerts.py`, `userdata/alerts.py`, `notifications/`, `/ws` event topics) and `apps/web/src/alerts/` (store, sync, events, dialog, panel, notifications, chart markers). The engine gained a Node-safe entry (`@investopen/engine/node`), chart markers, price lines and the price-axis "+" button.
- The service only decides that an alert fires and writes through the REST API; the API owns the database and delivers everything (in-app frames over `/ws`, webhook, Telegram, email through a persisted outbox). Secrets live in the API env only: see `.env.example` and the README.
- Alerts watch standard time bars of (symbol, interval, extended hours). Indicator settings are snapshotted; drawings are live references by id with a snapshotted scale mode. Expressions (`AAPL/MSFT`) work as symbols.
- Creating: top bar, price-scale "+", price-axis menu, a drawing's or indicator's menu, or a watchlist row. Alerts are not created offline.
- e2e: `e2e/persistence.ts` mocks `/api/alerts*` (CRUD with revisions, log, channels, service status); `e2e/market.ts` answers `op: events` and has `pushAlertFired`; `e2e/alerts.spec.ts` covers the entry points, the panel actions, toast/sound/marker/log/badge on a fire, browser notifications and reload. Remaining limitations: [LIMITATIONS.md](LIMITATIONS.md#alerts).

### Phase 11: Remaining drawing tools (bulk, on the framework)

- [ ] Lines: Trend angle, Regression trend, Flat top/bottom, Disjoint channel
- [ ] Pitchforks: Standard, Schiff, Modified Schiff, Inside; Pitchfan
- [ ] Gann: Box, Square fixed, Square, Fan
- [ ] Fib: Channel, Time zone, Speed resistance fan, Trend-based time, Circles, Spiral, Speed resistance arcs, Wedge
- [ ] Patterns: XABCD, Cypher, Head & Shoulders, ABCD, Triangle pattern, Three drives; Elliott impulse/correction/triangle/double/triple combo; Cyclic lines, Time cycles, Sine line
- [ ] Forecasting/volume: Forecast, Bars pattern, Ghost feed, Projection, Fixed range volume profile, Anchored volume profile
- [ ] Shapes: Highlighter, Arrow marker, Arrow up/down, Rotated rectangle, Path, Circle, Ellipse, Polyline, Triangle, Arc, Curve, Double curve
- [ ] Annotations: Anchored text, Note, Anchored note, Callout, Comment, Price label, Price note, Signpost, Flag mark, Table, Image; icon/emoji/sticker picker
- [ ] Zoom-in tool, Measure tool polish; sync drawings across layouts

### Phase 12: Remaining indicators (bulk)

- [ ] Trend/MA: DEMA, TEMA, ALMA, KAMA, LSMA, McGinley, SMMA, Moving Average Ribbon, Envelopes, Linear Regression channel, ZigZag, Williams Alligator, Fractals
- [ ] Momentum: Momentum, ROC, TRIX, TSI, Ultimate Oscillator, Awesome/Accelerator Oscillator, Coppock, KST, DPO, PPO, SMI Ergodic, Fisher Transform, Connors RSI, Chande MO, Aroon, Vortex, Choppiness, RVI, Elder Force, Balance of Power, Know Sure Thing
- [ ] Volume: A/D, Chaikin Money Flow, Chaikin Oscillator, Ease of Movement, Klinger, Net Volume, PVT, Volume Oscillator, Volume Profile (visible range / session), Relative Volume
- [ ] Volatility: Historical Volatility, Chaikin Volatility, Ulcer Index, Bollinger %B/Bandwidth, Standard Deviation, Mass Index
- [ ] Other: Pivot Points High/Low, Pivot types (Fibonacci, Woodie, Camarilla, DM), Correlation coefficient, Price oscillator, Median/Typical price, Auto fib, 52-week high/low, Seasonality
- [ ] Optional "more advanced than reference": user JS indicators in a sandboxed Worker with a documented API (not standard)

### Phase 13: Market replay

- [ ] Replay feed wrapper: pick start bar (scissors cursor), play/pause, step forward, speeds, jump to realtime, change interval during replay
- [ ] Indicators and alerts react incrementally; drawings stay usable
- [ ] Intrabar replay from a lower native interval where yfinance has the data (warn about intraday history limits)
- [ ] Optional: replay paper trading (buy/sell, P&L panel)

### Phase 14: Multi-chart layouts

- [ ] Grid layouts 1–16 charts; resizable splitters
- [ ] Sync per layout: symbol, interval, crosshair, time, date range, drawings
- [ ] Active-chart focus model (toolbar targets the active chart); a layout saves all charts

### Phase 15: Polish & parity sweep

- [ ] Chart settings dialog parity: Symbol, Status line, Scales & lines, Canvas, Trading, Alerts, Events
- [ ] Events on chart: dividends, splits, earnings markers with tooltips
- [ ] Data window; screenshot (PNG download/copy); fullscreen; full keyboard shortcut list + help dialog
- [ ] Performance pass (worker offload, render profiling, memory), error states (Yahoo down, symbol not found, rate-limited)
- [ ] Accessibility basics, i18n scaffolding
- [ ] Optional: screener (yfinance `screen`), economic/earnings calendar, financials view

### Phase 16: AI analysis integration point (feature built separately)

- [ ] `chart.snapshot()` → `{ png, visibleBars, indicators: {name, inputs, values}, drawings, symbol, interval, scale }`
- [ ] Plugin slot in the right sidebar + a command-bus hook (`ai.analyzeCurrentView`)
- [ ] Engine API so AI results can be rendered back as drawings or annotations

### Phase 17: Release

- [ ] User docs (install via docker compose, shortcuts, features), developer docs (engine/indicator/drawing APIs)
- [ ] Versioning, changelog, tagged release images

---

## Efficient build order rationale

Phases 0–3 give a usable live chart early. Phases 5–6 build the two frameworks that everything else depends on. Phase 7 persistence comes right after drawings, so work isn't lost. The bulk content phases (11, 12) are parallelizable, low-risk filler. Replay and multi-chart reuse the DataFeed and state abstractions, so they come late and cost little.

## Verification

- Each phase ends with: unit tests green (Vitest/pytest), Playwright scenario(s) for the new interactions, visual-regression screenshots for render changes, and `docker compose up` smoke tests (load AAPL 1D, pan/zoom, draw, reload, and check persistence).
- Indicators: golden-value tests against reference CSVs (tolerance 1e-8).
- Engine: perf benchmark in CI (100k bars, frame time budget).
- Backend: recorded yfinance fixtures; one opt-in live test job.
