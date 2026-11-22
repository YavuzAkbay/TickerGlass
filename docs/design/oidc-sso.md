# Design: OIDC single sign-on and trusted-header auth (roadmap 2.1)

Adds two ways in, next to the shared password: OpenID Connect (Authentik, Authelia, Keycloak,
Pocket ID, …) via authorization code + PKCE, and "trusted header" mode behind an auth proxy.
Password login stays the default and keeps working unchanged from the user's point of view.
Still single-tenant: identity is shown and allow-listed, but there are no users / owners yet (2.2).

## Modes and enablement

Auth is enabled when **any** method is configured. Methods can be combined.

| Method     | Enabled by                                                                          |
| ---------- | ----------------------------------------------------------------------------------- |
| `password` | `AUTH_PASSWORD`                                                                     |
| `oidc`     | `OIDC_ISSUER` + `OIDC_CLIENT_ID` (+ `PUBLIC_URL` required, startup error otherwise) |
| `header`   | `AUTH_TRUSTED_HEADER` (+ `AUTH_HEADER_PROXIES` required, startup error otherwise)   |

## Settings

| Var                                                             | Meaning                                                                                                                                                                                                                                                                                | Default                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `PUBLIC_URL`                                                    | External base URL, e.g. `https://tg.example.com`. Builds the OIDC redirect URI (never derived from `Host`). `https` ⇒ cookies `Secure`                                                                                                                                                 | empty                         |
| `TRUSTED_PROXIES`                                               | CIDR/IP list of plain forwarders (e.g. the bundled nginx). Used to find the real client IP (rate limiter) and to trust `X-Forwarded-Proto`                                                                                                                                             | empty                         |
| `AUTH_SESSION_DAYS`                                             | Session cookie lifetime                                                                                                                                                                                                                                                                | `30`                          |
| `AUTH_ALLOWED_USERS`                                            | Comma list; match `sub`, `preferred_username` or verified `email` (case-insensitive) — OIDC + header                                                                                                                                                                                   | empty                         |
| `AUTH_ALLOWED_GROUPS`                                           | Comma list; user must be in one                                                                                                                                                                                                                                                        | empty                         |
| `AUTH_ALLOW_ANY_USER`                                           | `true` lets every account the IdP / proxy accepts sign in. Not the default: with OIDC or header mode on and `AUTH_ALLOWED_USERS`, `AUTH_ALLOWED_GROUPS`, `AUTH_ADMIN_USERS` and `AUTH_ADMIN_GROUPS` all empty, startup fails unless this is set                                        | `false`                       |
| `AUTH_LOGOUT_URL`                                               | Optional URL to send the browser to after sign-out (header mode / proxy logout)                                                                                                                                                                                                        | empty                         |
| `OIDC_ISSUER`                                                   | Issuer URL; discovery at `<issuer>/.well-known/openid-configuration`                                                                                                                                                                                                                   | empty                         |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`                         | Client credentials; secret optional (public client + PKCE)                                                                                                                                                                                                                             | empty                         |
| `OIDC_TOKEN_AUTH`                                               | `client_secret_basic` \| `client_secret_post`                                                                                                                                                                                                                                          | `client_secret_basic`         |
| `OIDC_SCOPES`                                                   | Space list                                                                                                                                                                                                                                                                             | `openid profile email groups` |
| `OIDC_GROUPS_CLAIM`                                             | Claim holding groups                                                                                                                                                                                                                                                                   | `groups`                      |
| `OIDC_PROVIDER_NAME`                                            | Button label "Sign in with …"                                                                                                                                                                                                                                                          | `SSO`                         |
| `OIDC_ALLOW_HTTP`                                               | Allow `http://` issuer/endpoints (LAN IdP)                                                                                                                                                                                                                                             | `false`                       |
| `AUTH_TRUSTED_HEADER`                                           | Username header, e.g. `Remote-User`                                                                                                                                                                                                                                                    | empty                         |
| `AUTH_TRUSTED_EMAIL_HEADER` / `_NAME_HEADER` / `_GROUPS_HEADER` | Optional extra headers (groups separated by `,` or `\|`). Opt-in: **no defaults**, because a proxy only overwrites the headers it is configured to copy and a client could spoof the rest past the allow-lists. Every header you set MUST be overwritten by the proxy on every request | empty                         |
| `AUTH_HEADER_PROXIES`                                           | CIDR/IP list of the **authenticating** proxy (Authelia/Authentik outpost/Traefik forward-auth host)                                                                                                                                                                                    | empty                         |

