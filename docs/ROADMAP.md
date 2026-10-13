# InvestOpen Roadmap

Open-source (AGPL-3.0), self-hosted, single-user charting platform with reference-class features. Data source: yFinance. Tick items off as they land.

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
- Watchlist panel is a basic recent-symbols list with live quotes; the full version is Phase 8.
- Settings dialog: Symbol, Canvas, and Scales tabs work; others are placeholders until Phase 15.

### Phase 4: Chart types

- [x] Bars, Candles, Hollow candles, Volume candles, Line, Line with markers, Step line, Area, HLC area, Baseline, Columns, High-Low
- [x] Heikin Ashi (transform)
- [x] Brick-type transforms on a non-time index: Renko (box size: ATR/fixed, wicks), Line Break, Kagi, Point & Figure, Range bars
- [x] Volume overlay/pane; extended-hours shading; price-line + bid/ask-style lines
- [x] Per-type style settings in the settings dialog (Symbol tab)

Phase 4 notes:

- Bid/ask lines are not drawn: Yahoo's free data has no bid/ask. Instead there is a previous-day-close line (Settings → Scales and lines).
- Brick types (Renko, Line break, Kagi, P&F, Range) size ATR-based boxes once per load, so bricks stay stable during live updates. Their indices are not time bars; indicators in Phase 5 should run on the displayed series (`chart.store`), with `chart.sourceIndexOf(i)` mapping back to time bars.

### Phase 5: Indicator framework + core set

- [ ] Indicator definition API: inputs (int/float/bool/source/color/enum/timeframe), outputs (line/histogram/area/columns/circles/cross/step, hlines, fills, bgcolor, shapes/labels), overlay vs pane, precision
- [ ] Worker runtime with incremental update on the last bar; recompute on data change
- [ ] Indicator-on-indicator (source = other output); multi-timeframe inputs
- [ ] Indicators dialog (search, categories, favorites); legend row with eye/settings/source/remove/more menu
- [ ] Auto-generated settings dialog: Inputs / Style / Visibility (per-interval) tabs; defaults; "Save as default"
- [ ] Core 25 with golden tests vs a reference (TA-Lib / pandas-ta CSVs): SMA, EMA, WMA, VWMA, HMA, VWAP, Anchored VWAP, Bollinger, Keltner, Donchian, Ichimoku, Parabolic SAR, Supertrend, RSI, MACD, Stochastic, Stoch RSI, CCI, ATR, ADX/DMI, OBV, MFI, Williams %R, Volume, Pivot Points Standard

### Phase 6: Drawing framework + core tools

- [ ] Drawing model: anchors in (time, price) space mapped to bar index; survives interval changes; per-symbol storage, or synced across all symbols
- [ ] Create/select/drag/anchor-edit/multi-select/clone (Alt+drag)/copy-paste/lock/hide/z-order
- [ ] Magnet snap to OHLC; Shift-constrain angles; floating mini-toolbar on select (color, width, style, settings, lock, delete)
- [ ] Right-click menus for drawings (and the chart, scales, panes): settings, clone, copy, z-order, visibility per interval, lock, hide, remove, template
- [ ] Properties dialog generated from the schema: Style / Text / Coordinates / Visibility tabs; per-tool style templates ("Save as… / Apply default")
- [ ] Undo/redo via the command bus
- [ ] Core tools: Trend line, Ray, Extended line, Info line, Horizontal line/ray, Vertical line, Cross line, Parallel channel, Fib retracement, Trend-based fib extension, Rectangle, Text, Arrow, Brush, Long/Short position, Price range, Date range, Date & price range (measure)
- [ ] Object tree panel (list, reorder, hide/lock, delete)

### Phase 7: Persistence, layouts, templates

- [ ] API + DB: layouts, drawings, indicator templates, drawing templates, chart templates/themes, settings, notes
- [ ] Autosave the chart layout (debounced); named layouts: save/save-as/rename/load/delete; restore on startup
- [ ] Indicator templates (sets of indicators + settings); chart color/style templates
- [ ] Import/export of layouts and templates as JSON

### Phase 8: Watchlists

- [ ] Multiple named watchlists; create/rename/delete/duplicate; sections/separators; drag reorder
- [ ] Columns: last, change, change %, volume, ext-hours; sort; customizable columns
- [ ] Live updates via `/ws`; price tick flash
- [ ] Color flags (standard flag lists); right-click row menu (add alert, flag, remove, move to list, open in new chart)
- [ ] Import/export `.txt`; add the current chart symbol; keyboard navigation (↑/↓ changes the chart symbol)
- [ ] Details panel (key stats, performance, earnings date), news panel

### Phase 9: Compare & symbol math

- [ ] Compare dialog: add overlay symbols (same scale, new scale, new pane); auto-switch to percent scale
- [ ] Symbol expressions: spread/ratio/arithmetic (`AAPL/MSFT`, `(A+B)/2`) through an expression feed wrapper
- [ ] Time alignment across symbols with different sessions

### Phase 10: Alerts

- [x] Alert model: condition (crossing, crossing up/down, greater/less, entering/exiting channel, moving up/down %), sources (price, indicator output, drawing line/channel), trigger (once, once per bar, once per bar close, every time), expiry, message templates
- [x] Create from the toolbar, a drawing's right-click menu, the price-scale "+" button, or a watchlist row
- [x] Node alerts service: loads alerts, subscribes to live prices / polls bars, evaluates with the shared indicator package, writes the alert log
- [x] Notifications: in-app toast + sound, browser Notification API (via `/ws`), optional webhook/Telegram/email
- [x] Alerts panel: list, edit, pause, restart, clone, delete; alert log; markers on the chart

