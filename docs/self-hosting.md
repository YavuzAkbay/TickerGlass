# Self-hosting guide

Everything about running TickerGlass on your own machine or server: installing,
updating, backing up, protecting, and exposing it. For provider configuration see
[providers.md](providers.md), for alert delivery [alerts.md](alerts.md), for Prometheus
metrics, Grafana, and health probes [metrics.md](metrics.md).

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

### Option C: app stores

For NAS and home-server platforms there are ready-made templates in
[`deploy/`](../deploy). Two shapes exist: platforms built around one container and
one appdata folder (Unraid, CasaOS) use the **all-in-one image**; the others
(TrueNAS, Umbrel, Kubernetes) run the same three images as Option A.

#### All-in-one image

`ghcr.io/yavuzakbay/tickerglass` runs the API, the alerts service and the web server in
a single container (amd64 and arm64, same tags as the other images). Use it when a
platform wants one container; with Docker Compose, Option A is still the better fit
(per-service restarts and memory limits).

```sh
docker run -d --name tickerglass --restart unless-stopped \
  -p 8080:8080 -v tickerglass-data:/data \
  -e AUTH_PASSWORD=change-me \
  ghcr.io/yavuzakbay/tickerglass:latest
```

Open <http://localhost:8080>. Notes:

- **Port and data.** The web UI and the API (under `/api`) share port `8080`; there is no
  separate API port. Everything persistent lives in `/data` (SQLite database, session
  secret, alerts token).
- **Settings.** All environment variables of the `api` and `alerts` services in
  [`docker-compose.yml`](../docker-compose.yml) work unchanged (see
  [`.env.example`](../.env.example)). The internal wiring (`API_HOST`, `API_PORT`,
  `API_URL`) is fixed by the image.
- **`PUID` / `PGID`.** The processes run as an unprivileged user with these numeric ids
  (default `1000`/`1000`; Unraid uses `99`/`100`). On start the container takes ownership of
  `/data` if it belongs to someone else, so a host folder needs no manual `chown`.
- **Alerts token.** The API and the alerts service authenticate to each other with
  `ALERTS_INTERNAL_TOKEN`. If you do not set it, the container generates one on first start
  and keeps it in `/data/.alerts_token` (mode `0600`); nothing to configure, also with
  `AUTH_PASSWORD` or SSO enabled.
