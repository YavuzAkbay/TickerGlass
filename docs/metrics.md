# Metrics and health checks

TickerGlass can expose Prometheus metrics, so you can graph provider budget, cache hit rate, alerts,
notifications, the screener and backups, and get notified when something stops working. Metrics are
off by default. Nothing is sent anywhere: Prometheus pulls them from your server.

The design notes are in [design/metrics.md](design/metrics.md).

## Turn it on

Set these in `.env` (or the environment of the `api` container, or the all-in-one image):

| Variable          | Default | Meaning                                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED` | `false` | Serve `/metrics`. While `false` the path answers 404.                                         |
| `METRICS_TOKEN`   | unset   | Require `Authorization: Bearer <token>`. At least 16 characters, e.g. `openssl rand -hex 32`. |
| `METRICS_PUBLIC`  | `false` | Allow `/metrics` without a token even when sign-in is on.                                     |

Rules:

- With a token set, `/metrics` answers 401 (with `WWW-Authenticate: Bearer`) to a missing or wrong
  token. A sign-in session cookie and `X-Alerts-Token` do **not** open it: scrape credentials are kept
  separate from user and service credentials.
- If sign-in is on (password, single sign-on or a trusted proxy header), `METRICS_ENABLED=true`
  needs `METRICS_TOKEN`, or `METRICS_PUBLIC=true` to say that you want it open. Without one of them
  the API refuses to start and says why.
- If sign-in is off, the whole app is already open, so a token-less `/metrics` is allowed.
- A token shorter than 16 characters is refused at startup.

Restart the stack after changing them.

## Where to scrape

`/metrics` is served by the API at the root (not under `/api`). The bundled nginx forwards it, so you
can scrape either:

- the **web port** (`8080` in Docker Compose and the all-in-one image, the web Service in Kubernetes).
  The all-in-one image only publishes this port, so use it there;
- the **API port** (`8000`, bound to `127.0.0.1` by default in Compose, the API Service in Kubernetes).

If you publish the web port to the internet through a reverse proxy, keep a token set, or block
`/metrics` at the proxy (`location = /metrics { return 404; }`) and scrape from inside your network.

Quick check:

```sh
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:8080/metrics | head
```

## Prometheus

[`deploy/prometheus/prometheus.example.yml`](../deploy/prometheus/prometheus.example.yml) is a scrape job
with the token read from a file (`authorization.credentials_file`), and
[`deploy/prometheus/tickerglass.rules.yml`](../deploy/prometheus/tickerglass.rules.yml) holds starter alert
rules:

| Alert                              | Fires when                                                          |
| ---------------------------------- | ------------------------------------------------------------------- |
| `TickerGlassDown`                  | Prometheus cannot scrape the server for 5 minutes                   |
| `TickerGlassAlertsServiceDown`     | the alerts service has not sent a heartbeat for 5 minutes           |
| `TickerGlassScreenerSnapshotStale` | the screener snapshot is older than 36 hours                        |
| `TickerGlassBackupMissing`         | backups are enabled and the last success is older than 2 days       |
| `TickerGlassBackupNeverSucceeded`  | backups are enabled and none has ever succeeded for 2 days          |
| `TickerGlassNotificationFailures`  | a notification delivery was given up on in the last 30 minutes      |
| `TickerGlassNotificationBacklog`   | the oldest pending notification is older than 15 minutes            |
| `TickerGlassProviderBreakerOpen`   | a market data provider circuit breaker has been open for 15 minutes |
| `TickerGlassHighErrorRate`         | more than 5 percent of requests fail with a 5xx                     |

Routing (Alertmanager) is up to you; TickerGlass ships no Alertmanager configuration.

## Grafana

Import [`deploy/grafana/tickerglass.json`](../deploy/grafana/tickerglass.json) (Dashboards, New, Import,
upload the file). Grafana asks for the Prometheus data source. The dashboard has rows for the overview
(scrape status, version, request rate, 5xx ratio, p95 latency), the market data provider (requests by
outcome, refusals, remaining budget, circuit breaker), cache hit rate, alerts (service state,
evaluations, fires by source, evaluation lag p50/p95, queue depth, script faults), notifications
(deliveries by outcome and channel, outbox, oldest pending age), the screener (snapshot age) and backups
(time since the last success, last status). Its queries expect the scrape job to be named `tickerglass`
(only the first stat panel uses `up{job="tickerglass"}`).

## Docker Compose, Kubernetes and NAS templates

- **Compose**: `METRICS_ENABLED`, `METRICS_TOKEN` and `METRICS_PUBLIC` are passed through from `.env`.
  No port is added.
- **Helm**: `metrics.enabled=true` turns it on. The token is `metrics.token`, or a Secret of yours in
  `metrics.existingSecret` (key `METRICS_TOKEN`); with neither, the chart generates one and keeps it
  across upgrades. `metrics.serviceMonitor.enabled=true` adds a Prometheus Operator `ServiceMonitor`
  for the API Service when the cluster has the `monitoring.coreos.com/v1` API. The ServiceMonitor
  authenticates with the chart-generated Secret or `metrics.existingSecret`, so it cannot be combined
  with a `METRICS_TOKEN` in `api.env` (the chart refuses to render and says so): put the token in a
  Secret and set `metrics.existingSecret`. The API pod also has a `startupProbe`
  (`/api/health/live` every 10 s); `api.startupProbe.failureThreshold` (default `60`, that is 10
  minutes) is how long startup may take, which matters for migrations and restoring a large staged
  backup. Liveness and readiness only begin once it passes. See
  [`deploy/README.md`](../deploy/README.md).
- **Unraid, CasaOS, TrueNAS, Umbrel**: optional advanced variables `METRICS_ENABLED` and `METRICS_TOKEN`.

## Health checks

| Endpoint            | Meaning                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health`       | `{status, version}`; unchanged                                                                                                                                                     |
| `/api/health/live`  | `200` while the process serves requests. No database access. Used as the Kubernetes liveness probe                                                                                 |
| `/api/health/ready` | `200` when the database answers and startup (including a staged backup restore) finished, else `503`. Used by the Docker `HEALTHCHECK`, Compose and the Kubernetes readiness probe |