### Phase 11: Remaining drawing tools (bulk, on the framework)

- [x] Lines: Trend angle, Regression trend, Flat top/bottom, Disjoint channel
- [x] Pitchforks: Standard, Schiff, Modified Schiff, Inside; Pitchfan
- [x] Gann: Box, Square fixed, Square, Fan
- [x] Fib: Channel, Time zone, Speed resistance fan, Trend-based time, Circles, Spiral, Speed resistance arcs, Wedge
- [x] Patterns: XABCD, Cypher, Head & Shoulders, ABCD, Triangle pattern, Three drives; Elliott impulse/correction/triangle/double/triple combo; Cyclic lines, Time cycles, Sine line
- [x] Forecasting/volume: Forecast, Bars pattern, Ghost feed, Projection, Fixed range volume profile, Anchored volume profile
- [x] Shapes: Highlighter, Arrow marker, Arrow up/down, Rotated rectangle, Path, Circle, Ellipse, Polyline, Triangle, Arc, Curve, Double curve
- [x] Annotations: Anchored text, Note, Anchored note, Callout, Comment, Price label, Price note, Signpost, Flag mark, Table, Image; icon/emoji/sticker picker
- [x] Zoom-in tool, Measure tool polish; sync drawings across layouts

### Phase 12: Remaining indicators (bulk)

- [x] Trend/MA: DEMA, TEMA, ALMA, KAMA, LSMA, McGinley, SMMA, Moving Average Ribbon, Envelopes, Linear Regression channel, ZigZag, Williams Alligator, Fractals
- [x] Momentum: Momentum, ROC, TRIX, TSI, Ultimate Oscillator, Awesome/Accelerator Oscillator, Coppock, KST, DPO, PPO, SMI Ergodic, Fisher Transform, Connors RSI, Chande MO, Aroon, Vortex, Choppiness, RVI, Elder Force, Balance of Power, Know Sure Thing
- [x] Volume: A/D, Chaikin Money Flow, Chaikin Oscillator, Ease of Movement, Klinger, Net Volume, PVT, Volume Oscillator, Volume Profile (visible range / session), Relative Volume
- [x] Volatility: Historical Volatility, Chaikin Volatility, Ulcer Index, Bollinger %B/Bandwidth, Standard Deviation, Mass Index
- [x] Other: Pivot Points High/Low, Pivot types (Fibonacci, Woodie, Camarilla, DM), Correlation coefficient, Price oscillator, Median/Typical price, Auto fib, 52-week high/low, Seasonality
- [x] Optional "more advanced than reference": user JS indicators in a sandboxed Worker with a documented API (not standard)

### Phase 13: Market replay

- [x] Replay feed wrapper: pick start bar (scissors cursor), play/pause, step forward, speeds, jump to realtime, change interval during replay
- [x] Indicators and alerts react incrementally; drawings stay usable
- [x] Intrabar replay from a lower native interval where yfinance has the data (warn about intraday history limits)
- [x] Optional: replay paper trading (buy/sell, P&L panel)

### Phase 14: Multi-chart layouts

- [x] Grid layouts 1–16 charts; resizable splitters
- [x] Sync per layout: symbol, interval, crosshair, time, date range, drawings
- [x] Active-chart focus model (toolbar targets the active chart); a layout saves all charts

### Phase 15: Polish & parity sweep

- [x] Chart settings dialog parity: Symbol, Status line, Scales & lines, Canvas, Trading, Alerts, Events
- [x] Events on chart: dividends, splits, earnings markers with tooltips
- [x] Data window; screenshot (PNG download/copy); fullscreen; full keyboard shortcut list + help dialog
- [x] Performance pass (worker offload, render profiling, memory), error states (Yahoo down, symbol not found, rate-limited)
- [x] Accessibility basics, i18n scaffolding
- [x] Optional: screener (yfinance `screen`), economic/earnings calendar, financials view

### Phase 16: AI analysis integration point (feature built separately)

- [x] `chart.snapshot()` → `{ png, visibleBars, indicators: {name, inputs, values}, drawings, symbol, interval, scale }`
- [x] Plugin slot in the right sidebar + a command-bus hook (`ai.analyzeCurrentView`)
- [x] Engine API so AI results can be rendered back as drawings or annotations

### Phase 17: Release

- [x] User docs (install via docker compose, shortcuts, features), developer docs (engine/indicator/drawing APIs)
- [x] Versioning, changelog, tagged release images

---

## Efficient build order rationale

Phases 0–3 give a usable live chart early. Phases 5–6 build the two frameworks that everything else depends on. Phase 7 persistence comes right after drawings, so work isn't lost. The bulk content phases (11, 12) are parallelizable, low-risk filler. Replay and multi-chart reuse the DataFeed and state abstractions, so they come late and cost little.

## Verification

- Each phase ends with: unit tests green (Vitest/pytest), Playwright scenario(s) for the new interactions, visual-regression screenshots for render changes, and `docker compose up` smoke tests (load AAPL 1D, pan/zoom, draw, reload, and check persistence).
- Indicators: golden-value tests against reference CSVs (tolerance 1e-8).
- Engine: perf benchmark in CI (100k bars, frame time budget).
- Backend: recorded yfinance fixtures; one opt-in live test job.
