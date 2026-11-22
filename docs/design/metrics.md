# Metrics and health (roadmap 2.5)

Status: done 2026-11-17 (uncommitted).

Goal: a self-hoster can point Prometheus at TickerGlass, import one Grafana dashboard, and see
whether provider budget, cache, alerts, notifications, screener, and backups are healthy. Orchestrators
(Docker, Helm, Unraid) get real liveness and readiness probes.

## 1. Principles

- **One scrape target.** The alerts service has no port of its own and should not get one. It
  already sends a heartbeat to the API every 30 s, so it adds a `metrics` object to that heartbeat
  and the API exposes everything on a single `/metrics`.
- **Read existing state at scrape time.** Prefer a custom `prometheus_client` Collector that reads
  state already kept (`UpstreamGuard.snapshot()`, `CacheStats.snapshot()`, `ServiceState`, DB rows)
  over hooks spread through the code. Add in-process counters only where no state exists today
  (HTTP requests, notification delivery outcomes, fires received).
- **Bounded, private labels.** No label ever carries a user, symbol, alert id, screen id, note,
  URL, raw path, or error text. Allowed label values come from small fixed sets: provider id,
  cache name, channel kind, outcome/status enums, HTTP method, route *template*, status class.
  Multi-user servers must not leak one user's activity shape to anyone who can read metrics beyond
  aggregate totals.
- **Single process.** The API runs one uvicorn worker (`__main__.py`). Use a private
  `CollectorRegistry` on `app.state.metrics` (not the global default, so tests stay isolated). No
  multiprocess mode. Document that `workers>1` is unsupported for metrics.
- **Opt-in, fail closed.** Off by default.

## 2. Settings (api/settings.py)

| Env | Type | Default | Meaning |
|---|---|---|---|
| `METRICS_ENABLED` | bool | `false` | Serve `/metrics`. When false the path returns 404. |
| `METRICS_TOKEN` | secret str | none | If set, `/metrics` requires `Authorization: Bearer <token>` (constant-time compare via `hmac.compare_digest`). `repr=False`, same as other secrets. |
| `METRICS_PUBLIC` | bool | `false` | Explicitly allow `/metrics` without a token. |

Startup rule (same spirit as 2.1 allow-lists): if `METRICS_ENABLED=true` and no `METRICS_TOKEN`
and `METRICS_PUBLIC` is not true, **and** auth is enabled (password/OIDC/header mode), refuse to
start with a clear error. In open mode (no auth configured) a token-less `/metrics` is allowed,
because the whole app is already open. A token must be at least 16 chars.

`/metrics` is added to the auth middleware's public paths; the endpoint does its own token check.
Session cookies and `X-Alerts-Token` do **not** grant access (keeps scraping credentials separate
from user and service credentials). Wrong/missing token → 401 with `WWW-Authenticate: Bearer`.

## 3. Endpoints

- `GET /metrics` (app root, not `/api`): Prometheus text format
  (`prometheus_client.generate_latest`, content type `CONTENT_TYPE_LATEST`). Excluded from the HTTP
  metrics middleware itself.
- `GET /api/health` — unchanged (`{status, version}`), stays public; existing users and
  HEALTHCHECKs keep working.
- `GET /api/health/live` — public, always `200 {"status":"ok"}` if the process serves requests. No
  DB access.
- `GET /api/health/ready` — public. Runs `SELECT 1` on the DB with a 2 s budget and checks that the
  app finished startup (lifespan done, staged backup restore applied). `200 {"status":"ok"}` or
  `503 {"status":"unavailable","checks":{"startup":"ok","db":"fail"}}` (checks: `startup`, `db`). Public body contains only check names and
  `ok`/`fail`, never error text. Alerts-service offline does **not** fail readiness (the API is
  still usable; that is a metric/alert, not a restart reason).

nginx (`docker/nginx.conf`, AIO config): add `location = /metrics` proxied to the API, same as
`/api`. Prometheus can then scrape the web port (AIO only exposes 8080).

## 4. Metric catalogue

Prefix `tickerglass_`. `*_total` are counters, `_seconds` use seconds, timestamps are Unix seconds.

### 4.1 Process and HTTP (in-process)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_build_info` | gauge=1 | `version` | `_version.py` |
| `tickerglass_http_requests_total` | counter | `method`, `route`, `status` (`2xx`..`5xx`) | pure-ASGI middleware |
| `tickerglass_http_request_duration_seconds` | histogram | `method`, `route` | same middleware; buckets 0.005…10 |