All three are public. The `503` body only names the checks, `startup` (startup and any staged backup
restore finished) and `db` (the database answers), each `ok` or `fail`
(`{"status":"unavailable","checks":{"startup":"ok","db":"fail"}}`), never an error message. The alerts service being offline does not make the API unready: that is a
metric and an alert, not a reason to restart the API.

## Metric reference

Prefix `tickerglass_`. `*_total` are counters, `*_seconds` are seconds, `*_timestamp_seconds` are Unix
time. Labels only ever take values from small fixed sets (below).

### Process and HTTP

| Metric                                      | Type      | Labels                      | Meaning                                                             |
| ------------------------------------------- | --------- | --------------------------- | ------------------------------------------------------------------- |
| `tickerglass_build_info`                    | gauge     | `version`                   | Always 1; the running version                                       |
| `tickerglass_http_requests_total`           | counter   | `method`, `route`, `status` | Requests; `route` is the route template, `status` is `2xx` to `5xx` |
| `tickerglass_http_request_duration_seconds` | histogram | `method`, `route`           | Request latency                                                     |

`route` is the matched template such as `/api/alerts/{alert_id}`, `websocket` for WebSocket connects
(no duration) and `unmatched` otherwise. A WebSocket is counted when the server accepts or refuses the
connection, with a status class of `1xx` (accepted) or `4xx` (refused); a handler that raises before
accepting is not counted. The standard `process_*` and
`python_*` metrics are included.

### Market data provider

