# Persistence (Phase 7, watchlists Phase 8, compares Phase 9)

User data lives in the API database (SQLite by default, Postgres via `DATABASE_URL`). The web app talks to it
through `apps/web/src/api/persistence.ts` and `autosave.ts`. Server code: `api/src/tickerglass_api/userdata/`,
`routes/{layouts,drawings,templates,user_settings,notes,watchlists,user_scripts,transfer}.py`. Migrations
`bd686f7c13d4` (Phase 7), `50fc9b162b6f` (watchlists, Phase 8) and `3f8a6c1d9e47` (user scripts).

## 1. Data model

JSON payloads are **opaque** to the server: it checks the top-level type, size and `schemaVersion` only.
Wire format is camelCase. Timestamps are ISO 8601 UTC.

| Table                 | Columns (besides `created_at`/`updated_at`)                                                                                                   | Key               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `layouts`             | `id` uuid, `name`, `state` JSON object, `schema_version`, `revision`, `is_last_used`                                                          | id                |
| `drawings`            | `id` (= `Drawing.id`), `symbol` (null = synced), `pane_id`, `z`, `data` (the whole `Drawing`), `schema_version`, `revision` (no `created_at`) | id                |
| `indicator_templates` | `id`, `name` unique, `instances` JSON list, `schema_version`                                                                                  | name              |
| `drawing_templates`   | `id`, `tool_type`, `name`, `style` JSON, `is_default`, `schema_version`                                                                       | (tool_type, name) |
| `chart_templates`     | `id`, `name` unique, `data` JSON, `schema_version`                                                                                            | name              |
| `settings`            | `key` (`[A-Za-z0-9_.-]{1,64}`), `value` JSON (not null)                                                                                       | key               |
| `notes`               | `id`, `symbol` (null = general), `text` (<= 200k chars), `revision`                                                                           | id                |
| `watchlists`          | `id` (client-chosen), `name`, `items` JSON list, `revision`                                                                                   | id                |
| `user_scripts`        | `id` (client-chosen), `name` (1-100), `source` (<= 200k chars), `manifest` JSON object or null (<= 64 KB), `api_version`, `revision`          | id                |
| `symbol_flags`        | `symbol` (upper-case), `color` (one of 7)                                                                                                     | symbol            |
| `alerts`              | `id`, `name`, `symbol`, `spec` JSON, `status`, `revision`, ... (+ `alert_states`, `alert_log`, `alert_deliveries`: alerts.md §1.1)            | id                |

- **Drawings are one row per drawing, global (not per layout).** The server derives `symbol`/`pane_id`/`z` from
  the `Drawing` (`scope: 'all'` -> symbol null; else `symbol` upper-cased). This maps 1:1 onto the web store's
  `apply(upserts, removeIds)`. (docs/drawings.md §6 mentioned per-layout keys; per-layout drawings are deferred.)
- At most one `is_default` drawing template per tool (setting one clears the others).
- **Watchlists** are one row per list; `items` is a JSON array the server validates: `{type:'symbol', symbol}` and
  `{type:'section', id, title, collapsed}`. Symbols after a section belong to it until the next section. Symbols are
  trimmed and upper-cased (`[A-Z0-9.\-=^/&_]{1,32}`), unique within a list (case-insensitive), section ids unique,
  at most 1000 items. Names are not unique. The client creates the id (UUID v4, `[A-Za-z0-9_-]{1,36}`) so a list
  made offline keeps its identity. List order in the UI is alphabetical (no position column).
- **User scripts** are one row per script, with the source and the compiled `manifest` (null if the last save did
  not compile; the server does not run or validate scripts). The client creates the id (UUID v4,
  `[A-Za-z0-9_-]{1,36}`) because indicator instances reference it (`user:<id>`). Names are not unique.
  See [user-scripts.md](user-scripts.md).
- **Flags** are global: at most one of `red orange yellow green cyan blue purple` per symbol.
  `created_at` is the time the current color was set (it resets on a color change, not on setting the same color).
- **Alerts** (Phase 10) are one row per alert with revision checks like watchlists; the evaluation service owns
  `alert_states`, and the API owns the log and the delivery outbox. Tables, endpoints, firing and the `/ws` event
  topics: [alerts.md](alerts.md) §1.
- Size limits: layout state 2 MB, drawing 512 KB, template 256 KB, setting value 512 KB, 5000 ops per batch.

