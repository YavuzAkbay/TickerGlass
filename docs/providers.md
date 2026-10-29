# Market data providers

The API fetches market data through one provider, chosen with `MARKET_PROVIDER` in `.env`
(read at start-up; restart the API after changing it). The web app shows the active provider, its
limits and a connection test on the first visit and under **More → Data source…**. There is no
runtime switching and no key entry in the web app: keys and plans live in the server's environment.

| `MARKET_PROVIDER` | Provider      | Network | Notes                                                                                                                            |
| ----------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `yahoo` (default) | Yahoo Finance | yes     | Through [yfinance](https://github.com/ranaroussi/yfinance). No key, everything supported. Yahoo's terms allow personal use only. |
| `twelvedata`      | Twelve Data   | yes     | The [Twelve Data](https://twelvedata.com) REST API. Needs `TWELVEDATA_API_KEY`; paces itself to your plan's credits (below).     |
| `demo`            | Demo data     | no      | A deterministic random walk per symbol (New York session hours). For trying the app, screenshots, tests. Everything supported.   |

An unknown `MARKET_PROVIDER` stops the API at start-up and lists the valid ids. Symbols stay
Yahoo-style everywhere in the app (`BRK-B`, `^GSPC`, `EURUSD=X`, `BTC-USD`, `VOD.L`); each provider maps
them to and from its own forms. On Twelve Data `USD/JPY` is `JPY=X` (Yahoo's form for the dollar
against a currency; the cross `USDJPY=X` is accepted too and names the same listing, one request entry
and one credit, a quote row for each of them), `EUR/USD` is `EURUSD=X`.

## Switching providers

1. Set `MARKET_PROVIDER` (and the provider's own variables, below) in `.env`.
2. Restart the API (`docker compose up -d`).

Bars and symbol metadata of different providers are not interchangeable (adjusted closes, session
hours, symbol forms), so the first start with a different provider **clears the market data cache**
(bars, series bookkeeping, symbol metadata). The provider that filled the cache is remembered in the
`app_meta` table, which is not part of exports. Your own data (watchlists, drawings, alerts,
settings) is never touched. A database from before this marker existed is kept as it is on the first
start. A custom provider passed to `create_app` (tests) does not use the marker.

## Switching in the app

Settings, Data source (or the data source dialog) lists every provider. A configured one has a "Use"
button; one with required variables unset is disabled and says which to set in `.env` (then restart the
API). **Keys and other provider settings are only ever read from `.env`**; the app never asks for or
stores them.

Switching takes effect at once, without a restart: the API starts the new provider, **clears the market
data cache** (as above; your own data is kept), moves the live quotes to it and tells the connected
clients, which reload. A request that was running during the switch answers `503` with
`code: "provider_switched"` (retry it). Switching to the provider already in use does nothing.

**Credits.** The cache starts empty, so reloading charts and quotes refetches them: about one credit per
chart and one per quoted symbol on a metered provider (see "Credit economy"). The alerts service reloads
the series of every active alert after a switch too, one more chart each, so many alerts make a switch
dearer. Switching back refetches again, nothing is kept per provider.

**Cooldown.** Because a switch wipes the cache and spends credits, a switch to a different provider
within `PROVIDER_SWITCH_COOLDOWN_S` (default `10`; `0` turns it off) of the previous one is refused with
`429 switch_cooldown` and a `Retry-After` header. Switching to the provider already in use and refused
or failed switches do not start it.

**Which provider starts after a restart.** The choice made in the app is stored (`app_meta`, not
exported) together with the `MARKET_PROVIDER` in force at that time:

1. `PROVIDER_SWITCHING=false`: `MARKET_PROVIDER`; a stored choice is ignored (a warning is logged).
2. Nothing stored: `MARKET_PROVIDER`.
3. The stored provider is unknown or no longer configured: `MARKET_PROVIDER` (warning); the choice is kept.
4. `MARKET_PROVIDER` differs from the one stored with the choice: you changed `.env` since, so it wins and
   the stored choice is deleted.
5. Otherwise the stored choice.

**Locking it down.** `PROVIDER_SWITCHING=false` (default `true`) makes the app read-only here: the picker
shows the providers, `POST /api/providers/active` answers `403`, and the provider is whatever
`MARKET_PROVIDER` says. There is no other authentication; anyone who can reach the API can switch, and
`docker-compose.yml` publishes the API's port (on `127.0.0.1` by default). If you expose it beyond
this machine, or run on a shared network, set `PROVIDER_SWITCHING=false`: anyone reaching the port could
clear your cache and burn credits.

**Request priority.** `GET /api/bars` and `GET /api/symbols/{symbol}` make their upstream calls at
`interactive` priority (a user waits for them). A client that is not a user waiting on a chart, such as
the alerts service reloading series, sends `X-TickerGlass-Priority: visible` or `background` so its calls
yield to the user's when the upstream budget runs short (see "Credit economy"). Any other value, or no
header, means `interactive`.

## Configuration per provider

Each provider reads its own `<ID>_*` variables (from the environment or `.env`). Secrets are only ever
sent in a request header, never logged, and never returned by the API: `GET /api/providers` shows
only whether a variable is set.

| Provider     | Variables       |
| ------------ | --------------- |
| `yahoo`      | none            |
| `demo`       | none            |
| `twelvedata` | the table below |

| Variable                     | Default                      | Meaning                                                                                      |
| ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `TWELVEDATA_API_KEY`         | required                     | Your API key. Without it the API still starts; every data call answers 503 `not_configured`. |
| `TWELVEDATA_PLAN`            | `basic`                      | `basic`, `grow`, `pro`, `ultra` or `enterprise`: your subscription.                          |
| `TWELVEDATA_CREDITS_PER_MIN` | the plan's                   | Override of the per-minute credits.                                                          |
| `TWELVEDATA_DAILY_CREDITS`   | the plan's                   | Override of the daily credits; `0` removes the cap.                                          |
| `TWELVEDATA_EXTENDED_HOURS`  | the plan's                   | `true` / `false`: pre/post-market data.                                                      |
| `TWELVEDATA_EVENTS`          | the plan's                   | `true` / `false`: dividends, splits, earnings.                                               |
| `TWELVEDATA_FUNDAMENTALS`    | the plan's                   | `true` / `false`: company profile.                                                           |
| `TWELVEDATA_INTERNATIONAL`   | the plan's                   | `true` / `false`: non-US exchanges and indices.                                              |
| `TWELVEDATA_POLL_INTERVAL_S` | the plan's                   | Seconds between quote polls of a symbol (the quote cache TTL is at least this).              |
| `TWELVEDATA_BASE_URL`        | `https://api.twelvedata.com` | API base URL.                                                                                |

Unset overrides follow the plan; empty values (as `docker-compose.yml` passes them) count as unset. The
provider's numbers become the defaults of the global settings (`UPSTREAM_RATE_PER_MIN`,
`UPSTREAM_BURST`, `UPSTREAM_DAILY_LIMIT`, `QUOTE_TTL_S`, `LIVE_POLL_INTERVAL_S`, the cache TTLs, ...);
a global setting you set yourself always wins over them.

## Twelve Data plans

As implemented in `PLAN_PROFILES` (`providers/twelvedata.py`). Check your own limits at
twelvedata.com: if the API reports different ones (see calibration below), those win.

| Plan                 | Credits / min | Credits / day | Non-US + indices | Pre/post-market | Quote cache / poll | Closed-market poll | Bar tail refresh (intraday / daily) |
| -------------------- | ------------- | ------------- | ---------------- | --------------- | ------------------ | ------------------ | ----------------------------------- |
| `basic`              | 8             | 800           | no               | no              | 300 s / 300 s      | 3600 s             | 300 s / 3600 s                      |
| `grow`               | 55            | none          | yes              | no              | 60 s / 60 s        | 600 s              | 60 s / 1800 s                       |
| `pro`                | 610           | none          | yes              | yes             | 15 s / 15 s        | 120 s              | 30 s / 300 s                        |
| `ultra`/`enterprise` | 2584          | none          | yes              | yes             | 15 s / 15 s        | 120 s              | 30 s / 300 s                        |

On every plan: US stocks and ETFs, forex and crypto; dividends, splits, earnings and the company
profile; symbol search (free); intervals 1m to 3mo. Never on any plan (not implemented): news,
financial statements, futures (`=F`), 5d bars, streaming (the live feed polls quotes). Extended hours
and non-US data follow your plan or the `TWELVEDATA_*` override.

Costs as the app counts them (credits): a `/time_series` request 1, plus 1 for every further page of
5000 rows needed for a long history (at most 12 pages, and never more than the per-minute burst minus
one: a deeper history returns the newest pages it could pay for, and the older bars are simply missing);
a quote 1 per symbol (up to 120 per request); events 3 (dividends, splits and earnings, 1 each, paid for
together before the first is sent); company profile 1; symbol search and symbol info 0. Symbols
Twelve Data cannot serve (futures, indices and non-US symbols outside the plan), and the events and
company profile of FX, crypto and indices (none exist), are answered locally: no request, no credit,
and a symbol listed twice in one quote call is charged once. A deep history is one provider call:
the bar cache does not cut it into Yahoo-sized chunks (`ProviderSpec.self_paging`).

**Budget math.** A Basic account has 800 credits a day, which is 0.56 a minute averaged over the UTC
day (the per-minute 8 is only a burst limit). Polling may use at most half of what is sustainable, the
rest is kept for the chart you open. A 10-symbol watchlist costs 10 credits per quote round, so the
pacer spaces the rounds `10 x 60 / (0.5 x 0.56)` = about 36 minutes apart, whatever
`TWELVEDATA_POLL_INTERVAL_S` says (that is only the lower bound). Symbols whose market is closed are
not counted in that and are not polled again before their exchange opens (at most a day, never less than
the closed-market interval, 1 h on Basic). The cached quote of an open symbol is never fresh for less
than the pacer's interval either, so `/api/quotes` cannot spend what polling is held back from. On Grow
(no daily cap, 55 a minute) the same list is polled every minute, as configured.

## Credit economy

The upstream guard (`providers/guard.py`) is what keeps the app inside the plan:

- **Daily cap.** The guard counts credits per UTC day. At the cap calls are refused locally with 429
  and `Retry-After` set to the 00:00 UTC reset; cached data is served meanwhile (also stale, up to
  `CACHE_STALE_MAX_S`). A daily-exhaustion 429 from the upstream counts the whole day as used.
- **Calibration.** Every response carries `api-credits-used` and `api-credits-left`; `used + left` is
  the per-minute limit and replaces the plan's number, and the token bucket is lowered to `left`
  (never raised). At start-up one `/api_usage` call (1 credit) seeds the per-minute limit and the
  day's count, so a restart does not forget what was spent; other clients on the same key are
  noticed. The app prices every call from its cost model before sending it; a per-request
  `api-credits-request` header is not read (it was not seen in the recordings). A limit you set
  yourself (`UPSTREAM_*`, `TWELVEDATA_*`) is never replaced. The source shown in the Data source
  dialog is `plan`, `env` or `calibrated`.
- **Priorities.** Interactive (bars, symbol info, search) > visible (quotes, extended quotes, events,
  fundamentals) > background (live polls, background refreshes) > prefetch. Only interactive calls wait
  for credits (up to 2 s); the others are refused when they would dip into the share kept for more
  urgent calls: 10% / 25% / 50% of the per-minute burst, and 5% / 15% / 15% of the daily credits.
- **Closed markets.** A symbol whose session is closed is polled at most every
  `LIVE_POLL_CLOSED_INTERVAL_S` (plan value above); for a metered provider it is not polled again until
  the exchange opens (first poll on subscribing, then a hold of at most `QUOTE_CLOSED_TTL_S`). Its
  cached quote stays fresh until the next open, at most `QUOTE_CLOSED_TTL_S` (24 h on Twelve Data,
  10 min on Yahoo). Without stored exchange hours a closed quote is kept for 1 h at most, and a quote
  the upstream calls closed while the stored hours say the exchange is open uses the normal quote TTL.
  No `/market_state` calls.
- **Local refusal before charged requests.** Twelve Data charges refused calls (an unknown symbol,
  a plan-gated one, every failing entry of a batch, and a request over the minute's credits **in
  full**). So the app never sends a request it knows will be refused: a quote batch is split into
  chunks that fit the minute's credits, a request costing more than the credits left in the current
  minute fails locally with 429 until the next minute (the guard refunds its tokens and opens no
  cooldown; the minute's credits are reserved under a lock, so concurrent requests cannot overspend
  them, and the previous minute's count is kept for the first 2 s of the next one), symbols outside the
  plan fail before the upstream is asked, and unknown or unsupported symbols are remembered for
  `CACHE_NEGATIVE_TTL_S` (6 h on Twelve Data).
- **Long TTLs.** Search results 7 days, symbol info 7 days, events 24 h, company profile 7 days.

`GET /api/providers/usage` shows the budget (the guard's own accounting, no credits spent): `plan`,
`metered`, `minute {limit, left}`, `daily {limit, used, resetAt} | null`, `state` and `retryAfterS`.
`state` is `ok`, `throttled` (the next credit is more than 5 s away) or `exhausted` (daily cap reached).
Short waits of a few seconds are normal pacing and stay `ok`. The web app polls it once a minute for a
metered provider and shows a top-bar chip while `throttled` or `exhausted`.

## What is supported

Each provider declares `Capabilities` (intervals, extended history and quotes, adjusted close, search,
event kinds, news, company profile, statements, streaming, markets). A feature the provider does not
have is refused **before** any upstream request or token is spent, with HTTP **501**
`{"detail", "code": "unsupported", "feature", "provider"}`; missing required configuration is 503
`code: "not_configured"`. The web app does not retry a 501.

- Extended-hours bars requested from a provider without them are simply served without them; the
  `prepost` in the `/bars` answer is the effective one.
- `GET /api/news?symbols=` answers 501 when news is unsupported, not an empty list.
- The web app reads `GET /api/providers` once and degrades: the extended-hours toggles and command
  are hidden or disabled, the quote stream stops asking for extended quotes, the news timeline and the
  Details panel show "not available from {provider}", fundamentals-based indicators report why they
  cannot load, and symbol search waits longer (400 ms, 2 characters) on a metered provider. A chart
  whose symbol or interval the provider refuses (a 501, e.g. `VOD.L` on Basic) shows "Not available for
  VOD.L" with the provider's `feature` ("International symbols: not available from Twelve Data.")
  instead of a generic error. While the capabilities are unknown, everything counts as supported.

## Endpoints

- `GET /api/providers`: `{ active, setting, switchable, selectedBy, providers: [...], activeCapabilities,
  effectiveLimits }`. `switchable` is false with `PROVIDER_SWITCHING=false` and with a custom provider;
  `selectedBy` is `"ui"` (picked in the app), `"env"` (`MARKET_PROVIDER` set) or `"default"`.
  Per provider: `id, name, description, network, terms, configured, capabilities, costs, budget, config,
plan`. `config` lists each variable with `env, label, secret, required, set` and the value for
  non-secrets (their default while unset; always `null` for secrets). `effectiveLimits` is
  `{ creditsPerMin, dailyCredits, quoteTtlS, pollIntervalS, source: "plan" | "env" | "calibrated" }`.
  `active` is `null` when the API was built with a custom provider (tests).
- `POST /api/providers/active` `{ id }`: switch the provider (see "Switching in the app"); answers like
  `GET /api/providers`. Refusals are `{ detail, code, ... }`: `403 switching_disabled`,
  `409 custom_provider`, `409 not_configured` (with `missing`: the variables to set), `422 unknown_provider`,
  `429 switch_cooldown` (with `Retry-After`), `500`/`503 switch_failed` (nothing changed), `503
  shutting_down`.
- `GET /api/providers/usage`: the budget, see above.
- `POST /api/providers/test`: asks the active provider for one quote of its probe symbol, through the
  upstream guard (it counts as one upstream request). `{ ok: true, symbol, price, latencyMs }` or
  `{ ok: false, symbol, error }` (`code: "not_configured"` when settings are missing).

## Adding a provider

1. Write the module next to `yahoo.py` (`providers/<id>.py`) implementing `MarketDataProvider`
   (`providers/base.py`): `history`, `symbol_info`, `search`, `quotes`, `extended_quotes`, `events`,
   `news`, `fundamentals`. Raise `SymbolNotFound`, `RateLimited`, `UpstreamUnavailable` or
   `ProviderUnsupported` as the docstrings say; the guard and the caches depend on them. Return the
   shapes of the `TypedDict`s in `base.py`; daily bars are exchange-local midnight as UTC.
   `providers/demo.py` is a compact reference, `providers/twelvedata.py` a metered one.
2. A symbol mapper `to_provider` / `from_provider` between Yahoo-style symbols and yours, using
   `providers/exchanges.py` (MIC, Yahoo suffix, time zone, session). Use `providers/http.py`
   (`JsonHttp`, stdlib `urllib`, injectable `send`) for REST and `providers/resample.py` for
   intervals your API lacks. Do not add a dependency for HTTP.
3. `Capabilities`: what you really serve; the guard enforces it. If you can tell locally which symbols
   you cannot serve, implement `SymbolRouting` (`billable`, `answers_locally`): the guard then charges
   nothing for them. If `history` pages through long ranges itself, set `ProviderSpec.self_paging`.
4. `CostModel`: what each operation costs in your units (credits or requests), and `Budget` /
   `setting_defaults`: the request budget, daily limit and TTLs that suit the provider. They apply only
   to global settings the user did not set. A `plan` callable gives the plan name shown in the UI.
5. A config class, a `pydantic_settings.BaseSettings` with `env_prefix="<ID>_"` and `.env`; secrets are
   `SecretStr`. Required fields missing means "not configured" (503), not a crash. The callables
   of the spec must accept `None` (no config yet) and return the defaults.
6. Import heavy dependencies lazily inside the factory: importing a provider module must stay cheap.
7. Add a `ProviderSpec` to `PROVIDERS` in `providers/registry.py`. The id needs no other registration.
8. Tests: append a `ContractCase` to `CONTRACT_PROVIDERS` in `tests/test_provider_contract.py`
   (shapes, intervals, errors, capability gates), and write provider tests over recorded fixtures with
   a fake `send` (see `tests/test_twelvedata.py` and `tests/fixtures/twelvedata/`); nothing in the tests
   may reach the network.
9. List the variables in `docker-compose.yml` (empty default) and `.env.example`, and describe the
   provider in the table at the top of this page and in the README.

## Twelve Data — verified API facts (recorded 2026-10-27)

Recorded with a real key on a **Basic** account by `api/scripts/record_twelvedata.py`; the responses
are in `api/tests/fixtures/twelvedata/`. 28 credits were spent. Where this contradicts the
documentation or the original plan, the recording wins.

**Account and credits**

- `GET /api_usage` costs 1 credit and returns `{timestamp, current_usage, plan_limit, daily_usage,
plan_daily_limit, plan_category}`. On this account `plan_category` is `"basic"`, `plan_limit` 8 per
  minute and `plan_daily_limit` 800; `current_usage` and `daily_usage` include the call itself.
  So the plan tier and the daily count can be read from the API, no local counter is needed
  (`api_usage_start.json`, `api_usage_end.json`).
- Credit headers `api-credits-used` / `api-credits-left` are per-minute counters: `used + left` equals
  the per-minute limit (8) on every normal response. They are absent on `/symbol_search` and on a 401.
- `/symbol_search` is free (no credits, no credit headers). `/time_series`, `/quote`, `/api_usage` cost 1
  per symbol. `/dividends`, `/splits`, `/earnings`, `/profile` cost 1 per symbol on Basic and work there
  (not 20 / 10 and not plan-gated as the documentation says).
- Refused calls are **not free**. A 404 (unknown symbol), a 400 (bad interval), a plan-gated 404 and the
  per-symbol 403 / 404 entries of a batch each cost 1 credit per symbol. A 401 is free.
- Going over the per-minute limit returns 429 and **is charged in full**: a 9-symbol `/quote` on an
  8-credit minute returned `used=9, left=0`, and the daily count rose by 9 (`error_429.json`,
  `api_usage_after_429.json`). The 429 has no `Retry-After` header; wait for the next minute.
  Request at most `left` symbols per call.
- Authentication with `Authorization: apikey <key>` works. An invalid key gives 401 with the
  message "**apikey** parameter is incorrect or not specified" (`error_401.json`).

**Error JSON**

- Always `{"code": <int>, "message": str, "status": "error"}` with the HTTP status equal to `code`.
  400 and 404 add `"meta": {"symbol", "interval", "exchange"}` for `/time_series` (`time_series_notfound.json`,
  `time_series_bad_interval.json`, `error_429.json`).
- Unknown symbol is **404** (also for batch entries), not 400.
- Plan-gated international symbol: **404** from `/time_series` ("This symbol is available starting with
  the Grow or Venture plan", `time_series_vod_exchange.json`) but **403** inside a batch `/quote`
  ("**symbol** VOD is not available with your plan"). Classify by message, not by code alone.

**Time series**

- Values come newest first with `order=desc` (the default); numbers are strings.
- `1day`: `datetime` is `"YYYY-MM-DD"`, the exchange-local date only. The newest row is the current
  session while it is open (partial high / low / volume). `1min`: `datetime` is
  `"YYYY-MM-DD HH:MM:SS"`, exchange local, the bar's open time, regular session only
  (`time_series_1day_aapl.json`, `time_series_1min_aapl.json`).
- `meta` has `symbol, interval, currency, exchange_timezone ("America/New_York"), exchange, mic_code,
type` and the body ends with `"status": "ok"`.
- `1week`: bars are dated the **Monday** of the week (2026-10-26) and the current week is included while
  in progress (`time_series_1week_aapl.json`).
- `outputsize=5000` works for `1min` and returns 5000 rows on Basic (1 credit). The saved fixture is
  trimmed to 300 rows (`_trimmed`); `time_series_1min_aapl_page2_synthetic.json` is **synthetic** (older
  rows of the same response, shaped as an `end_date` page) because a real second page would cost more.
- Dotted tickers keep the dot: `BRK.B` is accepted (`time_series_brkb.json`).
  `symbol_search?symbol=BRK` lists `BRK.B` / NYSE / "Berkshire Hathaway Inc. Class B" seventh, after
  six foreign `BRK` listings (`symbol_search_brk.json`).

**Quote** (`quote_aapl.json`, `quote_batch.json`)

- Single symbol: a flat object. Several symbols (even when some fail): an object keyed by the symbol
  **as requested** (`"VOD:LSE"`), each value a quote object or a per-symbol error
  `{code, message, status: "error", meta}`; the HTTP status is 200.
- `datetime` is the date only and `timestamp` is the **session open** (09:30 New York), not the last
  trade. `last_quote_at` (epoch seconds) is the last quote time and should be used as the quote time.
  Other fields: `name, exchange, mic_code, currency, open, high, low, close, volume, previous_close,
change, percent_change, average_volume, is_market_open, fifty_two_week{...}`.
- `VOD:LSE` is a valid batch form but is plan-gated on Basic (403 entry above); whether it works on Grow
  is not verified.

**Events and profile** (Basic, 1 credit each)

- `/dividends`: `{meta, dividends: [{ex_date, amount}]}`. `/splits`: `{meta, splits: [{date, description,
ratio, from_factor, to_factor}]}`. `/earnings`: `{meta, earnings: [{date, time, eps_estimate,
eps_actual, difference, surprise_prc}], status}`. `/profile`: flat object with `sector, industry,
employees, website, description, type, CEO, address..., country, phone`
  (`dividends_aapl.json`, `splits_aapl.json`, `earnings_aapl.json`, `profile_aapl.json`).

**Not verified** (no credit was spent on these; the implementation follows the documentation, and the
first real use on the right plan may need a fix)

- `range=full` on `/dividends` and `/splits` (full history instead of the default window).
- The Twelve Data exchange codes of Euronext (one code for Paris and Amsterdam, told apart by `mic_code`),
  ARCX (`NYSE ARCA`), BATS (`CBOE`), XMIL (`MTA`) and XMAD (`BME`), and everything else in
  `providers/exchanges.py` that is not US, London or the `VOD:LSE` form seen above.
- On Pro and above: `prepost=true` on `/time_series` and `/quote`, and the names and meaning of the
  `extended_*` fields of `/quote` (`extended_price`, `extended_timestamp`, `extended_change`,
  `extended_percent_change`).
- Index symbols (`^GSPC` as `SPX`, `^IXIC`, `^DJI`, `^RUT`, `^NDX`, `^VIX`) and whether they need a
  plan above Basic (only plans with non-US data are assumed to serve them).
- Whether international symbols are priced as 1 credit on Grow and above, and the quote batch limit of 120.
- The `api-credits-request` response header (not seen in the recordings, not used).
- That `/symbol_search` stays free (it showed no credit headers and no usage on Basic).
- `/statistics` and the financial statements (documented at 50 and 100 credits): not used.