| Metric                                  | Type    | Labels                | Meaning                                                                      |
| --------------------------------------- | ------- | --------------------- | ---------------------------------------------------------------------------- |
| `tickerglass_provider_requests_total`   | counter | `provider`, `outcome` | Upstream attempts; `outcome` is `ok`, `rate_limited`, `unavailable`, `error` |
| `tickerglass_provider_refused_total`    | counter | `provider`, `reason`  | Requests refused locally (budget or circuit breaker) before going upstream   |
| `tickerglass_provider_budget_remaining` | gauge   | `provider`, `window`  | Requests or credits left in the rate window                                  |
| `tickerglass_provider_budget_limit`     | gauge   | `provider`, `window`  | The window's limit                                                           |
| `tickerglass_provider_breaker_open`     | gauge   | `provider`            | 1 while the circuit breaker is open                                          |

A provider without a request guard emits no budget series. Requests are counted per upstream attempt,
retries included. The Yahoo provider sends batch calls (many symbols in one request): a batch counts as
one request per attempt, however many symbols it carries.

### Cache

| Metric                             | Type    | Labels            | Meaning                                                              |
| ---------------------------------- | ------- | ----------------- | -------------------------------------------------------------------- |
| `tickerglass_cache_requests_total` | counter | `cache`, `result` | Lookups; `result` is `hit` or `miss`. Compute the hit rate in PromQL |

### Alerts

| Metric                                                        | Type    | Labels   | Meaning                                                                                                                  |
| ------------------------------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tickerglass_alerts_fired_total`                              | counter | `source` | Alerts fired, `chart` (chart and script alerts) or `screener`                                                            |
| `tickerglass_alerts_active`                                   | gauge   | `kind`   | Enabled alerts by kind: `price`, `indicator`, `drawing`, `other`. Script alerts are counted under `indicator` or `other` |
| `tickerglass_alerts_service_up`                               | gauge   |          | 1 while the alerts service heartbeat is younger than 90 seconds                                                          |
| `tickerglass_alerts_service_last_heartbeat_timestamp_seconds` | gauge   |          | Time of the last heartbeat                                                                                               |
| `tickerglass_alerts_service_start_timestamp_seconds`          | gauge   |          | When the alerts service started                                                                                          |
| `tickerglass_alerts_series`                                   | gauge   |          | Series being evaluated                                                                                                   |
| `tickerglass_alerts_live_symbols`                             | gauge   |          | Symbols with a live feed                                                                                                 |
| `tickerglass_alerts_polled_series`                            | gauge   |          | Series evaluated by polling                                                                                              |
| `tickerglass_alerts_waiting`                                  | gauge   |          | Series waiting for data or a free slot                                                                                   |

These come from the alerts service heartbeat and are only exported **while the service is up**, so a
stale value does not sit on a dashboard after it stops:

| Metric                                          | Type      | Meaning                                                                  |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `tickerglass_alerts_evaluations_total`          | counter   | Evaluation passes (bar close, poll)                                      |
| `tickerglass_alerts_evaluation_failures_total`  | counter   | Evaluations that failed                                                  |
| `tickerglass_alerts_fires_queued_total`         | counter   | Fires queued for delivery to the API                                     |
| `tickerglass_alerts_fire_retries_total`         | counter   | Delivery attempts that failed and will be retried                        |
| `tickerglass_alerts_fires_dropped_total`        | counter   | Fires dropped (the API rejected them, for example the alert was deleted) |
| `tickerglass_alerts_fire_queue_depth`           | gauge     | Fires waiting to be delivered                                            |
| `tickerglass_alerts_status_post_failures_total` | counter   | Failed status reports to the API                                         |
| `tickerglass_alerts_script_faults_total`        | counter   | User script faults                                                       |
| `tickerglass_alerts_evaluation_lag_seconds`     | histogram | Time between when an evaluation was due and when it finished             |

These counters live in the alerts service and **reset when it restarts**; use `rate()` or `increase()`,
which handle resets. The lag is a histogram, so use `histogram_quantile` on the `_bucket` series:

```promql
histogram_quantile(0.95, sum by (le) (rate(tickerglass_alerts_evaluation_lag_seconds_bucket[5m])))
```

Bar-close evaluations are measured from the end of the bar, poll evaluations from the scheduled poll
time; the first evaluation after attaching a series is not counted in the lag histogram.

Some details that matter when you compare numbers:

- `tickerglass_alerts_evaluations_total` counts every evaluation pass, so attaching an alert counts
  twice: the seed evaluation and the immediate sample that follows it.
- A poll that closes a bar records two lag observations, one for the bar close and one for the poll.

### Notifications

| Metric                                                 | Type    | Labels               | Meaning                                                                                                                                |
| ------------------------------------------------------ | ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tickerglass_notifications_deliveries_total`           | counter | `channel`, `outcome` | `channel` is the kind (`webhook`, `ntfy`, `gotify`, `apprise`, ..., else `other`); `outcome` is `sent`, `retry` or `failed` (given up) |
| `tickerglass_notifications_outbox`                     | gauge   | `status`             | Outbox rows, `pending` or `failed`                                                                                                     |
| `tickerglass_notifications_oldest_pending_age_seconds` | gauge   |                      | Age of the oldest pending row; 0 when none                                                                                             |

