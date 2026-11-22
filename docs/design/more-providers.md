# More providers (roadmap 3.1)

Status: done 2026-11-17 (uncommitted). Reviewed (2 opus reviews), smoke-tested with auth on against live Kraken, Coinbase, Binance. Alpaca, Tiingo, Massive, Stooq never called live (no keys).

Adds five market-data sources behind the existing provider registry, guard, and pacing:
**Alpaca**, **Tiingo**, **Massive** (formerly Polygon.io), **Stooq**, and a **crypto** provider
with direct Kraken / Coinbase / Binance adapters. Finnhub is deferred to 3.3 (its free plan has
no history, so it only makes sense as a secondary quotes/live/fundamentals source in a fallback
chain). CCXT is not used (6.8 MB, tightly pinned aiohttp/cryptography/typing_extensions, and the
repo rule is stdlib HTTP); direct adapters cover the three exchanges we care about.

API facts below come from doc research on 2026-11-17. Items marked **(verify)** were not
confirmed in official docs and must be confirmed by the first live call; providers must degrade
gracefully (clear `ProviderError` / `ProviderUnsupported`) rather than guess.

## 1. Common rules (all providers)

- One module per provider under `api/src/tickerglass_api/providers/` implementing
  `MarketDataProvider` (base.py:409), plus one `ProviderSpec` entry in `registry.py` `PROVIDERS`.
  Config class with env prefix `<ID>_` (pattern: `TwelveDataConfig`, twelvedata.py:146).
  Secrets are `SecretStr`, never logged, never in URLs that are logged (if a provider requires a
  query-param key, redact it in error messages/log lines the same way twelvedata does).
- HTTP only through `JsonHttp` (http.py) — stdlib urllib, injectable `send` for tests. Stooq
  returns CSV: add a small `TextHttp`/`get_text` path to http.py rather than a second client (same
  error mapping, same no-redirect policy).
- **Plan-aware**: each provider with paid tiers has a `plan` setting and a `PlanProfile` table
  (pattern: twelvedata.py:77-140) driving `capabilities(config)`, `costs(config)`,
  `setting_defaults(config)` (budget) and `plan(config)`. Capabilities must state what the
  configured plan _really_ serves (e.g. Massive basic → daily+ intervals only).
- **Symbols**: canonical Yahoo-style strings stay the app's namespace (`AAPL`, `BRK-B`, `VOD.L`,
  `^GSPC`, `EURUSD=X`, `BTC-USD`). Each provider has `to_provider` / `from_provider` mapping and
  implements `SymbolRouting` (`billable`, `answers_locally`) so symbols it can't serve are answered
  locally as not found / unsupported without spending budget. Use `exchanges.py` for suffix ↔ MIC.
- **Intervals**: native where the upstream has them; otherwise synthesize from finer bars with
  `resample.py` (as twelvedata `_SYNTH`). Never claim an interval in capabilities that neither
  native nor synthesized paths serve.
