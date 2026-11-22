# Market data providers

The API fetches market data through one provider at a time. `MARKET_PROVIDER` in `.env` picks the one
used at start-up, and the web app can switch it at runtime (see "Switching in the app"; locked with
`PROVIDER_SWITCHING=false`). The web app shows the active provider, its limits and a connection test on
the first visit and under **More → Data source…**. There is no key entry in the web app: keys and
plans live in the server's environment.

| `MARKET_PROVIDER` | Provider                | Key          | Free-plan limits                                                   | Markets                                          | Intervals         | Live         | Notes                                                                                                                      |
| ----------------- | ----------------------- | ------------ | ------------------------------------------------------------------ | ------------------------------------------------ | ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `yahoo` (default) | Yahoo Finance           | no           | none declared (unofficial, may throttle)                           | everything, worldwide                            | 1m to 3mo         | yes          | Through [yfinance](https://github.com/ranaroussi/yfinance). Everything supported. Yahoo's terms allow personal use only.   |
| `twelvedata`      | Twelve Data             | yes          | Basic: 8 credits/min, 800/day, US only                             | US stocks, FX, crypto (more on paid plans)       | 1m to 3mo         | polled       | The [Twelve Data](https://twelvedata.com) REST API; paces itself to your plan's credits (below).                           |
| `alpaca`          | Alpaca                  | key pair     | 200 requests/min, IEX feed only, 30 streamed symbols               | US stocks, ETFs, crypto                          | 1m to 3mo         | yes (trades) | [Alpaca](https://alpaca.markets) Market Data. IEX volume is a small part of the market (below).                            |
| `tiingo`          | Tiingo                  | yes          | 50 requests/hour, 1000/day, 500 symbols/month                      | US stocks, ETFs, crypto                          | 5m to 3mo         | opt-in (IEX) | [Tiingo](https://www.tiingo.com). Fetches whole ranges in one request to fit the hourly limit.                             |
| `massive`         | Massive (ex Polygon.io) | yes          | Basic: 5 calls/min, end-of-day, 2 years                            | US stocks, ETFs; crypto and FX as the key allows | 1d to 3mo (Basic) | polled       | [Massive](https://massive.com), formerly Polygon.io. Paid plans add minute bars (15-minute delayed on Starter, Developer). |
| `stooq`           | Stooq                   | yes (manual) | unknown quota (guessed: 10/min, 300/day)                           | US, UK, DE, JP stocks, indices, FX, crypto       | 1d, 1wk, 1mo      | polled       | Unofficial CSV downloads; the key comes from a captcha page. No search, no previous close in batch quotes.                 |
| `crypto`          | Crypto exchange         | no           | Kraken 50/min, Coinbase and Binance 300/min (the app's own pacing) | crypto spot pairs only                           | 1m to 3mo         | yes (ticks)  | Public data of Kraken (default), Coinbase or Binance (`CRYPTO_EXCHANGE`). Rolling 24 h "day".                              |
| `demo`            | Demo data               | no           | none (offline)                                                     | everything (synthetic)                           | 1m to 3mo         | yes          | A deterministic random walk per symbol (New York session hours). For trying the app, screenshots, tests.                   |

"Live: polled" means the live feed polls quotes at the plan's interval; "yes" means a WebSocket feeds
the live quotes (symbols the stream does not cover are polled). Finnhub is deferred to 3.3 (its free
plan has no candle history).

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
| `alpaca`     | see "Alpaca"    |
| `tiingo`     | see "Tiingo"    |
| `massive`    | see "Massive"   |
| `stooq`      | see "Stooq"     |
| `crypto`     | see "Crypto"    |

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

## Alpaca

US stocks, ETFs and crypto from [Alpaca](https://alpaca.markets) Market Data, with live trades over
WebSocket. Module `providers/alpaca.py`.

**Getting keys.** Create a free Alpaca account (a paper-trading account is enough, no funding), open
the dashboard and generate an API key pair: a key ID and a secret. Set `MARKET_PROVIDER=alpaca`,
`ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`.

| Variable                  | Default                            | Meaning                                                                                  |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `ALPACA_KEY_ID`           | required                           | API key ID. Without both keys every data call answers 503 `not_configured`.              |
| `ALPACA_SECRET_KEY`       | required                           | API secret.                                                                              |
| `ALPACA_PLAN`             | `basic`                            | `basic` (free) or `algo_trader_plus`.                                                    |
| `ALPACA_FEED`             | the plan's (`iex` / `sip`)         | `iex` or `sip`. Basic always uses `iex`; the setting only matters on `algo_trader_plus`. |
| `ALPACA_DATA_BASE_URL`    | `https://data.alpaca.markets`      | Market data base URL (https only, or http for localhost).                                |
| `ALPACA_TRADING_BASE_URL` | `https://paper-api.alpaca.markets` | Only the active-assets list (search, symbol info) is read from it (https only).          |
| `ALPACA_EXTENDED_HOURS`   | `true`                             | `true` / `false`: pre/post-market bars.                                                  |
| `ALPACA_CRYPTO_LOCATION`  | `us`                               | `us`, `us-1` or `eu-1`: the crypto data location.                                        |

**Plans.** `basic`: 200 calls a minute (burst 50), IEX feed, live trades for 30 symbols on one
connection per stream (symbols past that are polled), quotes cached 15 s. `algo_trader_plus`: 10 000
calls a minute, SIP feed, no stream symbol limit, quotes cached 5 s. Each request counts one call; further
bar pages, the adjusted-close pass, the assets lists and extra quote chunks are charged too, and the
`X-RateLimit-*` response headers are fed to the guard.

**Caveats.**

- The free IEX feed is one exchange: its volume is roughly 2.5% of the whole market, so volumes (and
  sometimes high / low) are far lower than on Yahoo. Prices come from IEX trades only.
- The free plan may not query recent SIP data (the last 15 minutes: such a request answers 403); the
  app therefore always sends `feed=iex` on `basic`.
- Indices, FX, futures and non-US symbols are not served (answered locally, no request). Crypto
  symbols are `BTC-USD` style. Extended-hours quotes, events, news and fundamentals are not offered.
- Daily and longer stock bars follow Yahoo's semantics (`close` split-adjusted, `adj_close` also
  dividend-adjusted); intraday bars are raw. Alpaca has no "unknown symbol" answer for quotes, so a
  missing symbol is simply absent.
- Stock 60m bars without pre/post-market are built from 30m bars so the first one opens at 09:30
  (Alpaca's native `1Hour` bars are clock-aligned: the 09:00 bar holds the half hour before the open).
  With pre/post-market, and for crypto, the native hourly bars are used.
- If the stock stream is refused for good (credentials, connection limit) while the crypto stream works,
  only that connection stops and its symbols are polled; the live feed shows as down when no stream is
  left or the stream could not be reached six times in a row.

**Verified API facts.** None from a live account: the module is built from the documented shapes. Still
unverified (the first real use may need a fix):

- `/v2/stocks/snapshots` answering `{SYMBOL: snapshot}` (a `{"snapshots": {...}}` wrapper is accepted)
  and omitting unknown symbols; an invalid symbol answering 400.
- `sort=desc` plus `page_token` paging of the multi-symbol bars endpoint, and `bars: null` for no data.
- Daily bar stamps (`T04:00Z` / `T05:00Z`), 1Hour and 3Month alignment, crypto daily bars on the UTC date.
- The assets list with paper-trading keys on `paper-api.alpaca.markets`; `/v2/assets` having no ETF flag.
- The 403 text of a plan-gated feed and the 429 `Retry-After`.
- Stream: `connected` arriving first, the `subscription` acknowledgement, what a 405 leaves subscribed,
  and the crypto stream on `wss://.../v1beta3/crypto/us`.

## Tiingo

US stocks and ETFs (end-of-day history, IEX intraday bars and quotes) and crypto from
[Tiingo](https://www.tiingo.com). Module `providers/tiingo.py`.

**Getting a key.** Create a free Tiingo account and copy the API token from the account page. Set
`MARKET_PROVIDER=tiingo` and `TIINGO_API_KEY`.

| Variable          | Default                  | Meaning                                                                           |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `TIINGO_API_KEY`  | required                 | API token. Without it every data call answers 503 `not_configured`.               |
| `TIINGO_PLAN`     | `starter`                | `starter` (free) or `power`.                                                      |
| `TIINGO_BASE_URL` | `https://api.tiingo.com` | API base URL (https only, or http for localhost).                                 |
| `TIINGO_STREAM`   | `false`                  | `true` opts in to the IEX WebSocket for stocks (crypto and the rest stay polled). |

**Plans.** `starter`: 50 requests an hour (burst 10), 1000 a day, 500 unique symbols a month; quotes
cached 2 min. `power`: 10 000 an hour, 100 000 a day, 5000 symbols a month.

**Caveats.**

- 50 requests an hour is tight, so every operation is one request: a history call fetches its whole
  range at once and a quote batch is one request for many symbols.
- The monthly unique-symbol cap (500) cannot be enforced by the app (Tiingo counts every symbol the
  key ever asked for). When it is hit, Tiingo's own error text surfaces as a plain upstream error;
  symbols already fetched stay served from the cache.
- Stock quotes use `tngoLast`: Tiingo's `last` is null without an IEX agreement (since 2025-02).
- Intraday bars are IEX 5-minute bars; 15m, 30m, 60m and 90m are built from them. `1m` and `2m` are
  not offered. Weekly, monthly and quarterly bars are built from daily ones. Intraday stock bars are
  cut to the regular session.
- Indices, FX, futures, non-US symbols and crypto pairs outside USD, USDT, USDC, EUR and BTC are not
  served. Fundamentals, events and news are not offered.
- Live updates are off by default: the free plan's request budget does not need the stream.

**Verified API facts.** None from a live account (built from the documented shapes). Still
unverified:

- Time stamps: IEX `date` as the bar's open with an offset or `Z`; daily `date` as
  `...T00:00:00.000Z` of the trading date; crypto `date` with `+00:00`; quote `timestamp` and
  `lastSaleTimestamp` as ISO strings.
- `startDate` without `endDate` running to the latest bar; a `startDate` after the last bar answering
  `[]`; an unknown stock answering 404 `{"detail": "Not found."}`; `/iex/?tickers=` omitting unknown tickers.
- `splitFactor` being the split ratio on the ex-date (the split-adjusted `close` depends on it).
- 5-minute IEX bars stamping the bar open and reaching back far enough (the depth is not documented).
- `/tiingo/crypto` meta and `/tiingo/crypto/prices` shapes, and the `/tiingo/utilities/search` rows.
- The wording and status codes of the per-hour, per-day and monthly-symbol limit errors, and the Power
  plan's numbers.
- Stream: `wss://api.tiingo.com/iex`, the subscribe form with `thresholdLevel` 6, an update re-sending
  the full ticker list (verify whether `eventName: "unsubscribe"` exists for removing tickers), the
  trade row layout, and `messageType: "E"` with 401 / 403 for a rejected key.

## Massive

US stocks and ETFs (plus crypto and FX where the key allows) from [Massive](https://massive.com),
formerly Polygon.io. Module `providers/massive.py`.

**Getting a key.** Create a free account on massive.com and copy the API key from the dashboard. Set
`MARKET_PROVIDER=massive` and `MASSIVE_API_KEY`. The id is `massive`; there is no `polygon` alias.

| Variable           | Default                   | Meaning                                                                            |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `MASSIVE_API_KEY`  | required                  | API key. Without it every data call answers 503 `not_configured`.                  |
| `MASSIVE_PLAN`     | `basic`                   | `basic` (free), `starter`, `developer` or `advanced`.                              |
| `MASSIVE_BASE_URL` | `https://api.massive.com` | API base URL (https only). `https://api.polygon.io` still works (pre-rename keys). |

**Plans.**

| Plan        | Calls / min | History   | Data                            | Quote cache / poll |
| ----------- | ----------- | --------- | ------------------------------- | ------------------ |
| `basic`     | 5           | 2 years   | end-of-day only (`1d` to `3mo`) | 1 h / 1 h          |
| `starter`   | no limit    | 5 years   | minute bars, 15-minute delayed  | 60 s / 60 s        |
| `developer` | no limit    | 10 years  | minute bars, 15-minute delayed  | 60 s / 60 s        |
| `advanced`  | no limit    | unbounded | minute bars, real time          | 15 s / 15 s        |

**Caveats.**

- On `basic` only `1d`, `1wk`, `1mo` and `3mo` bars are offered, there is no batch snapshot, and a
  quote costs one call per symbol (the last two daily bars give price and previous close). At 5 calls
  a minute a long watchlist is slow to fill: the request guard sends at most 5 symbols at a time (its
  burst), and when the budget runs out the quotes fetched so far are kept and the rest wait.
- A plain-http base URL is refused (the key travels to it) unless the host is `localhost`,
  `127.0.0.1` or `::1`; `next_url` pages are followed only on the same scheme, host and port.
- Weekly bars that start on a Sunday are stamped on the Monday after, like the other providers'.
- Prices are split-adjusted only: `adj_close` equals `close`. No streaming (Massive's WebSocket is
  paid and per asset class; the live feed polls). No events, news or statements.
- Stocks and ETFs are plain (`BRK-B` is `BRK.B`), crypto is `X:BTCUSD`, FX `C:EURUSD`. Indices
  (a separate paid asset class), futures and non-US listings are not served.

**Verified API facts.** None: no key was available when the module was written, and its fixtures are
hand-built from the documentation. Still unverified (each degrades to a clear error, not wrong data):

- Aggregates of an unknown ticker answering 200 without `results`, and one `/v3/reference/tickers/{T}`
  call telling "unknown" from "no bars".
- Daily, weekly and monthly `t` being midnight New York time of the bar's first day (a weekly bar
  starting on a Sunday is moved to the Monday).
- Native `{n}/minute` multipliers 1, 5, 15 and 30 aligning to the clock; minute aggregates including
  pre/post-market bars.
- The plan history depths and the refusal answers (403 `NOT_AUTHORIZED`, 401 bad key, 404 `NOT_FOUND`,
  429 over the limit; a 200 with status `DELAYED` is data).
- The snapshot shape `tickers: [{ticker, day, min, prevDay, lastTrade}]`, and whether the free key
  serves crypto and FX end-of-day data (capabilities declare them on every plan).
- The `X:` / `C:` prefixes and forex daily bars on the UTC day of `t`.

## Stooq

Daily, weekly and monthly history from [stooq.com](https://stooq.com) for US, UK, German and Japanese
stocks, some indices, FX and crypto. Module `providers/stooq.py`.

**Getting a key.** Stooq is unofficial and, since about March 2026, wants an `apikey` on every
request. Open <https://stooq.com/q/d/?s=aapl.us&get_apikey> in a browser, solve the captcha, and copy
the value after `apikey=` from the CSV download link on that page. Set `MARKET_PROVIDER=stooq` and
`STOOQ_API_KEY`. When the key expires the API answers 503 `not_configured` with the same
instructions; repeat the steps.

| Variable         | Default             | Meaning                                                                |
| ---------------- | ------------------- | ---------------------------------------------------------------------- |
| `STOOQ_API_KEY`  | required            | The key from the captcha page. Without it every data call answers 503. |
| `STOOQ_BASE_URL` | `https://stooq.com` | Base URL (https only, or http for localhost).                          |

There is no plan setting. The request budget is a conservative guess (10 a minute, burst 5, 300 a day)
because Stooq publishes no quota; set `UPSTREAM_RATE_PER_MIN`, `UPSTREAM_BURST` and
`UPSTREAM_DAILY_LIMIT` to override it.

**Caveats.**

- Unofficial and personal use; it may break without notice. The key is in the URL, so the app redacts
  it (`apikey=***`) from every message and log line.
- Only `1d`, `1wk` and `1mo`. No intraday, search, news, events or fundamentals. `adj_close` equals
  `close` (Stooq is believed to adjust for splits, not dividends). Streaming is not offered.
- Batch quotes come from `/q/l/` and carry no previous close, so the change is not shown for them.
  If `/q/l/` fails (unverified), quotes come from the last two daily bars, one request per symbol,
  each charged to the request budget; `/q/l/` is not tried again for six hours.
- No symbol search: type the symbol (`AAPL`, `VOD.L`, `^GSPC`, `EURUSD=X`, `BTC-USD`). Crypto pairs
  other than `-USD`, `-EUR` and `-GBP` (`BTC-USDT`, `ETH-BTC`), and fiat pairs without `=X`
  (`EURUSD`), are not served and never sent.
- Weekly and monthly bars are stamped on the first day of their week (Monday) or month, not on the
  last trading day Stooq dates them with. A plain-http base URL is refused unless the host is
  `localhost`, `127.0.0.1` or `::1`.
- Stooq answers 200 to everything, so the app judges the body: "Exceeded the daily hits limit" is a
  daily rate limit, an HTML page means a missing or expired key, "No data" means an unknown symbol or
  an empty range.

**Verified API facts.** None from a live account. Still unverified:

- The `apikey` parameter name on `/q/d/l/` and `/q/l/` (when `/q/l/` does not answer CSV, quotes fall
  back to the last two daily bars per symbol).
- The quote CSV (`Symbol,Date,Time,Open,High,Low,Close,Volume`, `N/D` for unknown symbols) and its
  times being Europe/Warsaw.
- The empty `h=` flag, `+` between symbols in `s=`, and the exact limit and key-missing texts (matched loosely).
- "No data" being the whole body for an unknown symbol and for an empty range alike.
- The daily limit resetting at 00:00 UTC; the free quota (the defaults are guesses).
- Weekly and monthly bars being dated on the period's last trading day, `Volume` absent for some
  indices (then 0).
- Symbol names of class shares (`brk-b.us`), the index table, `usdjpy` for `JPY=X`, crypto pairs
  `btcusd` / `btceur` / `btcgbp`, and UK prices being in pence (`GBp`).

## Crypto

Crypto spot pairs straight from the public API of Kraken, Coinbase or Binance, with live ticks. No key,
no account, no CCXT. Module `providers/crypto/`.

Set `MARKET_PROVIDER=crypto` and optionally `CRYPTO_EXCHANGE`.

| Variable            | Default        | Meaning                                     |
| ------------------- | -------------- | ------------------------------------------- |
| `CRYPTO_EXCHANGE`   | `kraken`       | `kraken`, `coinbase` or `binance`.          |
| `CRYPTO_BASE_URL`   | the exchange's | REST base URL override (a proxy or mirror). |
| `CRYPTO_STREAM_URL` | the exchange's | WebSocket URL override.                     |

Both overrides must be `https://` / `wss://` (plain `http://` / `ws://` only for localhost).

Defaults per exchange: Kraken `api.kraken.com` and `wss://ws.kraken.com/v2`; Coinbase
`api.coinbase.com` and `advanced-trade-ws.coinbase.com`; Binance `data-api.binance.vision` and
`data-stream.binance.vision`, Binance's public market-data hosts, which serve spot data without the
geo block (HTTP 451) that `api.binance.com` applies in some regions. binance.us is a different exchange
and is not covered. The app paces itself well under the public limits: Kraken 50 a minute, Coinbase and
Binance 300 (burst 10).

**Caveats.**

- Pairs only (`BTC-USD`, `ETH-USDT`, `ETH-BTC`); stocks, indices, FX and futures are not served.
  Kraken's `XBT` and `XDG` are read as `BTC` and `DOGE`. A pair the chosen exchange lacks is not found.
- Crypto has no session: the "day" of a quote is a **rolling 24 hours** (volume, high, low, and the
  change from the price 24 hours ago). Kraken's REST ticker only has the 00:00 UTC open, so its quotes
  measure from that, while its live ticks carry the rolling 24-hour change; the two differ a little.
- **Kraken keeps only the latest 720 bars** of each interval (12 hours of 1m, 60 days of 1h, 720 days
  of 1d), so deep ranges return what exists; synthesized weekly, monthly and quarterly bars reach back
  about two years. Coinbase and Binance page back as far as the request allows.
- Every interval is offered: native ones come from the exchange, `2m`, `90m`, weekly (Monday, UTC),
  monthly and quarterly bars are built from finer ones. `prepost` is ignored; daily bars open at
  00:00 UTC; volume is in the base asset and truncated to an integer in quotes.
- No extended-hours quotes, events, news or fundamentals. The screener stays off by default (its
  universe is equities).

**Verified API facts.** The endpoints below were confirmed against the live APIs on 2026-11-17 (the
test fixtures are trimmed recordings).

- Kraken: `/0/public/AssetPairs`, `OHLC` (latest 720 bars, last row still forming; weekly bars open on
  Thursdays, which is why weeks are built from daily bars) and `Ticker` (`c`, `o` = 00:00 UTC open, `h`,
  `l`, `v`); errors arrive inside a 200 as `{"error": [...]}`. WebSocket v2 takes `BTC/USD`, not `XBT`,
  refuses an unknown symbol alone, and its ticker frames carry the rolling 24-hour change.
- Coinbase Advanced Trade: the `/market/` endpoints answer without credentials. `products?product_type=SPOT`
  with repeated `product_ids=` is the batch quote; candles come newest first, a page is 300 (more than
  349 is a 400); weekly and longer bars are built from daily ones; a bad product id is a 400. The
  `ticker` WebSocket channel needs no authentication and drops unknown products silently.
- Binance (`data-api.binance.vision`): `exchangeInfo`, `klines` (at most 1000, newest before `endTime`;
  weekly bars open Mondays), `ticker/24hr` (one unknown symbol refuses the whole request, so only known
  symbols are asked), unknown symbol is 400 `-1121`. The `miniTicker` stream acknowledges
  `{"result": null}` and never streams an unknown symbol.

**Still unverified:** the 429 answers and `Retry-After` on all three (Binance's 418 ban text), that
Coinbase ONE_DAY candles start at 00:00 UTC, and Coinbase's 5-second rule for a first subscribe.

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

1. Write the module next to `yahoo.py` (`providers/<id>.py`; a provider with several backends is a
   package, as `providers/crypto/`) implementing `MarketDataProvider`
   (`providers/base.py`): `history`, `symbol_info`, `search`, `quotes`, `extended_quotes`, `events`,
   `news`, `fundamentals`. Raise `SymbolNotFound`, `RateLimited`, `UpstreamUnavailable` or
   `ProviderUnsupported` as the docstrings say; the guard and the caches depend on them. Return the
   shapes of the `TypedDict`s in `base.py`; daily bars are exchange-local midnight as UTC.
   `providers/demo.py` is a compact reference, `providers/twelvedata.py` a metered one.
2. A symbol mapper `to_provider` / `from_provider` between Yahoo-style symbols and yours, using
   `providers/exchanges.py` (MIC, Yahoo suffix, time zone, session). Use `providers/http.py`
   (`JsonHttp`, stdlib `urllib`, injectable `send`) for REST and `providers/resample.py` for
   intervals your API lacks. Do not add a dependency for HTTP. A CSV or other text API uses
   `JsonHttp.get_text` (same error mapping and request counting; the query string, where a key may
   travel, never appears in errors or logs), see `providers/stooq.py`.
3. `Capabilities`: what you really serve; the guard enforces it. If you can tell locally which symbols
   you cannot serve, implement `SymbolRouting` (`billable`, `answers_locally`): the guard then charges
   nothing for them. If `history` pages through long ranges itself, set `ProviderSpec.self_paging`.
4. `CostModel`: what each operation costs in your units (credits or requests), and `Budget` /
   `setting_defaults`: the request budget, daily limit and TTLs that suit the provider. They apply only
   to global settings the user did not set. A `plan` callable gives the plan name shown in the UI.
   Providers with paid tiers keep a `PlanProfile` table (`PLAN_PROFILES`, a `plan` setting) that
   drives capabilities, costs, budget and TTLs; `providers/alpaca.py`, `tiingo.py` and `massive.py`
   follow the same shape as `twelvedata.py`. Describe what the configured plan really serves
   (Massive Basic offers daily bars only).
5. A config class, a `pydantic_settings.BaseSettings` with `env_prefix="<ID>_"` and `.env`; secrets are
   `SecretStr`. Required fields missing means "not configured" (503), not a crash. The callables
   of the spec must accept `None` (no config yet) and return the defaults.
6. Import heavy dependencies lazily inside the factory: importing a provider module must stay cheap.
7. Live quotes: if the upstream has a WebSocket, return a `LiveSource` from `ProviderSpec.make_live`
   and build it on `providers/stream.py` (`StreamClient`: reconnect with backoff and jitter,
   `on_open` for auth and resubscribe, inline-awaited `on_message`, `StreamFatal` to give up,
   `max_failures` so `listen` ends and the hub shows the stream down during an outage, no redirects,
   `wss://` only; the `websockets` package is a declared dependency, imported lazily). Symbols the stream does not
   cover stay polled by the hub. Without `make_live` the hub polls quotes. See `alpaca.py`,
   `tiingo.py` and `crypto/live.py`.
8. Add a `ProviderSpec` to `PROVIDERS` in `providers/registry.py`. The id needs no other registration.
9. Tests: append a `ContractCase` to `CONTRACT_PROVIDERS` in `tests/test_provider_contract.py`
   (shapes, intervals, errors, capability gates), and write provider tests over recorded fixtures with
   a fake `send` (see `tests/test_twelvedata.py` and `tests/fixtures/twelvedata/`); nothing in the tests
   may reach the network. A live source gets a fake-WebSocket test (a fake `connect` factory).
10. List the variables in `docker-compose.yml` (empty default) and `.env.example`, and describe the
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
