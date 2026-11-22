# Design: multi-user (roadmap 2.2)

Every user-data row gets an owner. The market-data cache stays shared. An admin role covers server
settings, providers and user management. Existing data moves under the first user. Builds on the
identities from 2.1 (`docs/design/oidc-sso.md`); also works with password-only and open (no auth)
installs.

## Users and identities

```
users(id String(32) PK (uuid hex), name, email NULL, role 'admin'|'user', disabled bool,
      password_hash NULL, password_changed_at NULL, created_at, last_seen_at)
user_identities(key String(300) PK, user_id FK users CASCADE, created_at)
```

Identity keys: `oidc:<sha256(issuer)[:12]>:<sub>`, `header:<NFKC(username).casefold()>`,
`password:<username lowercased>`. Header usernames (and emails matched against the allow/admin
lists) must already be NFKC-stable and printable, else the request is refused (401, or no match for
an email): U+212A + "ate" must not become "kate". List entries are normalized with NFKC + casefold.

- **Owner user.** The migration creates one user (`name 'Owner'`, role admin) and assigns every
  existing row to it. Its id is stored in `app_meta['owner_user_id']`.
- **Open mode** (no auth method configured): every request is the owner user. Behaviour unchanged.
- **Bootstrap password.** `AUTH_PASSWORD` stays: logging in with it (username empty or `admin`) is
  the owner user (identity `password:admin`, linked at startup).
- **Local accounts.** When the password method is on, admins create users with username + password
  (Settings → Users). Hash: stdlib `hashlib.scrypt` (n=2**14, r=8, p=1, 16-byte salt), stored as
  `scrypt$n$r$p$salt_b64$hash_b64`; constant-time verify; min length 10. Users change their own
  password; admins reset others'.
- **OIDC / header users** are auto-provisioned on first sign-in (after the 2.1 allow check passes:
  `AUTH_ALLOW_ANY_USER`, the allow-lists, or an admin-list match, since admins are implicitly
  allowed; startup fails if none of the lists nor the flag is set, so SSO is never open by default),
  role `user` unless they match `AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS`. For OIDC, `AUTH_ADMIN_USERS`
  matches only `sub` or a verified email (not `preferred_username`: user-editable at some IdPs; the 2.1
  sign-in allow-list still matches it, documented); header mode also matches the proxy-asserted
  username. Groups match exactly. Matching an admin list promotes to admin at sign-in; it never demotes (admins demote
  in the UI). `AUTH_AUTO_PROVISION=false` makes unknown identities fail with `oidc_denied` / 401 until
  an admin pre-creates them — not in scope for pre-creation by OIDC sub in this item; just deny.
- **Claiming the owner.** The first OIDC/header identity that signs in while the owner user has no
  OIDC/header identity is linked to the owner **only if** it matches `AUTH_ADMIN_USERS`/`GROUPS`, or no
  admin lists are set and the password method is off (a pure SSO install upgrading). Logged at
  WARNING. Otherwise it gets a new account.
- Disabled users: every request 401, sessions dead. Deleting a user cascades all their data.
  Cannot delete or demote/disable the last enabled admin, or yourself.

## Sessions and request identity

- Session cookie v2 gains `uid`. `read_session` returns it; the middleware loads the user (small
  in-process cache, 10 s TTL, cleared on any users write) and rejects missing / disabled users.
  Local-password sessions carry a tag derived from `password_hash` (password change kills sessions;
  the bootstrap admin keeps the `AUTH_PASSWORD` tag from 2.1).
- Header mode: resolve/provision the user per request (cached by identity key).
- The middleware writes `scope["state"]["user"] = CurrentUser(id, name, email, role, method)`.
  The alerts-service token yields `CurrentUser.SYSTEM` (role `system`, no id).
- Dependencies: `UserDep` (any signed-in user), `AdminDep` (403 otherwise). `ServiceOnly` routes
  (`fire`, `status`, `PUT states`, `heartbeat`) and `SystemSessionDep` (an all-owners session)
  require the SYSTEM principal; an admin is not one. With auth on, SYSTEM exists only through a
  valid `ALERTS_INTERNAL_TOKEN` (`X-Alerts-Token` header, also on `/ws`; the legacy `auth_token` query parameter still works and is redacted from logs); unset, no request can be the
  service (403) and startup logs a WARNING. Open mode (no auth, one user): a request without a
  token is the service on these routes, so the Node service needs no token there. The only
  admin-initiated all-owners sessions are opened inside the handler after `AdminDep` (shared
  screener list writes, `GET /server/status`).
- Password reset/change, disable, delete and role change close the user's open `/ws` sockets
  (`LiveHub.kick_threadsafe`, after commit); they reconnect with their current session.

## Ownership in the database

