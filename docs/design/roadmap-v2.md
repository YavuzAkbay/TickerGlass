# Roadmap v2: "level up"

Goal: everything TradingView puts behind a paywall, plus what a self-hoster expects from a
well-behaved app on their own hardware. Work goes in order, one item at a time; each item gets a
short design note (in this file or its own `docs/design/*.md`) before code, and lands with tests.

Status legend: `todo` · `design` · `wip` · `done` · `dropped`.

Tier 5: local AI via Ollama — `done` 2026-11-27 ([design](local-ai.md), [guide](../ai.md)). MCP server
and community script repo are still parked.

---

## Tier 1: Big gaps people would notice

### 1.1 Strategy tester (backtester) — `done` (v1; user guide: [backtest.md](../backtest.md))

Rule-based strategies built from the same operands as alerts (price fields, any indicator output
on the chart, constants), evaluated on the chart's bars, with a report.

- **Rules**: long entry / long exit / short entry / short exit. Each rule = list of conditions,
  joined by _all_ or _any_. Condition = alert-style `left op right` (`crossingUp`, `crossingDown`,
  `crossing`, `greater`, `less`, `moving*`) or **signal** (an output has a value on the bar: a
  shape of a built-in or a user script fires).
- **Works with user scripts for free**: rules read the chart's computed study outputs, so any
  script that plots or marks something can drive a strategy. No sandbox changes.
- **Fill model** (no look-ahead): signals are decided on bar _i_'s close; fills at bar _i+1_'s
  open (default) or bar _i_'s close. Stop-loss / take-profit % checked intrabar on the following
  bars; gaps fill at the open; stop wins when both hit in one bar (conservative). Slippage %
  adverse on market and stop fills. Commission: % of value, per order, or per share. One
  position at a time; opposite entry reverses.
- **Sizing**: % of equity, fixed quantity, fixed cash; whole units unless fractional is on.
- **Report**: net profit, % return, CAGR, buy & hold, max drawdown (abs / %), profit factor, win
  rate, avg trade / win / loss, payoff ratio, largest win / loss, Sharpe, Sortino, exposure,
  avg bars in trade; equity curve and drawdown; trade list; entry/exit markers on the chart.
- **Raw prices**: Heikin Ashi charts fill at real OHLC (index-aligned); brick types (Renko,
  Kagi, P&F, Line break, Range) are refused because their bars are not time bars.
- **Storage**: strategies are synced user settings (`backtest.strategies`), so they follow you
  between devices and land in backups.
- Code: `packages/backtest` (pure TS: signals, engine, stats); `apps/web/src/backtest` (store,
  navigator panel, chart markers).
- Later: optimizer (grid over inputs), multi-symbol run over a watchlist, server-side run.

### 1.2 Portfolio and trade journal — `done` (v1; design: [portfolio.md](portfolio.md), user guide: [portfolio.md](../portfolio.md))

Holdings with cost basis, realized / unrealized P&L, dividends, allocation, performance vs a
benchmark. Transactions table on the API (buy, sell, dividend, split, fee, cash in/out). Broker
CSV import with per-broker mappers (IBKR Flex, Schwab, Degiro, Trading 212, generic). Journal
entries linked to trades: notes (reuse notes), tags, screenshot (chart snapshot), setup, R-multiple.

### 1.3 Alerts on user scripts — `done` (design: [script-alerts.md](script-alerts.md); guide: [alerts.md §2.8](../alerts.md))

LIMITATIONS "Scripts can't be used in alerts". Run scripts in the alerts service inside an
isolated runtime (`isolated-vm` or a `node:vm` child process with time / memory limits), same
`apiVersion 1` contract and the same Check semantics. Lift `checkRegistry`'s `user:` rejection.

### 1.4 ntfy, Gotify, Apprise delivery — `done` (design: [notify-channels.md](notify-channels.md); guide: [alerts.md §4](../alerts.md))

New channels next to `notifications/webhook.py`: ntfy (topic URL + optional token / priority /
tags), Gotify (URL + app token), Apprise (API URL or `apprise://` URLs). Per-alert toggles like
Telegram; settings in `.env`; outbox / retry reused.

---

## Tier 2: Self-hosting quality of life

### 2.1 OIDC single sign-on — `done`

Authentik / Authelia / Keycloak / Pocket ID via OpenID Connect (authorization code + PKCE),
plus "trusted header" mode behind an auth proxy (`Remote-User`, allow-listed proxy IPs).
Password login stays as the default.

### 2.2 Multi-user — `done`