`route` = matched route template (`/api/alerts/{alert_id}`), `"websocket"` for WS scopes (counted
on connect only, no duration), `"unmatched"` otherwise. Must be pure ASGI (not
`BaseHTTPMiddleware`) so streaming responses and websockets are untouched. Standard
`process_*`/`python_*` collectors are registered on the private registry too.

### 4.2 Market provider (collector over existing state + one counter)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_provider_requests_total` | counter | `provider`, `outcome` (`ok`,`rate_limited`,`unavailable`,`error`) | increment at the single upstream send points: `providers/http.py` `JsonHttp.get` and `providers/yahoo.py` `_call` (one count per upstream attempt, retries included) |
| `tickerglass_provider_refused_total` | counter | `provider`, `reason` | `UpstreamGuard` refused counters (local budget / breaker), read at scrape |
| `tickerglass_provider_budget_remaining` | gauge | `provider`, `window` | `UpstreamGuard.snapshot()` |
| `tickerglass_provider_budget_limit` | gauge | `provider`, `window` | same |
| `tickerglass_provider_breaker_open` | gauge 0/1 | `provider` | same, if snapshot exposes it |

Exact field names follow whatever `UpstreamGuard.snapshot()` returns; do not invent state the guard
does not keep. If a provider object has no guard, emit nothing for it.

### 4.3 Cache (collector)

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_cache_requests_total` | counter | `cache`, `result` (`hit`,`miss`) | `CacheStats.snapshot()` keys `cache.{name}.hit/miss` |

Hit rate is computed in Grafana. Other numeric CacheStats gauges may be exported as
`tickerglass_cache_<name>` only if their names are a fixed set.

### 4.4 Alerts

API-side (authoritative for "fired", survives alerts-service restarts):

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_alerts_fired_total` | counter | `source` (`chart`,`screener`) | `POST /api/alerts/{id}/fire` success path; `services/screener/alerts.py` each screen match that logs an entry |
| `tickerglass_alerts_active` | gauge | `kind` (fixed enum of alert kinds, e.g. `price`,`indicator`,`script`,`drawing`) | DB count of enabled alerts (scrape cache, §5) |
| `tickerglass_alerts_service_up` | gauge 0/1 | – | heartbeat younger than `ONLINE_WITHIN` (90 s) |
| `tickerglass_alerts_service_last_heartbeat_timestamp_seconds` | gauge | – | `ServiceState` |
| `tickerglass_alerts_service_start_timestamp_seconds` | gauge | – | heartbeat `startedAt` |
| `tickerglass_alerts_series` / `_live_symbols` / `_polled_series` / `_waiting` | gauge | – | heartbeat fields (`waiting` = len of list) |

From the heartbeat `metrics` object (§6), emitted **only while the service is up** so stale lag
does not flatline on dashboards. Counters reset when the service restarts; Prometheus `rate()`
handles that.

| Metric | Type | Heartbeat field |
|---|---|---|
| `tickerglass_alerts_evaluations_total` | counter | `evaluations` |
| `tickerglass_alerts_evaluation_failures_total` | counter | `evaluationFailures` |
| `tickerglass_alerts_fires_queued_total` | counter | `firesQueued` |
| `tickerglass_alerts_fire_retries_total` | counter | `fireRetries` |
| `tickerglass_alerts_fires_dropped_total` | counter | `firesDropped` |
| `tickerglass_alerts_fire_queue_depth` | gauge | `fireQueueDepth` |
| `tickerglass_alerts_status_post_failures_total` | counter | `statusPostFailures` |
| `tickerglass_alerts_script_faults_total` | counter | `scriptFaults` |
| `tickerglass_alerts_evaluation_lag_seconds` | histogram | `lag` |

### 4.5 Notifications

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_notifications_deliveries_total` | counter | `channel` (channel kind: `webhook`,`ntfy`,`gotify`,`apprise`,…; unknown → `other`), `outcome` (`sent`,`retry`,`failed`) | `notifications/dispatcher.py`: success at the `status="sent"` path; `_record_failure` → `failed` when terminal, else `retry` |
| `tickerglass_notifications_outbox` | gauge | `status` (`pending`,`failed`) | DB count (scrape cache) |
| `tickerglass_notifications_oldest_pending_age_seconds` | gauge | – | DB min(created) of pending rows; 0 when none |

### 4.6 Screener

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_screener_snapshot_age_seconds` | gauge | – | now − `max(ScreenerSnapshot.computed_at)`; absent if table empty |
| `tickerglass_screener_snapshot_rows` | gauge | – | row count |
| `tickerglass_screener_last_run_timestamp_seconds` | gauge | `kind`, `status` | latest `ScreenerRun` per kind (finished time, or start if unfinished) |
| `tickerglass_screener_enabled` | gauge 0/1 | – | effective setting |

