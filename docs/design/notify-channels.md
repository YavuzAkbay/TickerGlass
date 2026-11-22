# Design: ntfy, Gotify and Apprise delivery (roadmap 1.4)

Three push channels next to webhook / Telegram / email. Same outbox (`alert_deliveries`), same
dispatcher retry schedule, same per-alert toggles. Configured only by the operator in `.env`.

## Channel names

`ntfy`, `gotify`, `apprise` (fit `alert_deliveries.channel` String(16); no migration — `alerts.notify`
and screen notify are JSON).

## Settings (`settings.py`, `.env.example`, `docker-compose.yml`)

| Var               | Meaning                                                                                                  | Default                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| `NTFY_URL`        | Full topic URL, e.g. `https://ntfy.sh/my-alerts` or `http://ntfy:80/alerts`                              | empty                      |
| `NTFY_TOKEN`      | Access token (`tk_…`) sent as `Authorization: Bearer`; optional                                          | empty                      |
| `NTFY_PRIORITY`   | 1-5 or `min/low/default/high/max/urgent`                                                                 | `default`                  |
| `NTFY_TAGS`       | Comma list of tags / emoji shortcodes                                                                    | `chart_with_upwards_trend` |
| `GOTIFY_URL`      | Server base URL, e.g. `https://gotify.example.com`                                                       | empty                      |
| `GOTIFY_TOKEN`    | Application token, sent as `X-Gotify-Key` header (never query string)                                    | empty                      |
| `GOTIFY_PRIORITY` | Integer 0-10                                                                                             | `5`                        |
| `APPRISE_URL`     | Apprise API endpoint: `http://apprise:8000/notify` (stateless) or `…/notify/<key>` (stateful)            | empty                      |
| `APPRISE_URLS`    | Optional comma/space list of `apprise://`-style target URLs, sent as `urls` in the body (stateless mode) | empty                      |
| `APPRISE_TAG`     | Optional tag filter (stateful mode)                                                                      | empty                      |

Configured when: ntfy → `NTFY_URL`; gotify → `GOTIFY_URL` + `GOTIFY_TOKEN`; apprise → `APPRISE_URL`.
Invalid priority values fail settings validation at startup.

No Python `apprise` library dependency: we talk to the Apprise API server (caronc/apprise-api).

## Wire formats

Title / body reuse `email_content(entry)` (subject, body) so all text channels say the same thing.

- **ntfy** — JSON publish: `POST <scheme://host[/prefix]>/` with
  `{"topic", "title", "message", "priority": int, "tags": [...]}` (topic = last path segment of
  `NTFY_URL`, base = the rest). JSON avoids non-ASCII header problems.
- **Gotify** — `POST <GOTIFY_URL>/message`, header `X-Gotify-Key`, JSON `{"title","message","priority"}`.
- **Apprise** — `POST <APPRISE_URL>`, JSON `{"title","body","type":"info"}` + `"urls"` when
  `APPRISE_URLS` set + `"tag"` when `APPRISE_TAG` set.

## Transport and security

- Refactor `webhook.py`: extract `post(url, body, content_type, *, headers=None, timeout=10.0,
allow_private=False)`; `send()` becomes a thin wrapper (adds UA + HMAC header). New channels
  call `post`. Same DNS pinning, no redirects, same HTTP status classification
  (4xx permanent except 408/429; 5xx / network retryable) plus `Retry-After` (seconds) on 429/503
  → `DeliveryError.retry_after`.
- These URLs come from the operator's env, not from users, and are usually LAN hosts
  (`http://gotify`, `http://apprise:8000`) → `allow_private=True` for these three. Scheme must
  still be http/https.
- URL userinfo (`https://user:pw@host/...`) is stripped from the URL actually opened and sent as
  `Authorization: Basic` (an explicit header, e.g. the ntfy bearer token, wins); `NTFY_URL` must
  not carry a query string (settings validation).
- Secrets: tokens only in headers; `APPRISE_URLS` only in body. Never in `last_error`, logs, or
  `/api/alerts/channels` responses (URLs masked with `mask_url`, which must strip userinfo and
  query; Apprise target URLs are never returned at all).

## Code touch list

API: `notifications/{__init__,webhook,dispatcher}.py` + new `notifications/{ntfy,gotify,apprise}.py`
(each `send(settings, title, body, *, timeout=10.0)`), `outbox.record_log_entry` wanted list,
`settings.py`, `userdata/alerts.py` (`AlertNotify`, `Delivery.channel`, `Channels`),
`userdata/screens.py` notify flags, `routes/alerts.py` test-route Literal, screener alert enqueue
(`services/screener/alerts.py`). Tests in `api/tests/test_notifications.py` (FakeNet style).

Web / shared: `packages/alerts/src/types.ts` (`AlertNotify`, `DEFAULT_NOTIFY`, `DeliveryChannel`),
`apps/web/src/api/alerts.ts` (`AlertChannels`), `alerts/dialog/defaults.ts`,
`dialogs/AlertDialog.tsx` NotificationsTab (three Checks with "not configured" hint + test link,
same as Telegram), `alerts/SettingsTab.tsx` CHANNELS, screener channel toggles + i18n keys
`scr.scr.ch.{ntfy,gotify,apprise}`. Also fix the Email hint (`SMTP_*`, not `ALERTS_SMTP_*`).

Docs: `docs/alerts.md` §4.1 env table, §4.2 request formats, §6.3 tests; README channel list;
roadmap 1.4 → `done`.
