# Server-side screener — design (v1)

Status: approved for implementation 2026-11-06. Contracts in §4 are FROZEN (field ids, ScreenSpec, alert log shape; `schemaVersion: 1`).

## 0. Verified facts

- Yahoo `fundamentals()` costs 7 tokens (info + 6 statements) — never loop it per symbol. Use batch v7 fields (`screen_fields`, 50 symbols/token) + weekly `info` (1 token/stock).
- Daily backfill pulls full history (`intervals.py` `_daily` `max_lookback=None`): ~770 symbols × ~6k bars ≈ 4–6M `bars` rows vs `bars_max_rows=10M`. Mitigate with `screener_max_symbols` (default 800) and report `bars.rows` in status. NO live probing of Yahoo during development.
- No user model: auth optional/single-user (`auth.py` middleware). "Admin" = any authenticated caller.
- Alerts are evaluated by the Node service, delivered by API (`routes/alerts.py:fire_alert` → `AlertLog`, `AlertDelivery`, `_prune_log`, `hub.publish`, `dispatcher.wake`). `AlertLog.alert_id` nullable, `kind` String(8).
- Guard is per-process. Provider switch wipes caches via `cache_source.ensure_cache_source`.
- pandas 3 present (numpy transitively). `services/performance.compute_performance(df, tz)` reusable.

## 1. Approach

Nightly snapshot table built through `BarService` (≈1 token/symbol/night tail refresh; scans <10 ms SQL). Wide typed metric columns (not EAV/JSON).

## 2. Architecture

`ScreenerJob` in `MarketStack`, started/stopped by `ProviderSwitcher` like `CacheMaintenance`. Holds a DB lease, `background` priority, self-paced. Per tracked symbol: `BarService.get_bars(sym, 1d, limit=450)` → numpy technicals → upsert `screener_snapshots`. Then batch quote-extras (50/token) → `screener_fundamentals`. Weekly `info` (beta/sector/industry). After each run: evaluate screen alerts. **Scan/snapshot/status endpoints read DB only — never upstream.** Web reads live quotes only for the visible result page.

Budget (Yahoo, `screener_rate_per_min=24`): cold start ≈32 min; nightly ≈32 min; weekends ≈0 (session-aware `next_check_at`); weekly info ≈50 min at 10/min.

## 3. Data model (single alembic migration; down_revision = current head — verify, expected "5d2a7f3c9e18")

```
screener_symbols(symbol S32 PK, cls S12 idx, name S200, grp S64, exchange S32 null, rank int,
  cap_static float null, source S8 'bundled'|'custom', fail_count int=0, last_error S200 null,
  tombstoned_at tz null, updated_at tz)
screener_lists(id S36 PK, name S200, kind S8 'index'|'custom', as_of S10, source S8 'bundled'|'upload', updated_at)
screener_list_members(list_id FK CASCADE, symbol S32, PK(list_id,symbol)); idx(symbol)
screener_snapshots(symbol S32 PK, provider S16, as_of_date Date idx, bar_ts BigInt, computed_at tz,
  bars_count int, last, prev_close, chg1d_pct, gap_pct, volume, avg_vol30, rel_vol, avg_dollar_vol30,
  perf_1w, perf_1m, perf_3m, perf_6m, perf_ytd, perf_1y, rsi14, prev_rsi14,
  sma20, sma50, sma200, prev_last, prev_sma20, prev_sma50, prev_sma200,
  pct_vs_sma20, pct_vs_sma50, pct_vs_sma200, hi52, lo52, pct_off_hi52, pct_off_lo52,
  new_hi52 bool, new_lo52 bool, atr14, atr_pct, cross_state SmallInt(1 golden/-1 death/null),
  days_since_cross int null)          -- metric columns Float null
screener_fundamentals(symbol S32 PK, provider S16, mcap, pe, fwd_pe, eps_ttm, div_yield_pct, beta,
  shares_out, sector S64 null, industry S100 null, next_earnings_ts BigInt null, quote_at tz null, info_at tz null)
screener_runs(id int autoinc PK, kind S16 'snapshot'|'fundamentals', trigger S10 'schedule'|'manual',
  provider S16, target_date Date, status S10 'running'|'done'|'partial'|'aborted'|'failed',
  total int, done int, failed int, tokens int, started_at tz idx, finished_at tz null, error S500 null)
job_leases(name S32 PK, owner S64, expires_at tz)
screens(id S36 PK, name S200, spec JSON, schema_version int, alert JSON null, revision int, created_at, updated_at)
screen_states(screen_id FK screens CASCADE PK, as_of Date, members JSON {"members":[...],"seen":[...]}, updated_at)
```

