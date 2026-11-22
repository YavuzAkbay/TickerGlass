# deploy/

Templates for installing TickerGlass from app stores and Kubernetes. User-facing instructions are
in [docs/self-hosting.md](../docs/self-hosting.md) (Option C: app stores); design in
[docs/design/app-store-templates.md](../docs/design/app-store-templates.md).

| Path                          | Platform                                | Image shape               |
| ----------------------------- | --------------------------------------- | ------------------------- |
| `unraid/tickerglass.xml`      | Unraid Community Applications           | all-in-one `tickerglass`  |
| `casaos/docker-compose.yml`   | CasaOS                                  | all-in-one `tickerglass`  |
| `truenas/docker-compose.yaml` | TrueNAS SCALE 24.10+ (Install via YAML) | `-api`, `-web`, `-alerts` |
| `umbrel/`                     | Umbrel community app store              | `-api`, `-web`, `-alerts` |
| `helm/tickerglass/`           | Kubernetes (Helm 3)                     | `-api`, `-web`, `-alerts` |

## Checks

```sh
uv run --with pyyaml python deploy/check.py   # templates vs docker-compose.yml, release.yml, VERSION
helm lint deploy/helm/tickerglass && helm template t deploy/helm/tickerglass >/dev/null
docker build -f docker/aio.Dockerfile -t tickerglass:smoke . && deploy/smoke-aio.sh tickerglass:smoke
deploy/smoke-aio.sh tickerglass:smoke 99 100   # the Unraid user
```

`.github/workflows/deploy.yml` runs all of it.

## Releasing

When `VERSION` changes, bump together: `helm/tickerglass/Chart.yaml` (`version` and `appVersion`),
`umbrel/tickerglass-store-tickerglass/umbrel-app.yml` (`version`) and the three image tags in
`umbrel/tickerglass-store-tickerglass/docker-compose.yml`. `check.py` fails until they all match.
The other templates track `latest` and need no edit.

## Keeping environment variables in sync

Every variable a template sets must exist in `docker-compose.yml` (or be `PUID`, `PGID`, `TZ`,
`TG_*`). Adding a setting to the app means adding it to `docker-compose.yml` first; add it to a
template only if it deserves a field there.

## Metrics

Optional Prometheus metrics ([docs/metrics.md](../docs/metrics.md), design in
[docs/design/metrics.md](../docs/design/metrics.md)); off by default, no ports added.

| Path                                  | What                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `grafana/tickerglass.json`            | Grafana dashboard (Import asks for the Prometheus data source)               |
| `prometheus/prometheus.example.yml`   | Scrape job with the Bearer token read from a file, and `rule_files`          |
| `prometheus/tickerglass.rules.yml`    | Starter alert rules                                                          |
| `metrics_catalogue.txt`               | Metric names from the design note; `check.py` checks the dashboard and rules against it |

- Every template accepts `METRICS_ENABLED` / `METRICS_TOKEN` (advanced, optional). Compose also has
  `METRICS_PUBLIC`.
- Helm: `metrics.enabled`, `metrics.token` / `metrics.existingSecret` (key `METRICS_TOKEN`; empty =
  generated once), and `metrics.serviceMonitor.enabled` (rendered only when the cluster has the
  `monitoring.coreos.com/v1` API; test it with `helm template --api-versions monitoring.coreos.com/v1`).
  The API pod's liveness probe is `/api/health/live` and its readiness probe `/api/health/ready`.
- Docker `HEALTHCHECK`s (all-in-one image, Compose, TrueNAS, Umbrel) call `/api/health/ready`.
- Adding a metric: add it to `docs/design/metrics.md`, `metrics_catalogue.txt` and `docs/metrics.md`
  (`check.py` fails when the catalogue and the guide disagree), then to the dashboard if it deserves a
  panel.
