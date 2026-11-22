# Design: app-store templates and all-in-one image (roadmap 2.3)

Install TickerGlass from Unraid Community Apps, TrueNAS, CasaOS, Umbrel, or Kubernetes (Helm).
Everything lives in `deploy/` and CI checks it against `docker-compose.yml`. YunoHost is deferred
(native packaging, separate repo) — roadmap gets a new later item for it.

## Two shapes

| Target                | Shape                                                 | Why                                                                        |
| --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Unraid, CasaOS        | **all-in-one** image `ghcr.io/yavuzakbay/tickerglass` | these UIs are built around one container + one appdata folder              |
| Umbrel, TrueNAS, Helm | the existing three images (`-api`, `-web`, `-alerts`) | multi-container is native there; per-service memory limits matter (alerts) |

## Shared nginx template (one source of truth)

`docker/nginx.conf` becomes `docker/nginx.conf.template`; the two `proxy_pass http://api:8000`
become `proxy_pass http://${TG_API_UPSTREAM};`. Everything else (the `$tg_forwarded_proto` map,
sandbox-worker CSP, `/ws`) unchanged.

- The template is included in the `http` context in both images, so the `map $http_x_forwarded_proto
$tg_forwarded_proto` sits at its top level (an outer TLS proxy's `X-Forwarded-Proto` is passed on,
  else `$scheme`; `/api/` and `/ws` use `$tg_forwarded_proto`).
- Web image: copy to `/etc/nginx/templates/default.conf.template`, `ENV TG_API_UPSTREAM=api:8000
NGINX_ENVSUBST_FILTER=^TG_`. The official nginx entrypoint would otherwise substitute _every_
  env var of the container (`-e host=EVIL` rewrote `$host`); the filter limits it to `TG_*`. Helm
  sets `TG_API_UPSTREAM=<release>-api:8000`.
- AIO: entrypoint renders it with `envsubst '${TG_API_UPSTREAM} ${TG_LISTEN_PORT}'` (gettext-base;
  an explicit list, so `$http_x_forwarded_proto`, `$tg_forwarded_proto`, `$scheme`, `$host` survive).
  Add `listen ${TG_LISTEN_PORT};` (web image default `80`, AIO `8080`).

## All-in-one image (`docker/aio.Dockerfile`)

