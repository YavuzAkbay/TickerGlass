# Level up TickerGlass for self-hosters

## Context

TickerGlass targets users who host it themselves, but four things work against that audience today: there is no way to get the app without cloning and building it (slow first run, no arm64 guarantee for NAS/Pi, no update path), there is no authentication so the app can never safely leave localhost, there is zero server visibility or backup story inside the app (backups = manually copying a Docker volume), and it isn't installable as an app (no manifest, not even a favicon exists). This plan closes all four gaps plus the docs to match.

Versions are currently inconsistent (`api/__init__.py` = "0.1.0", web/alerts packages = "0.0.0"); the plan centralizes them so the release pipeline can stamp everything from one tag.

---

## Workstream 1 — Prebuilt images, releases & update check

**Single source of truth:** root `VERSION` file (start at `0.2.0`).

- `api/src/tickerglass_api/__init__.py`: `__version__` reads env `TICKERGLASS_VERSION` with the file constant as fallback.
- `docker/node.Dockerfile` + `api/Dockerfile`: accept `TICKERGLASS_VERSION` build arg → ENV. `services/alerts`: esbuild `--define:__VERSION__` from the same arg (heartbeat already reports its version — `services/alerts/src/heartbeat.ts`).
- `apps/web`: Vite `define: { __APP_VERSION__: … }` read from root `VERSION` (shown in the new Server settings tab).

**`.github/workflows/release.yml`** (new, modeled on ci.yml): on push of tag `v*` → docker buildx + QEMU → build & push three multi-arch images (`linux/amd64`, `linux/arm64`) to GHCR: `ghcr.io/yavuzakbay/tickerglass-api` (api/Dockerfile), `-web` (node.Dockerfile target `web`), `-alerts` (target `alerts`). Tags: `vX.Y.Z`, `vX.Y`, `latest`. Permissions: `packages: write`.

**`docker-compose.yml`**: add `image: ghcr.io/yavuzakbay/tickerglass-{api,web,alerts}:${TICKERGLASS_TAG:-latest}` alongside existing `build:` (dual declaration — `up` builds when the image is missing, `pull && up -d` updates without cloning). Pass `TICKERGLASS_VERSION` build args.

**Update check (opt-in, no phoning home):** `apps/web/src/api/updates.ts` — button-triggered fetch of `https://api.github.com/repos/yavuzakbay/TickerGlass/releases/latest`, semver-compare against `__APP_VERSION__`, show "up to date" / "vX available" + link to release notes. Handles 403 rate-limit gracefully.

## Workstream 2 — Optional password auth

**API** (all new code under `api/src/tickerglass_api/`):
- `settings.py`: `auth_password: str | None = None` (env `AUTH_PASSWORD`). Unset = exactly today's behavior.
- `routes/auth.py`: `POST /api/auth/login` `{password}` → constant-time compare (`secrets.compare_digest`), sets signed HttpOnly `SameSite=Lax` session cookie (HMAC over expiry; signing secret persisted once to `/data/.session_secret`, falling back to env `AUTH_SECRET`, so sessions survive restarts); `POST /api/auth/logout`; `GET /api/auth/state` → `{enabled, authed}` (public, drives the UI). Login rate limit: in-memory per-IP counter, 5 failures → 429 + Retry-After. No new dependencies.
- New pure-ASGI middleware registered in `create_app` (`app.py`): when auth enabled, every `http` and `websocket` scope except `/api/health`, `/api/auth/*` requires a valid cookie → 401 JSON / close WS with 4401. Exempt requests carrying a valid `X-Alerts-Token` on the service-only alert routes, so the alerts container keeps working (docs will say: when `AUTH_PASSWORD` is set, also set `ALERTS_INTERNAL_TOKEN`).
- `docker/nginx.conf`: add `X-Forwarded-Proto` header to `/api/` and `/ws` (for Secure cookies behind HTTPS).
- Tests: `api/tests/test_auth.py` — login/logout, wrong password, protected route without cookie, WS close, health open, rate limit, disabled-when-unset, token exemption.

