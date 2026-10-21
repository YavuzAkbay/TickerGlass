# Caching and upstream request limits

Yahoo's free data has hidden rate limits, so TickerGlass keeps the number of upstream requests low. Every request that
can be answered from memory, the bars database or the browser is. Only the API talks to Yahoo; the browser only talks
to the API. When a cached value exists, an upstream failure never turns into an error: the cached value is served.

Code:

- `api/src/tickerglass_api/providers/guard.py`: `UpstreamGuard`, `GuardedProvider`.
- `api/src/tickerglass_api/services/cache.py`: `SmartCache`. `services/market.py`, `services/symbols.py`: its users.
- `api/src/tickerglass_api/services/bars.py`, `services/sessions.py`: bars database, tail refresh schedule, pruning.
- `api/src/tickerglass_api/services/maintenance.py`: periodic upkeep.
- `api/src/tickerglass_api/routes/_cache_headers.py`: `Cache-Control` helpers. `routes/cache.py`: `/api/cache/stats`.
- `api/src/tickerglass_api/services/stats.py`: counters behind the stats endpoint.
- `packages/engine/src/feed/coalescing-feed.ts`, `http-feed.ts`; `apps/web/src/quotes/stream.ts`, `apps/web/src/api/client.ts`: client caches.

Limitations and their status: [LIMITATIONS.md](LIMITATIONS.md#data-yahoo--yfinance).

## 1. Layers

A request passes these layers from the browser inward to Yahoo and stops at the first one that has the answer.

```
browser caches -> HTTP Cache-Control -> server caches (SmartCache, bars DB) -> upstream guard -> Yahoo
```

The sections below go from Yahoo outward.

### 1.1 Upstream guard

`create_app` wraps the provider (the Yahoo adapter, or a fake in tests) in a `GuardedProvider`. Every upstream call,
including the live poller's and background refreshes, takes tokens from one `UpstreamGuard` first. Nothing else sends
requests to Yahoo.

- **Token bucket.** `UPSTREAM_RATE_PER_MIN` tokens per minute (default 60), at most `UPSTREAM_BURST` saved up
  (default 20). A call costs the number of upstream requests it makes: 1 for bars, symbol info, search and news, 2 for
  events, 4 for fundamentals, and one per 50 symbols for quotes (`ceil(n / 50)`). A foreground call that has no tokens
  waits up to 2 s for them; if they would take longer it fails locally with `429` and a `Retry-After` header, without
  contacting Yahoo.
- **Background priority.** Refreshes nobody is waiting for (stale-while-revalidate reloads, the live poller's polls) run
  in background mode. They never wait, and are refused while fewer than 25% of the burst is left, so interactive
  requests keep a reserve. A refused poll just skips that round.
- **Rate-limit breaker.** When Yahoo refuses (rate limited), nothing is sent for `max(retry_after, backoff)` seconds.
  The backoff starts at `UPSTREAM_COOLDOWN_INITIAL_S` (30), doubles on every further refusal, resets on a success and
  is capped at `UPSTREAM_COOLDOWN_MAX_S` (900; this also caps a `retry_after` from upstream, and `0` turns the breaker
  off). While it is open, calls fail locally with `429` and the remaining time in `Retry-After`.
- **Unavailable breaker.** After a connection failure or timeout nothing is sent for `UPSTREAM_UNAVAILABLE_COOLDOWN_S`
  seconds (10); calls fail locally with `503`.
- **What counts as success.** A symbol that does not exist is a definite answer from a healthy upstream, so it resets
  the backoff. A partial quote answer (some 50-symbol chunks failed) changes no breaker.
- **Provider retries.** Inside the Yahoo adapter, network failures are retried `UPSTREAM_RETRIES` times (2) with a short
  backoff, rate-limit refusals `UPSTREAM_RATE_LIMIT_RETRIES` times (0: the guard's cooldown takes over), and any other
  failure (usually a payload yfinance cannot parse) once.

Callers see `429` (rate limited), `503` (unavailable) or `502` (other upstream failure) only when nothing cached can be
served.

### 1.2 Server cache (`SmartCache`)

Market data without a table of its own (quotes, extended-hours quotes, events, news, fundamentals, search) lives in
in-memory `SmartCache` instances. Each is an LRU with these rules:

- **Single-flight.** Concurrent readers of one key share one load, and a batch read joins loads already in flight.
- **Stale-while-revalidate** (events, fundamentals, search). A value older than its TTL but younger than
  `CACHE_STALE_MAX_S` is served immediately while one background reload runs (on a 2-thread pool, in background mode).
  Quotes, extended quotes and news are not served stale this way: past their TTL they are fetched first.
- **Stale-on-error.** If a load fails, a value younger than `CACHE_STALE_MAX_S` (7 days) is served instead.
- **Not-found tombstones.** A symbol Yahoo reports as unknown is remembered as unknown for `CACHE_NEGATIVE_TTL_S` (1 h).
  For quotes this happens only when the whole batch was answered; a symbol that merely failed to load is asked again.
- **LRU bound.** At most `CACHE_MAX_ENTRIES` entries per cache (4096); search keeps 1024 queries.
- **One fetch for several limits.** News is fetched with `NEWS_FETCH_LIMIT` items (50) and sliced for smaller limits.
  Search keys ignore case and surrounding spaces, and one fetch serves every smaller `limit`; a larger one fetches again.

Symbol metadata (`/api/symbols/{symbol}`) is stored in the database for 24 h; if a refresh fails the stored row is
served whatever its age.

### 1.3 Quotes

`/api/quotes` and the live poller read through one quote cache, so a poll and a request within the poll interval share
one upstream request. Quotes come from Yahoo's batch quote endpoint, 50 symbols per request, so a 50-symbol watchlist
costs one request instead of fifty. Each quote carries its currency and market state. The TTL follows the market state
of the quote:

- open (`REGULAR`) or unknown: `QUOTE_TTL_S` (15 s);
- pre/post-market sessions (`PRE`, `PREPRE`, `POST`, `POSTPOST`): `EXTENDED_TTL_S` (60 s);
- closed (`CLOSED`): `QUOTE_CLOSED_TTL_S` (600 s), as prices cannot change.

If the batch endpoint fails for a reason other than a rate limit or an outage, the quotes are built from the last daily
bars instead (one request per symbol; currency is only known for symbols opened before, and the answer is never used
to mark a symbol unknown). Rate limits and outages skip that fallback so it cannot add load.

`/api/quotes/extended` (pre/post-market prices) has its own cache with a fixed `EXTENDED_TTL_S`. A failed chunk of it is
never cached as "no such symbol".

### 1.4 Bars database

Bars live in the `bars` table (SQLite or Postgres), one series per symbol, interval and pre/post flag. The first request
for a series backfills everything Yahoo allows; later requests refetch only the newest bars.

**Tail refresh.** A series is refreshed when its next check time (`series_meta.next_check_at`) has passed. A request
whose `to` is not newer than the newest cached bar never refreshes (`bars.covered`).

- With the symbol's stored metadata (type, time zone and regular session), the schedule follows the market. Open: every
  `BARS_TAIL_TTL_INTRADAY_S` (30 s) for intraday intervals, `BARS_TAIL_TTL_DAILY_S` (300 s) for daily and longer. After
  the close: one final refresh `BARS_SETTLE_AFTER_CLOSE_S` (1200 s) later. Then nothing until the next open, so a
  weekend costs no requests.
- Only a weekly schedule is known (one regular session per trading day, in the exchange time zone). The trading days
  follow the time zone: Monday to Friday for the Americas, Europe, Australia and the major Asian and African markets,
  Sunday to Thursday for Riyadh, Qatar, Kuwait, Bahrain and Cairo. Any other time zone counts as always open. Pre/post
  series count as open for the whole trading day. Crypto, currencies, futures, unknown instrument types and symbols
  without a usable session count as always open and are refreshed at the plain TTL.
- The stored session may be from an early-close day. A session shorter than 4 hours, or metadata older than 24 hours,
  keeps its open time but counts as open until midnight.
- Holidays are inferred. A series that is open but receives no new bar though one is due is "quiet": its TTL doubles on
  each such check, up to `BARS_QUIET_BACKOFF_MAX_S` (1800 s). A quiet series whose newest bar is from before today, 30
  minutes after the regular open (a holiday, a stock with no trade yet, a fund whose NAV comes after the close), is
  checked every `BARS_QUIET_BACKOFF_MAX_S` until the close, and still gets the one refresh after the close.
- Without stored metadata (first request of a symbol) the plain TTL applies.
- If a refresh fails, the cached bars are served, the failure is logged, and the series is retried after at least 30 s
  (longer when the failure was a rate limit with a longer `Retry-After`). It raises an error only when nothing is cached.
  A re-backfill that comes back empty for a series with cached bars counts as such a failure.
- A series not read for longer than one request may span (1m: 7 days) is caught up in chunks, back to at most Yahoo's
  lookback; the older cached bars are kept.
- A series Yahoo has no bars for is answered "not found" from memory for `CACHE_NEGATIVE_TTL_S`. A 1m backfill whose
  newest 7-day chunk is empty stops there, unless the symbol's metadata is stored.
- Upstream calls happen before the sync writes anything, so no database write lock is held while waiting on Yahoo; a
  re-backfill replaces the stored bars only after the fresh ones arrived.

**Overlap handling.** A tail refresh refetches the 3 newest cached bars and compares their closes (the newest one is
skipped, as it may still have been forming):

- Unchanged: the new bars are stored.
- Daily and longer intervals (full history in one request) changed: the series is deleted and backfilled again.
- Intraday, every compared bar scaled by one ratio (a split or re-adjustment): all stored bars of the series are
  rescaled locally (prices by the close ratio, adjusted close by its own, volume inversely) with no extra request.
- Intraday, any other change (Yahoo revised recent bars): the fresh bars overwrite the stored ones and nothing else is
  touched.

Intraday history therefore keeps growing beyond Yahoo's lookback window (for example 30 days of 1m bars); only pruning
bounds it.

**Pruning** (`BarService.prune`, run by maintenance). "Used" is the last time a series was read (recorded at most once
an hour; for older series, when it was cached).

1. Intraday series unused for `BARS_INTRADAY_RETENTION_DAYS` (30) are deleted.
2. Daily, weekly and monthly series unused for `BARS_DAILY_RETENTION_DAYS` (365) are deleted.
3. While the bar rows exceed `BARS_MAX_ROWS` (10,000,000, about 800 MB), the least recently used series are deleted,
   intraday first, down to 90% of the budget.

A series used within the last 24 hours is never deleted, nor one a request is syncing at that moment.

### 1.5 Maintenance

`CacheMaintenance` runs 60 s after start-up and then every `CACHE_MAINTENANCE_INTERVAL_S` (21600 = 6 h), in a worker
thread so requests keep being served. A failed run is logged and the next one happens on schedule.

1. Prune the bars as above.
2. Delete symbol metadata not refreshed for 30 days that no cached series refers to.
3. SQLite only: `PRAGMA optimize`, and `VACUUM` when more than 25% of the file's pages are free and the free pages add up
   to more than 64 MiB. Deleted bars leave free pages but never shrink the file by themselves. VACUUM blocks writers
   while it runs, so it waits for a run with no bar request in the last 10 minutes (`maintenance.vacuum_deferred`
   counts the put-off ones). SQLite connections wait up to 60 s for a busy database before failing.
4. Log one INFO line with what was pruned and the upstream and bar counters (skipped when identical to the previous run's).

`CACHE_MAINTENANCE_ENABLED=false` turns it off. On Postgres only steps 1 and 2 apply.

### 1.6 HTTP `Cache-Control`

Successful (200) market data responses carry a `Cache-Control` header so the browser can reuse them without asking. All
are `private` (no shared proxies); there is no `ETag`. Error responses never carry it.

| Route                                                              | Header                  |
| ------------------------------------------------------------------ | ----------------------- |
| `/api/symbols/{symbol}`, `/api/symbols/search`                     | `private, max-age=3600` |
| `/api/fundamentals/{symbol}`, `/api/events/{symbol}`               | `private, max-age=600`  |
| `/api/news`, `/api/news/{symbol}`                                  | `private, max-age=120`  |
| `/api/bars` with `to` at least 2 bars in the past                  | `private, max-age=300`  |
| `/api/bars` open-ended (no `to`) or ending recently                | `private, no-cache`     |
| `/api/quotes`, `/api/quotes/extended`, `/api/performance/{symbol}` | `private, no-cache`     |

### 1.7 Client caches (browser, memory only)

Nothing is persisted in the browser by these caches; a reload starts empty.

- **`CoalescingFeed`** (chart data, `apps/web/src/chart/feed.ts`). Identical `getBars` requests share one in-flight
  request. A finished open-ended request ("latest bars") is reused for 1 s. With tail refresh on, reopening a series
  after that fetches only the bars since its last bar (plus 3 for overlap) and merges them into the cached series;
  the series is fetched in full again once its last full fetch is older than 30 min, or when the tail does not reach the
  cached bars. Bounded requests (older pages, `to` set) are reused for 5 min. The whole cache is bounded by 64 requests
  and a budget of 1,000,000 bars (about 48 MB), dropping the least recently used first. Failed requests are never kept.
  Symbol search results are cached too: 100 queries, 10 min.
- **Symbol metadata** (`HttpDataFeed`): the last 500 resolved symbols.
- **`QuoteStream`** (watchlist and quote consumers). Subscribing a symbol again fetches a snapshot only when there is no
  quote yet, or the snapshot is over 15 s old and no live tick arrived in the last 60 s (extended: 120 s). The 60 s
  refresh skips symbols with a recent live tick unless their snapshot is over 10 min old (it still carries the previous
  close and market state), and does nothing while the page is hidden. Stopping the stream keeps the quotes; released
  symbols are dropped after 5 min, and at most 500 released symbols are kept.
- **`cachedJson`** (events and other short-lived JSON): an LRU of 300 paths, with expired entries swept on insert.

## 2. TTL summary

| Data                           | Fresh for                                                                 | Served stale                            |
| ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------- |
| Quotes                         | 15 s open or unknown, 60 s pre/post, 600 s closed                         | On error, up to 7 d                     |
| Extended-hours quotes          | 60 s                                                                      | On error, up to 7 d                     |
| Events, fundamentals           | 6 h                                                                       | While reloading and on error, up to 7 d |
| News                           | 5 min                                                                     | On error, up to 7 d                     |
| Symbol search                  | 24 h                                                                      | While reloading and on error, up to 7 d |
| Symbol info (database)         | 24 h                                                                      | On error, any age                       |
| Unknown symbol                 | 1 h                                                                       | n/a                                     |
| Bars tail, market open         | 30 s intraday, 300 s daily and longer (doubling when quiet, up to 30 min) | On error, always                        |
| Bars tail, market closed       | One refresh 20 min after the close, then none until the next open         | Always                                  |
| Bars, unknown series           | 1 h (`CACHE_NEGATIVE_TTL_S`)                                              | n/a                                     |
| Bars, unused series            | Deleted after 30 d (intraday), 365 d (daily and longer), or over 10M rows | n/a                                     |
| Upstream breaker, rate limited | 30 s, doubling to 900 s                                                   | n/a                                     |
| Upstream breaker, unavailable  | 10 s                                                                      | n/a                                     |
| Browser: latest bars           | 1 s, then a tail merge; full refetch after 30 min                         | n/a                                     |
| Browser: older bars            | 5 min                                                                     | n/a                                     |
| Browser: search                | 10 min                                                                    | n/a                                     |

## 3. Settings

Set these as environment variables (the names are the setting names in upper case). The API also reads an `.env` file in
its working directory. With Docker Compose, `docker-compose.yml` passes only the variables listed under `api.environment`,
so add the ones you want to change there (for example `UPSTREAM_RATE_PER_MIN: ${UPSTREAM_RATE_PER_MIN:-60}`).
All times are in seconds unless the name says otherwise. The defaults suit a single user; most people never change them.

| Variable                          | Default    | Meaning                                                                                   |
| --------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `UPSTREAM_RATE_PER_MIN`           | `60`       | Upstream request budget per minute (token refill rate)                                    |
| `UPSTREAM_BURST`                  | `20`       | Most requests that can be saved up                                                        |
| `UPSTREAM_COOLDOWN_INITIAL_S`     | `30`       | First pause after Yahoo refuses; doubles on each further refusal                          |
| `UPSTREAM_COOLDOWN_MAX_S`         | `900`      | Longest rate-limit pause, and cap on an upstream `retry_after`; `0` disables the pause    |
| `UPSTREAM_UNAVAILABLE_COOLDOWN_S` | `10`       | Pause after a connection failure                                                          |
| `UPSTREAM_RETRIES`                | `2`        | Provider retries after network failures                                                   |
| `UPSTREAM_RATE_LIMIT_RETRIES`     | `0`        | Provider retries after a rate-limit refusal                                               |
| `QUOTE_TTL_S`                     | `15`       | Quote freshness while the market is open or its state is unknown                          |
| `QUOTE_CLOSED_TTL_S`              | `600`      | Quote freshness while the market is closed                                                |
| `EXTENDED_TTL_S`                  | `60`       | Pre/post-market quotes, and quote freshness during those sessions                         |
| `EVENTS_TTL_S`                    | `21600`    | Events (dividends, splits, earnings) freshness                                            |
| `FUNDAMENTALS_TTL_S`              | `21600`    | Fundamentals freshness                                                                    |
| `NEWS_TTL_S`                      | `300`      | News freshness                                                                            |
| `SEARCH_TTL_S`                    | `86400`    | Symbol search freshness                                                                   |
| `NEWS_FETCH_LIMIT`                | `50`       | News items fetched per symbol; smaller requests are sliced from it                        |
| `CACHE_STALE_MAX_S`               | `604800`   | Oldest value served stale (while reloading, or after an upstream error)                   |
| `CACHE_MAX_ENTRIES`               | `4096`     | Entries per in-memory cache (least recently used dropped first)                           |
| `CACHE_NEGATIVE_TTL_S`            | `3600`     | How long an unknown symbol is remembered as unknown                                       |
| `BARS_TAIL_TTL_INTRADAY_S`        | `30`       | Intraday tail refresh interval while the market is open                                   |
| `BARS_TAIL_TTL_DAILY_S`           | `300`      | Daily, weekly and monthly tail refresh interval while the market is open                  |
| `BARS_SETTLE_AFTER_CLOSE_S`       | `1200`     | Delay after the close before the day's final refresh                                      |
| `BARS_QUIET_BACKOFF_MAX_S`        | `1800`     | Cap of the doubling interval for series that stop receiving bars                          |
| `BARS_MAX_ROWS`                   | `10000000` | Bar rows across all series (about 80 bytes each); least recently used series go beyond it |
| `BARS_INTRADAY_RETENTION_DAYS`    | `30`       | Intraday series not read for this many days are deleted                                   |
| `BARS_DAILY_RETENTION_DAYS`       | `365`      | Daily, weekly and monthly series not read for this many days are deleted                  |
| `CACHE_MAINTENANCE_ENABLED`       | `true`     | Run the periodic upkeep                                                                   |
| `CACHE_MAINTENANCE_INTERVAL_S`    | `21600`    | Time between upkeep runs                                                                  |

## 4. `GET /api/cache/stats`

Counters since the API process started (they reset on restart), for checking that caching works. It makes no upstream
request. The body is a tree built from dotted counter names, with these top-level keys:

- `upstream`: per provider operation (`history`, `symbol_info`, `search`, `quotes`, `extended_quotes`, `events`, `news`,
  `fundamentals`): `calls` (sent upstream), `requests` (the cost charged to the budget), and when they occurred
  `refused` (stopped by the guard), `not_found`, `rate_limited`, `unavailable`, `partial`, `errors`.
- `bars`: `backfill`, `rebackfill`, `tail_refresh`, `tail_skipped_fresh`, `tail_skipped_closed`, `tail_quiet`,
  `covered`, `stale_retry_wait`, `stale_error`, `overlap_same`, `overlap_rescaled`, `overlap_revised`, `pruned_series`,
  `pruned_rows`, and the `rows` gauge after the last maintenance run.
- `cache`: per cache (`quotes`, `extended`, `events`, `news`, `fundamentals`, `search`, `symbol_info`): `hit`, `miss`,
  `coalesced` (joined another caller's load), `stale` (served while reloading), `refresh`, `refresh_error`, `stale_on_error`,
  `evicted`, and the `size` gauge.
- `maintenance`, `db`: `runs`, `vacuums`, `vacuum_deferred`, and (SQLite) the `free_bytes` and `file_bytes` gauges.
- `guard`: the upstream guard's state now.

Counters appear once they have been incremented, so a fresh process returns few keys. Example after three quote
requests for the same two symbols, two events requests and one first bars request:

```json
{
  "bars": { "backfill": 1 },
  "cache": {
    "events": { "hit": 1, "miss": 1, "size": 1 },
    "quotes": { "hit": 4, "miss": 2, "size": 2 }
  },
  "upstream": {
    "events": { "calls": 1, "requests": 2 },
    "history": { "calls": 1, "requests": 1 },
    "quotes": { "calls": 1, "requests": 1 }
  },
  "guard": {
    "tokens": 16.01,
    "burst": 20,
    "ratePerMin": 60.0,
    "rateLimited": false,
    "rateLimitedForS": 0,
    "backoffS": 30.0,
    "unavailable": false,
    "unavailableForS": 0,
    "refused": { "rate_limited": 0, "unavailable": 0, "budget": 0 }
  }
}
```

What to look for: with a 50-symbol watchlist open, `upstream.quotes.requests` grows by about 1 per quote TTL, not by 50.
Reopening a chart raises `bars.tail_skipped_fresh` or `bars.tail_skipped_closed` rather than `upstream.history.calls`.
On a weekend `bars.tail_skipped_closed` grows and `bars.tail_refresh` stays flat. After a rate-limit refusal,
`guard.rateLimited` is `true` and `upstream.*.refused` counts the requests stopped locally.

## 5. Operating notes

**Run a single API worker.** The guard's budget and breakers, the `SmartCache` entries, the bar refresh retry pauses and
the stats are per process. With several workers (for example `uvicorn --workers 4`) each one has its own budget, so the
upstream sees up to that many times the configured rate and a rate-limit cooldown in one worker does not stop the
others. The default (`tickerglass-api`, and the Docker image) is one process.

**Reclaiming space after the `WITHOUT ROWID` migration.** On SQLite, the migration `9b4e1c7a5d23` rebuilds the `bars`
table `WITHOUT ROWID`, which makes it about 40% smaller. The old table's pages become free pages inside the file; the
file itself does not shrink. Maintenance runs `VACUUM` only when more than 25% of the pages are free and they exceed
64 MiB, so a smaller database may never be compacted automatically. To reclaim the space once, stop the API and run,
from `api/` (the default database path is `data/tickerglass.db`; in Docker it is `/data/tickerglass.db` in the `api-data`
volume):

```sh
sqlite3 data/tickerglass.db 'VACUUM;'
```

`VACUUM` rewrites the whole file, so it needs free disk space about the size of the database and takes longer the larger
it is. It is optional: free pages are reused by new bars either way.