No per-metric indexes. `screener_snapshots` + `screener_fundamentals` join the `ensure_cache_source` wipe list. Keep newest 200 `screener_runs`.

## 4. Contracts (FROZEN)

### Universe — single source of truth

`api/src/tickerglass_api/screener_data/{stocks,etfs,crypto,commodities}.json` + `lists/{sp500,ndx100}.json`.
Class file: `{"asOf":"2026-01","rows":[[symbol,name,group,exchange|null,cap|null], ...]}` (rows in rank order; rank = index+1). cap = billions USD (same unit as the TS dataset).
List file: `{"id":"sp500","name":"S&P 500","asOf":"YYYY-MM","symbols":[...]}`.
Startup: upsert bundle into DB when its hash differs from `app_meta['screener.bundle']`.
`GET /api/screener/universe?cls=stocks` → the TS `Universe` shape currently in `apps/web/src/screener/universe/types.ts` (WP1 reads that file to mirror it exactly), ETag = bundle hash.
`GET /api/screener/lists` → `[{id,name,kind,asOf,source,count}]`. `PUT /api/screener/lists/{id}` `{name, asOf, symbols ≤1500}` override (source='upload'); `DELETE` reverts bundled / removes custom.
Tracked set = bundled symbols ∪ list members ∪ watchlist symbols (if `screener_include_watchlists=True`), capped at `screener_max_symbols` (default 800) in rank order; non-tombstoned.

### Field ids (frozen, camelCase)

```
name cls group exchange last chg1d gapPct volume avgVol30 relVol avgDollarVol30 perf1w perf1m perf3m
perf6m perfYtd perf1y rsi14 sma20 sma50 sma200 pctVsSma20 pctVsSma50 pctVsSma200 hi52 lo52 pctOffHi52
pctOffLo52 newHi52 newLo52 atr14 atrPct smaCross daysSinceCross mcap pe fwdPe eps divYield beta sector
industry nextEarnings daysToEarnings
```

Units: percent fields are in percent (5 = 5%). `mcap`, `avgDollarVol30` in USD. `nextEarnings` unix seconds. `smaCross` enum `'golden'|'death'|null`.

### `GET /api/screener/fields`

```json
{
  "version": 1,
  "fields": [
    {
      "id": "rsi14",
      "category": "technical",
      "type": "number",
      "unit": null,
      "dimension": "oscillator",
      "ops": [">", "<", ">=", "<=", "between", "crossesAbove", "crossesBelow"],
      "crossable": true,
      "available": true,
      "enumValues": null
    }
  ]
}
```

category ∈ meta|price|performance|technical|volume|fundamental; type ∈ number|percent|money|int|bool|enum|date|string; `available=false` when provider lacks source. Labels are client i18n.

### `POST /api/screener/scan`

```ts
type ScreenerClass = 'stocks' | 'etfs' | 'crypto' | 'commodities';
type Universe =
  | { kind: 'class'; cls: ScreenerClass }
  | { kind: 'list'; id: string }
  | { kind: 'watchlist'; id: string }
  | { kind: 'symbols'; symbols: string[] }; // ≤1000
type Operand = number | { field: string };
type Rule = {
  field: string;
  op:
    | '>'
    | '<'
    | '>='
    | '<='
    | '='
    | 'between'
    | 'in'
    | 'crossesAbove'
    | 'crossesBelow'
    | 'abovePct'
    | 'belowPct';
  value: Operand | [number, number] | string[] | boolean | { field: string; pct: number };
};
type Group = { op: 'and' | 'or'; rules: (Rule | Group)[] }; // depth ≤ 2, ≤ 50 rules total
interface ScanRequest {
  universe: Universe;
  filter: Group | null;
  sort: { field: string; dir: 'asc' | 'desc' };
  limit: number /*1..500, default 100*/;
  offset: number;
  fields?: string[];
}
interface ScanResponse {
  asOf: string | null;
  computedAt: string | null;
  provider: string;
  total: number;
  offset: number;
  limit: number;
  coverage: { universe: number; withSnapshot: number };
  rows: {
    symbol: string;
    name: string;
    cls: string;
    group: string;
    exchange: string | null;
    stale: boolean;
    values: Record<string, number | string | boolean | null>;
  }[];
}
```

