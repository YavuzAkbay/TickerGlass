# Market screener

A full-window screen (sidebar Watchlist panel > Screener, `Alt+Shift+S`, or the command palette) that scans a
curated symbol universe. It has two modes:

- **Server mode** (default when the API supports it): a nightly job on the API computes a snapshot of technical
  and fundamental metrics for every tracked symbol and stores it in the database. Scans are one SQL query over
  that table, so rules over the whole universe (RSI, moving averages, 52-week highs, earnings dates, ...) answer
  in milliseconds and never call the data provider. Design: [design/server-screener.md](design/server-screener.md).
- **Client mode** (fallback): the earlier browser-side screener over live quotes. It is used when the API has no
  screener (older server, screener disabled, or `/api/screener/status` says the provider is unsupported). See
  [Client mode](#client-mode-fallback).

The same snapshot also feeds optional columns of the watchlist tables, see
[watchlists](watchlists.md#snapshot-columns).

## How server mode works

1. **Universe.** The API ships a curated list of symbols per asset class (stocks, ETFs, crypto, commodities)
   plus the S&P 500 and Nasdaq-100 membership lists (`api/src/tickerglass_api/screener_data/`). On startup the
   bundle is loaded into the database when its hash changed.
2. **Tracked set.** Bundled symbols and list members, in rank order, capped at `SCREENER_MAX_SYMBOLS` (800).
   By default every symbol on a watchlist is tracked as well and has its own allowance on top of the cap: the
   watchlist symbols the cap left out (custom ones, or bundled ones below the cut) are added, up to 200 more
   (`WATCHLIST_ALLOWANCE`), so a large uploaded list can never push a watchlist symbol out. Symbols the provider
   no longer knows are tombstoned after 3 consecutive failures.
3. **Nightly run.** Every day at **17:15 America/New_York** (after the US close; the schedule is session-aware, so
   weekends need no run) the job walks the tracked symbols oldest-snapshot-first. For each it refreshes the daily bars
   through the normal bar cache (one upstream request per symbol, the same cache the charts use), computes the
   metrics and upserts one row. A second pass reads market cap, P/E, dividend yield, next earnings date and
   similar fields in batches of 50 symbols; sector, industry and beta come from a weekly per-stock pass. You can
   also start a run manually (`POST /api/screener/runs`, offered on the screener page); starting one while another is
   running answers 409.
4. **Scans.** `POST /api/screener/scan` filters and sorts the snapshot table. Status, runs and the snapshot
   endpoint only read the database. The browser then reads live quotes for the visible result page only.

The run is resumable (the queue is "tracked symbols whose snapshot is older than the target session"), holds a
database lease so two workers never run it together, and uses the `background` request priority so charts and
watchlists keep their share of the provider budget.

### Provider budget and first-run time

The job paces itself at `SCREENER_RATE_PER_MIN` (default 24) upstream requests per minute, and never above a third
of the guard's sustainable rate. On **Yahoo**:

| Run                            | Requests                                                   | Time at 24/min                 |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------ |
| First run (cold, ~770 symbols) | ~770 daily backfills + ~16 quote batches                   | **about 30 minutes**           |
| Nightly refresh                | ~770 one-bar tail refreshes (cache hits cost no wait)      | about 30 minutes, usually less |
| Weekly info pass               | one request per stock at `SCREENER_INFO_RATE_PER_MIN` (10) | about 50 minutes               |

Until the first run finishes the page stays in client mode and shows a banner with progress and an ETA: the
status reports `asOf` / `computedAt` (and scans return them) from the newest _finished_ snapshot run only, so
the page never switches to a half-built snapshot. Scans called directly return what is already computed. The Yahoo "info" call (`yf.Ticker().info`) makes several HTTP requests per symbol while the request guard counts
it as one token, so the real upstream rate of the weekly pass is a few times `SCREENER_INFO_RATE_PER_MIN`. If
Yahoo starts rate limiting, lower it (3 to 4 is a safer value than the default 10) and accept a longer pass.
Three upstream rate limits in one run abort it (status `aborted`) and the next run resumes where it
stopped. **Twelve Data**: the screener is off by default (daily credits); when enabled it computes technicals only
and stops after 30 % of the daily credits. **Demo** provider: everything is computed from synthetic data.

## Fields

Percent fields are in percent (`5` = 5 %). Field ids are stable (`schemaVersion: 1`); `GET /api/screener/fields`
lists them with their type and whether the current provider can fill them.

| Category    | Fields (id: unit)                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta        | `name`, `cls`, `group`, `exchange`                                                                                                                                                                                                      |
| Price       | `last` (price), `chg1d` (%), `gapPct` (%)                                                                                                                                                                                               |
| Performance | `perf1w`, `perf1m`, `perf3m`, `perf6m`, `perfYtd`, `perf1y` (all %)                                                                                                                                                                     |
| Volume      | `volume`, `avgVol30` (shares), `relVol` (volume / 30-day average, x), `avgDollarVol30` (close x volume, in the symbol's quote currency)                                                                                                 |
| Technical   | `rsi14` (0-100, Wilder), `sma20`, `sma50`, `sma200` (price), `pctVsSma20`, `pctVsSma50`, `pctVsSma200` (%), `atr14` (price), `atrPct` (% of price), `smaCross` (`golden`, `death` or empty, 50 vs 200-day), `daysSinceCross` (sessions) |
| 52 weeks    | `hi52`, `lo52` (price), `pctOffHi52`, `pctOffLo52` (%), `newHi52`, `newLo52` (true/false)                                                                                                                                               |
| Fundamental | `mcap` (USD), `pe`, `fwdPe`, `eps`, `divYield` (%), `beta`, `sector`, `industry`, `nextEarnings` (unix seconds), `daysToEarnings` (whole days, rounded down)                                                                            |

Notes on units and definitions:

- **Currencies are not converted.** `mcap` is stored only when the quote currency is USD (or the provider names
  none); for a symbol quoted in another currency it is empty, so `mcap > 10B` never compares euros or yen with
  dollars. `avgDollarVol30` is close x volume in the symbol's own quote currency (field unit `ccy`, despite the
  name): compare it only among symbols of one currency, since the default sort by it ranks a JPY or INR
  listing by its raw numbers. `eps` is in the company's reporting currency.
- **`daysToEarnings`** is a whole number of days rounded down (7.5 days away is `7`), computed in the database,
  so `= 7` matches exactly the value shown. A date up to a day in the past (a report that just happened) is `-1` or `0`.
- **`divYield`**: Yahoo's `trailingAnnualDividendYield` (a fraction) is multiplied by 100; only when it is
  missing is `dividendYield` used as it comes, assuming percent. The units of Yahoo's v7 fields are not
  documented and have changed before, so spot-check yields against a known payer before relying on them.
- **52-week range** is the last 252 daily bars, or 365 for crypto (which trades every day).
- **Sessions** follow the NYSE calendar (`services/holidays.py`, rules only, no data download): weekends, the ten
  regular holidays with their observance rules (a Saturday New Year's Day is not observed on the Friday) and
  one-off closures listed in `MARKET_EXTRA_HOLIDAYS`. The target date is the latest completed trading session
  (its close is 13:00 on early-close days, 16:00 otherwise, plus the bar settle time), and the scheduled run
  skips holidays. `daysSinceCross` counts bars.
- **Crypto staleness**: crypto snapshots use the last complete UTC day, which trails the US close, so a crypto
  row one day behind the target counts as current once it was computed after the target session's close
  (plus the bar settle time); two days behind is stale.

Technicals use split-adjusted daily closes. A field that needs more bars than the symbol has (for example
`sma200` for a recent IPO) is empty, and an empty value never matches a rule. Fundamental fields come from the
provider's quote extras (Yahoo and demo); with Twelve Data they are marked unavailable.

## Rule builder

Rules are `field operator value` rows combined with AND / OR groups (up to two levels deep and 50 rules). The
operators depend on the field type: comparisons (`>`, `<`, `>=`, `<=`, `=`), `between`, `in` (for sectors and
other lists), and for price-like and oscillator fields `crosses above` / `crosses below` (a threshold crossed
since the previous session: `last`, `rsi14`, `sma20`, `sma50`, `sma200`), plus `above by %` / `below by %`
(for example `last` above `sma50` by 5 %). A value can be a number or another field of the same dimension
(`last > sma200`). The sort, the result limit (up to 500 per page) and the columns are part of the screen.
Mistakes are reported with the offending rule path (unknown field, operator not allowed for the field, field not
available from the provider, bad value, too complex).

### Formula rules

**Formula** adds a rule on a custom expression compared with a number or a range, e.g.
`last / sma200 - 1 < 0.05` (within 5 % of the 200-day average), `abs(chg1d) > 3`, `rsi14 - prev(rsi14) > 10`
or `max(0, min(rsi14, 100)) between 40 and 60`. The language is deliberately small:

```
formula = expr ;
expr    = term , { ( "+" | "-" ) , term } ;
term    = unary , { ( "*" | "/" ) , unary } ;
unary   = "-" , unary | primary ;
primary = number | field | call | "(" , expr , ")" ;
call    = ( "abs" | "min" | "max" ) , "(" , expr , { "," , expr } , ")" | "prev" , "(" , field , ")" ;
number  = digit , { digit } , [ "." , digit , { digit } ] | "." , digit , { digit } ;   (no exponents)
field   = ( letter | "_" ) , { letter | digit | "_" } ;                                  (ASCII only)
```

- Fields are the numeric field ids above (number, percent, money and whole-day fields such as `daysSinceCross`
  and `daysToEarnings`); text, enum, yes/no fields and `nextEarnings` are refused. `prev(field)` is the previous
  session's value of `last`, `rsi14`, `sma20`, `sma50` or `sma200`. Percent fields are in percent (5 = 5 %).
- `abs(x)` takes one value, `min(...)` / `max(...)` two to eight. There is no comparison inside a formula: the
  rule's operator (`>`, `<`, `>=`, `<=`, `between`) does that.
- Division by zero gives an empty value, and any empty operand makes the whole formula empty (also inside
  `min` / `max`), so such rows never match and sort last.
- Limits: 200 characters, 64 terms, nesting 16 deep, `min` / `max` nested at most 2 deep, numbers of at most
  24 characters, 10 formula rules per screen (each also counts toward the 50 rules).
- The editor checks the formula as you type with the same grammar as the server, underlines the position of a
  mistake with a caret and suggests field ids and functions for the word at the cursor (arrow keys, Enter or Tab
  to insert, Escape to close).
- Errors (422) carry the character `offset` next to `code` and `path` (`filter.rules[1].formula`):
  `bad_formula` (syntax, unknown function, non-numeric field), `unknown_field`, `field_unavailable` (a
  fundamental field with Twelve Data), `too_complex` (a limit) and `formula_overflow` (below).

**Formula columns.** Options → Columns → *Add formula column…* shows up to three custom expressions as
table columns, with an optional name (else the formula is the header). They are saved with the screen
(`columns` holds `"=<formula>"`; the names stay on this device) and are written to the CSV export. They are not
sortable: the server sorts by field ids only, and sorting just the visible page would disagree with the pager.
Select one in the column menu to remove it. In the API a scan names them in `fields`, e.g.
`"fields": ["last", "=last / sma200"]`; each row then carries that value under the same key (empty when a
referenced fundamental field is unavailable).

On PostgreSQL a formula whose value leaves the float range (e.g. `mcap * mcap * mcap * …`) is answered with a
422 `formula_overflow` pointing at the first formula of the request; SQLite yields an empty value instead.

Built-in presets: oversold large caps (`rsi14 < 30` and `mcap > 10B`), golden cross in the last 5 days, new
52-week highs, unusual volume (`relVol > 2`), above the 200-day average and near the high, and high dividend
(`divYield > 4`).

## Saved screens and screen alerts

- **Saved screens** store the universe, rules, sort and columns on the server (`/api/screener/screens`, same
  revision / conflict rules as watchlists, so they sync between devices).
- **Screen alerts**: turn on the alert of a saved screen and, after each nightly run, the API compares the
  matching symbols with the previous run. Symbols that newly match are delivered through the usual alert
  channels (in-app, webhook, Telegram, email; see [alerts](alerts.md)) and appear in the alert log. The first
  run of a screen only records its members.

## Universes

A screen runs over one of: an asset class (stocks, ETFs, crypto, commodities), a list (S&P 500, Nasdaq-100 or
your own), a watchlist, or an explicit symbol set (up to 1000 symbols). Symbols outside the tracked set have no
snapshot; the result shows the coverage ("N of M symbols have a snapshot").

The **S&P 500 and Nasdaq-100 lists are curated**, bundled with the release and dated (`asOf`, shown in the
picker). Index membership changes between releases. To correct a list without waiting for a release, override it:

```
GET    /api/screener/lists                  [{id, name, kind, asOf, source, count}]
PUT    /api/screener/lists/sp500            {"name": "S&P 500", "asOf": "2026-11", "symbols": ["AAPL", ...]}   (up to 1500)
DELETE /api/screener/lists/sp500            back to the bundled list (a custom list is removed)
```

An overridden list has `source: "upload"` and survives restarts and bundle updates. Members become tracked at
the next run (subject to `SCREENER_MAX_SYMBOLS`).

## Settings

Environment variables of the API (no prefix; also settable in `.env`, see [self-hosting](self-hosting.md)).

| Variable                      | Default            | Meaning                                                                                                                            |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SCREENER_ENABLED`            | unset (auto)       | Unset: on for Yahoo and demo, off for Twelve Data. `true` / `false` forces it.                                                     |
| `SCREENER_RUN_AT`             | `17:15`            | Local time of the daily run, `HH:MM` in `SCREENER_TZ`.                                                                             |
| `SCREENER_TZ`                 | `America/New_York` | Time zone of `SCREENER_RUN_AT` (the session calendar stays the US one).                                                            |
| `MARKET_EXTRA_HOLIDAYS`       | empty              | One-off NYSE closures the rules cannot know (days of mourning, disasters), ISO dates, comma separated: `2025-01-09`.               |
| `SCREENER_RATE_PER_MIN`       | `24`               | Upstream requests per minute for the daily run (further capped to a third of the guard's rate).                                    |
| `SCREENER_INFO_RATE_PER_MIN`  | `10`               | Same for the weekly per-stock info pass. Yahoo's info call costs several real requests per token: 3 to 4 is safer.                 |
| `SCREENER_MAX_SYMBOLS`        | `800`              | Most bundled and list symbols tracked; the rest (lowest rank first) are dropped.                                                   |
| `SCREENER_INCLUDE_WATCHLISTS` | `true`             | Also track watchlist symbols: up to 200 beyond `SCREENER_MAX_SYMBOLS`.                                                             |
| `SCREENER_STALE_DAYS`         | `7`                | A snapshot older than this many days before the latest session is left out of scans; newer but not current rows are flagged stale. |

### Storage and deployment

- Each tracked symbol keeps its full daily history in the `bars` table: ~770 symbols x ~6000 bars is **4-6 million
  rows**, against the default `BARS_MAX_ROWS` of 10 million (the cache evicts least-recently-used series first,
  user charts included). `GET /api/screener/status` reports `barsRows`; lower `SCREENER_MAX_SYMBOLS` or raise
  `BARS_MAX_ROWS` if it approaches the cap. The snapshot tables themselves are a few hundred kilobytes.
- Run **one API worker** (a single process, for example `uvicorn` without `--workers`). The job lease prevents
  double runs, but the request guard, the caches and the scan cache are per process, so several workers
  multiply the provider budget and each answers scans from its own cache.
- Switching the data provider wipes the snapshot together with the other caches; the next run rebuilds it.

## Client mode (fallback)

Everything below applies when the API has no screener: filtering, sorting and paging run in the browser
(`apps/web/src/screener`) over the bundled universe and live quotes.

- **Filters** are two-stage: static filters (search, sector/category/group, exchange, market cap lower bound)
  cut the whole class first; then the top N (50, 100, 250 or all, default 100) are subscribed for quotes and the
  live filters (price, change %, volume, exact cap) run on those only. A row without a quote never passes a live
  bound, and the page says how many symbols were evaluated.
- **Sorting** re-sorts about every 1.5 seconds ("Live") and freezes while you read (pointer over the rows,
  keyboard focus, open menu) or when you press "Paused".
- **Columns**: Name, Last, Change, Change %, Prev close, Volume, Rel vol, Turnover, Day range, 52-week range,
  Pre/post change %, Cap (static), Live cap, Sector/Category/Group, Exchange and 30-day trend. Rel vol, Live cap
  and the 52-week range need Yahoo's quote extras.
- **Budget**: only the scanned slice is subscribed. The first 200 symbols stream over the socket; the rest are
  HTTP-polled in batches of 100 every 15 seconds (60 s without a fresh tick). Pre/post quotes are requested only
  while that column is visible. "All" with a large class raises polling load; keep the slice at 100-250.
- No technical or fundamental rules, saved screens or screen alerts.

## Heatmap and grouping

The **Table | Heatmap** switch in the header (device-local) works in both modes. The heatmap has the same size / color /
group controls, tiles and keyboard as the watchlists heatmap (see watchlists.md, "Heatmap view").

- **Server mode** requests one scan of up to 500 rows (`limit: 500`, `offset: 0`) with the snapshot fields the map reads
  (`mcap`, `chg1d`, `perf1w`, `perf1m`, `perfYtd`, `relVol`, `rsi14`, `avgDollarVol30`, `sector`, ...). A footnote shows
  when there are more matches than tiles. Size by market cap uses the snapshot `mcap`.
- **Client mode** draws the filtered set of the scanned slice, which the heatmap caps at the top 200 of the class.
- **Live quotes** are subscribed for the 200 largest tiles only (snapshot or static market cap); other tiles use their
  snapshot values.
- **Group by** (None | Sector | Group; the table's footer and the heatmap toolbar share it). Server mode groups by the snapshot
  `sector` or by the universe group; client mode by the universe's group (sector for stocks, category for ETFs).
  In the table each group gets a collapsible header with the count, mean change % and total market cap; rows keep the sort
  inside their group, groups appear in the order of their first row. Table groups cover the rows of the current page
  (use 500 rows or All to group the whole result).

## Actions

- **Detail pane**: click a row; it shows the quote, ranges, universe metadata and the shared symbol sections
  (performance, key stats, events, news). Enter or a double click opens the chart.
- **Export view (CSV)**: writes the current filtered, sorted rows (all pages) with the visible columns, as
  `Screener-<class>_<date>.csv`. Text fields are escaped and guarded against spreadsheet formula injection;
  numbers are written raw.
- **Add to watchlist**: the row menu adds one symbol; "Add all N results to watchlist..." adds every match to an
  existing list. The toast reports added, already present and skipped (a list holds at most 1000 symbols).

Row badges show alerts, notes and data state. Most rows are HTTP-polled, so the plain "delayed" `D` badge is
hidden here; stale `S`, closed `C`, `Pre`/`Post` and missing `!` still show (legend in
[watchlists](watchlists.md#row-badges)).

## Hotlists

The **Hotlists** sidebar panel (flame icon under the watchlist tab, or "Show Hotlists" in the command palette)
ranks a universe by a ready-made rule on the nightly snapshot. It needs server mode; before the first snapshot
it explains that and links to the screener.

| Kind           | Rule (sorted by)                                 | Shows        |
| -------------- | ------------------------------------------------ | ------------ |
| Top gainers    | `chg1d > 0` (`chg1d` desc)                       | close change |
| Top losers     | `chg1d < 0` (`chg1d` asc)                        | close change |
| Most active    | `avgDollarVol30 > 0` (`avgDollarVol30` desc)     | avg $ volume |
| Unusual volume | `relVol >= 2` (`relVol` desc)                    | RelVol       |
| 52-week highs  | `newHi52` (`pctOffHi52` desc)                    | % off high   |
| 52-week lows   | `newLo52` (`pctOffLo52` asc)                     | % off low    |
| Oversold       | `rsi14 < 30` (`rsi14` asc)                       | RSI          |
| Overbought     | `rsi14 > 70` (`rsi14` desc)                      | RSI          |
| Gap up / down  | `gapPct > 0` desc / `gapPct < 0` asc             | gap %        |
| Golden cross   | `smaCross = golden`, `daysSinceCross <= 5` (asc) | days since   |

The universe is the S&P 500 when the server has that list (else all stocks); Nasdaq-100, other lists, ETFs, crypto
and commodities are in the dropdown. The header reads "As of <date> close": the **ranking comes from the last
close snapshot while the shown prices and day change are live** (the first 25 rows subscribe to live quotes). The
panel re-fetches when the status poll reports a new snapshot date. Click a row (or Enter) to open the symbol;
the row menu adds it to a watchlist, creates an alert or opens a new chart.

`GET /api/screener/hotlists?kind=<kind>&universe=<class|list:id>&limit=<=50>` builds a `ScanRequest` per kind and
runs it on the database only (no upstream call), with the same ETag and `private, no-cache` headers as `/scan`.
Answer: `{kind, asOf, universe, rows: [{symbol, name, value, last, chg1d}]}`. Before the first finished run
`asOf` is `null` and `rows` is empty; an unknown kind or universe is 422, an unknown list 404.

## Sharing a screen

The saved-screens menu has a share button per screen: **Copy link** (same `#tg-import=` fragment format as
[watchlists](watchlists.md#sharing)) and **Download JSON**. The document is `{v:1, type:'screen', name, spec}`
with the saved spec (universe, rules, sort, columns). Alerts and notification settings are not shared. A
`watchlist` universe names a local list, so it is replaced by that list's symbols when sharing.

Opening a link or file shows a preview (name, rule count, universe, sort) and saves it as a **new screen** on this
instance's server (the name is deduped) only after you confirm; it needs the screens API, so an error from the
server is shown in the dialog. Specs are validated strictly (known operators and field ids, at most 50 rules and
two group levels, bounded values): a rule that does not validate rejects the whole screen instead of being
dropped, since dropping a rule would widen the screen. Fields the receiving instance's provider does not offer
show as unavailable in its rule builder.

## Limitations

See [LIMITATIONS](LIMITATIONS.md#screener). In short: daily data only, a US-session schedule, curated index
lists, technicals only with Twelve Data, synthetic data with the demo provider, no currency conversion and a
US-only holiday calendar.