### Screener

| Metric                                            | Type  | Labels           | Meaning                                                               |
| ------------------------------------------------- | ----- | ---------------- | --------------------------------------------------------------------- |
| `tickerglass_screener_snapshot_age_seconds`       | gauge |                  | Age of the newest snapshot; absent while there is none                |
| `tickerglass_screener_snapshot_rows`              | gauge |                  | Snapshot rows                                                         |
| `tickerglass_screener_last_run_timestamp_seconds` | gauge | `kind`, `status` | When the latest run of each kind finished (or started, if unfinished) |
| `tickerglass_screener_enabled`                    | gauge |                  | 1 when the screener is enabled                                        |

### Backups

| Metric                                              | Type  | Labels   | Meaning                                                             |
| --------------------------------------------------- | ----- | -------- | ------------------------------------------------------------------- |
| `tickerglass_backup_last_success_timestamp_seconds` | gauge |          | Last successful backup; absent if there never was one               |
| `tickerglass_backup_last_run_status`                | gauge | `status` | 1 for the latest run's status: `ok`, `partial`, `failed`, `running` |
| `tickerglass_backup_last_size_bytes`                | gauge |          | Size of the latest backup run that finished `ok` or `partial`       |
| `tickerglass_backup_enabled`                        | gauge |          | 1 when a backup schedule is configured                              |

### Collector health

| Metric                                     | Type    | Labels    | Meaning                                                                                                                                        |
| ------------------------------------------ | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tickerglass_metrics_collect_errors_total` | counter | `section` | A section (`provider`, `cache`, `alerts`, `notifications`, `screener`, `backups`) failed to collect and was skipped; the scrape still succeeds |

Values read from the database are cached for 15 seconds, so scraping more often than that costs nothing
extra.

## Upgrading

Upgrade the API before, or together with, the alerts service. The alerts service sends its metrics in
the heartbeat; an older API does not know that field and rejects it. A newer alerts service copes: when
the API rejects a heartbeat, it falls back to heartbeats without metrics, so the service still shows as
up, but its alert series stay empty until the API is upgraded.

## Privacy

No label ever carries a user, symbol, alert, screen or note identifier, a URL, a raw request path or an
error message. Everything is an aggregate over the whole server, even with several users, so someone
who can read `/metrics` learns totals, not who did what.

## Limits

- One API worker. The API runs a single uvicorn worker; running it with more workers is unsupported
  for metrics (each worker would report its own partial counters).
- The alerts service has no port of its own. It reports through its heartbeat to the API, which is why
  its series appear only while it is up.
- No OpenTelemetry/OTLP export, per-user metrics or tracing.

The dashboard and the rules are checked against the metric list in
[`deploy/metrics_catalogue.txt`](../deploy/metrics_catalogue.txt) by `deploy/check.py`.