Users table; every user-data row (watchlists, layouts, drawings, alerts, scripts, settings,
notes, screens, strategies, portfolio) gets an owner. Market-data cache stays shared. Admin role
for server settings and providers. Migration puts existing data under the first user. Depends on
2.1 for identity, works with password users too. Design: [multi-user.md](multi-user.md); setup:
[self-hosting.md](../self-hosting.md#users).

### 2.3 App-store templates — `done` (design: [app-store-templates.md](app-store-templates.md); guide: [self-hosting.md](../self-hosting.md))

All-in-one image `ghcr.io/yavuzakbay/tickerglass` (nginx + API + alerts in one container), Unraid
CA template, CasaOS manifest, TrueNAS "Install via YAML" compose, Umbrel community-store app and a
Helm chart. Kept in `deploy/` and checked in CI (`deploy/check.py`, `helm lint`, AIO smoke test)
against `docker-compose.yml`. YunoHost is tracked separately as 2.7.

### 2.4 Scheduled backups — `done` (design: [scheduled-backups.md](scheduled-backups.md); guide: [self-hosting.md](../self-hosting.md))

Nightly whole-database backup (SQLite) to a local folder and / or any S3-compatible store, gzip,
optional AES-256-GCM encryption, GFS retention, run history, and restore (UI, upload, CLI) that
stages a verified file and swaps it in at the next start. Postgres reports "not supported, use
pg_dump".

### 2.5 Metrics and health — `done` (design: [metrics.md](metrics.md); user guide: [metrics.md](../metrics.md))

Prometheus `/metrics` (provider requests and budget, cache hit rate, alerts evaluated / fired /
lag, delivery failures, screener snapshot age) and a Grafana dashboard JSON in `deploy/`.

### 2.6 Home Assistant / MQTT — `todo`

Optional MQTT publisher: quotes of chosen watchlists and alert fires as topics, with Home
Assistant discovery. REST sensor docs as the no-broker alternative.

### 2.7 YunoHost package — `todo`

Native YunoHost app (no Docker): package manifest, install / upgrade / backup / restore scripts,
nginx and systemd units for the API and the alerts service, SSO via the YunoHost LDAP / SSOwat
(trusted-header mode from 2.1). Lives in its own repository (`tickerglass_ynh`), as the YunoHost
catalog requires; split out of 2.3.

---

## Tier 3: Data independence

### 3.1 More providers — `done` (design: [more-providers.md](more-providers.md); guide: [providers.md](../providers.md))

Alpaca (US stocks, free IEX real-time + WebSocket), Tiingo, Finnhub, Polygon, Stooq (free daily),
CCXT for crypto exchanges (Binance, Kraken, Coinbase; WebSocket live). Each behind the existing
registry, guard and pacing. Finnhub is deferred to 3.3 (its free plan has no candle history, so it only
fits as a secondary quotes / live / fundamentals source).

### 3.2 Bring your own bars — `todo`

Import OHLCV from CSV / Parquet into a local "file" provider (symbol namespace `LOCAL:`), with a
mapper for column names and timezone. Makes fully offline instances useful beyond demo data.

### 3.3 Provider fallback chain — `todo`

Ordered providers per data kind (intraday, daily, quotes, fundamentals); on upstream errors or
cooldown, fall back (e.g. Yahoo → Stooq for daily). Response says which provider served it.
Finnhub joins here as quotes / live / fundamentals source.

### 3.4 Local history archive — `todo`

Keep fetched bars permanently (opt-in, size cap), so intraday history grows past the provider
window (Yahoo 1m ≈ 30 days). Archive feeds charts and backtests.

---

## Tier 4: Analysis depth

### 4.1 Fundamentals view — `todo`

Income / balance / cash-flow statements (annual / quarterly), valuation history (P/E, P/S,
EV/EBITDA), peer table. Builds on the existing financials indicators and the symbol info panel.

### 4.2 Market-wide calendars — `todo`

Earnings calendar across watchlists and the screener universe; economic calendar (provider
permitting) with impact level; both as a navigator section and as chart events.

### 4.3 Volume / market profile — partly `done`

Volume profile (visible range, session) already exists (`vp-visible`, `vp-session`). Remaining:
fixed-range VP drawing tool, TPO / market profile, footprint (needs tick or 1s data — only with
providers that offer it).

### 4.4 Options chain and IV — `todo`

Chain by expiry (yfinance has it), IV smile, expected-move band overlay on the chart, put/call
ratio. Yahoo provider first.

### 4.5 Multi-timeframe screener filters — `todo`

Screener formulas that reference another timeframe (`rsi(14, '1W') < 30 and close > sma(200)`),
computed in the nightly snapshot for the weekly / monthly columns.

---

## Revise / harden

- **H1 Index constituents from a real source** — `todo`. Curated S&P 500 (361) / NDX (78) lists
  are incomplete. Generate from public holdings data with a refresh script; verify removals
  (DFS, IPG, SKX, FI → FISV).
- **H2 Verify Yahoo v7 fundamental units** — `todo`. Probe live (dividend yield, margins,
  percent vs fraction) and pin with fixture tests.
- **H3 Green e2e** — `todo`. Fix `e2e/drawing-tools.spec.ts` (duplicate "Measure" aria-label, 51
  failures) and the flakes (`alerts.spec:361`, `chart.spec:64`).
- **H4 Mobile pass** — `todo`. Phone layouts of chart, watchlist, screener, new strategy panel.

## Order

1.1 → 1.2 → 1.3 → 1.4 → 2.x → 3.x → 4.x, hardening items slotted in between where they unblock
(H3 before large UI work lands, so CI can be trusted).