## 2. Endpoints (all under `/api`)

| Method + path                                                               | Client function                                                               | Notes                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /layouts`                                                              | `listLayouts`                                                                 | summaries (no state), newest `updatedAt` first                                                                                                                                 |
| `POST /layouts` `{name,state,schemaVersion?}`                               | `createLayout`                                                                | 201; also "save as"                                                                                                                                                            |
| `GET /layouts/{id}`                                                         | `getLayout`                                                                   |                                                                                                                                                                                |
| `PUT /layouts/{id}` `{state,revision,schemaVersion?}`                       | `saveLayout`                                                                  | 409 if `revision` stale; returns new revision                                                                                                                                  |
| `PATCH /layouts/{id}` `{name}`                                              | `renameLayout`                                                                | does not bump revision                                                                                                                                                         |
| `POST /layouts/{id}/duplicate` `{name}`                                     | `duplicateLayout`                                                             | copies the _stored_ state                                                                                                                                                      |
| `DELETE /layouts/{id}`                                                      | `deleteLayout`                                                                | 204                                                                                                                                                                            |
| `GET/PUT /layouts/last-used` (`{id}`)                                       | `getLastUsedLayout`/`setLastUsedLayout`                                       | GET returns `null` when none                                                                                                                                                   |
| `GET /layouts/{id}/export`, `POST /layouts/import?name=`                    | `exportLayout`/`importLayout`                                                 | import always creates a new layout                                                                                                                                             |
| `GET /drawings?symbol=&synced=true`                                         | `getDrawings`                                                                 | no symbol = all; with symbol = its + synced                                                                                                                                    |
| `POST /drawings/batch`                                                      | `batchDrawings`                                                               | see §3                                                                                                                                                                         |
| `GET/POST /indicator-templates`, `GET/PUT/DELETE /indicator-templates/{id}` | `list/save/get/update/deleteIndicatorTemplate`                                | POST upserts by name (201 new, 200 replaced); PUT 409 on name clash                                                                                                            |
| `GET /drawing-templates?toolType=`, `POST`, `GET/PUT/DELETE /{id}`          | `...DrawingTemplate(s)`                                                       | POST upserts by (toolType, name)                                                                                                                                               |
| `GET/POST /chart-templates`, `GET/PUT/DELETE /{id}`                         | `...ChartTemplate(s)`                                                         | POST upserts by name                                                                                                                                                           |
| `GET /settings`, `PATCH /settings` `{k: v\|null}`                           | `getSettings`/`patchSettings`                                                 | null deletes; PATCH returns all settings                                                                                                                                       |
| `GET/PUT/DELETE /settings/{key}` (`{value}`)                                | `getSetting`/`putSetting`/`deleteSetting`                                     | GET 404 if unset; last writer wins per key                                                                                                                                     |
| `GET /notes?symbol=`, `POST`, `GET/PUT/DELETE /notes/{id}`                  | `listNotes/createNote/getNote/updateNote/deleteNote`                          | PUT with `revision` -> 409 if stale                                                                                                                                            |
| `GET/POST /watchlists`, `GET/PUT/DELETE /watchlists/{id}`                   | `listWatchlists/createWatchlist/getWatchlist/updateWatchlist/deleteWatchlist` | list includes items, oldest first; POST accepts an `id` (409 + `current` if taken); PUT `{name,items,revision?}` -> 409 if stale; DELETE 404 if missing (treated as done)      |
| `GET/POST /user-scripts`, `GET/PUT/DELETE /user-scripts/{id}`               | `...UserScript(s)` (web data layer)                                           | list includes sources, oldest first; POST accepts an `id` (409 + `current` if taken); PUT `{name,source,manifest,apiVersion,revision?}` -> 409 if stale; DELETE 404 if missing |
| `GET /flags`, `PATCH /flags` `{SYMBOL: color\|null}`                        | `getFlags`/`patchFlags`                                                       | PATCH sets or removes flags in one transaction (max 5000) and returns all flags                                                                                                |
| `/alerts*` (CRUD, status, log, channels, service)                           | `apps/web/src/api/alerts.ts`                                                  | Phase 10: see [alerts.md](alerts.md) §1.4. Mutations are online-only (no localStorage queue)                                                                                   |
| `GET /export`                                                               | `exportAll`                                                                   | full bundle (§4)                                                                                                                                                               |
| `POST /import?mode=merge\|replace&dryRun=&confirm=`                         | `importAll`                                                                   | returns per-entity `{created,updated,deleted}`; replace needs `confirm=true`                                                                                                   |

Errors: `{detail: string}` (400, 404, 409 name clash, 422) or, for revision conflicts, `{detail: {message, current | conflicts}}`.
`ApiError.message` is the `detail` string or `detail.message`; `ApiError.body` holds the parsed body.

## 3. Revisions and conflicts

`revision` starts at 1 and is bumped by every content write. Writers send the revision they based the change on.

- **Layouts**: `PUT` with a stale `revision` -> 409, `detail.current` = the stored layout (`layoutConflict(err)`).
  Rename does not bump the revision, so it never conflicts with autosave.
- **Drawings** (`POST /drawings/batch`): `{upserts: [{drawing, baseRevision}], deletes: [{id, baseRevision?}],
schemaVersion?, force?}`. Upsert with `baseRevision: null` = create (conflict if the id exists); with a number =
  must equal the stored revision (conflict if changed or deleted). Delete without `baseRevision` is unconditional;
  deleting a missing id is a no-op. **All-or-nothing**: any conflict -> 409 and nothing is written;
  `detail.conflicts[] = {id, revision|null, drawing|null}` (`drawingConflicts(err)`). `force: true` skips checks
  (last writer wins, for "keep mine"). Success returns the written rows (new revisions) and `deleted` ids.
- **Notes**: optional `revision` on PUT (409 with `detail.current`); omit it to overwrite.
- **Watchlists**: like notes. `PUT` replaces name and items as a whole with one conditional `UPDATE ... WHERE id AND
revision`; a stale `revision` -> 409 `{detail: {message, current}}`, a missing id -> 404, omitting `revision`
  overwrites. `POST` with an existing `id` -> 409 with `current` (the client then saves with `PUT` instead).
  The web side adopts `current` on a conflict and shows "Keep mine", which re-applies the local version.
- **User scripts**: like watchlists (`POST` with an existing `id` -> 409 with `current`; `PUT` with a stale
  `revision` -> 409 `{detail: {message, current}}`; omitting `revision` overwrites).
- **Flags**: last writer wins; `PATCH /flags` has no revisions. Unflagging a missing symbol is a no-op.
- **Templates, settings**: last writer wins. A name clash (PUT rename, or two POSTs creating the same name at the
  same time) is a 409 `{detail: string}`.

Checks are atomic with the write: layouts/notes use one `UPDATE ... WHERE id = :id AND revision = :base` and
treat "0 rows" as the conflict; the drawing batch pre-checks (for the full `conflicts` list) and then writes each
row conditionally on the revision it read, rolling the whole batch back with the same 409 shape if another writer
committed in between (or created the same id: an insert unique violation). `force: true` writes unconditionally, but
a concurrent create of the same id is still a 409. `tests/test_userdata.py` races a second connection between check
and write; set `TEST_DATABASE_URL` to a disposable Postgres database to run those tests there too.

Recommended web policy: keep `id -> revision` for drawings next to the store; diff the store against the last
synced state (like `mergeBuckets`) to build a batch; on 409 adopt the server copies of the conflicting ids, rebuild
the batch for the rest, retry. Refetch (`getDrawings`, `getLayout`) on window focus / `visibilitychange` visible.

## 4. Import/export bundle

```jsonc
{ "version": 1, "app": "tickerglass", "exportedAt": "...",
  "layouts": [{ "id", "name", "state", "schemaVersion", "isLastUsed", ... }],   // "app" is required
  "drawings": [{ "data": <Drawing>, "schemaVersion", ... }],   // id/symbol/z derived from data
  "indicatorTemplates": [...], "drawingTemplates": [...], "chartTemplates": [...],
  "settings": { "<key>": <value> }, "notes": [{ "id", "symbol", "text", ... }],
  "watchlists": [{ "id", "name", "items": [...], ... }],   // added in Phase 8
  "flags": [{ "symbol", "color", ... }],                   // added in Phase 8
  "alerts": [{ ...AlertIn, "status", "statusReason", "fireCount", "lastFiredAt" }],   // added in Phase 10
  "userScripts": [{ "id", "name", "source", "manifest", "apiVersion", ... }] }       // added with user scripts