Semantics: `{field}` operand only when same `dimension`. `crossesAbove X` ⇔ `a > X AND prev_a <= prev_X`; crossable fields: last, rsi14, sma20, sma50, sma200. `abovePct {field,pct}` ⇔ `a > b*(1+pct/100)`; `belowPct` ⇔ `a < b*(1-pct/100)`. Nulls never match; sort nulls last. Rows with `as_of_date` older than target − 7 days: excluded; older than latest target but within 7 days: `stale:true`. `daysToEarnings = (next_earnings_ts − :now)/86400` with bound `:now`.
Errors 422 `{detail:{code, message, path}}` codes: `unknown_field`, `bad_op`, `field_unavailable`, `bad_value`, `too_complex`.
SQL builder (`query.py`): SQLAlchemy Core only; `FIELD_COLUMNS: dict[str, ColumnElement]` whitelist; values via bindparam; sort via whitelist; no `text()`, no f-strings into SQL.
Caching: `ETag = sha1(latest done run id + canonical request JSON)`; 304 on If-None-Match; in-process LRU 64.
Python interface used by WP4: `def run_scan(session, req: ScanRequest, *, settings, now) -> ScanResponse` (pydantic models in `services/screener/schemas.py`, owned by WP3).

### Other endpoints

`GET /api/screener/status` →

```
{enabled, supported, reason: null|'disabled'|'provider_unsupported'|'first_run', provider, asOf, computedAt,
 fundamentalsAsOf, coverage:{tracked,fresh,stale,failed,tombstoned},
 running:{runId,kind,done,total,startedAt,etaS}|null, nextRunAt, budget:{ratePerMin,tokensLastRun}, barsRows}
```

`POST /api/screener/runs {kind:'snapshot'|'fundamentals'}` → 202 `{runId}` | 409 if running. (Route calls `stack.screener.trigger(kind)`; WP2 provides it.)
`GET /api/screener/snapshot?symbols=A,B` (≤200) → `{asOf, rows:{SYM:{<fieldId>:value}}}`; untracked omitted.
Screens `/api/screener/screens` GET(list)/POST/GET{id}/PUT/PATCH/DELETE — mirror `routes/watchlists.py`: client-chosen ids, `revision`, 409 with `current`.
`ScreenSpec = {schemaVersion:1, universe:Universe, filter:Group|null, sort:{field,dir}, columns?:string[]}`
`alert = {enabled:boolean, notify:{webhook:boolean,telegram:boolean,email:boolean,webhookUrl?:string}} | null`
Screen JSON: `{id,name,spec,alert,revision,createdAt,updatedAt}`.
`GET /api/screener/presets` → `[{id,name,spec}]`: oversold-large-caps (`rsi14<30 AND mcap>10e9`), golden-cross-5d (`smaCross='golden' AND daysSinceCross<=5`), new-52w-highs (`newHi52=true`), unusual-volume (`relVol>2`), above-sma200-near-high (`pctVsSma200>0 AND pctOffHi52>-5`), high-dividend (`divYield>4`).

### Python internals

```python
def compute_snapshot(df: pd.DataFrame, tz: str, now: datetime) -> dict[str, float | int | bool | None]  # pure, keys = snapshot column names
class ScreenInfoProvider(Protocol):           # optional capability, detected like as_metered
    def screen_fields(self, symbols: list[str]) -> list[dict[str, Any]]  # Yahoo: raw v7 subset
    def info(self, symbol: str) -> dict[str, Any]                         # Yahoo: t.info only
```

`GuardedProvider` charges `screen_fields` at `costs.quotes(n)` (chunked like quotes), `info` at 1.

## 5. Job rules

Schedule daily `screener_run_at="17:15"` America/New_York + manual. `screener_enabled: bool|None = None` → auto: on for yahoo/demo, off for twelvedata. Target date = latest completed US session. Crypto: drop in-progress UTC-day bar. Work queue = tracked non-tombstoned symbols with `as_of_date < target` oldest-first (resumable, no cursor). Lease: `UPDATE job_leases SET owner=:me, expires_at=:now+120s WHERE name='screener' AND (owner=:me OR expires_at<:now)` (+insert first use), renew every 60 s; lost → abort. Pacing: after each symbol read CacheStats `upstream.*.requests` delta, sleep `delta*60/rate`, `rate=min(setting, guard.sustainable_rate_per_min()/3)`; cache hits cost no wait. Reserve refusal → sleep retry_after (not failure). Breaker open → pause. 3 upstream rate-limits in a run → `aborted`. Twelve Data: stop after 30% of daily credits. `SymbolNotFound` → fail_count++; 3 consecutive → tombstoned_at (bundle update clears). Other errors logged, continue. Technicals on split-adjusted close; RSI/ATR Wilder. Fields needing more bars than available → null. Demo provider: everything incl. synthetic screen_fields. Twelve Data: technicals only; fundamental fields `available:false`.