- **Client addresses and HTTPS.** Inside the container nginx is the API's only peer, so
  `TRUSTED_PROXIES` defaults to `127.0.0.1` there (per-client sign-in lockout). Set
  `PUBLIC_URL=https://…` when you publish it over HTTPS: that is the reliable way to get
  `Secure` cookies. An outer TLS-terminating proxy's `X-Forwarded-Proto` also works: the
  bundled nginx passes it on and the API trusts it from nginx (see
  [Client addresses and HTTPS](#client-addresses-and-https-behind-a-proxy)).
- **`ALLOW_ROOT`.** `PUID=0` is refused: the processes would run as root. Set
  `ALLOW_ROOT=true` to allow it anyway (the container logs a warning).
- **Memory.** Give the container at least 1.5 GB: the alerts service reserves headroom for
  user-script isolates (`ALERTS_SCRIPT_PROCESS_MB`, default 768).
- **Supervision.** If any of the three processes exits the container stops with a non-zero
  code and your restart policy brings it back. `docker stop` shuts everything down
  cleanly.
- **Update.** `docker pull ghcr.io/yavuzakbay/tickerglass:latest` and recreate the
  container (or pin a version tag such as `0.2.0`; image tags have no `v` prefix).

#### Unraid

<!-- deploy:unraid -->

Community Applications template for the all-in-one image
([`deploy/unraid/tickerglass.xml`](../deploy/unraid/tickerglass.xml)). Until TickerGlass is
listed in the CA catalog, add the template by hand from the Unraid terminal:

```sh
wget -O /boot/config/plugins/dockerMan/templates-user/tickerglass.xml \
  https://raw.githubusercontent.com/YavuzAkbay/TickerGlass/main/deploy/unraid/tickerglass.xml
```

Then **Docker -> Add Container**, choose **TickerGlass** under "User templates" and press Apply.
The template maps port `8080`, stores data in `/mnt/user/appdata/tickerglass`, runs as `99`/`100`
(nobody/users) and limits the container to 1.5 GB. The password, data provider, Twelve Data key and
public URL are on the main page; notification channels (Telegram, ntfy, Gotify, Apprise, webhook,
SMTP host) and single sign-on are under "Show more settings". Set a password before exposing the
port beyond your LAN. Update with the usual **Check for updates**.

#### TrueNAS

<!-- deploy:truenas -->

For TrueNAS SCALE 24.10 (Electric Eel) and later, which runs apps with Docker Compose. A ready
file with the three images is in
[`deploy/truenas/docker-compose.yaml`](../deploy/truenas/docker-compose.yaml); it is not in the
official app catalog yet.

1. Create a dataset for the database, for example `tank/apps/tickerglass`.
2. Copy the file, replace `/mnt/tank/apps/tickerglass` with that dataset's path and both
   `CHANGE-ME-long-random-string` values with the same random string (`openssl rand -hex 32`).
3. **Apps -> Discover Apps -> (three dots) -> Install via YAML**, name it `tickerglass`, paste, save.

The app is on `http://<truenas-ip>:30080` (change the published port in the file if it is taken).
Add `AUTH_PASSWORD` and the notification variables to the `api` service's `environment`; the
alerts service keeps the 1280 MB memory cap from `docker-compose.yml`. Update by changing the
image tags (or re-pulling `latest`) and saving the app again.

#### CasaOS

<!-- deploy:casaos -->

All-in-one image with CasaOS metadata
([`deploy/casaos/docker-compose.yml`](../deploy/casaos/docker-compose.yml)). In CasaOS open
**App Store -> Custom Install -> Import**, paste the file's contents and install. The form shows
the port (`8080`), the data folder (`/DATA/AppData/tickerglass/data`) and the settings
(`MARKET_PROVIDER`, `TWELVEDATA_API_KEY`, `AUTH_PASSWORD`, `PUBLIC_URL`, ...) with their
descriptions; any other variable from `docker-compose.yml` can be added there. The file is also
usable as an app in a CasaOS third-party store. It runs as `1000`/`1000`; change `PUID` / `PGID`
if your files belong to someone else.

#### Umbrel

<!-- deploy:umbrel -->

A community app store in [`deploy/umbrel/`](../deploy/umbrel/): `umbrel-app-store.yml` plus the
app folder `tickerglass-store-tickerglass/` (`umbrel-app.yml`, `docker-compose.yml`, `exports.sh`). It runs the
three images behind Umbrel's app proxy, so Umbrel's own login protects TickerGlass; the alerts
token and the session secret are derived from the Umbrel seed independently of each other
(`exports.sh`, Umbrel's `derive_entropy`, 64 hex characters each). Umbrel reads a store from the root of a
repository, so publish the contents of `deploy/umbrel/` as its own Git repository (or a fork
with those files at the root), then **App Store -> (three dots) -> Community App Stores** and add
its URL. Install "TickerGlass" from that store. Data is kept in the app's data folder, so
Umbrel backups include it. `AUTH_PASSWORD` is not needed; it would add a second login behind
Umbrel's.

#### Kubernetes (Helm)

<!-- deploy:helm -->

Chart in [`deploy/helm/tickerglass/`](../deploy/helm/tickerglass/) (Helm 3, Kubernetes 1.25+): API
(one replica, `Recreate`, a 2 Gi ReadWriteOnce volume for `/data`), web and alerts Deployments,
Services, an optional Ingress and a Secret with the alerts token and session secret, generated
on first install and kept across upgrades.

```sh
git clone https://github.com/YavuzAkbay/TickerGlass.git && cd TickerGlass
kubectl create namespace tickerglass
kubectl -n tickerglass create secret generic tickerglass-auth \
  --from-literal=password="$(openssl rand -base64 18)"
helm install tickerglass deploy/helm/tickerglass -n tickerglass \
  --set ingress.enabled=true --set 'ingress.hosts[0].host=tickerglass.example.com' \
  --set publicUrl=https://tickerglass.example.com \
  --set api.trustedProxies=10.42.0.0/16 \
  --set api.extraEnv.AUTH_PASSWORD.secretKeyRef.name=tickerglass-auth \
  --set api.extraEnv.AUTH_PASSWORD.secretKeyRef.key=password
```

The password comes from a Kubernetes Secret (`valueFrom.secretKeyRef`), so it is not in the
Helm release values. `api.trustedProxies` is your pod network CIDR (`kubectl get pods -o wide`
shows the range; `10.42.0.0/16` is the k3s default): the API then reads the client address and
`X-Forwarded-Proto` from the web pod. Left empty (the default) every client looks like the web
pod; keep `publicUrl` at `https://…` for `Secure` cookies either way. The data volume and the
generated Secret are kept on `helm uninstall` (`keepResources: true`, `helm.sh/resource-policy:
keep`); delete them with `kubectl` when you want everything gone.

Images default to the chart's `appVersion` (`--set image.tag=...` to override). Settings are
environment maps per component: `api.env` / `api.extraEnv` take any API variable from
`docker-compose.yml` (a value may be a `valueFrom` object such as `{ secretKeyRef: { name, key } }`
for secrets), `alerts.env` the `ALERTS_*` tuning. Use `existingSecret` (keys
`ALERTS_INTERNAL_TOKEN`, `AUTH_SECRET`) to bring your own secret, which is also required with
tools that cannot `lookup` (Argo CD, `helm template`). For PostgreSQL set
`api.env.DATABASE_URL`; no database is bundled. The alerts pod is limited to 1280 Mi; keep it
above `ALERTS_SCRIPT_PROCESS_MB` plus about 300 MB. Upgrade with `helm upgrade` after pulling the
repository; there is no chart repository yet.

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

Two layers: **scheduled backups** (set once, the server does the rest) and the one-click
**Download backup**. Both cover the whole database, every user's data included, and need an
admin. They are for SQLite; with the Postgres profile use `pg_dump` (below). Per-user exports
(**Settings → Data**) are separate and stay as they are.

### Scheduled backups

Set a target in `.env` and restart; a backup runs every night (default 03:30 UTC, change it with
`BACKUP_AT` / `BACKUP_TZ`). **Settings → Server → Backups** shows the schedule, the last runs, the
backups on every target, and has **Run now** and **Test targets**.

Each backup is an online copy of the database (consistent, taken while the server runs), gzipped,
named `tickerglass-<UTC timestamp>.db.gz` (`.enc` when encrypted) with a small `.json` next to it.
The market-data cache is left out by default (it is refetched after a restore, and is most of the
file); `BACKUP_INCLUDE_CACHE=true` keeps it. A backup that does not pass SQLite's integrity check
is never written. After a start with no successful backup in the last 26 hours (a missed night, a
new install) one runs five minutes later.

**Local folder.** Mount a host folder, ideally on another disk, and point `BACKUP_DIR` at it:

```yaml
# docker-compose.yml (api service): uncomment the volume, and set in .env: BACKUP_DIR=/backups
- ./backups:/backups
```

The status shows a warning when the folder is on the same disk as the database: that protects
against a bad upgrade or a deleted watchlist, not against losing the disk.

**S3-compatible storage.** Set all four of `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`,
`BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY`; `BACKUP_S3_PREFIX` (default
`tickerglass/`), `BACKUP_S3_REGION` (default `us-east-1`) and `BACKUP_S3_PATH_STYLE` (default
`true`) are optional. The key needs list, put, get and delete on that prefix. Examples:

```dotenv
# MinIO / Garage on your network (path-style addressing, any region)
BACKUP_S3_ENDPOINT=http://minio:9000
BACKUP_S3_BUCKET=tickerglass

# Backblaze B2 (S3 API; use the region from your bucket's endpoint)
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
BACKUP_S3_REGION=us-west-004

# Cloudflare R2 (region "auto")
BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
BACKUP_S3_REGION=auto

# AWS S3 (virtual-host addressing)
BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
BACKUP_S3_REGION=eu-central-1
BACKUP_S3_PATH_STYLE=false
```

Both targets can be set; each gets the same file, and one failing does not stop the other (the
run is then marked **partial**). Errors show the S3 error code (`AccessDenied`, `NoSuchBucket`),
never keys. Files over 5 GiB are refused (single upload).

**Secrets in the configuration** (`BACKUP_PASSPHRASE`, `BACKUP_S3_SECRET_ACCESS_KEY`, and the other
passwords/tokens) are never shown in a startup configuration error or in the settings dump.

**Encryption.** `BACKUP_PASSPHRASE` (12 or more characters) encrypts every backup with AES-256-GCM
(key from the passphrase with scrypt). **If you lose the passphrase the encrypted backups cannot
be read, by anyone, ever.** Keep it somewhere other than this server (a password manager).
Changing it only affects new backups; restoring an old one needs the passphrase it was made with.

**Retention.** Per target, over **this server's** backup files only: the latest backup of each of
the newest `BACKUP_KEEP_DAILY` (7) days, `BACKUP_KEEP_WEEKLY` (4) ISO weeks and
`BACKUP_KEEP_MONTHLY` (6) months is kept (UTC days; manual runs count like scheduled ones); older
ones are removed after a successful write. The backup just made, and the newest one, are never
removed; a failed run removes nothing.

Each server stamps a random id (kept in its database) into the `.json` of every backup it writes,
and retention only deletes backups whose `.json` carries that id. Other files, backups without a
`.json` (or from before this was added) and backups of **another server** are never touched, and
do not count towards what is kept. **Use one prefix or folder per server**; two servers sharing
one only means each prunes its own. A restored server keeps the id of the backup, so it goes on
managing the same series. Delete backups that predate the id by hand.

### Restore

A restore never overwrites the live database. It is staged, checked, and swapped in when the
server **starts**.

- **From the app (admin).** **Settings → Server → Backups**: pick a backup and _Restore_, or
  _Restore from file…_ to upload a `.db.gz`, `.db.gz.enc` or a plain `.db` (the Download backup
  file) and, for an encrypted file, enter the passphrase (it is not stored). The backup is
  validated and a banner says _Restart the server to finish the restore_. _Cancel_ discards it.
  Restart with `docker restart <container>` (or `docker compose restart api`). Checks: an intact
  SQLite file; a schema revision this version knows (any older one is fine, including backups and
  Download-backup files from before multi-user; a backup from a **newer** TickerGlass is refused);
  the `users` table, from the multi-user schema on; and nothing but plain tables and plain-column
  indexes: a file with triggers, views, virtual tables, generated columns, or expression/partial
  indexes is refused (TickerGlass never writes those, and they would let a crafted file run SQL
  inside the server). `BACKUP_RESTORE_MAX_MB` (8192) caps what is fetched and unpacked, and the
  data folder needs about that much free space while staging (the check says how much).
- **At the restart.** The staged file is checked again; the current database is moved to
  `pre-restore-<timestamp>.db` in the data folder (the last two are kept, so a restore can be
  undone by moving it back), the backup becomes the database, and the normal migrations bring an
  older backup up to date (a pre-multi-user backup gets its Owner account and every row under it).
  If the check fails the database is left as it was and the reason is shown in the Backups
  section. If the **migrations** fail on the restored file, the previous database is put back
  automatically (with its `-wal`/`-shm`), the Backups section says so, and the server does not
  start; fix the cause (or cancel the restore) and restart. A second process on the same data
  folder is never touched: the restore and the clean-up of `backups-tmp/` happen only for the
  process that holds the folder's lock; any other one logs an error, starts without them and
  leaves the restore staged.
- **From the shell** (same settings as the server):

  ```sh
  docker compose exec api tickerglass-api backup run                       # a backup now
  docker compose exec api tickerglass-api backup list
  docker compose exec api tickerglass-api backup restore /backups/tickerglass-20261113T033000Z.db.gz
  docker compose exec api tickerglass-api backup restore s3://tickerglass-20261113T033000Z.db.gz.enc
  tickerglass-api backup decrypt in.db.gz.enc out.db.gz      # needs only the passphrase, no server
  ```

  `restore` stages the backup; restart the server to apply it. `--apply-now` swaps it in at once
  but only when no server is running on that data folder (it refuses otherwise, and wherever it
  cannot tell). `decrypt` writes the `.db.gz` (`gunzip` it for the SQLite file).

- **By hand** (no TickerGlass needed): `gunzip` the file (after `decrypt` if it is encrypted),
  stop the stack, and replace the volume's database file:

  ```sh
  docker compose down
  docker run --rm -v tickerglass_api-data:/data -v "$PWD":/backup alpine \
    cp /backup/tickerglass-backup.db /data/tickerglass.db
  docker compose up -d
  ```

  (Volume names are prefixed with the compose project name; check with `docker volume ls`.
  Move the old `tickerglass.db-wal` / `-shm` files out of the way too.)

Sign-ins survive a restore only if `AUTH_SECRET` (or the generated `.session_secret` in the data
folder) is the same: the session secret lives outside the database. Otherwise sign in again. The
cached market data (not in the backup by default) refills on its own.

### Download backup and the shell

**Settings → Server → Download backup** saves an uncompressed consistent snapshot
(`tickerglass-backup-<date>.db`) including the cached bars; it restores like any other backup
(upload it, or the by-hand steps above). From the shell:

```sh
docker run --rm -v tickerglass_api-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/tickerglass-data.tar.gz -C /data .
```

### Postgres

Scheduled backups and restore are not available (the status says so); use `pg_dump`, e.g. a
sidecar that dumps nightly into a mounted folder (prune old dumps yourself or with a cron job):

```yaml
pg-backup:
  image: postgres:17-alpine
  profiles: [postgres]
  depends_on: [postgres]
  restart: unless-stopped
  environment:
    PGHOST: postgres
    PGUSER: tickerglass
    PGPASSWORD: ${POSTGRES_PASSWORD}
    PGDATABASE: tickerglass
  volumes:
    - ./pg-backups:/dump
  entrypoint:
    - sh
    - -c
    - 'while true; do pg_dump -Fc -f /dump/tickerglass-$$(date +%Y%m%d).dump; sleep 86400; done'
```

Restore with `pg_restore --clean --no-owner -d tickerglass <file>`. Match the user, password and
database name to your `postgres` service.

## Password protection

By default the app is open — safe on `127.0.0.1`, but anyone who can reach the
port can use it and switch the data source. Before exposing it (LAN, Tailscale,
a reverse proxy), set a password in `.env` and restart:

```dotenv
AUTH_PASSWORD=choose-a-long-password
ALERTS_INTERNAL_TOKEN=<output of: openssl rand -hex 32>
```

- `AUTH_PASSWORD` turns on a login screen; every API route and the live socket
  require a signed session cookie (30 days by default, `AUTH_SESSION_DAYS`
  changes it; then sign in again). Without it, nothing changes.
- `ALERTS_INTERNAL_TOKEN` lets the alerts container keep reaching the API when
  auth is on — always set both together. With auth on it is the **only** way to
  act as the alerts service (firing alerts, setting their status, writing their
  state): an admin's session cannot, and without the token no request can, so the
  API logs a warning at startup and the alerts container is refused. Without
  any auth (open mode) no token is needed.
- Sessions survive restarts on SQLite (a signing secret is stored next to the
  database). With PostgreSQL, set `AUTH_SECRET` to a long random string,
  otherwise a restart signs everyone out.
- Five failed sign-ins lock the source address out for a minute, and five failed
  sign-ins for one username from one address lock that pair. Behind a reverse
  proxy, set `TRUSTED_PROXIES` (below) so the lockout applies to the real client
  address instead of the proxy. There is deliberately **no** lockout per username
  alone: it would let anyone on the internet lock `admin` (or any user) out by
  failing logins on purpose. The trade-off: guessing one password from many
  addresses is not stopped by a lockout. It is bounded by the per-address limits
  and by the cost of every password check (scrypt, about 0.1 s of CPU each);
  use long passwords, and put the site behind a VPN or an SSO proxy if that
  matters to you.
- `/api/health` stays open so the container healthcheck works; it only reports
  `{"status":"ok","version":"…"}`.

Log out via **Settings → Server → Log out**.

> **Upgrading from an older version?** Session cookies changed format (they no
> longer contain a hash of the password), so everyone signs in once more after the
> update.

Password sign-in, single sign-on and the proxy header can be enabled together;
auth is on as soon as any one of them is configured. Remember to set
`ALERTS_INTERNAL_TOKEN` whichever method you use.

## Single sign-on (OIDC)

TickerGlass can sign users in through any OpenID Connect provider (Authentik,
Authelia, Keycloak, Pocket ID, Zitadel, …) using the authorization-code flow with
PKCE. The login screen then shows a **Sign in with …** button, next to the
password form if `AUTH_PASSWORD` is also set.

```dotenv
PUBLIC_URL=https://charts.example.com
OIDC_ISSUER=https://auth.example.com/application/o/tickerglass/
OIDC_CLIENT_ID=tickerglass
OIDC_CLIENT_SECRET=the-client-secret
OIDC_PROVIDER_NAME=Authentik
AUTH_ALLOWED_GROUPS=tickerglass-users
ALERTS_INTERNAL_TOKEN=<output of: openssl rand -hex 32>
```

In the provider, create a client / application with:

- **Redirect URI** `PUBLIC_URL/api/auth/oidc/callback`, for example
  `https://charts.example.com/api/auth/oidc/callback`. `PUBLIC_URL` is the address
  users type in the browser; it is never derived from the request's `Host`
  header, and it must be set whenever OIDC is on (the API refuses to start
  otherwise). An `https://` value also marks the session cookies `Secure`.
- **Scopes** `openid profile email groups` (the default, `OIDC_SCOPES`). Drop
  `groups` if your provider does not know it.
- **Client type** confidential with a secret (`client_secret_basic`, the default;
  set `OIDC_TOKEN_AUTH=client_secret_post` if the provider wants the secret in
  the body), or public with PKCE only (leave `OIDC_CLIENT_SECRET` empty).
- A **groups claim** if you use `AUTH_ALLOWED_GROUPS`. The claim name is
  `groups` unless you change `OIDC_GROUPS_CLAIM`. If the id_token has no groups
  (or no email / username), TickerGlass reads them from the provider's userinfo
  endpoint; the `sub` there must match the id_token's.

`OIDC_ISSUER` is the provider's issuer URL exactly as it appears in its discovery
document (`<issuer>/.well-known/openid-configuration`); a trailing slash does not
matter. The provider only needs to be reachable when someone signs in, so
TickerGlass starts fine while it is down. Endpoints must be `https://`; for an
identity provider on your LAN without TLS, set `OIDC_ALLOW_HTTP=true`.

Provider notes:

| Provider  | Issuer URL                                       | Notes                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentik | `https://auth.example.com/application/o/<slug>/` | Create an _OAuth2/OpenID Provider_ + _Application_. The default scope mappings include `groups`. Note the trailing slash and the application slug.                                                                            |
| Authelia  | `https://auth.example.com`                       | Add the client under `identity_providers.oidc.clients` with `redirect_uris`, `scopes: [openid, profile, email, groups]`, and a _hashed_ `client_secret`. Authelia puts email and groups in userinfo, which TickerGlass reads. |
| Keycloak  | `https://kc.example.com/realms/<realm>`          | Client with _Client authentication_ on and the standard flow only. Add a _Group Membership_ mapper (token claim name `groups`, _Full group path_ off) to the client's dedicated scope.                                        |
| Pocket ID | `https://id.example.com`                         | Create an _OIDC client_ with the callback URL above; user groups are returned in the `groups` claim.                                                                                                                          |

### Who may sign in

There is no open default: with OIDC on, the API **refuses to start** unless you say who
may sign in. Set an allow-list (either or both of the two below, or an admin list, see
[Users](#users): admins are implicitly allowed), or set `AUTH_ALLOW_ANY_USER=true` to let
**every account your identity provider accepts** sign in (the API logs a warning at startup
when you do).

- `AUTH_ALLOWED_USERS` — comma list matched (case-insensitively) against the
  `sub`, the `preferred_username` and the email address. An email only counts
  when the provider marks it verified (`email_verified`). **Warning:**
  `preferred_username` can be edited by the user at some identity providers, so a
  user could rename themselves into the list. Prefer the `sub`, a verified email
  or `AUTH_ALLOWED_GROUPS` (managed by the provider's admins).
- `AUTH_ALLOWED_GROUPS` — comma list; the user must be in at least one (exact
  match). Groups are checked when signing in.

When both are set, both must match. A user on `AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS` is
allowed regardless; with only admin lists set, everyone else is denied. Each person gets
their own account and data (see [Users](#users)).

Sessions last `AUTH_SESSION_DAYS` (30). They end sooner if OIDC is turned off or
`OIDC_ISSUER` / `OIDC_CLIENT_ID` change. **Sign out** clears the TickerGlass
session and, when the provider advertises an end-session endpoint, sends the
browser there too (`AUTH_LOGOUT_URL` is the fallback).

**Revoking access.** A session is a signed cookie; TickerGlass does not ask the
provider again until it expires. So:

- Changing `AUTH_ALLOWED_USERS`, `AUTH_ALLOWED_GROUPS`, `AUTH_ADMIN_USERS`,
  `AUTH_ADMIN_GROUPS` or `AUTH_ALLOW_ANY_USER` ends every OIDC session;
  everyone signs in again and is checked against the new lists.
- Rotating `AUTH_SECRET` (or deleting the stored secret next to the database) ends
  all sessions, of every method.
- Disabling or deleting a user at the identity provider only takes effect at their
  next sign-in, up to `AUTH_SESSION_DAYS` later. If that is too slow for you, lower
  `AUTH_SESSION_DAYS` (for example `1` or `7`) or rotate `AUTH_SECRET` when someone
  leaves.

If sign-in fails, the login screen shows a short message; the API log has the
detail (never tokens or secrets), under the logger `tickerglass.auth`.

## Behind an auth proxy

Alternatively let a proxy in front of TickerGlass do the authentication — Authelia
or Authentik forward-auth with Traefik or Caddy, Cloudflare Access, oauth2-proxy —
and have it pass the signed-in user's name in a header. TickerGlass then trusts
that header **only** for requests that came through the proxy you name.

```dotenv
AUTH_TRUSTED_HEADER=Remote-User
AUTH_HEADER_PROXIES=172.30.0.5        # the authenticating proxy, exactly
TRUSTED_PROXIES=172.30.0.0/24         # plain forwarders in between (e.g. the web container)
# Optional extras (empty = not read), used for display and AUTH_ALLOWED_*.
# Only set the ones your proxy overwrites on EVERY request (see below):
# AUTH_TRUSTED_EMAIL_HEADER=Remote-Email
# AUTH_TRUSTED_NAME_HEADER=Remote-Name
# AUTH_TRUSTED_GROUPS_HEADER=Remote-Groups     # comma or | separated
AUTH_ALLOWED_GROUPS=tickerglass-users
ALERTS_INTERNAL_TOKEN=<output of: openssl rand -hex 32>
```

No cookie is set in this mode: the header is checked on every request, including
the live websocket. `AUTH_HEADER_PROXIES` is required with `AUTH_TRUSTED_HEADER`.

Like OIDC, header mode needs an allow-list to start: `AUTH_ALLOWED_USERS`,
`AUTH_ALLOWED_GROUPS`, an admin list (admins are implicitly allowed), or
`AUTH_ALLOW_ANY_USER=true` to accept every user the proxy authenticates.

**Every header you configure MUST be set (overwritten) by the proxy on every
request.** Only `AUTH_TRUSTED_HEADER` turns the mode on; the email, name and
groups headers are read only when you name them, and there are no defaults.
A forward-auth proxy overwrites just the headers it is told to copy, so a header
it does not copy passes through from the client untouched, and a client could
send `Remote-Groups: tickerglass-users` itself to get past `AUTH_ALLOWED_GROUPS`.
Configure an extra header here only when the proxy's copy list (Traefik's
`authResponseHeaders`, Caddy's `copy_headers`) includes exactly that header, and
that the proxy sets it on every request (an empty value is fine, absence is not).

**Two lists, two jobs.** TickerGlass looks at the chain of addresses a request
travelled through (the `X-Forwarded-For` header plus the TCP peer) and walks it
from the right:

- `AUTH_HEADER_PROXIES` is the proxy that authenticates users and sets the
  identity headers (the Traefik / Caddy / Authentik outpost host). Reaching one
  of these accepts the header.
- `TRUSTED_PROXIES` is for plain forwarders that only relay traffic, such as the
  bundled `web` (nginx) container. They are skipped while walking, and are also
  trusted for the real client address (used by the sign-in rate limit) and for
  `X-Forwarded-Proto`.
- Any other address ends the walk and the header is ignored. So someone who
  reaches the bundled nginx directly and sends `Remote-User: admin` is refused:
  nginx records _their_ address in `X-Forwarded-For`, which is in neither list.

The API does this walk itself, so uvicorn's own proxy-header rewriting is turned
off in `tickerglass-api` (the Docker image's entry point). If you start the API
with the `uvicorn` command instead, pass `--no-proxy-headers`. Otherwise uvicorn
replaces the peer address with the forwarded one and a proxy on `127.0.0.1` is
never recognised.

With the stock compose file the path is _proxy → `web` (nginx) → `api`_, so list
the `web` container in `TRUSTED_PROXIES` and the proxy in `AUTH_HEADER_PROXIES`.
Give both fixed addresses so they survive restarts:

```yaml
# docker-compose.override.yml (sketch)
networks:
  default:
    ipam:
      config:
        - subnet: 172.30.0.0/24
services:
  traefik:
    networks:
      default:
        ipv4_address: 172.30.0.5
```

> **Warning: list the proxy's exact address, not a whole Docker range.** With
> Docker's port publishing, requests from the outside can reach a container with
> the bridge _gateway_ as their source address. If `AUTH_HEADER_PROXIES` covers
> that gateway (for example `172.17.0.0/16`), anyone who can reach the published
> port can send `Remote-User` and be signed in. Use single addresses for
> `AUTH_HEADER_PROXIES`, and never publish the web or API port to the network
> when you use this mode — only the proxy should be reachable.
>
> The proxy must also **overwrite** any identity headers the client sends, for
> every header you configure (see above). Authelia and Authentik's forward-auth
> replace a header with their verified value only if it is in the copy list
> (Traefik's `authResponseHeaders` / Caddy's `copy_headers`). If your proxy does
> not, strip the header first.

Authelia sends `Remote-User`, `Remote-Groups` (comma-separated), `Remote-Email`
and `Remote-Name`:

```dotenv
AUTH_TRUSTED_HEADER=Remote-User
AUTH_TRUSTED_GROUPS_HEADER=Remote-Groups
AUTH_TRUSTED_EMAIL_HEADER=Remote-Email
AUTH_TRUSTED_NAME_HEADER=Remote-Name
```

Traefik with Authelia forward-auth, as labels on the `web` service:

```yaml
labels:
  - traefik.http.routers.tg.rule=Host(`charts.example.com`)
  - traefik.http.routers.tg.middlewares=authelia@docker
  - traefik.http.middlewares.authelia.forwardauth.address=http://authelia:9091/api/authz/forward-auth
  - traefik.http.middlewares.authelia.forwardauth.authResponseHeaders=Remote-User,Remote-Groups,Remote-Email,Remote-Name
```

Caddy with Authelia:

```caddyfile
charts.example.com {
    forward_auth authelia:9091 {
        uri /api/authz/forward-auth
        copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
    }
    reverse_proxy web:80
}
```

Authentik's proxy outpost works the same way with its own header names. Authentik
separates groups with `|` (pipe), which TickerGlass accepts alongside commas:

```dotenv
AUTH_TRUSTED_HEADER=X-authentik-username
AUTH_TRUSTED_EMAIL_HEADER=X-authentik-email
AUTH_TRUSTED_NAME_HEADER=X-authentik-name
AUTH_TRUSTED_GROUPS_HEADER=X-authentik-groups
```

Add those four headers to the copy list (`authResponseHeaders` / `copy_headers`)
too; the outpost's forward-auth endpoint returns them.

Header sessions end when the proxy's session ends. **Sign out** is hidden unless
`AUTH_LOGOUT_URL` is set (for example Authelia's `https://auth.example.com/logout`);
then it clears nothing in TickerGlass and sends the browser there.

### Client addresses and HTTPS behind a proxy

`TRUSTED_PROXIES` fixes two things behind a reverse proxy (including the bundled
nginx): the failed-sign-in lockout is counted per real client instead of locking
everybody out together, and `X-Forwarded-Proto: https` from those proxies marks the
cookie `Secure`. `X-Forwarded-Proto` from any other source is ignored.

**For `Secure` cookies, set `PUBLIC_URL=https://…`.** It is the reliable way: its
scheme always wins and nothing depends on the proxy chain. Relying on
`X-Forwarded-Proto` alone only works if `TRUSTED_PROXIES` covers _every_ hop that
connects to the API. With the bundled `web` (nginx) container that means the nginx
container's address, and, when Docker's userland proxy publishes the port, the
bridge gateway address as well, since the connection the API sees comes from
whichever hop is closest. If one is missing the header is ignored and the cookie
is not `Secure`. (The bundled nginx passes through an `X-Forwarded-Proto` sent by
an outer TLS-terminating proxy and only falls back to `http` when there is none.)

## Users

TickerGlass can serve several people from one install. Every user has their own
layouts, drawings, notes, watchlists, alerts, screens, scripts, templates, settings,
flags and portfolios; nobody sees or changes another user's. Market data and its
cache are shared. Nothing to turn on: users exist as soon as a sign-in method does.
With no sign-in method (open mode) everyone is the one **Owner** user, as before.

**Roles.** An _admin_ can also change server-wide things: the market data provider,
clearing the cache, downloading the database backup, running the screener manually,
editing shared screener lists, and managing users. A _user_ cannot (the API refuses
it, the buttons are hidden). Users see the version, provider name and sign-in
methods on the server status page; admins see everything.

**The Owner account and upgrading.** The upgrade creates one admin user named
_Owner_ and gives it all existing data. Session cookies changed again, so everyone
signs in once more after the update. Sign in as the Owner and your data is there:

- With `AUTH_PASSWORD`: leave the username empty (or type `admin`) and use that
  password. That is the Owner.
- With single sign-on or proxy-header mode only (no `AUTH_PASSWORD`): the first
  identity that signs in becomes the Owner account and inherits the data, but only if
  `AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS` match it, or if neither list is set. If
  you set an admin list, the person on it claims the data; everyone else gets a new,
  empty account. A claim is logged at WARNING (`linked to the owner account`).
  Without admin lists, an SSO identity does not claim the Owner while `AUTH_PASSWORD`
  is set (the password is the way in); with them, the matching identity can.

**Local accounts** (when `AUTH_PASSWORD` is set). An admin creates users in
**Settings → Users** with a username, display name, role and a password of at
least 10 characters. They sign in with that username and password. Users change their
own name and password under **Settings → Account**; admins can reset anyone's password
(this signs that user out everywhere). Disabling a user ends their sessions at
once; deleting a user deletes all of their data. The last enabled admin, and yourself,
cannot be deleted, demoted or disabled. Failed sign-ins are rate limited per address
and per (address, username) pair; changing your own password limits failed guesses per
signed-in user. Resetting or changing a password, disabling, deleting or changing the role
of a user also closes that user's open live connections.

**SSO and proxy users** are created on first sign-in (after the allow check passes:
`AUTH_ALLOW_ANY_USER`, `AUTH_ALLOWED_*` or an admin match) as plain users. SSO / proxy mode
does not start without an allow-list or `AUTH_ALLOW_ANY_USER=true`; admins are implicitly
allowed, and with only admin lists set, everyone else is denied:

```dotenv
AUTH_ADMIN_USERS=alice@example.com      # admins: the OIDC `sub` or a verified email (header mode: the username)
AUTH_ADMIN_GROUPS=tickerglass-admins    # ... or members of these groups
AUTH_AUTO_PROVISION=true                # false: only accounts an admin created may sign in
```

A match with the admin lists promotes at sign-in and never demotes; demote in the UI.
For OIDC, `AUTH_ADMIN_USERS` matches only the `sub` or a verified email, never the
`preferred_username` (editable at some providers); header mode matches the username the
proxy asserts. In header mode a username (or email) that is not in Unicode NFKC form
(look-alikes such as the Kelvin sign or full-width letters) or has non-printable characters is
refused, so it cannot be merged into another user's account; names compare case-insensitively.
With `AUTH_AUTO_PROVISION=false`, an unknown OIDC / header identity is refused
(`oidc_denied` / 401).

**Alerts and notifications.** Alerts, screens and their log belong to their creator and
only they get the live events and the in-app toasts. Notification channels
(webhook, Telegram, email, ntfy, Gotify, Apprise) are configured in `.env` and are
shared by all users.

**Export and import** are per user: _Export_ contains only your data, and _Import_
adds to or replaces only yours. A file exported by someone else imports fine: ids that
are taken get new ones (an alert follows its drawing). The exception is indicator
scripts: layouts and alerts refer to them by id, so a file whose script id belongs to
another user is refused with `409 id in use`. The database **backup** is admin-only
and contains everyone's data.

API (all under `/api`): `GET /auth/state` (`user.id`, `role`, `isOwner`,
`canManageUsers`, `localAccounts`), `GET`/`PATCH /me`, `PUT /me/password`, and for
admins `GET`/`POST /users`, `PATCH`/`DELETE /users/{id}`, `PUT /users/{id}/password`.
Responses never contain password hashes. The alerts service keeps using
`ALERTS_INTERNAL_TOKEN`; it is the only caller that reads other users' drawings and
scripts (each record carries its `ownerId`).

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
1h read timeout. Always set a sign-in method (`AUTH_PASSWORD`, [single sign-on](#single-sign-on-oidc)
or an [auth proxy](#behind-an-auth-proxy)) before exposing the app beyond
localhost, keep the API port (8000) unexposed, and use HTTPS — the session
cookie is marked `Secure` when `PUBLIC_URL` is `https://`; set it. (Without it
the cookie is `Secure` only if every hop to the API is listed in `TRUSTED_PROXIES`
and the outermost proxy reports `X-Forwarded-Proto: https`, see
[Client addresses and HTTPS](#client-addresses-and-https-behind-a-proxy).)

## Resource requirements

The stack runs comfortably in 512 MB RAM (SQLite, default provider). The bar
cache grows with usage and is pruned automatically (see
[caching.md](caching.md)); `Settings → Server` shows the current database size.
ARM64 images make Raspberry Pi 4/5 and NAS containers first-class.

## Troubleshooting

- **Login screen appears unexpectedly** — a sign-in method (`AUTH_PASSWORD`,
  `OIDC_ISSUER`, or `AUTH_TRUSTED_HEADER`) is set and the browser has no session.
  Sign in; to disable auth entirely, unset them all and restart. After upgrading
  from an older version everybody signs in once more.
- **SSO says "not allowed" or "unavailable"** — check the `tickerglass.auth` log
  lines of the `api` container: `AUTH_ALLOWED_*` mismatch, a redirect URI that
  differs from `PUBLIC_URL/api/auth/oidc/callback`, or an issuer URL that does not
  match the provider's discovery document.
- **Header auth always signs out** — the request did not come through
  `AUTH_HEADER_PROXIES`: check the proxy's address (`docker inspect`), that any
  hop between it and the API is in `TRUSTED_PROXIES`, and that the proxy
  forwards the header.
- **Alerts show offline (Settings → Server)** — the `alerts` container cannot
  reach the API. If `AUTH_PASSWORD` is set, `ALERTS_INTERNAL_TOKEN` must be too,
  and both containers must share the same value (`docker compose up -d` again
  after changing `.env`).
- **Forgot the password** — remove `AUTH_PASSWORD` from `.env` (and any other
  sign-in method), restart, then set a new one. Sessions are signed with a
  secret derived from the setup, so changing the password invalidates old
  sessions.
- **Check versions** — `Settings → Server` shows the API version and the alerts
  service version; `GET /api/health` and `docker compose ps` also help.