Allowed to sign in = `AUTH_ALLOW_ANY_USER`, or a match on the allow-lists (when both are set, both
must match), or a match on `AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS` (admins are implicitly allowed;
OIDC admin users match only `sub` / verified email). Only admin lists set: everyone else is denied.
Startup fails (naming the four lists) when OIDC or header mode is on with all four empty and
`AUTH_ALLOW_ANY_USER` false; it logs a warning when `AUTH_ALLOW_ANY_USER=true` is used.

## Identity and sessions

`Identity(sub, name, email, groups, method)` returned by one `authenticate(scope) -> Identity | None`
function used by the ASGI middleware for http and websocket. Alerts-service token handling unchanged.

New stateless cookie `tickerglass_session` format **v2**:
`v2.<b64url(json{sub,name,email,m,iat,exp,pw?})>.<b64url(hmac_sha256(secret, payload))>`.

- `m` = `password` | `oidc`. Groups are not stored (checked at login only).
- Password sessions carry `pw = b64url(hmac_sha256(secret, "pw:" + AUTH_PASSWORD))[:16]` so a
  password change still kills sessions, and the cookie no longer contains a plain SHA-256 of the
  password (fixes offline brute force).
- OIDC sessions are invalidated if OIDC is turned off or `OIDC_ISSUER`/`OIDC_CLIENT_ID` change, or
  the allow-lists change (a short HMAC tag of `issuer|client_id|sha256(normalized
AUTH_ALLOWED_USERS, AUTH_ALLOWED_GROUPS, AUTH_ADMIN_USERS, AUTH_ADMIN_GROUPS, AUTH_ALLOW_ANY_USER)`). Removing a user at the IdP only takes effect at the
  next sign-in (sessions are stateless); lower `AUTH_SESSION_DAYS` or rotate `AUTH_SECRET`.
- The MAC is verified (constant time) before the body is parsed; an unparsable body is "no session".
- v1 cookies are rejected → users sign in once more after upgrade (documented).
- Constant-time compare; reject on bad version, bad b64/json, expired, unknown method, method disabled.

Header mode never sets a cookie: every request (incl. websocket upgrade) is authenticated by the header.

## Client IP and proxies

`client_chain(scope)` = `X-Forwarded-For` entries + `[peer]`.

- **Client IP** (rate limiter key, logs): walk from the right, skip hops in `TRUSTED_PROXIES`;
  first non-trusted hop is the client. If the peer itself is not trusted, ignore XFF entirely.
  (Fixes today's global lockout behind nginx when `TRUSTED_PROXIES` is set.)
- **Header auth**: walk from the right. Hop in `AUTH_HEADER_PROXIES` → accept header. Hop in
  `TRUSTED_PROXIES` → continue left. Anything else → reject (ignore header). Fail closed.
  This rejects someone who reaches the bundled nginx directly and sends `Remote-User`, because
  nginx appends their address to XFF.
- `X-Forwarded-Proto` honoured only when the peer is in `TRUSTED_PROXIES`; `PUBLIC_URL` scheme wins
  and is the recommended way to get `Secure` cookies (the header route needs every hop to the API in
  `TRUSTED_PROXIES`, incl. the Docker bridge gateway). The bundled nginx keeps an incoming
  `X-Forwarded-Proto` and only falls back to its own `$scheme`.
- Docs must warn: list the auth proxy's exact address, not a whole Docker range (the Docker
  userland proxy can make outside clients appear as the bridge gateway), and the auth proxy must
  overwrite client-sent identity headers (Authelia/Authentik do).

## OIDC flow

Library: add `pyjwt[crypto]` (signature + claims). HTTP via stdlib `urllib` (no httpx), 10 s timeout (5 s for discovery / JWKS).

Discovery: lazy on first use, cached 1 h. Fetches run outside any lock, one at a time: concurrent
callers use the stale copy if there is one, else fail fast with `oidc_unavailable`. A failed
discovery / JWKS fetch is remembered for 30 s (callers fail immediately during that window, then
the next one retries), so an unreachable IdP cannot exhaust the API's worker threads. Issuer in the document must equal
`OIDC_ISSUER` (trailing slash normalized). Endpoints must be `https` unless `OIDC_ALLOW_HTTP`.
JWKS cached; refetch once on unknown `kid` (at most once per 60 s). API boots fine if the IdP is down.

1. `GET /api/auth/oidc/login?next=/path` → new `state`, `nonce`, `code_verifier` (secrets.token_urlsafe(32+)).
   Store in signed cookie `tickerglass_oidc` (HttpOnly, SameSite=Lax, Path=/api/auth/oidc, Max-Age 600,
   Secure per rules). 302 to `authorization_endpoint` with `response_type=code`, `client_id`,
   `redirect_uri=PUBLIC_URL/api/auth/oidc/callback`, `scope`, `state`, `nonce`,
   `code_challenge` (S256), `code_challenge_method=S256`.