## 6. Work packages & ownership

- **WP1 Data model, settings, universe** — `models.py`, new migration, `settings.py` (`screener_*`), `screener_data/**`, `services/screener/__init__.py`, `services/screener/universe.py` (seed, tracked set), `services/cache_source.py` (wipe list), TS→JSON conversion script (`api/scripts/`), tests.
- **WP2 Engine & job** — `services/screener/{technicals,job,lease,fundamentals}.py`; `providers/{base,guard,yahoo,demo}.py` additions; `stack.py` (`MarketStack.screener`, start/stop, `trigger(kind)`, `status()` data); tests.
- **WP3 Scan API** — `services/screener/{schemas,fields,query}.py`, `routes/screener.py` (universe, lists, fields, scan, status, runs, snapshot), `app.py` includes for BOTH `routes/screener.py` and `routes/screens.py`; tests.
- **WP4 Screens & alerts** — `routes/screens.py` (exports `router`), `userdata/screens.py`, `services/screener/{alerts,presets}.py` (presets route lives in routes/screens.py), `notifications/outbox.py` (`record_log_entry` extracted from `fire_alert`) + `routes/alerts.py` refactor, `userdata/store.py` export/import, web alerts WS handler tolerance for `alert: null`; tests.
- **WP5 Web screener** — `apps/web/src/screener/server/{types,api}.ts`, `rules/{RuleBuilder,FieldPicker,ValueInput}.tsx`, `page/{UniversePicker,SnapshotBanner,SavedScreensMenu}.tsx`, `ScreenerPage.tsx`, `ResultsTable.tsx`, `screenerPrefs.ts` v4, `universe/index.ts` → API, delete TS datasets, i18n keys, e2e mocks/spec.
- **WP6 Watchlist snapshot columns & docs** — `apps/web/src/screener/server/snapshot.ts`, `watchlist/columns/registry.ts` (`ColumnCtx.snap`; perf1m, perfYtd, rsi14, pctVsSma200, nextEarnings), `watchlist/types.ts` ColumnId, `docs/screener.md`, `docs/LIMITATIONS.md`.

## 7. Risks

Bar storage vs 10M cap (LRU evicts user chart series first) → cap tracked symbols, report rows. Stale rows → stale flag. Splits → BarService re-backfill. Holidays → session calendar (verify `services/sessions`). Multi-worker → lease covers job; document single worker.

## 8. Non-goals

Intraday screening; non-US session schedules beyond per-symbol tz; full-market universes / scraping index providers; multi-tenant; user-script fields; metric indexes; quote-delta optimisation; historical backtests.

## 9. Addendum — cross-WP interfaces (after WP1)

WP1 delivered `services/screener/universe.py`: `bundle()`, `bundle_hash()`, `class_symbols(cls)`, `universe_payload(session, cls)`, `seed_bundle(...)`, `tracked_symbols(session, settings)`, `list_lists`, `list_symbols(session, id)`, `put_list(...)` (raises `ListError` → 422), `delete_list(...)` → 'reverted'|'removed'|'unchanged'|'missing'(→404). Functions never commit; caller commits.

- Symbols in two classes (19 commodity ETFs) are stored once (`cls='etfs'`). **Class universes resolve via `symbol IN class_symbols(cls)`, never `screener_symbols.cls`.**

WP2 → WP3 (job runtime), in `services/screener/job.py`, exposed as `stack.screener` (type `ScreenerJob`):

```python
class RunInProgress(Exception): ...
class ScreenerJob:
    def trigger(self, kind: Literal["snapshot","fundamentals"]) -> int   # returns run id; raises RunInProgress
    def runtime(self) -> dict  # {"enabled":bool,"supported":bool,"reason":str|None,
                               #  "running":{"runId","kind","done","total","startedAt","etaS"}|None,
                               #  "nextRunAt":iso|None,"ratePerMin":float}
    def target_date(self, now: datetime | None = None) -> date            # latest completed US session
```

WP3 builds `/status` from `runtime()` + DB (asOf = max done-run target_date / snapshots, coverage counts, fundamentalsAsOf, tokensLastRun, barsRows = count of `bars`).

WP3 → WP4: `services/screener/query.py`:

```python
def run_scan(session: Session, req: ScanRequest, *, settings: Settings, now: datetime) -> ScanResponse
```