### 4.7 Backups

| Metric | Type | Labels | Source |
|---|---|---|---|
| `tickerglass_backup_last_success_timestamp_seconds` | gauge | – | `runner.last_ok_at` (absent if never) |
| `tickerglass_backup_last_run_status` | gauge=1 | `status` (`ok`,`partial`,`failed`,`running`) | latest `BackupRun` |
| `tickerglass_backup_last_size_bytes` | gauge | – | size of the latest run with status ok or partial |
| `tickerglass_backup_enabled` | gauge 0/1 | – | schedule configured |

## 5. DB-derived values

All DB reads in the collector:
- use a **system** session (`get_system_db` equivalent / ownership system session from 2.2), so
  the multi-user loader criteria don't hide rows; results are aggregates only;
- are cached for 15 s (scrape interval is usually 15–60 s; avoids load if scraped by two
  Prometheus instances);
- are wrapped so any exception emits `tickerglass_metrics_collect_errors_total{section}` +1 and
  skips that section; a scrape never 500s because one section failed;
- run synchronously inside the collector — the endpoint calls `generate_latest` via
  `run_in_threadpool` so the event loop is not blocked.

`tickerglass_metrics_collect_errors_total` (counter, `section` ∈ `provider`,`cache`,`alerts`,
`notifications`,`screener`,`backups`).

## 6. Heartbeat contract (alerts service → API)

`ServiceHeartbeat` (packages/alerts/src/types.ts, api schema) gains an **optional** field, so old
services and new APIs (and vice versa) keep working:

```ts
metrics?: {
  evaluations: number;          // cumulative runner evaluation passes since start (seed + every runner sample: live tick, bar close, poll)
  evaluationFailures: number;   // runnerFailure calls
  firesQueued: number;          // host.enqueueFire calls
  fireRetries: number;          // send attempts that failed and will retry
  firesDropped: number;         // 404/422 drops
  fireQueueDepth: number;       // current queue length
  statusPostFailures: number;
  scriptFaults: number;         // fault events delivered to onScriptFault (hold or final)
  lag: {
    buckets: number[];          // upper bounds in seconds, ascending, fixed:
                                // [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
    counts: number[];           // cumulative: counts[i] = observations <= buckets[i]; same length
    count: number;              // total observations (the +Inf bucket)
    sum: number;                // seconds
  };
}
```

API validation (pydantic): all counters `int >= 0` (floats rejected), `buckets` strictly
ascending, finite, `len <= 20`, `counts` same length, non-decreasing, each `<= count`, `sum >= 0`
finite. Invalid `metrics` → 422 for the whole heartbeat is too harsh; instead drop the `metrics`
part, keep the rest, log once at warning. Stored in memory on `ServiceState` only.

**Evaluation lag** (alerts service): time between when an evaluation *should* happen and when it
completes.
- bar-close evaluation: `completedAt − closeEventTime`, where the close event is bar end plus the configured close grace (`closeGraceS`, default 60 s for the clock rule) — otherwise a healthy close would always read ≥ 60 s;
- poll evaluation: `completedAt − scheduledNextPollAt`; if the schedule is older than one poll interval (live feed was up, schedule not advanced), the due time is `now`; failed/not-ready polls are not observed;
- seed on attach: not observed (startup backlog would skew it).
Clamp negatives to 0. Implementer confirms the exact hook points in `series.ts` (scout pointed at
~773-780 seed, ~1036 poll, bar close via tracker `onClock` ~1032) and at `service.ts:209`
(`enqueueFire`), `fires.ts` (retry / drop paths), `service.ts:251` (status post failure),
`series.ts:730` (`onScriptFault`). Counters live in one small `metrics.ts` module owned by the
service instance (not module globals, for test isolation) and are read by `stats()` / heartbeat.

## 7. Deploy artefacts