- **Errors**: 401/403 auth → `ProviderNotConfigured`-style message naming the env var ("ALPACA_
  key rejected"); plan-restricted → `ProviderUnsupported(feature, provider)`; 429 / quota text →
  `RateLimited` (with `retry_after` / `daily=True` when known); 5xx/network → `UpstreamUnavailable`.
  Feed response headers into the guard via `report_usage` when the upstream exposes remaining-quota
  headers (Alpaca `X-RateLimit-*`).
- **Metrics (2.5)**: every upstream send counts once in `metrics/upstream.py` with the provider id
  (`JsonHttp(provider=...)`). Add new ids to the metrics label allow-list if there is one.
- **Live**: only where a free/plan-appropriate upstream WebSocket exists, via
  `ProviderSpec.make_live` returning a `LiveSource` (live.py:44) emitting the normalized message
  shape (live.py:44-63). Otherwise the LiveHub poll fallback is used automatically. A shared helper
  `providers/stream.py` (reconnecting WS client: backoff with jitter, auth-then-subscribe hook,
  resubscribe on reconnect, bounded queue, close idempotent) is used by all streaming providers.
  Use the `websockets` package already installed via `uvicorn[standard]` (verify it is importable
  in the runtime image; if not, add it explicitly to pyproject — it is a pure-Python, unpinned
  dependency, which is acceptable).
- **Tests**: fixture JSON/CSV under `api/tests/fixtures/<id>/` (hand-built from documented
  response shapes, format like twelvedata fixtures), a fake `send` (pattern `td_fake.py`), unit
  tests for mapping/paging/plans/errors, a `ContractCase` in `test_provider_contract.py`, and a
  fake-WS test for each `LiveSource`. No test touches the network.
- **No web changes expected**: the picker renders `GET /api/providers` generically. If a provider
  needs a field type the UI can't render, report it instead of hacking the UI.

## 2. Alpaca (`alpaca`)

Best free option for US stocks: 200 calls/min, multi-symbol bars and snapshots, IEX real-time WS.

- Config `ALPACA_`: `key_id` (secret, required), `secret_key` (secret, required),
  `plan` (`basic`|`algo_trader_plus`, default basic), `feed` (`iex`|`sip`, default from plan:
  basic→iex), `data_base_url` (default `https://data.alpaca.markets`), `trading_base_url`
  (default `https://paper-api.alpaca.markets` — assets list works with paper keys too; verify),
  `extended_hours`, `crypto_location` (`us` default).
- Auth headers `APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`.
- History: `GET /v2/stocks/bars` — `timeframe` `{n}Min` (1-59), `{n}Hour` (1-23), `1Day`, `1Week`,
  `{n}Month` (1,2,3,4,6,12) — so 1m…3mo native, map our intervals exactly (60m → `1Hour`).
  `adjustment=all` for daily+ (fills `adj_close`; raw for intraday — follow what yahoo/twelvedata do
  for `adj_close` semantics), `feed` from config, `limit=10000`, loop `next_page_token`. On basic
  plan, `feed=sip` for the last 15 min returns 403 → always send `feed=iex` on basic.
  `prepost=False` filters bars outside the regular session (exchanges.py session for XNAS/XNYS).
- Quotes: `GET /v2/stocks/snapshots?symbols=…` (batch; chunk by URL length, e.g. 100 symbols) →
  price from `latestTrade.p`, day OHLCV from `dailyBar`, prev close from `prevDailyBar.c`.
- Search / symbol_info: `GET {trading}/v2/assets?status=active&asset_class=us_equity` (needs
  keys) cached in memory for 24 h; search filters locally (symbol prefix first, then name
  substring). Alpaca symbols use `.` for classes (`BRK.B`) → map to `BRK-B`.
- Crypto: `GET /v1beta3/crypto/{loc}/bars` and `/latest/…` or `/snapshots` with `BTC/USD` symbols
  ↔ canonical `BTC-USD`. Send keys (keyless is documented inconsistently — don't rely on it).
- Live: `wss://stream.data.alpaca.markets/v2/{feed}`; auth message
  `{"action":"auth","key":…,"secret":…}`; subscribe `trades` (+ `dailyBars` for day OHLCV if
  useful); messages are JSON arrays with `T` = `t` trade, `d` daily bar, `success`, `error`,
  `subscription`. Error codes 405 symbol limit (basic 30 symbols), 406 connection limit (1).
  On 405, keep the first N symbols streamed, rest fall back to polling (LiveHub) — report via
  capabilities/plan text, not an error storm. Crypto WS `wss://…/v1beta3/crypto/{loc}` same
  pattern on a second connection, only if crypto symbols are subscribed.
- Budget basic: 200/min, burst 50 (`setting_defaults`). algo: 10 000/min.
- Capabilities: markets us + crypto; intervals 1m…3mo; extended_quotes no; events/news/
  fundamentals no; streaming yes.

## 3. Tiingo (`tiingo`)

Free plan is tight: **50 requests/hour, 1 000/day, 500 unique symbols/month**.

- Config `TIINGO_`: `api_key` (secret, required), `plan` (`starter`|`power`), `base_url`
  (`https://api.tiingo.com`), `stream` (bool, default false — the IEX firehose at threshold 6 is
  heavy; opt-in).
- Auth header `Authorization: Token <key>`.
- History daily+: `GET /tiingo/daily/<t>/prices?startDate&endDate&resampleFreq=daily|weekly|monthly`
  (weekly/monthly values: verify; fall back to resampling daily) → `adjClose` → `adj_close`.
  Intraday: `GET /iex/<t>/prices?startDate&endDate&resampleFreq={n}min|{n}hour&columns=open,high,low,close,volume`
  (only `5min` documented; `1min`, `hour` values verify — on rejection synthesize from 5min/1min
  as available and lower `capabilities.intervals` accordingly). IEX history depth unknown (verify)
  → `extended_history` false.
- Quotes: batch `GET /iex/?tickers=a,b,c` → use `tngoLast` (raw `last` is null without an IEX
  agreement since 2025-02-01), `prevClose`, `open/high/low`, `volume`. Crypto quotes from
  `GET /tiingo/crypto/prices?tickers=btcusd,…&resampleFreq=1day` last bar (`/top` is deprecated).
  CostModel: one quote batch = 1 request regardless of size (that is what makes Tiingo usable).
- Search: `GET /tiingo/utilities/search?query=` (beta) for interactive search; symbol_info from
  `GET /tiingo/daily/<t>` meta. (Optional, nice-to-have: supported_tickers.zip download cached
  daily — skip in v1.)
- Crypto history `GET /tiingo/crypto/prices?tickers=btcusd&startDate&resampleFreq=…`,
  canonical `BTC-USD` ↔ `btcusd`.
- Live (opt-in `stream=true`): `wss://api.tiingo.com/iex`, subscribe
  `{"eventName":"subscribe","authorization":<key>,"eventData":{"thresholdLevel":6,"tickers":[…]}}`
  (field names inconsistent in docs → verify; implement exactly one form and log the upstream
  error clearly if rejected). Messages `messageType:"A"`, `data` arrays `[type, date, nanos,
ticker, …, lastPrice, …]` — parse by documented index, skip unknown.
- Budget: `rate_per_min` = 50/60 with burst 10 and `daily` 1 000 (starter); power 10 000/h,
  100 000/day. The monthly unique-symbol cap can't be enforced by the guard → document it and
  surface Tiingo's own error text when hit.
- Capabilities: markets us + crypto (+ intl? no), events/news/fundamentals no (fundamentals are
  a paid add-on, DOW30-only on free — out of scope), streaming = `stream` setting.

## 4. Massive (`massive`, formerly Polygon.io)

- Config `MASSIVE_`: `api_key` (secret, required), `plan` (`basic`|`starter`|`developer`|
  `advanced`), `base_url` default `https://api.massive.com` (`https://api.polygon.io` still works,
  user may set it). Provider display name "Massive (formerly Polygon.io)"; also accept
  `MARKET_PROVIDER=polygon` as an alias id resolving to `massive` if the registry makes that cheap
  (otherwise skip, document).
- Auth `Authorization: Bearer <key>`. `next_url` pagination: follow it with the same header
  (don't append the key to the URL); only follow `next_url` whose origin equals `base_url`.
- History: `GET /v2/aggs/ticker/{T}/range/{mult}/{timespan}/{from}/{to}?adjusted=true&sort=asc&limit=50000`
  → `t` ms window start, `o h l c v`. Adjusted series fills both close and adj_close the same way
  twelvedata does when only adjusted data is available (follow existing convention; document).
  **basic plan = end-of-day data, 2 years**: capabilities intervals `1d, 1wk, 1mo` only (verify
  whether minute aggs on basic are delayed or refused; until verified, refuse intraday on basic).
- Quotes: starter+ → `GET /v2/snapshot/locale/us/markets/stocks/tickers?tickers=A,B` (batch, 15-min
  delayed on starter). basic → no snapshot: `GET /v2/aggs/ticker/{T}/prev` per symbol (expensive at
  5/min; CostModel quote_batch=1 on basic so the guard prices it honestly). Prefer serving quotes on
  basic from the cached last daily bar where the existing quote path allows it.
- Search `GET /v3/reference/tickers?search=&active=true&limit=`; symbol_info and fundamentals_info
  (market cap, description, employees, sic) from `GET /v3/reference/tickers/{T}`.
  Financial statements: out of scope (paid add-on).
- Symbols: stocks plain (`BRK.B` ↔ `BRK-B`), crypto `X:BTCUSD` ↔ `BTC-USD`, forex `C:EURUSD` ↔
  `EURUSD=X` (verify), indices `I:SPX` ↔ `^SPX`/`^GSPC` only if cheap (indices are a separate
  paid asset class — basic: mark unsupported).
- Budget basic: 5/min (per asset class; we model one bucket), burst 5. Paid plans: "unlimited" →
  use the global defaults.
- No live in v1 (WS is paid-only and per-asset-class; LiveHub polling covers paid plans). Note as
  follow-up.

## 5. Stooq (`stooq`)

Unofficial, best-effort free daily history for many markets. **Needs a manually obtained key**
(since ~March 2026, captcha at `https://stooq.com/q/d/?s=aapl.us&get_apikey`; the key is the
`apikey=` value in the CSV link on that page).

- Config `STOOQ_`: `api_key` (secret, required), `base_url` (`https://stooq.com`).
- History: `GET /q/d/l/?s=<sym>&i=d|w|m&d1=YYYYMMDD&d2=YYYYMMDD&apikey=…` → CSV
  `Date,Open,High,Low,Close,Volume`. Intervals `1d, 1wk, 1mo` only (intraday 60/5 exist per a
  third-party spec — out of scope). `adj_close` = close (Stooq is believed split-adjusted, not
  dividend-adjusted — document; set `adjusted_close` capability false).
- **Response sniffing**: body containing `Exceeded the daily hits limit` → `RateLimited(daily=True)`;
  HTML instead of CSV (missing/expired key) → `ProviderNotConfigured`-style error telling the user
  to get a new key; `No data` → empty frame / `SymbolNotFound` as appropriate. Key is in the
  query string → redact `apikey=` in any logged URL or error text.
- Quotes: `GET /q/l/?s=a.us+b.us&f=sd2t2ohlcv&h&e=csv` (multi-symbol with `+`, may need apikey —
  verify; if it fails, fall back to the last daily bar per symbol). prev close from history.
- Symbols: `AAPL` ↔ `aapl.us`, `VOD.L` ↔ `vod.uk`, `SAP.DE` ↔ `sap.de`, `7203.T` ↔ `7203.jp`,
  `^GSPC` ↔ `^spx`, `^DJI` ↔ `^dji`, `EURUSD=X` ↔ `eurusd`, `BTC-USD` ↔ `btcusd`. Small explicit
  table for indices; suffix table via exchanges.py where possible. Unknown → answered locally.
- Search: none upstream → `search` capability false (returns []), symbol_info minimal from mapping.
- Budget: unknown quota → conservative defaults: 10/min, burst 5, daily 300; cache hard (the
  existing bar cache already does).
- Terms text in ProviderSpec: "unofficial, personal use, may break without notice".

## 6. Crypto exchanges (`crypto`)

One provider, one exchange at a time: `CRYPTO_EXCHANGE=kraken|coinbase|binance` (default
`kraken` — public data, no key, no geo block). Each exchange is a small adapter class in
`providers/crypto/{kraken,coinbase,binance}.py` with a common interface (history page, tickers,
markets, live), and `providers/crypto/__init__.py` the `MarketDataProvider`.

- No keys needed (public market data). Optional `CRYPTO_BASE_URL` override per adapter (Binance:
  default `https://data-api.binance.vision`, which serves public spot data and avoids the 451 geo
  block of `api.binance.com` — verify; `binanceus` is out of scope).
- Symbols: canonical `BASE-QUOTE` (`BTC-USD`, `ETH-USDT`, `ETH-BTC`). Markets list loaded per
  adapter (Kraken `GET /0/public/AssetPairs`, Coinbase `GET /api/v3/brokerage/market/products`
  (verify path; public), Binance `GET /api/v3/exchangeInfo`) and cached 24 h; search filters it
  locally. Kraken `XBT` ↔ `BTC`, `XDG` ↔ `DOGE` alias table. Non-crypto symbols answered locally.
- History (endpoint paths: verify against docs during implementation):
  - Kraken `GET /0/public/OHLC?pair=&interval=1|5|15|30|60|240|1440|10080|21600&since=` — returns at
    most 720 most-recent candles; older history is NOT available → `extended_history` false,
    and requests older than the window return what exists (documented).
  - Coinbase `GET /api/v3/brokerage/market/products/{id}/candles?start&end&granularity=` — 300 per
    call, page backwards.
  - Binance `GET /api/v3/klines?symbol=&interval=&startTime&endTime&limit=1000` — page forward.
    Missing intervals synthesized via resample.py (e.g. 2h on Kraken from 1h, 1mo from 1d).
    Volume is base-asset volume. `adj_close` = close. Sessions are 24/7 (`prepost` ignored).
- Quotes: Kraken `GET /0/public/Ticker?pair=a,b`; Coinbase products/ticker (batch if available,
  else per product); Binance `GET /api/v3/ticker/24hr?symbols=[…]`. change/percent from 24 h
  open, day high/low/volume 24 h rolling (document: "day" = rolling 24 h for crypto).
- Live: Kraken `wss://ws.kraken.com/v2` channel `ticker`; Coinbase
  `wss://advanced-trade-ws.coinbase.com` channel `ticker` (public, verify no-auth); Binance
  `wss://data-stream.binance.vision/ws` `<sym>@miniTicker` (verify host). Via `providers/stream.py`.
- Budget: per adapter `setting_defaults` well under documented limits (Kraken ~1 req/s public →
  50/min; Coinbase/Binance 300/min), burst 10.
- Capabilities: markets crypto only; streaming yes; search yes; events/news/fundamentals no.
  The screener stays disabled by default (universe is equities).

## 7. Deferred / out of scope

Finnhub (→ 3.3), CCXT, Massive WebSocket, Stooq intraday, Tiingo fundamentals and
supported_tickers.zip, Alpaca options/news, binance.us, financial statements for any provider.

## 8. Docs & config

- `docs/providers.md`: fix stale "There is no runtime switching" (switching exists:
  `PROVIDER_SWITCHING`, POST /api/providers/active); add a comparison table (free limits, markets,
  intervals, live, key needed) and one section per new provider: getting a key, env vars, plan
  notes, caveats, and a "verified API facts" list mirroring the Twelve Data one (marking items
  still unverified).
- `.env.example`, `docker-compose.yml` api env, README provider list, and deploy templates only
  where they already enumerate provider env vars (check `deploy/check.py` consistency rules).

## 9. Implementation waves

- **Wave 1 (parallel)**: Alpaca (also builds `providers/stream.py` + `http.py` text helper only if
  needed by it — Stooq owner builds the text helper), Massive, Stooq.
- **Wave 2 (parallel, after wave 1)**: Tiingo, crypto (both reuse `stream.py`).
- **Wave 3**: docs/config integration, opus review, fixes, smoke (demo + one live public source:
  crypto/Kraken needs no key; others only if the user supplies keys).

## 10. Deviations from design

Differences between sections 1-9 and what was built (implementation notes, 2026-11-17):

- **Alpaca**: daily and longer stock bars take two requests for Yahoo-style adjustment, one with
  `adjustment=split` and one with `adjustment=all` (a failure of the second only costs `adj_close`).
  Bar pages are walked newest first (`sort=desc`), so a range cut short by `max_pages` keeps its
  newest bars. `stream.py` has no inbound queue: `on_message` is awaited inline, so a slow handler
  back-pressures the socket (section 1 said "bounded queue").
- **Massive**: bars use `sort=desc`. On Basic, quotes come from the last two daily bars of each
  symbol, not from `/prev` (price and previous close in one call). `3mo` bars are offered. There is no
  `polygon` alias id: it would need edits to `app.py` / `provider_choice` for a second registry id;
  `MASSIVE_BASE_URL=https://api.polygon.io` covers old keys instead.
- **Tiingo**: only `5min` and `1day` are sent as `resampleFreq`, so `1m` and `2m` are not offered
  (15m to 90m are built from 5-minute bars). The 500-symbols-a-month cap cannot be enforced; when
  Tiingo reports it, the error is a plain `ProviderError` with Tiingo's own text.
- **Stooq**: batch quotes carry no previous close (`prevClose` is absent).
- **Crypto**: Kraken's WebSocket v2 uses `BTC/USD` (not `XBT`). Kraken's weekly candles open on
  Thursdays (epoch aligned), so weeks are synthesized from daily bars. Kraken history is capped at
  the latest 720 bars per interval. Coinbase batch quotes repeat `product_ids=` on the products
  endpoint; a params mapping cannot repeat a key, so the query string is built into the request path.