`owner_id String(32) NOT NULL FK users.id ON DELETE CASCADE, indexed` on top-level user tables:
`layouts, drawings, indicator_templates, drawing_templates, chart_templates, settings, notes,
watchlists, user_scripts, symbol_flags, alerts, alert_log, screens, portfolios`.
Children stay owned through their parent (`alert_states, alert_deliveries, screen_states,
portfolio_transactions, journal_entries, journal_screenshots`); routes reach them only via an owned
parent. `screener_lists` gets `owner_id NULL` (NULL = shared/bundled, admin-managed; non-NULL = a
user's custom/uploaded list).

Key changes: `settings` PK → `(owner_id, key)`; `symbol_flags` PK → `(owner_id, symbol)`;
`UNIQUE(name)` → `(owner_id, name)` on indicator/chart templates; `(owner_id, tool_type, name)` on
drawing templates. `layouts.is_last_used` and `drawing_templates.is_default` clearing scoped to owner.
Client-chosen string ids stay global PKs; inserting an id owned by someone else → 409 `id in use`
(no other info). `journal_entries.note_id` / `transaction_id` must reference rows of the same owner.

**Enforcement (two layers, fail-closed):**

1. _Automatic._ `Session.info["owner_id"]` (set by `OwnedSessionDep` from `CurrentUser`) or
   `Session.info["all_owners"] = True` (system code only: alerts-service routes, screener evaluation,
   dispatcher, maintenance, migrations). A `do_orm_execute` hook adds
   `with_loader_criteria(Model, Model.owner_id == owner)` for every owned model on ORM SELECT /
   UPDATE / DELETE, and a `before_flush` hook fills `owner_id` on new owned rows and **raises** if an
   owned row is written with a different owner. Any ORM statement touching an owned model in a session
   with neither flag raises `OwnershipError` (→ 500 in dev, test failure) — no silent unscoped queries.
   Core (`session.execute(text(...))` / Table-level) statements on owned tables are banned in route code.
2. _Explicit._ Store helpers (`owned_get(session, Model, id)`) still filter by owner, so a hook bug
   isn't a leak. `session.get` must go through `owned_get` (identity map can bypass criteria).

## Cross-cutting

- **WebSocket.** Connections carry the user id (system connections: all). `publish(topic, msg,
owner_id=…)` delivers user-data events (`alert.fired`, `alerts.changed`, `alerts.log`,
  `drawings.changed`, transfer events) only to that owner's sockets + system sockets. Price ticks stay
  broadcast.
- **Alerts service (Node).** Stays one process with the system token. API payloads for alerts, states,
  user scripts and drawings include `ownerId`. The service keys scripts and drawings by
  `(ownerId, id)` and only resolves an alert's script / drawing operands within the alert's owner.
  Fire / status / state writes are validated by the API against the alert's owner.
- **Screener evaluation** runs per screen as system, writing logs/deliveries with the screen's owner.
  The tracked-symbol set stays the union of all users' watchlists (shared cache; no content exposed).
- **Notifications** unchanged (env channels are server-wide); `alert_log.owner_id` from the alert.
- **Export / import** are per user (own rows only; `replace` deletes only own rows).
  `GET /server/backup` (whole DB) is admin-only.
- **Admin-only:** `POST /server/cache/clear`, `GET /server/backup`, `POST /providers/active`,
  `POST /providers/test`, `POST /screener/runs`, writes to shared screener lists, `/api/users/*`.
  `GET /server/status`: admins get everything; users get version/auth/provider name only.
  Provider usage / cache stats readable by all signed-in users (no secrets there).

## API surface

- `GET /api/auth/state` → `user` gains `id`, `role`; adds `canManageUsers` (admin) and
  `localAccounts` (password method on).
- `POST /api/auth/login {username?, password}` — empty/`admin` username = bootstrap password.
  Rate limit: per client IP (5 failures / 60 s) and per (client IP, username) pair. No global
  per-username lockout: anyone could lock `admin` out from any address. Distributed guessing
  is bounded by scrypt cost plus the per-IP limits (docs/self-hosting.md). `PUT /me/password`
  counts wrong current passwords per signed-in user id (10 / 60 s).
- `GET /api/me`, `PATCH /api/me {name}`, `PUT /api/me/password {current, new}` (local accounts only).
- Admin: `GET /api/users`, `POST /api/users {username, name, password, role}`,
  `PATCH /api/users/{id} {name?, role?, disabled?}`, `PUT /api/users/{id}/password {new}`,
  `DELETE /api/users/{id}`. Responses never include hashes; identities listed by method only.

## Web

- Auth state `user.id` drives a cache guard: on load, if `localStorage['tickerglass-user']` differs
  from the signed-in user id, clear every `tickerglass-*` key (and session keys) before stores
  hydrate, then store the new id. Logout clears them too. The localStorage → server one-time migration
  only runs for the user whose id matches the stored one (never imports another user's cache). If
  `/auth/state` could not be fetched (user unknown), the guard does not claim or clear and the
  migration does not run on an owned or unclaimable cache; the next load retries.
  Migrated fixed ids (`migrated-default-layout`, `migrated-general-note`) get a random suffix.
- Login form gains an optional Username field when `localAccounts`.
- Settings → **Users** tab (admins): list, create local user, rename, role, disable, reset password,
  delete (confirm). Settings → **Account**: name, change password (local accounts).
- Admin-only controls (cache clear, backup, provider switch/test, manual screener run, shared list
  edits) hidden for non-admins; the API enforces regardless.

## Settings

`AUTH_ADMIN_USERS`, `AUTH_ADMIN_GROUPS`, `AUTH_AUTO_PROVISION` (default `true`),
`AUTH_ALLOW_ANY_USER` (default `false`, see oidc-sso.md).

## Tests

Isolation matrix: two users × every resource (list, get, update, delete, export/import, ws events,
alerts-service payload ownership, journal cross-owner links, id-collision 409). Hook tests: unscoped
ORM query raises; cross-owner flush raises. Migration test: existing rows → owner, PK/unique changes,
downgrade. Admin guard tests. Password hashing + rate limit by username. Open mode and existing
suites keep passing unchanged (owner user implicit).