- `deploy/grafana/tickerglass.json`: Grafana dashboard (schemaVersion ≥ 39), datasource as input
  `${DS_PROMETHEUS}`, `__inputs` block so "Import" asks for it. Rows: Overview (up, version, HTTP
  rate/5xx, p95 latency), Provider (requests by outcome, refusals, budget remaining), Cache (hit
  rate per cache), Alerts (service up, evaluations/s, fires/s chart vs screener, lag p50/p95
  from histogram, queue depth, script faults), Notifications (deliveries by outcome/channel,
  outbox pending, oldest pending age), Screener (snapshot age with threshold), Backups (time since
  last success, last status).
- `deploy/prometheus/prometheus.example.yml`: scrape job with `authorization: credentials_file`
  and an alert rules file `deploy/prometheus/tickerglass.rules.yml` with a few sane alerts:
  alerts service down 5 m, screener snapshot older than 36 h, no backup success in 2 d (only if
  enabled), notification failures rising, provider breaker open 15 m.
- Helm: `metrics.enabled`, `metrics.token` / `metrics.existingSecret`, optional
  `metrics.serviceMonitor.enabled` (template guarded by `.Capabilities.APIVersions.Has
  "monitoring.coreos.com/v1"`); liveness → `/api/health/live`, readiness → `/api/health/ready`.
- Dockerfiles / compose / AIO HEALTHCHECK: switch to `/api/health/ready` (API) — AIO keeps checking
  through nginx on 8080.
- `deploy/check.py`: validate dashboard JSON parses, every `expr` metric name used in the dashboard
  and rules file appears in the catalogue list exported by the API test (or a static list in the
  doc) — keeps dashboard and code from drifting.
- Unraid/CasaOS/TrueNAS/Umbrel templates: add `METRICS_ENABLED` / `METRICS_TOKEN` as optional,
  hidden/advanced variables. No ports added.

## 8. Docs

- `docs/metrics.md` user guide: enabling, token, scraping through nginx vs API port, Grafana
  import, metric table (generated from §4), multi-worker note, privacy note (no per-user labels).
- README env table and `.env.example`: three new vars.

## 9. Tests

- API: `/metrics` 404 when disabled; 401 without/with wrong token; 200 with token; session cookie
  and `X-Alerts-Token` don't grant access; startup refuses enabled+auth+no-token+not-public;
  short token refused; output parses with `prometheus_client.parser`; contains catalogue names;
  no label value equals a known user id / symbol / alert id from fixtures (privacy regression);
  heartbeat with valid `metrics` shows histogram; invalid `metrics` accepted but dropped; metrics
  absent when service offline; DB section failure increments collect errors and still 200;
  `/api/health/live` and `/ready` (503 when DB broken); dispatcher counters on sent/retry/failed;
  provider outcome counters with fake transport; HTTP middleware uses route template label.
- Alerts service: counters increment on eval, failure, fire queued, retry, drop, status failure,
  script fault; lag histogram cumulative counts correct for bar-close and poll; heartbeat payload
  includes `metrics`; counters are per instance.
- deploy/check.py runs in CI (existing workflow).

## 10. Deviations accepted in review

Differences between this design and the implementation that review accepted:

- The `route` label comes from FastAPI's `effective_route_context`, with a fallback to the matched
  route template and then `unmatched`.
- WebSocket requests are counted on accept or refusal, with status class `1xx` (accepted) or `4xx`
  (refused); handlers that raise before accepting are not counted.
- Provider request counters are process-wide, not per provider instance.
- `disable_created_metrics` is process-wide, not per registry.
- `tickerglass_alerts_active` kinds are `price`, `indicator`, `drawing`, `other`; script alerts are
  counted under `indicator` or `other`.
- The oldest pending notification age is computed from `alert_log.fired_at`, not the outbox row.
- A set `METRICS_TOKEN` is required even when `METRICS_PUBLIC` is true.
- If the API answers a heartbeat with 422 (an older API that rejects `metrics`), the alerts service
  falls back to heartbeats without `metrics`. Upgrade the API first.
- Helm gets a `startupProbe` on `/api/health/live` (`api.startupProbe.failureThreshold`, default 60 at
  10 s), and the ServiceMonitor refuses to render alongside an `api.env.METRICS_TOKEN`.

## 11. Out of scope

OpenTelemetry/OTLP push, per-user metrics, tracing, alertmanager config, a metrics UI in the app
(the existing server status panel already covers humans), Postgres-specific DB metrics.