- Stages reuse the existing builds: python venv from the api build (uv sync), web `dist`, alerts
  `/deploy` (from `docker/node.Dockerfile` stages via `--target` / shared stage names, or duplicate
  minimal stages — implementer's call, no logic duplication beyond COPY).
- Runtime base: `python:3.11-slim-<debian>` + Node 24 binary copied from `node:24-slim` of the
  **same Debian release** (isolated-vm prebuilt needs matching glibc); `apt-get install nginx
gettext-base tini` (no recommends). Pin both bases to the same codename tag.
- PID 1: `tini` → `/usr/local/bin/tickerglass-aio` (POSIX sh):
  1. `PUID`/`PGID` (default `1000`/`1000`; Unraid template sets `99`/`100`): no user is created;
     `chown -h` `/data` (only if the top owner differs; `find -xdev`, so links in the volume are
     never followed), drop privileges per process with `setpriv --reuid --regid --clear-groups
--no-new-privs`. `PUID=0` is refused unless `ALLOW_ROOT=true` (then a warning is logged).
     Children run with cwd `/app` (root-owned: the API's settings read `./.env` from the cwd).
     `TRUSTED_PROXIES` defaults to `127.0.0.1` (nginx is the API's only peer; the API binds
     loopback).
  2. `ALERTS_INTERNAL_TOKEN`: if unset, read `/data/.alerts_token` or create it (32 random bytes
     as hex, mode 0600) and export it to API and alerts. `/data` is writable by `PUID`, so root
     never opens the file: it is read and created by a `setpriv`-ed shell (create is `O_EXCL`),
     and a symlink or non-regular file at that path stops the container with an error.
  3. Render nginx config (upstream `127.0.0.1:8000`, listen `8080`, pid/temp paths under `/tmp` so
     nginx runs unprivileged).
  4. Start API (`tickerglass-api`, API_HOST=127.0.0.1), wait for `/api/health` (timeout 60 s), start
     alerts (`API_URL=http://127.0.0.1:8000`, `node --no-node-snapshot dist/index.js`), start nginx
     in foreground mode.
  5. If any child exits, stop the others and exit non-zero (Docker restart policy restarts the
     container). Forward SIGTERM to all; exit cleanly.
- `EXPOSE 8080`, `VOLUME /data`, `ENV DATABASE_URL=sqlite:////data/tickerglass.db`,
  `HEALTHCHECK` via `python -c urlopen('http://127.0.0.1:8080/api/health')` (exercises nginx + API).
- All API/alert env vars work unchanged (same names as compose). Alerts memory caps: defaults as in
  compose; docs recommend ≥1.5 GB container memory.

## Templates (`deploy/`)

- `deploy/unraid/tickerglass.xml` — CA template for the AIO image. WebUI `http://[IP]:[PORT:8080]/`,
  port 8080, path `/data` → `/mnt/user/appdata/tickerglass`, `PUID=99`, `PGID=100`, `TZ`.
  Shown fields: `AUTH_PASSWORD` (masked), `MARKET_PROVIDER`, `TWELVEDATA_API_KEY` (masked),
  `PUBLIC_URL`. Advanced (`Display="advanced"`): notification channels, OIDC basics. Icon:
  raw GitHub URL of `apps/web/public/icons/icon-512.png`. Overview, Category (`Tools: Productivity:`
  or the CA finance-ish equivalent), Support/Project URLs → GitHub.
- `deploy/casaos/docker-compose.yml` — AIO + `x-casaos` metadata (title, tagline, icon, port_map,
  envs/volumes descriptions), data under `/DATA/AppData/tickerglass`.
- `deploy/truenas/docker-compose.yaml` — three-image compose ready for **Apps → Discover → Install
  via YAML**, host paths documented as `ixVolume`-free bind mounts the user edits. (Official catalog
  submission is a follow-up, not this item.)
- `deploy/umbrel/tickerglass/` — `umbrel-app.yml` + `docker-compose.yml` (three images +
  `app_proxy` with `APP_HOST: tickerglass_web_1`, `APP_PORT: 80`), data in `${APP_DATA_DIR}`,
  `AUTH_SECRET` and `ALERTS_INTERNAL_TOKEN` each derived on its own in `exports.sh`
  (`derive_entropy "${app_entropy_identifier}-auth-secret"` / `-alerts-token`; 64 hex characters;
  never `${APP_SEED}` plus a prefix, which would make one computable from the other) and
  referenced in the compose file as `${APP_TICKERGLASS_AUTH_SECRET}` / `${APP_TICKERGLASS_ALERTS_TOKEN}`.
  `umbrel-app.yml` has an `icon:` (raw GitHub URL of the 512 px icon). Umbrel's proxy auth stays on.
  A community-store layout (`umbrel-app-store.yml` at `deploy/umbrel/`) so users can add the repo as
  a community app store.
- `deploy/helm/tickerglass/` — chart (apiVersion v2): api Deployment (1 replica, `strategy: Recreate`,
  PVC RWO for `/data`, readiness/liveness on `/api/health`), web Deployment (TG_API_UPSTREAM),
  alerts Deployment (memory limit 1280Mi), Services, optional Ingress (`/` → web), Secret holding the
  alerts token (+ AUTH_SECRET) generated once and preserved via `lookup`, `existingSecret` support,
  `env` / `extraEnv` maps per component, `image.tag` defaulting to `.Chart.AppVersion`, optional
  external `DATABASE_URL` (no bundled Postgres). `NOTES.txt` with the URL. Also: `api.trustedProxies`
  → `TRUSTED_PROXIES` (pod network CIDR; default empty, NOTES hints at it); the `AUTH_SECRET`
  `secretKeyRef` is `optional: true` (an `existingSecret` may lack the key); the PVC and the generated
  Secret carry `helm.sh/resource-policy: keep` (`keepResources`, default `true`); all pods set
  `enableServiceLinks: false`.

## Alerts token rules (API)

`ALERTS_INTERNAL_TOKEN`, when set, must be at least 32 characters and must not contain `CHANGE-ME`
(case-insensitive; the TrueNAS file ships that placeholder): the API refuses to start otherwise.
The alerts service sends it as `X-Alerts-Token` on the `/ws` handshake as well (Node's built-in
WebSocket takes `{ headers }`), no longer as a query parameter. The API still accepts `?auth_token=`
for older services but masks it in uvicorn's logs (`logredact.py`, installed at app creation).

## CI (`.github/workflows/deploy.yml`, separate from ci.yml)

1. `deploy/check.py` (stdlib + PyYAML via `uv run --with pyyaml`):
   - every env var name used in any template exists in `docker-compose.yml` (api or alerts service),
     or in an allow-list of AIO-only vars (`PUID`, `PGID`, `TZ`, `TG_*`);
   - image names match the release matrix; ports and `/data` paths consistent;
   - Unraid XML parses and has the required CA fields; Umbrel/CasaOS/TrueNAS YAML parses;
   - Chart `appVersion` == `VERSION`.
2. `helm lint` + `helm template` (azure/setup-helm).
3. Build the AIO image (no push, amd64 only) and smoke it: run with a temp volume, wait for healthy,
   `GET /api/health`, then `GET /api/server/status` (open mode = owner admin) until the alerts
   heartbeat shows the service connected (≤90 s). Also run with `PUID=99 PGID=100`. The smoke
   script also plants a symlink at `/data/.alerts_token` (target in another volume): the
   container must exit non-zero and the target stay unchanged; and `docker stop` must exit 0
   within 15 s.
4. The workflow also runs on changes to `api/**`, `apps/**`, `services/**`, `packages/**` and the
   pnpm lockfile/workspace files (the AIO image is built from them), and `shellcheck` over the
   shell scripts.

## Release

`release.yml` matrix gains `tickerglass` (AIO, `docker/aio.Dockerfile`, amd64+arm64). Fix the
version stamp: pass the metadata-action `version` output (no `v` prefix) as `TICKERGLASS_VERSION`
(`apps/web/src/api/updates.ts` expects bare semver). Chart `appVersion`/`version` bumped from
`VERSION` by the release process (document in CONTRIBUTING / release notes; no auto-publish of the
chart in this item — users install from the repo path or a packaged `.tgz` attached to the release
if trivial).

## Docs

`docs/self-hosting.md` "Install" gains "Option C: app stores" with one short subsection per platform
(Unraid, TrueNAS, CasaOS, Umbrel, Kubernetes/Helm) + the AIO image (env, PUID/PGID, token file,
memory). README install section mentions them. Roadmap: 2.3 → `done`, add YunoHost as a new later
item.