```

Export fields `revision`/`createdAt`/`updatedAt` are informational. Import validates everything first (`app:
"tickerglass"` required, version 1..server's `BUNDLE_VERSION`, sizes, duplicate keys in the bundle, per-symbol
drawings without a symbol, null setting values, more than 10,000 settings -> 422) and runs in one transaction.
`merge`: layouts/drawings/notes match by id, templates by name (drawing templates by toolType+name), settings by
key; matches are overwritten (revision bumped), the rest is created (watchlists match by id, flags by symbol; a
flag keeps its `created_at` unless the color changed); a bundle `isLastUsed` applies only if no
layout is last-used yet. `replace` requires `confirm=true` (400 otherwise; not needed with `dryRun=true`) and
empties only the tables of the sections **present** in the bundle (`"notes": []` wipes notes; an absent `notes`
key leaves them alone), so `{"version": 1, "app": "tickerglass"}` changes nothing. Send a full export bundle to
replace everything. `dryRun=true` returns the same summary and rolls back.

- `watchlists` and `flags` are additive: `BUNDLE_VERSION` stays 1, and a Phase 7 bundle without these keys leaves
  them untouched, also in `replace`. Duplicate watchlist ids or flag symbols in a bundle -> 422. A watchlist id that
  is not `[A-Za-z0-9_-]{1,36}` gets a fresh id on import.
- `alerts` is additive too (no states, no log): `merge` matches by id, `replace` empties alerts and their states only
  when the key is present. Details: [alerts.md](alerts.md) §1.7.
- `userScripts` is additive too: `merge` matches by id, `replace` empties the table only when the key is present.
  Duplicate ids or an id that is not `[A-Za-z0-9_-]{1,36}` -> 422 (ids are referenced by indicator instances, so
  they are never regenerated).
- Layout ids that would shadow a fixed route (`last-used`, `import`, `export`) or are not `[A-Za-z0-9_-]{1,36}` get a
  fresh id on import (`isLastUsed` follows the new id); such layouts are always created, never matched.
- Settings: `null` values are rejected (422), as with `PUT /settings/{key}`; to remove a key use `PATCH` / `DELETE`.
  Export never emits null. Single-layout files: `{version: 1, kind: "layout", layout: {name, state, schemaVersion}}`.

## 5. Schema versions and migrations

- Table changes: edit `models.py`, `uv run alembic revision --autogenerate -m "..."` (batch mode for SQLite),
  hand-check; `run_migrations` applies them on startup. `tests/test_userdata.py` checks the head matches
  `models.py` and that upgrade/downgrade work on SQLite.
- JSON shapes: the **client** owns them. Bump `schemaVersion` when a state/template/drawing shape changes; on read,
  upgrade older versions with `upgrade[v]: (old) => new` steps and write back the current version on the next save.
  The server never rewrites JSON; only if a change must be applied server-side add an Alembic data migration.
- Layout `state` versions: v1 (Phase 7), v2 (volume as an indicator), v3 (Phase 9, adds `compares`), v4 (renamed built-in indicators), v5 (Phase 14, multi-chart grid). Each step is
  an entry in `UPGRADES` in `apps/web/src/persist/layoutState.ts`; details in §6.
- Bundle format: bump `BUNDLE_VERSION` (server + `types.ts`) only for incompatible changes; the server must keep
  reading every older version (convert in `store.import_bundle`).

## 6. Web migration plan (localStorage -> API)

Implemented in `apps/web/src/persist/` (Phase 7): `migration.ts` (step 1), `bootstrap.ts` + `layouts.ts` (steps
2–4), `drawingSync.ts`, `settingsSync.ts` (keys `app.prefs`, `ui.prefs`, `indicators.favorites`,
`indicators.defaults`, `watchlist.prefs`), `drawingTemplatesSync.ts`, `notes.ts`, `watchlists.ts` (Phase 8,
`WatchlistSync`: lists whole with revision checks, flags as `PATCH` batches). Layout cache key: `tickerglass-layout`.
Watchlist cache keys: `tickerglass-watchlists` (lists, flags, dirty flags, pending deletes) and
`tickerglass-watchlist-prefs` (mirror of the setting `watchlist.prefs` = `{activeId, columns, sort}`; `activeId` is a
list id or `flag:<color>`). The first run seeds one list "Watchlist" with the current and recent symbols; seeded
offline, it is kept only if the first successful load finds no lists on the server (or it was edited).

Layout `state` (schemaVersion 3): `{ chart: chart.getState(), indicators: IndicatorState[],
chartSettings: { chartType, chartStyle, showPrevClose, timezone, prepost },
compares: { items: CompareState[], scaleRestore: PriceScaleMode | null } }`. v1 also had
`chartSettings.volume` (engine built-in volume); `parseLayoutState` upgrades it to a Volume indicator
(`'overlay'` -> price pane, `'pane'` -> own pane taking over the `volume` pane's size, none if a Volume
indicator exists) and drops it. The step is content based and idempotent, because the local cache, the
recovery copy and the orphan copy store no schema version and are read as v1; the server copy is rewritten as
the current version on the next save. The local stores migrate the same way (`tickerglass-indicators` v2 reads the legacy
`tickerglass-app` `volume`). Chart templates ignore a stored `volume`.

v3 (Phase 9) adds `compares` (`docs/compare.md` §6). The upgrade step `UPGRADES[2]` adds
`{items: [], scaleRestore: null}` when the key is missing. `parseLayoutState` drops invalid compare items and
re-canonicalizes their symbols. A client that only knows v2 rejects a v3 layout, as for any newer version. The
server needs no change: layout `state` is opaque JSON. Compares are not part of indicator or chart templates.

v5 (Phase 14) turns the single chart into a grid of charts (`docs/multi-chart.md`):
`{ template: string | null, grid: GridNode, charts: ChartSlotState[], activeChartId, sync: SyncFlags }`.
`GridNode` is `{kind:'leaf', chartId}` or `{kind:'split', dir:'row'|'col', sizes, children, aligned?}`; each
`ChartSlotState` is the old v4 state of one chart (`id`, `chart`, `indicators`, `compares`, `chartSettings`).
The resolved tree is stored; `template` is only the picker label. `parseLayoutState` normalises the tree
(directions alternate, `sizes` are fractions summing to 1, leaves and charts match one to one). `UPGRADES[4]`
wraps a v4 state into one slot `c1` with a single-leaf grid, template `'1'`, `activeChartId: 'c1'` and the
default sync flags; it is deterministic. Symbol, interval, chart type and style, previous-close line, timezone
and extended hours moved from the global app store into each slot's `chartSettings`; the app store keeps theme,
crosshair, magnet, favorites and recent symbols. A client that only knows v4 rejects a v5 layout. The server
needs no change (opaque JSON), and `Drawing.chartId` lives inside the drawing's `data`. Chart templates keep their v4 shape (one chart).

| localStorage key                                                                                     | Goes to                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `tickerglass-drawings` `{version:1, bySymbol, synced}`                                                | `drawings` (one row per `Drawing`, unchanged JSON)                                |
| `tickerglass-indicators` `instances` + `tickerglass-app` chart fields                                  | one layout "Default", set last-used                                               |
| `tickerglass-indicator-prefs` `{favorites, defaults}`                                                 | settings `indicators.favorites`, `indicators.defaults`                            |
| `tickerglass-drawing-templates` `{byType, defaults}`                                                  | `drawing_templates`; each `defaults[type]` -> `isDefault: true`, name `"Default"` |
| `tickerglass-app` prefs (theme, favoriteIntervals, customIntervals, recentSymbols, crosshair, magnet) | setting `app.prefs`                                                               |
| `tickerglass-ui` `notes` (string)                                                                     | one general note (symbol null)                                                    |

1. **First run**: if setting `migration.localStorage` is absent and localStorage holds data, build a bundle from it,
   `importAll(bundle, {mode: 'merge', dryRun: true})`, then for real; then `putSetting('migration.localStorage',
{version: 1, at})`. Never delete the localStorage keys in this step. If the API is unreachable, retry next start.
2. **Startup**: `getLastUsedLayout()` (create "Default" when null), `getDrawings()`, `getSettings()`, templates,
   notes. API data replaces the in-memory stores; localStorage keeps a copy as the **offline cache**.
3. **Edits**: stores keep writing localStorage (fast, offline) and also push to the API: layout state via
   `createLayoutAutosaver(layout, {onConflict})`; drawings via debounced `batchDrawings`; settings via
   `patchSettings`; notes via `createAutosaver` + `updateNote` with `revision`. All saves flush on `pagehide`
   with `keepalive` (bodies over 64 KB may be dropped by the browser there; the next start re-syncs from cache).
4. **Offline**: autosavers keep the value pending and retry (`retryDelay`); on reconnect, flush. Unsynced cache
   newer than the server is pushed with revisions, so conflicts surface instead of silent overwrites.