pydantic `ScanRequest`/`ScanResponse`/`Group`/`Rule`/`Universe` in `services/screener/schemas.py` (WP3). WP4 validates ScreenSpec by reusing these models.

WP2 → WP4 (post-run hook): after a snapshot run finishes with status done|partial the job calls

```python
services.screener.alerts.evaluate_screens(session, settings, *, as_of: date, hub, dispatcher, now: datetime) -> int
```

(import lazily; if module missing, skip). WP2 passes the stack's LiveHub/Dispatcher (find them in stack.py/app.state).

`app.py`: WP3 adds includes for `routes/screener.py` and `routes/screens.py` (both export `router`). Nobody else edits app.py.

## 10. Addendum — formula rules (2026-11-10, additive; `schemaVersion` stays 1)

A filter node may also be a **formula rule**, discriminated from `Rule` by the presence of `formula` (a node with `rules` is a `Group`):

```ts
type FormulaRule = {
  formula: string;
  op: '>' | '<' | '>=' | '<=' | 'between';
  value: number | [number, number];
};
type Group = { op: 'and' | 'or'; rules: (Rule | FormulaRule | Group)[] }; // ≤ 10 formula rules, each counts toward the 50-rule budget
```

Grammar (hand-written tokenizer + recursive descent: `services/screener/formula.py`, mirrored in `apps/web/src/screener/rules/formula.ts`; ASCII only, whitespace = space/tab/CR/LF):

```
formula = expr ;
expr    = term , { ("+"|"-") , term } ;
term    = unary , { ("*"|"/") , unary } ;
unary   = "-" , unary | primary ;
primary = number | field | call | "(" , expr , ")" ;
call    = ("abs"|"min"|"max") , "(" , expr , { "," , expr } , ")" | "prev" , "(" , field , ")" ;
number  = digit , {digit} , [ "." , digit , {digit} ] | "." , digit , {digit} ;
field   = (letter|"_") , { letter | digit | "_" } ;
```

- Fields: registry ids of type number|percent|money|int (so `daysSinceCross`, `daysToEarnings` yes; string/enum/bool/date no). `prev(f)` only for crossable fields → `prev_column`. `abs` 1 arg, `min`/`max` 2–8.
- Limits: ≤ 200 code points, ≤ 64 AST nodes, AST depth and paren/unary/call nesting ≤ 16, `min`/`max` nesting ≤ 2, number tokens ≤ 24 chars, ≤ 10 formula rules, ≤ 3 formula columns.
- SQL: columns from `FIELDS` only, literals as `bindparam`, no `text()`. `a / b` → `CAST(a AS FLOAT) / NULLIF(b, 0)` (division by zero → NULL); int fields cast to FLOAT. `min`/`max` render SQLite's scalar `min()`/`max()` (NULL if any arg is NULL); elsewhere `CASE WHEN any arg IS NULL THEN NULL ELSE LEAST/GREATEST(...) END` (hence the nesting cap). NULLs never match.
- Errors: 422 `{detail:{code, message, path, offset}}`; `offset` (0-based character) is present only for formula errors, so plain errors keep the §4 three-key shape. Codes: `formula_overflow` (below), `bad_formula` (syntax, unknown function, non-numeric or non-crossable field), `unknown_field`, `field_unavailable`, `too_complex`; `bad_op` / `bad_value` for the rule's op / value. Path `filter.rules[i].formula` or `fields[i]`.
- Formula columns: a `fields` entry `"=<formula>"` returns the value under the same key (`values["=last / sma200"]`); fundamental references are null (not an error) without fundamentals, like plain fundamental columns. Formula sort keys are not supported (`sort.field` stays a field id). `ScreenSpec.columns` may hold the same `"=<formula>"` ids (web: ≤ 3, after the fixed columns; display names are a device pref, `formulaLabels`); the table does not sort by them.
- Overflow: PostgreSQL raises on float overflow (`NumericValueOutOfRange` → SQLAlchemy `DataError`). Queries of a request with formulas run in a SAVEPOINT (non-SQLite) and a `DataError` becomes 422 `formula_overflow` with the path of the request's first formula (`query.formula_paths`); the caller's transaction stays usable. SQLite yields inf (→ null in values). `DataError` without formulas is not masked.
- Shared conformance vectors: `api/tests/data/formula_vectors.json` (valid → canonical s-expression; invalid → code + offset; `fields` mirrors the registry and is checked by pytest), run by `api/tests/test_screener_formula.py` and `apps/web/src/screener/rules/formula.test.ts`.