**Web UI:**
- `apps/web/src/api/auth.ts` + a small zustand `useAuth` store: on startup fetch `/api/auth/state`; if `enabled && !authed`, App renders a login screen (existing `Modal`/form styling, dark/light aware). Any `ApiError` with status 401 elsewhere flips the store to logged-out. Login success → `location.reload()`.
- Logout button lives in the new Server settings tab.

## Workstream 3 — Server status & backup UI

**API** — new `routes/server.py` (prefix `/server`):
- `GET /api/server/status` → `{version, uptimeSeconds, provider: {id, configured}, alerts: {online, version, lastHeartbeatAt}` (reuse `alerts.ServiceState` + existing `/alerts/service` logic), `database: {kind, sizeBytes}` (SQLite `PRAGMA page_count*page_size`; Postgres `pg_database_size`), `counts: {watchlists, layouts, drawings, notes, alerts, userScripts}`}.
- `POST /api/server/cache/clear` → clears market-data caches by reusing the provider-switch cache-clearing path (`services/cache_gate.py` / `stack.py` `ProviderSwitcher` — retire gate generation + SmartCache reset; exact function determined at implementation, keeping the cooldown logic out).
- `GET /api/server/backup` → SQLite: consistent copy via `sqlite3` backup API to a temp file, streamed as `tickerglass-backup-YYYYMMDD.db`. Postgres → 501 with "use pg_dump" detail.
- Tests: `api/tests/test_server.py` (status shape, backup download on sqlite, 501 on postgres, cache clear bumps generation).

**Web** — new Settings tab `ServerTab` (`apps/web/src/settings/ServerTab.tsx`, registered in `dialogs/SettingsDialog.tsx` TABS with i18n keys in `i18n/en.ts`): status rows (version, alerts service online/offline + last heartbeat, provider, DB size + row counts, uptime) and actions: Download backup, Clear cached market data (with `confirmDialog`), Check for updates (Workstream 1), Log out (only when auth enabled).

## Workstream 4 — PWA installability

- `apps/web/public/` (new): `manifest.webmanifest` (name, standalone display, theme colors matching `tokens.css`, icons), `icons/icon.svg` + generated `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (simple candlestick glyph on panel-color background; committed as assets, generated once by a script run during implementation).
- `index.html`: manifest link, favicon + `apple-touch-icon` (fixes the missing favicon), `apple-mobile-web-app-title`.
- `apps/web/src/sw.ts` → built as `sw.js` (minimal, hand-rolled, no workbox — consistent with the zero-dep approach): network-first for navigations with cached-index fallback when offline; cache-first for hashed `/assets/*` with old-cache cleanup on activate; **never** intercepts `/api`, `/ws`, or the sandbox worker path (preserving its CSP). Registered from `main.tsx` only when `import.meta.env.PROD && 'serviceWorker' in navigator`. `skipWaiting` + `clients.claim()` so updates apply on next reload.
- Playwright e2e `e2e/pwa.spec.ts`: manifest link present, SW registers, navigating offline still serves the shell.
- README: short "Install as an app" note.

## Docs (cross-cutting)

- New `docs/self-hosting.md`: pull-vs-build install, update procedure, backup/restore (UI button + manual volume copy), auth setup, reverse-proxy + HTTPS examples (Caddy, nginx, Tailscale), resource notes.
- README: prebuilt-image install path, auth + PWA mentions, link to the new doc. `.env.example`: `AUTH_PASSWORD`, `TICKERGLASS_TAG`, `ALERTS_INTERNAL_TOKEN`-with-auth note.

## Execution order

1. Versions + release workflow + compose (independent, unblocks everything)
2. Auth (API → UI)
3. Server panel (its logout button needs auth; update-check needs `__APP_VERSION__`)
4. PWA (independent)
5. Docs + README + `.env.example`

## Verification

- `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`; `cd api && uv run ruff check . && uv run mypy && uv run pytest`
- Local stack: `docker compose build` then exercise — login screen with `AUTH_PASSWORD` set (and none when unset), WS still streams ticks when logged in, alerts container stays online, backup downloads and opens with `sqlite3`, cache-clear + Server tab render, PWA install prompt in Chromium + offline reload works.
- Release workflow can't run fully without a tag push; validate YAML + build args locally (`docker build --build-arg TICKERGLASS_VERSION=test`) and dry-run the workflow logic; first real run happens on the next tag.
