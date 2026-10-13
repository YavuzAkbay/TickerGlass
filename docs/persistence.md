# Persistence (Phase 7)

User data lives in the API database (SQLite by default, Postgres via `DATABASE_URL`). The web app talks to it
through `apps/web/src/api/persistence.ts` and `autosave.ts`. Server code: `api/src/investopen_api/userdata/`,
`routes/{layouts,drawings,templates,user_settings,notes,transfer}.py`. Migration `bd686f7c13d4`.

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

- **Drawings are one row per drawing, global (not per layout).** The server derives `symbol`/`pane_id`/`z` from
  the `Drawing` (`scope: 'all'` -> symbol null; else `symbol` upper-cased). This maps 1:1 onto the web store's
  `apply(upserts, removeIds)`. (docs/drawings.md §6 mentioned per-layout keys; per-layout drawings are deferred.)
- At most one `is_default` drawing template per tool (setting one clears the others).
- Size limits: layout state 2 MB, drawing 512 KB, template 256 KB, setting value 512 KB, 5000 ops per batch.

## 2. Endpoints (all under `/api`)

| Method + path                                                               | Client function                                      | Notes                                                               |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /layouts`                                                              | `listLayouts`                                        | summaries (no state), newest `updatedAt` first                      |
| `POST /layouts` `{name,state,schemaVersion?}`                               | `createLayout`                                       | 201; also "save as"                                                 |
| `GET /layouts/{id}`                                                         | `getLayout`                                          |                                                                     |
| `PUT /layouts/{id}` `{state,revision,schemaVersion?}`                       | `saveLayout`                                         | 409 if `revision` stale; returns new revision                       |
| `PATCH /layouts/{id}` `{name}`                                              | `renameLayout`                                       | does not bump revision                                              |
| `POST /layouts/{id}/duplicate` `{name}`                                     | `duplicateLayout`                                    | copies the _stored_ state                                           |
| `DELETE /layouts/{id}`                                                      | `deleteLayout`                                       | 204                                                                 |
| `GET/PUT /layouts/last-used` (`{id}`)                                       | `getLastUsedLayout`/`setLastUsedLayout`              | GET returns `null` when none                                        |
| `GET /layouts/{id}/export`, `POST /layouts/import?name=`                    | `exportLayout`/`importLayout`                        | import always creates a new layout                                  |
| `GET /drawings?symbol=&synced=true`                                         | `getDrawings`                                        | no symbol = all; with symbol = its + synced                         |
| `POST /drawings/batch`                                                      | `batchDrawings`                                      | see §3                                                              |
| `GET/POST /indicator-templates`, `GET/PUT/DELETE /indicator-templates/{id}` | `list/save/get/update/deleteIndicatorTemplate`       | POST upserts by name (201 new, 200 replaced); PUT 409 on name clash |
| `GET /drawing-templates?toolType=`, `POST`, `GET/PUT/DELETE /{id}`          | `...DrawingTemplate(s)`                              | POST upserts by (toolType, name)                                    |
| `GET/POST /chart-templates`, `GET/PUT/DELETE /{id}`                         | `...ChartTemplate(s)`                                | POST upserts by name                                                |
| `GET /settings`, `PATCH /settings` `{k: v\|null}`                           | `getSettings`/`patchSettings`                        | null deletes; PATCH returns all settings                            |
| `GET/PUT/DELETE /settings/{key}` (`{value}`)                                | `getSetting`/`putSetting`/`deleteSetting`            | GET 404 if unset; last writer wins per key                          |
| `GET /notes?symbol=`, `POST`, `GET/PUT/DELETE /notes/{id}`                  | `listNotes/createNote/getNote/updateNote/deleteNote` | PUT with `revision` -> 409 if stale                                 |
| `GET /export`                                                               | `exportAll`                                          | full bundle (§4)                                                    |
| `POST /import?mode=merge\|replace&dryRun=`                                  | `importAll`                                          | returns per-entity `{created,updated,deleted}`                      |

Errors: `{detail: string}` (404, 422) or, for revision conflicts, `{detail: {message, current | conflicts}}`.
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
- **Templates, settings**: last writer wins.

Recommended web policy: keep `id -> revision` for drawings next to the store; diff the store against the last
synced state (like `mergeBuckets`) to build a batch; on 409 adopt the server copies of the conflicting ids, rebuild
the batch for the rest, retry. Refetch (`getDrawings`, `getLayout`) on window focus / `visibilitychange` visible.

## 4. Import/export bundle

```jsonc
{ "version": 1, "app": "investopen", "exportedAt": "...",
  "layouts": [{ "id", "name", "state", "schemaVersion", "isLastUsed", ... }],
  "drawings": [{ "data": <Drawing>, "schemaVersion", ... }],   // id/symbol/z derived from data
  "indicatorTemplates": [...], "drawingTemplates": [...], "chartTemplates": [...],
  "settings": { "<key>": <value> }, "notes": [{ "id", "symbol", "text", ... }] }
```

Export fields `revision`/`createdAt`/`updatedAt` are informational. Import validates everything first (version
1..server's `BUNDLE_VERSION`, sizes, duplicate keys in the bundle -> 422) and runs in one transaction.
`merge`: layouts/drawings/notes match by id, templates by name (drawing templates by toolType+name), settings by
key; matches are overwritten (revision bumped), the rest is created; a bundle `isLastUsed` applies only if no
layout is last-used yet. `replace`: deletes all user data first. `dryRun=true` returns the same summary and rolls
back. Single-layout files: `{version: 1, kind: "layout", layout: {name, state, schemaVersion}}`.

## 5. Schema versions and migrations

- Table changes: edit `models.py`, `uv run alembic revision --autogenerate -m "..."` (batch mode for SQLite),
  hand-check; `run_migrations` applies them on startup. `tests/test_userdata.py` checks the head matches
  `models.py` and that upgrade/downgrade work on SQLite.
- JSON shapes: the **client** owns them. Bump `schemaVersion` when a state/template/drawing shape changes; on read,
  upgrade older versions with `upgrade[v]: (old) => new` steps and write back the current version on the next save.
  The server never rewrites JSON; only if a change must be applied server-side add an Alembic data migration.
- Bundle format: bump `BUNDLE_VERSION` (server + `types.ts`) only for incompatible changes; the server must keep
  reading every older version (convert in `store.import_bundle`).

## 6. Web migration plan (localStorage -> API)

Suggested layout `state` (schemaVersion 1): `{ chart: chart.getState(), indicators: IndicatorState[],
chartSettings: { chartType, chartStyle, volume, showPrevClose, timezone, prepost } }`.

| localStorage key                                                                                     | Goes to                                                                           |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `investopen-drawings` `{version:1, bySymbol, synced}`                                                | `drawings` (one row per `Drawing`, unchanged JSON)                                |
| `investopen-indicators` `instances` + `investopen-app` chart fields                                  | one layout "Default", set last-used                                               |
| `investopen-indicator-prefs` `{favorites, defaults}`                                                 | settings `indicators.favorites`, `indicators.defaults`                            |
| `investopen-drawing-templates` `{byType, defaults}`                                                  | `drawing_templates`; each `defaults[type]` -> `isDefault: true`, name `"Default"` |
| `investopen-app` prefs (theme, favoriteIntervals, customIntervals, recentSymbols, crosshair, magnet) | setting `app.prefs`                                                               |
| `investopen-ui` `notes` (string)                                                                     | one general note (symbol null)                                                    |

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