2. `GET /api/auth/oidc/callback?code&state` (or `error`) → verify cookie signature + expiry, constant-time
   `state` match; delete the oidc cookie on every outcome. Exchange code at `token_endpoint`
   (`grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, client auth per setting).
3. Validate `id_token`: signature against JWKS; `alg` from an allow-list of asymmetric algs
   (RS256/384/512, PS*, ES256/384/512, EdDSA) — never `none` or HS*, and it must fit the signing JWK (RSA ↔ RS*/PS*, EC ↔ ES* with the matching
   curve, OKP ↔ EdDSA; a JWK that names its own `alg` must match exactly); `iss`; `aud` contains client_id,
   `azp` == client_id when multiple audiences; `exp`, `iat` (60 s leeway); `nonce` match.
4. Claims: `sub` (required), `preferred_username`/`name`, `email` + `email_verified`, groups from
   `OIDC_GROUPS_CLAIM`. If groups claim missing and `userinfo_endpoint` exists, fetch userinfo with the
   access token and require its `sub` to equal the id_token `sub`.
5. Allow check (see Settings). Email counts for `AUTH_ALLOWED_USERS` and `AUTH_ADMIN_USERS` only if
   `email_verified` is true; `AUTH_ADMIN_USERS` never matches `preferred_username`.
6. Set session cookie, 302 to `next` — only if it starts with `/`, not `//` or `/\`, no scheme;
   otherwise `/`.

Any failure, including an unexpected exception in the callback, → 302 `/?auth_error=<code>` with a fixed code (`oidc_state`, `oidc_exchange`,
`oidc_token`, `oidc_denied`, `oidc_unavailable`), details only in the server log, never tokens/secrets.

Logout: `POST /api/auth/logout` clears the cookie and returns `{"redirect": url | null}`:
OIDC session + `end_session_endpoint` → that URL with `client_id` and
`post_logout_redirect_uri=PUBLIC_URL/`; else `AUTH_LOGOUT_URL`; else null.

## API surface

- `GET /api/auth/state` → `{enabled, authed, methods: ["password"|"oidc"|"header"...],
oidcName: str|null, user: {name, email, method} | null}` (keep `enabled`/`authed` for compat).
- `POST /api/auth/login` unchanged (400 when password method off).
- `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback` (404 when OIDC off).
- `GET /server/status` `auth` gains `methods`.
- Rate limiter keyed by resolved client IP (IPv6 by /64); partial failure counts expire after the
  lockout window and stale entries are pruned as the table grows.

## Web

- `LoginScreen`: password form if `password` in methods; "Sign in with {oidcName}" button →
  `location.href = /api/auth/oidc/login?next=<current path+search>` if `oidc`. Show a readable message
  for `?auth_error=` codes, then strip the param with `history.replaceState`. If `oidc` is the only
  method and no `auth_error`, redirect automatically — at most once per 60 s per tab
  (`sessionStorage` `tg.oidcAutoRedirectAt`), otherwise show the button, so a misbehaving IdP cannot
  cause a redirect loop. The timestamp is cleared once the user is signed in.
- Settings → Server: show "Signed in as {name} ({method})"; Sign out follows `redirect` if present,
  else reload. Hide Sign out for header-only sessions unless `AUTH_LOGOUT_URL` given (state exposes
  `logoutAvailable: bool`).
- All new strings via i18n keys.

## Code touch list

API: `settings.py`, `auth.py` (identity, v2 tokens, chain/IP resolution, middleware), new
`auth_oidc.py` (discovery, JWKS, flow), `routes/auth.py`, `routes/server.py`, `app.py` wiring,
`pyproject.toml` + `uv.lock`. Tests: `api/tests/test_auth.py` (v2 tokens, v1 rejected, password-change,
client-IP resolution, header-mode accept/reject matrix incl. spoof via nginx, websocket with header),
new `api/tests/test_auth_oidc.py` with a fake IdP (locally generated RSA key, JWKS, monkeypatched
urllib): happy path, bad state, missing cookie, wrong nonce/iss/aud/azp, expired, alg none/HS256,
unknown kid refetch, open-redirect `next`, allow-lists, email_verified, userinfo sub mismatch, IdP down.

Web: `apps/web/src/api/auth.ts`, `store/auth.ts`, `auth/LoginScreen.tsx` (+ css), `settings/ServerTab.tsx`,
`api/server.ts`, `i18n/en.ts`, tests; e2e mock of `/api/auth/state` updated.

Docs: `docs/self-hosting.md` (new "Single sign-on" + "Behind an auth proxy" sections with Authentik,
Authelia, Keycloak, Pocket ID examples), `.env.example`, `docker-compose.yml` pass-through, README,
roadmap 2.1 → `done`.
