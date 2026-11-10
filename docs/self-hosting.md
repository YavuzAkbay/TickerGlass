# Self-hosting guide

Everything about running TickerGlass on your own machine or server: installing,
updating, backing up, protecting, and exposing it. For provider configuration see
[providers.md](providers.md), for alert delivery [alerts.md](alerts.md).

## Install

Requirements: Docker Engine with the Compose plugin.

### Option A: prebuilt images (recommended)

No repository clone, no build: the compose file pulls the published multi-arch
images (amd64 and arm64 — works on Raspberry Pi, NAS devices and Apple silicon).

```sh
mkdir tickerglass && cd tickerglass
curl -O https://raw.githubusercontent.com/yavuzakbay/TickerGlass/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/yavuzakbay/TickerGlass/main/.env.example
mv .env.example .env
docker compose pull
docker compose up -d
```

Open <http://localhost:8080>. The API health endpoint is
<http://localhost:8000/api/health> and reports the running version.

### Option B: build from source

```sh
git clone https://github.com/yavuzakbay/TickerGlass.git
cd TickerGlass
cp .env.example .env
docker compose up -d --build
```

Building uses the checkout as-is; the images carry the version from the `VERSION`
file. Both options share the same compose file (it declares both `image:` and
`build:`), so you can switch at any time.

### Ports and storage

`WEB_PORT` (default 8080) serves the app, `API_PORT` (default 8000) the API. Both
bind to `127.0.0.1` by default — nothing is reachable from other machines until
you deliberately change the binding or put a proxy in front. Data lives in the
`api-data` volume (SQLite at `/data/tickerglass.db`). PostgreSQL is available via
the `postgres` profile — see `.env.example`.

## Update

With prebuilt images:

```sh
docker compose pull
docker compose up -d
```

Pin a version by setting `TICKERGLASS_TAG` in `.env` (e.g. `v0.2.0`); the default
`latest` tracks the newest release. When building from source, `git pull` and
`docker compose up -d --build`. User data survives updates (it is in the volume);
the running version shows in **Settings → Server**, next to a manual
**Check for updates** (the app never phones home on its own).

## Back up and restore

### From the app

**Settings → Server → Download backup** saves a consistent SQLite snapshot
(`tickerglass-backup-<date>.db`). It contains everything: watchlists, layouts,
drawings, notes, templates, user scripts, settings, alerts, and the cached bars.

To restore: stop the stack, replace the volume's database file, start it again:

```sh
docker compose down
docker run --rm -v tickerglass_api-data:/data -v "$PWD":/backup alpine \
  cp /backup/tickerglass-backup-20260101-120000.db /data/tickerglass.db
docker compose up -d
```

(Volume names are prefixed with the compose project name — check with
`docker volume ls`. With the Postgres profile, back up with `pg_dump` instead.)

### From the shell

```sh
docker run --rm -v tickerglass_api-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tickerglass-data.tar.gz -C /data .
```

## Password protection

By default the app is open — safe on `127.0.0.1`, but anyone who can reach the
port can use it and switch the data source. Before exposing it (LAN, Tailscale,
a reverse proxy), set a password in `.env` and restart:

```dotenv
AUTH_PASSWORD=choose-a-long-password
ALERTS_INTERNAL_TOKEN=any-long-random-string
```

- `AUTH_PASSWORD` turns on a login screen; every API route and the live socket
  require a signed session cookie (30 days, then sign in again). Without it,
  nothing changes.
- `ALERTS_INTERNAL_TOKEN` lets the alerts container keep reaching the API when
  auth is on — always set both together. It also authenticates the service's
  write routes on its own, as before.
- Sessions survive restarts on SQLite (a signing secret is stored next to the
  database). With PostgreSQL, set `AUTH_SECRET` to a long random string,
  otherwise a restart signs everyone out.
- Five failed sign-ins lock the source address out for a minute.
- `/api/health` stays open so the container healthcheck works; it only reports
  `{"status":"ok","version":"…"}`.

Log out via **Settings → Server → Log out**.

## Exposing it safely

The defaults assume localhost. To reach TickerGlass from other devices, pick one:

**Tailscale (easiest, recommended).** Install Tailscale on the server and your
devices; nothing is exposed to the public internet. Change the port bindings in
`docker-compose.yml` from `127.0.0.1:` to the tailnet address or `0.0.0.0:`,
set `AUTH_PASSWORD`, and use `https://<machine>.<tailnet>.ts.net` via
`tailscale serve`:

```sh
tailscale serve --bg https+http://localhost:8080
```

**Reverse proxy with HTTPS** (Caddy example; nginx and Traefik work the same —
proxy `/` to the web port, keep `/api/` and `/ws` on the same origin):

```caddyfile
charts.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy provisions certificates automatically. nginx needs `proxy_set_header
Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` on `/ws` and a
1h read timeout. Always set `AUTH_PASSWORD` before exposing the app beyond
localhost, keep the API port (8000) unexposed, and use HTTPS — the session
cookie is marked `Secure` when the request arrives over it.

## Resource requirements

The stack runs comfortably in 512 MB RAM (SQLite, default provider). The bar
cache grows with usage and is pruned automatically (see
[caching.md](caching.md)); `Settings → Server` shows the current database size.
ARM64 images make Raspberry Pi 4/5 and NAS containers first-class.

## Troubleshooting

- **Login screen appears unexpectedly** — `AUTH_PASSWORD` is set and the browser
  has no session. Sign in; to disable auth entirely, unset `AUTH_PASSWORD` and
  restart.
- **Alerts show offline (Settings → Server)** — the `alerts` container cannot
  reach the API. If `AUTH_PASSWORD` is set, `ALERTS_INTERNAL_TOKEN` must be too,
  and both containers must share the same value (`docker compose up -d` again
  after changing `.env`).
- **Forgot the password** — remove `AUTH_PASSWORD` from `.env`, restart, then
  set a new one. Sessions are signed with a secret derived from the setup, so
  changing the password invalidates old sessions.
- **Check versions** — `Settings → Server` shows the API version and the alerts
  service version; `GET /api/health` and `docker compose ps` also help.
