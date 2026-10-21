# Alerts (Phase 10 design)

Alerts watch a value of a symbol (price, an indicator output) against a target (a number, another value, a
drawing's line or channel) and notify when a condition becomes true. They are evaluated by the Node service in
`services/alerts`, so they fire with the browser closed. The service uses the same TypeScript code as the chart:
the engine's feed stack for bars and live updates, `@tickerglass/indicators` for indicator values, and the engine's
anchor mapping for drawings.

Planned code:

- `packages/alerts/` (`@tickerglass/alerts`, new): wire types, spec validation, condition and trigger evaluator,
  drawing level math, warm-up lengths, message templates. Pure TS, no DOM, used by the service and the web app.
- `packages/engine/src/node.ts` (new entry `@tickerglass/engine/node`): the Node-safe part of the engine (feeds,
  expression language, intervals, anchor mapping, trading calendar). No chart, render or canvas imports.
- `services/alerts/src/`: the evaluation service.
- `api/src/tickerglass_api/`: `routes/alerts.py`, `userdata/alerts.py`, `notifications/`, migration
  `<rev>_alerts.py`, `/ws` event topics.
- `apps/web/src/alerts/`: store, sync, events, dialog, panel, notifications, chart markers.

Limitations will be listed in [LIMITATIONS.md](LIMITATIONS.md#alerts) (new section, slice G).

## 0. Decisions

| Question                         | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Who writes the database          | Only the API. The service reads and writes through REST (`/api/alerts/...`). SQLite stays single-writer, and every write goes through the same revision checks as the browser's.                                                                                                                                                                                                                                                                                         |
| Who delivers notifications       | The **API**. In-app frames go out over `/ws`. Webhook, Telegram and email go through a persisted outbox in the API (stdlib `urllib`/`smtplib`, no new dependencies). Secrets live in one place (the API env), "Send test" works while the service is down, and pytest covers delivery. The service only decides _that_ an alert fires.                                                                                                                                   |
| Service <-> API live data        | The service uses `ExpressionFeed(ResamplingFeed(HttpDataFeed({baseUrl: API_URL})))`, the same stack as `apps/web/src/chart/feed.ts`. Node 22 has global `fetch` and `WebSocket`. Bars, resampling, expression math and live bar building are byte-for-byte the chart's.                                                                                                                                                                                                  |
| Service <-> API control          | A second `/ws` connection subscribes to event topics `alerts` and `drawings` (new `op: 'events'`). A full REST resync runs every 60 s as a safety net.                                                                                                                                                                                                                                                                                                                   |
| Expression symbols (`AAPL/MSFT`) | **Supported.** The expression code (`packages/engine/src/feed/expression/`, `expression-feed.ts`) is pure TS with no DOM. Exposing it through `@tickerglass/engine/node` gives the service the same bars the chart shows, at no extra cost. A node-environment test keeps that entry DOM-free. Legs outside the `/ws` charset get no live ticks; those series fall back to bar polling (§3.6). Watchlist rows cannot hold expressions, so that entry point is unaffected. |
| Series the alert runs on         | Always **standard time bars** of `(symbol, interval, prepost)` as captured at creation. Heikin Ashi and brick chart types are display transforms. On Heikin Ashi the dialog notes that values use regular candles. On brick types, drawing sources are disabled, because the drawing geometry would differ.                                                                                                                                                              |
| Indicator settings               | Snapshot. The alert stores the fully resolved inputs of the indicator and of every upstream indicator. Editing the indicator on the chart later does not change the alert. The dialog says so.                                                                                                                                                                                                                                                                           |
| Drawings                         | Live reference by `drawingId`. Moving the line moves the alert. The price-scale mode (linear or log) is snapshotted, because it changes the line's shape (§2.6). Deleting the drawing puts the alert into `error`.                                                                                                                                                                                                                                                       |
| Offline creation                 | Not supported. Alerts only work with the server, so the dialog needs the API and shows an error toast when it is unreachable. There is no localStorage queue (unlike drawings and watchlists).                                                                                                                                                                                                                                                                           |
| Expiry                           | Optional `expiresAt` (null = open-ended; this is self-hosted, so there are no plan limits). The API enforces it (§1.4). The service also stops evaluating locally.                                                                                                                                                                                                                                                                                                       |

## 1. Data model, wire format, endpoints

### 1.1 Tables (migration `20261015_<rev>_alerts.py`, `down_revision = "50fc9b162b6f"`)

| Table              | Columns (besides `created_at`/`updated_at`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Key      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `alerts`           | `id` String(36) (client-chosen, `[A-Za-z0-9_-]{1,36}`), `name` String(200), `symbol` String(128) index (canonical, plain or expression), `interval` String(16) (`formatInterval` form: `5m 1h 1D 1W 1M`), `prepost` bool, `spec` JSON (§1.2), `schema_version` int, `message` Text (template, <= 2000 chars), `notify` JSON, `status` String(16) index, `status_reason` String(500) null, `expires_at` tz null, `drawing_id` String(64) null index (derived from `spec`), `revision` int, `fire_count` int, `last_fired_at` tz null | id       |
| `alert_states`     | `alert_id` FK `alerts.id` ON DELETE CASCADE, `revision` int (the alert revision the state belongs to), `state` JSON (`AlertRuntimeState`, §3.5), `updated_at` (no `created_at`)                                                                                                                                                                                                                                                                                                                                                     | alert_id |
| `alert_log`        | `id` Integer autoincrement, `fire_id` String(36) unique (idempotency key from the service), `alert_id` String(36) null index (no FK: the log outlives the alert), `alert_name` String(200), `symbol` String(128) index, `interval`, `kind` String(8) (`fired`), `fired_at` tz index, `bar_time` BigInteger (unix s, open of the bar), `message` Text (rendered), `values` JSON, `delayed` bool, `final` bool, `read` bool (no `updated_at`)                                                                                         | id       |
| `alert_deliveries` | `id` Integer autoincrement, `log_id` FK `alert_log.id` ON DELETE CASCADE index, `channel` String(16) (`webhook telegram email`), `target` String(500) null (per-alert webhook URL), `status` String(8) (`pending sent failed`), `attempts` int, `next_attempt_at` tz index, `last_error` String(500) null                                                                                                                                                                                                                           | id       |

- `status`: `active` (being evaluated), `paused` (by the user), `triggered` (a `once` alert fired), `expired`,
  `error` (permanent problem; `status_reason` says what). Only `active` alerts are evaluated.
- `drawing_id` is derived by the server from `spec` (the first drawing operand). The drawing menu uses it to count
  alerts on a drawing, and the API uses it to decide which drawing writes matter (§1.6).
- `alert_states` is service-owned runtime state. It is kept separate so that service writes never bump the
  alert's `revision` and never conflict with user edits. Every content change to an alert deletes its state row
  (§1.4).
- `alert_log` retention: the newest `ALERTS_LOG_MAX` (default 5000) entries. The insert path prunes older ones
  in the same transaction. Deleting an alert keeps its log entries (`alert_id` stays as a dangling id; the UI
  shows `alert_name`).
- Limits: at most 1000 alerts (422 beyond), `spec` <= 64 KB, 16 indicator instances per spec, `notify.webhookUrl`
  <= 500 chars `http(s)://`.
- Migration: edit `models.py`, then `uv run alembic revision --autogenerate -m "alerts"` (batch mode), and
  hand-check the result: the FKs, the unique `fire_id`, and the indexes above. `tests/test_userdata.py` already
  checks that head matches `models.py` and that upgrade/downgrade work. Downgrade drops the four tables in
  reverse order. SQLite FKs are enforced (`PRAGMA foreign_keys=ON` in `db.py`). The delete route still deletes
  the state row explicitly, so Postgres and SQLite behave the same.

### 1.2 Alert spec (`@tickerglass/alerts` `types.ts`, JSON in `alerts.spec`)

```ts
export const ALERT_SCHEMA_VERSION = 1;

export interface AlertSpec {
  schemaVersion: 1;
  left: SeriesOperand; // the value that moves ("x")
  condition: Condition;
  trigger: TriggerMode;
}

/** A value per bar of the alert's series. */
export type SeriesOperand =
  | { kind: 'price'; field: PriceField } // live: close = last price
  | { kind: 'indicator'; ref: IndicatorRef };

export type PriceField = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4';

export interface IndicatorRef {
  /** The target instance and all its upstream instances (indicator-on-indicator), any order. */
  instances: { id: string; type: string; inputs: InputValueMap }[]; // inputs fully resolved (resolveInputs)
  instanceId: string; // which instance
  outputId: string; // which plot (unshifted: plot `offset` is display only)
  title: string; // legend text at creation, e.g. "RSI 14 close", for descriptions only
}

/** The target ("y"). */
export type ValueOperand =
  | SeriesOperand
  | { kind: 'value'; value: number } // finite
  | DrawingLineOperand;

export interface DrawingLineOperand {
  kind: 'drawing';
  drawingId: string;
  part: 'line' | 'upper' | 'lower' | 'middle'; // 'line' for line tools; upper/lower/middle for channels
  scale: 'linear' | 'log'; // the drawing pane's price-scale mode at creation (percent/indexed -> linear)
}

export type ChannelOperand =
  | { kind: 'bounds'; upper: ValueOperand; lower: ValueOperand } // e.g. Bollinger upper/lower, two numbers
  | { kind: 'drawing'; drawingId: string; scale: 'linear' | 'log' }; // parallel-channel, rectangle, flat-channel or split-channel

export type Condition =
  | { op: 'crossing' | 'crossingUp' | 'crossingDown' | 'greater' | 'less'; right: ValueOperand }
  | {
      op: 'enteringChannel' | 'exitingChannel' | 'insideChannel' | 'outsideChannel';
      channel: ChannelOperand;
    }
  | {
      op: 'movingUp' | 'movingDown' | 'movingUpPercent' | 'movingDownPercent';
      amount: number;
      bars: number;
    };

export type TriggerMode = 'once' | 'oncePerBar' | 'oncePerBarClose' | 'everyTime';

export interface AlertNotify {
  toast: boolean; // in-app toast in open tabs (default true)
  sound: boolean; // default true
  browser: boolean; // Notification API in hidden tabs (default false; needs permission)
  webhook: boolean;
  webhookUrl: string | null; // null = ALERTS_WEBHOOK_URL
  webhookRaw: boolean; // body = rendered message instead of the JSON envelope
  telegram: boolean;
  email: boolean;
}
```

Validation (the Python pydantic models and TS `validateAlert` must agree; both run the shared fixtures in
`packages/alerts/test/fixtures/{valid,invalid}/*.json`):

- Every number must be finite. `amount > 0`, `bars` is an integer in 1..1000. Percent amounts are <= 10000.
- `instances`: 1..16 entries with unique ids `[A-Za-z0-9_-]{1,64}`. `instanceId` must be among them, and every
  `{instanceId, outputId}` source input inside must point to an instance in the list. TS also checks that the
  types exist in the registry, that `outputId` is a plot of the definition, and that the graph has no cycle.
  Python checks only the shape.
- `drawing` operands: the drawing must exist in `drawings` (422 `drawing not saved`; the dialog flushes
  `DrawingSync` first). Its type must support the part: line tools (`trend-line ray extended-line measured-line
arrow-line horizontal-line horizontal-ray`) take `part: 'line'`. Channels (`parallel-channel` with 3 points,
  `rectangle`, `flat-channel`, `split-channel`) take `upper lower middle` as a `DrawingLineOperand`, or the whole channel as a `ChannelOperand`.
  The drawing's `scope` must be `all`, or its `symbol` must equal the alert's symbol. Python reads `type`,
  `points.length`, `scope` and `symbol` from the stored drawing JSON. That is the only place the server looks
  inside a drawing.
- `interval` matches `^[1-9][0-9]{0,5}[mhDWM]$`. `symbol` is 1..128 printable characters. The web side sends
  `canonicalSymbol(...)`, and the service rejects what the feed cannot resolve (status `error`).
- `crossing*`/`greater`/`less` with `right.kind === 'value'` and `left` = price is a "price alert". Only these
  get an alert line on the chart (§5.5).

### 1.3 Wire format (camelCase, ISO 8601 UTC)

```ts
interface AlertIn {
  id?: string; // client-chosen UUID v4 (keeps identity if the POST is retried)
  name: string; // 1..200 chars; the client sends describeCondition(...) when the user leaves it empty
  symbol: string;
  interval: string;
  prepost: boolean;
  spec: AlertSpec;
  message: string; // template (§4.3); '' = default template
  notify: AlertNotify;
  expiresAt: string | null;
  status?: 'active' | 'paused'; // create/PUT only these; default 'active'
}
interface Alert extends Required<Omit<AlertIn, 'status'>> {
  status: 'active' | 'paused' | 'triggered' | 'expired' | 'error';
  statusReason: string | null;
  drawingId: string | null;
  revision: number;
  fireCount: number;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface AlertLogEntry {
  id: number;
  alertId: string | null;
  alertName: string;
  symbol: string;
  interval: string;
  firedAt: string;
  barTime: number; // unix s, open time of the bar the sample belongs to
  message: string; // rendered
  values: SampleValues; // §2.1 (x, y?, upper?, lower?, ref?, open, high, low, close, volume)
  delayed: boolean; // fired more than max(120 s, 1 interval) after the bar event it reports (catch-up)
  final: boolean; // this fire ended the alert (once)
  read: boolean;
  deliveries: {
    channel: 'webhook' | 'telegram' | 'email';
    status: 'pending' | 'sent' | 'failed';
    attempts: number;
    lastError: string | null;
  }[];
}
```

### 1.4 Endpoints (all under `/api`)

Routes with fixed segments (`log`, `states`, `channels`, `service`) are declared before `/alerts/{id}`. Ids equal
to those words are rejected (422).

| Method + path                                                              | Caller       | Notes                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /alerts?status=&symbol=`                                              | web, service | all alerts, newest `createdAt` first. First runs the lazy expiry sweep (below).                                                                                                                                                                                                                                       |
| `POST /alerts` `AlertIn`                                                   | web          | 201. Existing `id` -> 409 `{detail:{message, current}}` (like watchlists).                                                                                                                                                                                                                                            |
| `GET /alerts/{id}`                                                         | web, service | 404 if missing                                                                                                                                                                                                                                                                                                        |
| `PUT /alerts/{id}` `AlertIn + {revision?}`                                 | web          | replaces all editable fields. Stale `revision` -> 409 with `current`; omitting it overwrites. Bumps revision, deletes the state row, sets `status` from the body (default: keep `active`/`paused`; `triggered`/`expired`/`error` become `active`), and clears `statusReason`. 422 if `active` and `expiresAt <= now`. |
| `PATCH /alerts/{id}` `{status:'active'\|'paused', expiresAt?, revision?}`  | web          | pause / restart. Restart (`active` from any status) deletes the state row, clears `statusReason` and keeps `fireCount`. Bumps revision. Same 409/422 rules as PUT.                                                                                                                                                    |
| `DELETE /alerts/{id}`                                                      | web          | 204; 404 if missing (the client treats it as done). Deletes the state row; log entries stay.                                                                                                                                                                                                                          |
| `POST /alerts/{id}/fire` `FireIn`                                          | service      | §1.5                                                                                                                                                                                                                                                                                                                  |
| `POST /alerts/{id}/status` `{revision, status:'expired'\|'error', reason}` | service      | conditional on `revision` and `status = 'active'` (409 otherwise). Bumps revision.                                                                                                                                                                                                                                    |
| `GET /alerts/states`                                                       | service      | `[{alertId, revision, state}]`                                                                                                                                                                                                                                                                                        |
| `PUT /alerts/states` `{states:[{alertId, revision, state}]}`               | service      | upsert each row only if the alert exists and `alerts.revision == revision`; returns `{written:[ids], ignored:[ids]}`. Never 409. At most 1000 per call, state <= 16 KB each.                                                                                                                                          |
| `GET /alerts/log?alertId=&symbol=&before=&after=&limit=`                   | web          | newest first. `before`/`after` are log ids (exclusive); `limit` defaults to 100, max 500. Returns `{entries, hasMore, unread}` (`unread` = total unread count).                                                                                                                                                       |
| `POST /alerts/log/read` `{upTo?: id, ids?: id[]}`                          | web          | marks entries read; broadcasts `alerts.log`                                                                                                                                                                                                                                                                           |
| `DELETE /alerts/log?alertId=`                                              | web          | 204; without `alertId` clears all                                                                                                                                                                                                                                                                                     |
| `GET /alerts/channels`                                                     | web          | `{webhook:{configured, url: masked\|null}, telegram:{configured}, email:{configured, to: masked\|null}}`                                                                                                                                                                                                              |
| `POST /alerts/channels/{channel}/test` `{webhookUrl?}`                     | web          | sends one test message synchronously (10 s timeout). 200 `{ok:true}`; 400 if not configured; 502 `{detail}` with the transport error. No log entry.                                                                                                                                                                   |
| `POST /alerts/service/heartbeat` `ServiceHeartbeat`                        | service      | kept in memory (not in the DB): `{version, startedAt, series, liveSymbols, polledSeries, lastError}`                                                                                                                                                                                                                  |
| `GET /alerts/service`                                                      | web          | heartbeat + `online` (last heartbeat less than 90 s ago) + `lastHeartbeatAt`; `{online:false}` before any heartbeat                                                                                                                                                                                                   |

Lazy expiry: `GET /alerts`, `GET /alerts/{id}` and `fire` first run
`UPDATE alerts SET status='expired', revision=revision+1, status_reason=NULL WHERE status='active' AND expires_at <= :now`
and broadcast `alerts.changed` for the affected ids. So the panel shows the right status even while the service
is down.

Optional shared secret: if the API env has `ALERTS_INTERNAL_TOKEN`, the service-only routes (`fire`, `status`,
`PUT states`, `heartbeat`) require the header `X-Alerts-Token` (401 otherwise). It is unset by default. This is a
single-user setup behind nginx, and the token only stops a stray browser tab from impersonating the service.

### 1.5 Firing (`POST /alerts/{id}/fire`)

```ts
interface FireIn {
  fireId: string; // UUID v4 chosen by the service, reused on retries
  revision: number; // alert revision the evaluator ran on
  firedAt: string;
  barTime: number;
  final: boolean; // trigger 'once'
  delayed: boolean;
  message: string; // rendered by the service (§4.3)
  values: SampleValues;
  state?: AlertRuntimeState; // stored with the same revision rule as PUT /alerts/states (after the bump if final)
}
```

One transaction:

1. `fire_id` already logged -> 200 with the existing entry (idempotent retry; nothing else happens).
2. `UPDATE alerts SET fire_count = fire_count + 1, last_fired_at = :firedAt, status = CASE WHEN :final THEN
'triggered' ELSE status END, revision = revision + CASE WHEN :final THEN 1 ELSE 0 END WHERE id = :id AND
revision = :revision AND status = 'active' AND (expires_at IS NULL OR expires_at > :firedAt)`. 0 rows -> 409
   `{detail:{message, current}}` (404 if gone). The service then drops the fire and reloads the alert. This is
   what keeps an alert from firing after the user paused or edited it.
3. Insert `alert_log` (rendered message, values). Insert one `alert_deliveries` row (`pending`,
   `next_attempt_at = now`) per enabled external channel that is configured. A channel that is enabled but
   not configured gets a `failed` row with `last_error = 'not configured'`, so the log shows why nothing arrived.
4. Upsert `state` if given, then prune the log.
5. Commit, then publish `alert.fired` (and `alerts.changed` when `final`), then wake the dispatcher.

`fire_count`/`last_fired_at` changes do not bump `revision` (like a rename), so a fire never makes an open edit
dialog conflict. Status changes do bump it.

### 1.6 `/ws` event topics

New client op on the existing socket (`routes/live.py`):

```jsonc
→ {"op": "events", "topics": ["alerts", "drawings"]}   // replaces the client's topic set; [] stops
← {"type": "events", "topics": ["alerts", "drawings"]}
← {"type": "error", "message": "unknown topic 'x'"}    // unknown topics reject the frame (topics unchanged)
```

Frames (each carries `topic`):

| Frame                                                                                              | Topic      | When                                                                                 |
| -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `{type:'alerts.changed', ids, deleted}`                                                            | `alerts`   | after create, PUT, PATCH, DELETE, status, final fire, lazy expiry, bundle import     |
| `{type:'alert.fired', entry: AlertLogEntry, alert:{id, status, revision, fireCount, lastFiredAt}}` | `alerts`   | after a fire commits                                                                 |
| `{type:'alerts.log', ids?, cleared?, readUpTo?}`                                                   | `alerts`   | log read/clear, delivery status changes (`ids` = log ids whose deliveries changed)   |
| `{type:'drawings.changed', ids, deleted}`                                                          | `drawings` | after `POST /drawings/batch` and bundle import (all written and deleted drawing ids) |

Implementation: `LiveClient.topics: set[str]`; `LiveHub.publish(topic, frame)` fans out to clients holding the
topic through `client.send` (same bounded queue as ticks). Routes are sync (`def`, threadpool), so they call
`hub.publish_threadsafe(...)`, which uses the event loop captured in the lifespan and
`loop.call_soon_threadsafe`. Publishing happens **after** commit. Event subscribers do not count toward the
200-symbol cap. A client that only subscribes to topics keeps the upstream idle (no symbols).

Dropped frames (queue overflow) are possible but harmless. The web refetches on reconnect, tab focus and
`visibilitychange`, and the service runs a full resync every 60 s.

### 1.7 Revisions and conflicts (consistent with persistence.md §3)

- **User writes** (PUT, PATCH) carry the `revision` the edit was based on. A stale one -> 409 with
  `detail.current`; the web adopts `current` and shows "Keep mine" (re-sends PUT without `revision`), as for
  watchlists. Check and write are one conditional `UPDATE ... WHERE id AND revision`.
- **Service writes** are conditional on the revision the evaluator used: `fire` and `status` -> 409, which the
  service treats as "reload, do not retry". `PUT /alerts/states` silently ignores stale rows.
- **Status bumps revision, counters do not.** So "the service marked it triggered" reaches an open dialog as a
  conflict, but a recurring alert firing does not.
- **State lifecycle:** every revision bump makes the stored state stale. The API deletes the row on PUT/PATCH;
  for service-side bumps the service ignores rows whose `revision` differs. That gives one rule: an alert
  revision starts with fresh evaluator state.
- **Import/export** (persistence.md §4): additive bundle section `"alerts": [AlertIn + status, statusReason,
fireCount, lastFiredAt]` (no states, no log). `merge` matches by id. `replace` empties `alerts` (and
  `alert_states`) only when the key is present. `BUNDLE_VERSION` stays 1. Imported alerts keep their status.
  An alert whose drawing is not in the database after import becomes `error` (`drawing not found`) the first
  time the service loads it.

## 2. Condition and trigger semantics

This section is the math spec. The functions named here live in `packages/alerts/src/` and are the ones the
golden tests in §6.1 call.

### 2.1 Series, samples, operands

The alert's **series** is the standard OHLCV time series of `(symbol, interval, prepost)` from the feed stack.
It has bars `0..n-1` with open times `T_0 < ... < T_{n-1}`. Bar `n-1` may be **forming** (still receiving
updates) or **closed** (§2.4).

A **sample** `s` is one evaluation point:

```ts
interface Sample {
  kind: 'tick' | 'close'; // a live/poll update of the forming bar, or the final values of a closed bar
  barIndex: number; // i
  barTime: number; // T_i
  now: number; // service wall clock, ms
  values: SampleValues;
}
interface SampleValues {
  x: number; // left operand at bar i
  y?: number; // right operand (crossing/greater/less)
  upper?: number;
  lower?: number; // channel, already ordered: lower <= upper when both finite
  ref?: number; // moving*: left operand at the close of bar i - N
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // bar i as of this sample
}
```

Operand values at bar `i` for a sample:

| Operand               | Value                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `price`               | `close_i`, `open_i`, `high_i`, `low_i`, `hl2 = (h+l)/2`, `hlc3 = (h+l+c)/3`, `ohlc4 = (o+h+l+c)/4` of bar `i` as of the sample. Live, `close` is the last price.                                                         |
| `indicator`           | the instance's output `outputId` at chart index `i` after the runtime has processed this sample's bar (`computeLast('update')` for a tick, the final bar for a close). It is unshifted: a plot `offset` is display only. |
| `value`               | the constant                                                                                                                                                                                                             |
| `drawing` (line/part) | `drawingLevel(drawing, part, scale, timeline, T_i)` (§2.6), evaluated at bar `i`'s own logical index                                                                                                                     |
| channel `bounds`      | `u = value(upper)`, `l = value(lower)`, then `upper = max(u, l)`, `lower = min(u, l)` (NaN if either is non-finite)                                                                                                      |
| channel `drawing`     | `drawingChannel(drawing, scale, timeline, T_i)` -> `{upper, lower}` (§2.6)                                                                                                                                               |

A value is **valid** if it is finite. A sample whose required values are not all valid makes the condition
false. The sample still becomes the previous sample `p` of the next one, so a gap (NaN) breaks edge detection
instead of bridging it.

### 2.2 Evaluated stream and the previous sample

Each alert sees a stream of samples `s_0, s_1, ...` that depends on its trigger mode:

- **Tick modes** (`once`, `oncePerBar`, `everyTime`): every `tick` sample **and** every `close` sample of the
  series, in order. The close sample of bar `i` carries the refetched final values. It belongs to bar `i` and
  can fire, for example when the official close crosses a level that the last tick did not.
- **Close mode** (`oncePerBarClose`): only `close` samples.

`p = s_{k-1}`, the immediately preceding sample in **that alert's** stream. Within a bar, `p` is the previous
tick; for the first tick of bar `i`, `p` is the close sample of bar `i-1`. In close mode, `p` is the close of
bar `i-1`.

Activation (create, edit, restart, unpause, or the first service load of an alert revision):

- Tick modes: `p` is the persisted `state.prev` if it belongs to the current revision and
  `state.prev.barTime ∈ {T_{n-1}, T_{n-2}}` (the forming or the previous bar). Otherwise there is no `p`. The
  first sample after activation is the latest known values of bar `n-1`. **State conditions** (§2.3) may fire
  on it. **Edge conditions** need `p` and cannot fire on the first sample without one.
- Close mode: `p` is the close sample of the last closed bar computed from history, so it is always available
  after the series loads. Only bars that **close after activation** are evaluated. A bar counts as closing
  after activation if its close event (§2.4) happens after the alert's `updatedAt`. Catch-up after a service
  restart: if `state.lastClosedBarTime` (same revision) is older than the newest closed bar, the newest closed
  bar alone is evaluated once, with `delayed = true` if its close event is more than `max(120 s, interval)` old.
  Earlier missed bars are skipped and counted in the service log.

### 2.3 Conditions

Notation: for the current sample `c` and the previous sample `p`, `d = x - y`. All comparisons are on IEEE
doubles with no epsilon; values are what the chart computes, and the golden tests pin the boundary cases.

| `op`                | Kind  | True when                                                      |
| ------------------- | ----- | -------------------------------------------------------------- |
| `crossingUp`        | edge  | `p` exists, `d_p <= 0` and `d_c > 0`                           |
| `crossingDown`      | edge  | `p` exists, `d_p >= 0` and `d_c < 0`                           |
| `crossing`          | edge  | `crossingUp` or `crossingDown`                                 |
| `greater`           | state | `x_c > y_c`                                                    |
| `less`              | state | `x_c < y_c`                                                    |
| `insideChannel`     | state | `in(c)`, where `in(s) = lower_s <= x_s <= upper_s` (inclusive) |
| `outsideChannel`    | state | `!in(c)` (all values valid)                                    |
| `enteringChannel`   | edge  | `p` exists, `!in(p)` and `in(c)`                               |
| `exitingChannel`    | edge  | `p` exists, `in(p)` and `!in(c)`                               |
| `movingUp`          | state | `x_c - ref_c >= amount`                                        |
| `movingDown`        | state | `ref_c - x_c >= amount`                                        |
| `movingUpPercent`   | state | `ref_c != 0` and `(x_c - ref_c) / abs(ref_c) * 100 >= amount`  |
| `movingDownPercent` | state | `ref_c != 0` and `(ref_c - x_c) / abs(ref_c) * 100 >= amount`  |

- Edge conditions also require every value of `p` that they use to be valid.
- The crossing definitions are the usual crossover/crossunder rules applied to consecutive samples. Touching
  and leaving on the same side counts as a cross away from the touch (`9, 10, 9` against 10 is a `crossingDown`
  at the third sample). That is deliberate and pinned by golden tests.
- Moving: `ref_c` = the left operand at the **close** of bar `i - N` (`N = bars`), i.e. the final value stored
  for that closed bar, for both tick and close samples. If `i - N < 0` or the value is invalid, the condition is
  false. The window is in bars, not wall-clock time: bars are what the service has, they match the usual
  "within N bars", and a time window would depend on session gaps.
- The condition is evaluated per alert; the operand values are shared per series and bar (§3.3).

### 2.4 Bar close

Bar `i` (open `T_i`) is **closed** at the first of these events:

1. **Next bar:** the feed delivers a bar with time `> T_i` (live or poll).
2. **Clock:** `now >= end_i + ALERTS_CLOSE_GRACE_S` (default 60 s), where
   - intraday (native or resampled): `end_i = T_i + intervalSeconds`, capped at the regular session end of that
     trading day when the series is RTH-only (`prepost = false`) and `SymbolInfo.session` is known;
   - `1D` and above with a known regular session: `end_i` = the session end on the **last trading day covered by
     bar `i`**, in the exchange timezone. That is the local day of `T_i` for daily bars. For weekly and monthly
     bars it is the last day of the week or month, but only once a later day has no new data, so in practice
     rule 1 closes them;
   - otherwise (no session, e.g. an expression whose legs differ, or round-the-clock symbols):
     `end_i = stepTime(T_i, 1, interval)`.

On close the service refetches the newest 3 bars (`getBars({limit: 3})`), replaces bar `i` with the fetched
values (ticks can miss the true high, low and volume), lets the runtime process it, and emits one `close`
sample for bar `i`. Then, if rule 1 triggered the close, it emits a `tick` sample for the new bar. A bar is
closed at most once; later revisions of the same bar (Yahoo restating a daily bar) update values but do not
emit a second close sample. Holidays: no bar appears, so rule 2 closes the last real bar on its own day and
nothing is evaluated for the holiday.

### 2.5 Trigger modes

Each alert keeps `lastFiredBarTime`, `lastFiredAt` and `lastClosedBarTime`. For a sample `c` whose condition is
true:

| Trigger           | Fires when                                                                                  | After firing                                        |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `once`            | the first time                                                                              | `final = true` -> status `triggered`                |
| `oncePerBar`      | `lastFiredBarTime != c.barTime` (first true sample of each bar, tick or close)              | `lastFiredBarTime = c.barTime`                      |
| `oncePerBarClose` | always (the stream only has close samples)                                                  | (`lastClosedBarTime` is set for every close sample) |
| `everyTime`       | `lastFiredAt` is null or `c.now - lastFiredAt >= ALERTS_MIN_REFIRE_S * 1000` (default 60 s) | `lastFiredAt = c.now`                               |

- `everyTime` on an edge condition fires once per crossing (crossings are events). On a state condition it fires
  every sample while the condition holds, rate-limited by the refire floor. A suppressed fire is not logged.
- Expiry: a sample with `c.now >= expiresAt` is not evaluated; the service posts `status: expired` once.
- Per-bar dedupe uses `barTime`, never `barIndex`, because indices shift when the window is trimmed.
- Before evaluating, a sample is dropped if `c.barTime` is older than the newest bar the alert has seen (an
  out-of-order poll result).

### 2.6 Drawing levels

Drawings store anchors in `(time, price)`; the chart maps time to a **logical bar index** and draws straight
lines in **pixel** space. Pixel x is affine in the logical index (index-based time scale). Pixel y is affine in
`f(price)`, where `f` depends on the pane's scale mode (`PriceScale.toInternal`): `log` gives
`f(p) = log10(max(p, 1e-12))`; `linear`, `percent` and `indexed` are affine in `p`, so `f(p) = p`. `inverted`
only flips the sign of the affine map. So "straight on screen" is straight in `(L, f(p))`, and the service
reproduces any line tool from the anchors, the snapshotted `scale`, and a timeline of its own bars. `g = f⁻¹`.

**Timeline in the service.** For the alert's series, the service builds an `AnchorTimeline` (`bricks: false`,
`time` = bar open times, `endTime = T_{n-1}`) and a calendar, exactly as `Chart.tradingCalendar()` does:
`buildTradingCalendar(time, n, interval, tz, prepost ? null : session)` with `tz`/`session` from
`resolveSymbol`. The calendar is rebuilt on series (re)load, on trim, and at most once per local trading day
(first bar of a new day). Logical indices are relative to the service's window; only differences enter the math,
so the window offset cancels out.

`L(t) = timeToLogical(timeline, {time: t})` (engine `drawings/mapping.ts`; `brick` is ignored). The
evaluation point for bar `i` is `L_i = i` (`L(T_i)` is exactly `i` inside the data). Anchor `j` maps to
`l_j = L(points[j].time)`. This covers gap times (the next bar), times past the last bar (calendar slots), and
times before the first bar (extrapolation). To make the last case match the chart, the service loads history at
least back to `min(points[].time)` (§3.4), so extrapolation only happens where the chart has no data either.

Line tools (anchors `A = points[0]`, `B = points[1]`):

```
lineAt(L) with s = (L - l_A) / (l_B - l_A):
  defined iff |l_B - l_A| >= 1e-9                     (else: vertical -> alert status error "vertical line")
  s_min = style.extendLeft  ? -∞ : 0                  (extendLeft extends past anchor 0, extendRight past anchor 1:
  s_max = style.extendRight ? +∞ : 1                   parametric like extendSegment, NOT screen left/right)
  value = s in [s_min, s_max] ? g(f(p_A) + s * (f(p_B) - f(p_A))) : NaN
```

| Tool                                                  | Value at `L`                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `trend-line`, `ray`, `extended-line`, `measured-line` | `lineAt(L)` with the drawing's own `extendLeft`/`extendRight` (ray/extended only change defaults) |
| `arrow-line`                                          | `lineAt(L)` with no extension (segment)                                                           |
| `horizontal-line`                                     | `p_0` for every `L`                                                                               |
| `horizontal-ray`                                      | `L >= l_0 ? p_0 : NaN`                                                                            |

Channels:

```
parallel-channel (3 anchors; fewer -> error "incomplete channel"):
  Y_m(L) = f(p_0) + (f(p_1) - f(p_0)) * (L - l_0) / (l_1 - l_0)      (|l_1 - l_0| < 1e-9 -> error)
  Δ      = f(p_2) - Y_m(l_2)                                          (= channelOffsetPx / pixels-per-f-unit)
  domain: s = (L - l_0)/(l_1 - l_0) in [extendLeft ? -∞ : 0, extendRight ? +∞ : 1], else NaN
  a = g(Y_m(L)), b = g(Y_m(L) + Δ), mid = g(Y_m(L) + Δ/2)
  upper = max(a, b), lower = min(a, b), middle = mid

rectangle (2 anchors):
  upper = max(p_0, p_1), lower = min(p_0, p_1), middle = (upper + lower)/2 (linear) or g((f(upper)+f(lower))/2) (log)
  domain: L in [extendLeft ? -∞ : min(l_0, l_1), extendRight ? +∞ : max(l_0, l_1)]   (screen-based, as rectangle.ts box.l/box.r)
```

```
flat-channel (3 anchors) and split-channel (3 or 4 anchors; fewer than 3 -> error "incomplete channel"):
  a = f of line p_0-p_1 at L (extend flags as the parallel channel, else NaN outside l_0..l_1)
  b = flat-channel: g(f(p_2));  split-channel: line p_2-p_3 at L (p_3 missing -> (t_1, price_2 - (price_1 - price_0)), as completePoints)
  upper = max(g(a), g(b)), lower = min(g(a), g(b)), middle = g((a + b)/2)   (a, b in f units; lines may cross, upper/lower then swap)
```

The parallel channel's width is a pixel offset in the engine (`channelOffsetPx`). Because pixel y is affine in
`f`, a constant pixel offset is a constant `Δ` in `f` units: a constant price difference on linear scales, a
constant ratio on log scales. The formulas above therefore draw exactly what the chart draws in that scale
mode. If the user later switches the pane between linear and log, the chart's line changes shape but the
alert keeps the snapshotted `scale`. The dialog states this, and LIMITATIONS lists it.

The drawing is re-read on every `drawings.changed` that names its id (§3.2). Hidden or locked drawings still
evaluate. A drawing on a non-main pane yields values in that pane's units; the dialog only offers it as a
target when the left operand is an indicator in that pane (UI rule, not enforced server-side).

### 2.7 Indicator values and warm-up

The service runs one `IndicatorRuntime` per series (§3.3) with `setContext({timezone, session,
intervalSeconds, timeframeSeconds})` as in `docs/indicators.md` §2, and with `resolveTimeframe` matching the web
controller (`'auto'` rules from §4 there). Multi-timeframe instances get their timeframe bars from the same
feed (`requiredTimeframes()` -> `getBars` + `subscribe` -> `setTimeframeBars` / `updateTimeframeBar`). Live values
are therefore "what was known", with the same confirmed/unconfirmed behavior as the chart.

Warm-up (`warmupBars(ref): number`, `packages/alerts/src/warmup.ts`): recursive indicators depend on how much
history precedes the evaluated bar. The service loads enough that, for EMA/RMA-based indicators, its values
equal a long-history computation within 1e-8 relative error, the golden-test tolerance (a seed error decays like
`(1 - 2/(L+1))^k`, below 1e-8 after about 10·L bars):

- Base per instance: `10 × max(int inputs, 1) + 50`, at least 300.
- Overrides by definition id: `obv`, `volume`-style cumulative outputs -> `ALERTS_MAX_BARS`; `anchored-vwap` ->
  bars since its `time` input (loaded by time, not count); `vwap`/`vwap-bands` -> since the start of the
  anchor period before the current one; `ichimoku` -> `10 × max(lengths) + displacement`; `parabolic-sar` ->
  500; `pivot-points` -> its timeframe needs 3 timeframe bars (MTF warm-up as in the web controller).
- Chain: warm-up of an instance = own + the max over its upstream instances (sources add up along a chain).
- Total series window `W = min(ALERTS_MAX_BARS (5000), max over alerts of (warm-up + bars for moving* + 2))`,
  further limited by yfinance's per-interval history (1m: 30 days).

Cumulative indicators (OBV, A/D) have no converging warm-up; their level depends on the start bar, as on the
chart, where it depends on how far you scrolled. Alerts on their **level** may not match the chart. Crossings
with another cumulative or relative value (OBV vs its moving average) are unaffected. LIMITATIONS lists this.

## 3. Node service (`services/alerts`)

### 3.1 Modules

| File              | Responsibility                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | bootstrap: config, wait for `/api/health` (backoff), load, start loops; SIGINT/SIGTERM -> flush state, close sockets, exit within 5 s                                                                                         |
| `config.ts`       | env parsing with defaults (§4.1); invalid values are a startup error                                                                                                                                                          |
| `api.ts`          | typed REST client (`listAlerts getAlert listStates putStates fire setStatus heartbeat getDrawings`); `X-Alerts-Token`; retries with backoff on network/5xx; 409/404/422 surface as typed errors                               |
| `control.ts`      | control `/ws` (topics `alerts`, `drawings`), reconnect 1 s..30 s with jitter, ping every 25 s; emits `alertsChanged(ids, deleted)` and `drawingsChanged(ids, deleted)`; while down, `registry` polls `GET /alerts` every 10 s |
| `registry.ts`     | in-memory alerts by id (with revision); diffs a fresh list against memory -> `added / changed / removed`; routes them to series                                                                                               |
| `series.ts`       | `Series` per key `symbol                                                                                                                                                                                                      | interval | prepost`: `resolveSymbol`, history load (§3.4), `subscribe`, close detection (§2.4), poll fallback (§3.6), `IndicatorRuntime`, timeline/calendar, drawings cache; emits samples to its alerts |
| `operands.ts`     | per sample: computes each distinct operand once (`price`, indicator output by instance hash, drawing level by drawing id+part+scale)                                                                                          |
| `alert-runner.ts` | wraps `createAlertEvaluator` from `@tickerglass/alerts` for one alert revision; renders the message; queues fires                                                                                                              |
| `fires.ts`        | fire queue: `POST /fire` with the same `fireId` until 2xx, 409 (drop and reload the alert) or 404/422 (drop); in order per alert                                                                                              |
| `state.ts`        | dirty set of alert states; flush with `PUT /alerts/states` every `ALERTS_STATE_FLUSH_MS` (5 s) and on shutdown                                                                                                                |
| `heartbeat.ts`    | `POST /alerts/service/heartbeat` every 30 s                                                                                                                                                                                   |
| `log.ts`          | one-line JSON logs (`level, msg, alertId?, series?`); `ALERTS_LOG_LEVEL`                                                                                                                                                      |

The feed is `new ExpressionFeed(new ResamplingFeed(new HttpDataFeed({ baseUrl: API_URL, wsUrl })))` from
`@tickerglass/engine/node`, with `wsUrl` derived as `ws(s)://<API_URL host>/ws`. The live socket is the feed's
own; the control socket is separate, so neither one's reconnect logic depends on the other.

### 3.2 Loop

The service is event-driven, plus a 1 s clock:

1. **Sync:** on start, and on `alertsChanged` (fetch the named ids, or the full list if more than 20) or every
   60 s: the registry diff. An added active alert is attached to its series (created on demand). A changed
   revision gets a new evaluator; its old state is discarded unless the stored state's revision matches. A
   removed alert, or one no longer active, is detached; a series with no alerts is disposed (unsubscribe,
   runtime dropped).
2. **Bars:** a feed bar for the series updates the bar store: same time -> update, newer -> append (which closes
   the previous bar by §2.4 rule 1), older -> ignored. Then the runtime processes it (`updateBar`), then one sample
   goes to each attached alert. Samples are not coalesced; Yahoo ticks arrive at most a few times per second
   per symbol.
3. **Clock (1 s):** close detection rule 2 per series, expiry per alert, poll scheduling (§3.6), and series retry
   timers.
4. **Fires** go to `fires.ts`; **state** changes mark the alert dirty for `state.ts`.
5. **Drawings:** each series with drawing alerts caches `GET /drawings?symbol=<symbol>` (symbol + synced). On
   `drawingsChanged` naming a cached or referenced id, it refetches. A referenced drawing that is missing ->
   `POST /status {status:'error', reason:'drawing not found'}`.

Operands are shared: distinct indicator subgraphs are deduplicated by a content hash of
`{type, inputs, upstream hashes}`. Instance ids inside the runtime are those hashes, so two alerts on "RSI 14"
use one instance.

### 3.3 Series and indicator runtime

- The bar store is `BarStore`-compatible columns (`time open high low close volume`) with at most `W + 500`
  bars. When a 500-bar overflow builds up, the oldest 500 bars are dropped and the service calls
  `runtime.setBars` (a full recompute) and rebuilds the timeline and calendar. Values match within the warm-up
  tolerance.
- `closed` flag per series: whether bar `n-1` is closed (§2.4). Moving `ref` reads the closed values at
  `i - N`.
- Indicator errors (`status(id).state === 'error'`) put the alerts that use that instance into `error` with the
  runtime's message.

### 3.4 History load

`getBars({symbol, interval, prepost, limit})`, paging backwards with `to` while `hasMore`, until both
conditions hold:

- at least `W` bars are loaded;
- for drawing alerts, the first bar is at or before `min(anchor times) - 2 intervals`, capped at 20,000 bars
  (`ALERTS_MAX_DRAWING_BARS`).

A page request uses `limit = min(5000, remaining)`. `hasMore = false` (yfinance limit reached) ends the load
silently; extrapolation then matches the chart.

### 3.5 State persistence across restarts

```ts
interface AlertRuntimeState {
  v: 1;
  seriesKey: string;
  prev: { barTime: number; kind: 'tick' | 'close'; values: SampleValues } | null;
  lastFiredBarTime: number | null;
  lastFiredAt: number | null; // ms
  lastClosedBarTime: number | null;
}
```

The `revision` is stored next to the state in `alert_states`, not inside it. Restored state is used only if its
revision equals the alert's, and then as §2.2 describes. Writes are batched (5 s), and a fire carries the
post-fire state, so a crash between a fire and the next flush cannot re-fire a `oncePerBar` alert in the same
bar. Worst case after a crash: a `tick` sample's `prev` is up to 5 s old. That can at most suppress or reproduce a
crossing that happened inside those 5 s, and the `fireId` and per-bar guard prevent duplicates.

### 3.6 Price source, polling and backoff

- **Live:** the feed's `subscribe` (ticks over `/ws`, with the API's own upstream poll fallback when Yahoo's
  stream is silent).
- **Bar polling** for a series: when the feed's `LiveStatus.connection` has not been `open` for 20 s, when the
  symbol or a leg is outside the `/ws` charset (`^[A-Za-z0-9.\-=^]{1,32}$`), or when more than 200 distinct live
  symbols are needed (the series beyond the cap, newest first, are polled). It runs
  `getBars({limit: 3})` every `ALERTS_POLL_MS` (default 30 s; 120 s outside the regular session when the session
  is known). The results go through the same update path as live bars. A spike that reverses between two polls
  is not seen; LIMITATIONS lists this.
- **Backoff:** API unreachable -> 1, 2, 4 ... 60 s with ±20 % jitter for everything. A series `getBars` failure
  with 502/0 (Yahoo or network) -> 5 s doubling to 5 min, series state `retrying`, alerts stay `active`. 404 from
  `resolveSymbol` -> alerts `error` (`symbol not found`). A `FeedError` naming an expression leg -> `error`
  with that message. 422 (bad interval) -> `error`.
- The heartbeat reports `polledSeries`, `liveSymbols` and the last error. The web shows it (§5.3).

### 3.7 Packaging

`docker/node.Dockerfile` copies `packages/alerts/package.json` before `pnpm install`. The `alerts` target keeps
bundling with esbuild (workspace packages are bundled; `@tickerglass/engine/node` keeps canvas code out).
`docker-compose.yml` passes the service env (§4.1).

## 4. Notifications

### 4.1 Configuration (env)

API (`settings.py`, `.env.example`):

| Variable                                                                                                                         | Default          | Meaning                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `ALERTS_WEBHOOK_URL`                                                                                                             | unset            | default webhook target (a per-alert `notify.webhookUrl` overrides it)                     |
| `ALERTS_WEBHOOK_SECRET`                                                                                                          | unset            | adds `X-TickerGlass-Signature: sha256=<hex HMAC-SHA256 of the body>`                       |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`                                                                                         | unset            | both are required for Telegram                                                            |
| `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TO`, `SMTP_TLS` (`starttls` \| `ssl` \| `none`) | unset / as noted | `SMTP_HOST`, `SMTP_FROM`, `SMTP_TO` are required for email; `SMTP_TO` may be a comma list |
| `ALERTS_LOG_MAX`                                                                                                                 | 5000             | log retention                                                                             |
| `ALERTS_INTERNAL_TOKEN`                                                                                                          | unset            | §1.4                                                                                      |

Service (`docker-compose.yml` `alerts.environment`): `API_URL` (`http://api:8000`), `ALERTS_INTERNAL_TOKEN`,
`ALERTS_POLL_MS` (30000), `ALERTS_CLOSE_GRACE_S` (60), `ALERTS_MIN_REFIRE_S` (60), `ALERTS_STATE_FLUSH_MS`
(5000), `ALERTS_MAX_BARS` (5000), `ALERTS_MAX_DRAWING_BARS` (20000), `ALERTS_LOG_LEVEL` (`info`).

Secrets live only in env: the browser never sees them, and `GET /alerts/channels` masks URLs and addresses.

### 4.2 Delivery (API `notifications/`)

`dispatcher.py` is an asyncio task started in the lifespan. It wakes on a fire or every 5 s, takes due
`pending` deliveries (`next_attempt_at <= now`), sends each via `asyncio.to_thread` (stdlib only), and records
the result. Attempts happen at +0 s, 10 s, 60 s, 5 min and 30 min (5 in total); then the delivery is `failed`.
Telegram `429` honors `retry_after`; 4xx other than 408/429 fails at once. Pending deliveries survive a restart
(the DB is the outbox). Every status change publishes `alerts.log {ids}`.

| Channel  | Request                                                                                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| webhook  | `POST`, 10 s timeout. Default body `application/json`: `{alert:{id,name,symbol,interval}, message, firedAt, barTime, values, delayed}`. With `notify.webhookRaw`: the rendered message as the body, sent as `application/json` if it parses as JSON and `text/plain; charset=utf-8` otherwise. |
| telegram | `POST https://api.telegram.org/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}`, plain text (no parse mode), message truncated to 4096                                                                                                                                |
| email    | `smtplib` with `SMTP_TLS`; subject `TickerGlass alert: <name>`; plain text body: message, then symbol, interval, bar time, fired at                                                                                                                                                             |

### 4.3 Message templates (`renderMessage`, `packages/alerts/src/template.ts`)

The service renders the message at fire time, so the log, toast and all channels show the same text. The syntax
is `{{name}}`, with no nesting and no expressions. Unknown placeholders are kept literally, and `{{` without a
matching `}}` is literal text. The output is truncated to 2000 characters (with `…`).

| Placeholder                                      | Value                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `{{ticker}}`                                     | alert symbol (canonical, expressions included)                                                     |
| `{{exchange}}`, `{{currency}}`                   | from `resolveSymbol` (`''` if unknown)                                                             |
| `{{interval}}`                                   | `formatInterval` form                                                                              |
| `{{open}} {{high}} {{low}} {{close}} {{volume}}` | the sample's bar; `{{price}}` = `{{close}}`                                                        |
| `{{value}}`                                      | left operand `x`                                                                                   |
| `{{target}}`                                     | right operand `y`, or `lower–upper` for channels, or `amount` (with `%`) for moving                |
| `{{upper}} {{lower}}`                            | channel bounds (`''` otherwise)                                                                    |
| `{{change}}`                                     | moving: `x - ref`, or the percent (`%` suffix) for `*Percent`                                      |
| `{{time}}` / `{{timenow}}`                       | bar open / fire time, ISO 8601 UTC (`2026-10-15T14:30:00Z`)                                        |
| `{{name}}`, `{{condition}}`                      | alert name; `describeCondition(alert)`, e.g. `Crossing Up 190.00`, `RSI 14 close Entering Channel` |

Prices are formatted with the symbol's price precision (`SymbolInfo` price hint), indicator values with the
definition's `precision` (default 2 decimal places beyond the price hint), and volume as an integer. The default
template (when `message === ''`) is `{{ticker}} {{condition}}`. The default name is `describeCondition` with the
symbol (`AAPL Crossing 190.00`).

## 5. Web UI

### 5.1 Data layer (`apps/web/src/alerts/`)

- `api/alerts.ts`: REST functions for §1.4 on `api/client.ts` (`ApiError`), plus `alertConflict(err)`.
- `alerts/store.ts` (zustand): `alerts: Record<id, Alert>`, `log: AlertLogEntry[]` (newest page), `unread`,
  `service: ServiceStatus | null`, `channels`, `status: 'idle'|'loading'|'ready'|'offline'`.
- `alerts/sync.ts`: `startAlertsSync()` from `persist/bootstrap.ts`. It loads `GET /alerts`, `GET /alerts/log`,
  `GET /alerts/service` (then every 60 s while the panel is open) and `GET /alerts/channels`. It refetches on
  `alerts.changed` (by ids), on reconnect, focus and visible. Mutations: `createAlert`, `updateAlert(id, patch,
revision)`, `setAlertStatus`, `deleteAlert`, `cloneAlert(id)` (opens the dialog with a copy: new id, name
  `"<name> (copy)"`, status `paused` until saved). On 409 it adopts `current` and shows the "Keep mine" toast.
- `alerts/events.ts`: subscribes to the `alerts` topic through `QuoteStream.subscribeEvents(topics, handler)`
  (additive in `quotes/stream.ts`). The subscription keeps the socket open like a symbol ref, is re-sent on
  every (re)connect, and is answered by the mock in `e2e/market.ts`. `alert.fired` updates the store and calls
  the listeners registered with `onAlertFired(fn)` (notifications and markers, §5.4). On reconnect it fetches
  `GET /alerts/log?after=<newest id>`; entries younger than 5 minutes are announced like live fires, older ones
  only count as unread.

### 5.2 Create/edit dialog (`dialogs/AlertDialog.tsx`, `alerts/dialog/`)

Opened by `alert.create` (args below) and `alert.edit {id}`. Dialog id `'alert'` in `store/ui.ts`, lazily
loaded in `DialogHost.tsx`. Tabs:

- **Settings:** symbol (read-only from the entry point; editable from the toolbar and the panel's "+" via the
  symbol search, expressions allowed), interval and extended hours (default: the chart's), **Condition**: left
  operand select (price fields, then every indicator output on the chart, titled like the legend), op select,
  then the right side by op. A value field (price precision, plus/minus nudges), a "source" select (price,
  indicator outputs, drawings that support the op), channel bounds, or amount plus bars. Trigger (4 radio
  buttons with one-line explanations), expiry (none, or date and time; preset +1 day, +1 week, +1 month).
- **Notifications:** toast, sound (preview button), browser notification (asks for permission on check, in the
  click handler), webhook (+ URL override, raw body), Telegram, email. Unconfigured channels are disabled with
  "Not configured (set TELEGRAM_BOT_TOKEN…)" from `GET /alerts/channels`. A "Send test" link per channel.
- **Message:** name, message template with a placeholder picker, and a live preview rendered with
  `renderMessage` on the chart's current values.

Rules: indicator refs are built with `buildIndicatorRef(instanceId, outputId)` from the indicator store: the
closure of upstream instances, with resolved inputs. The dialog shows "Uses the current settings of <title>;
later changes on the chart do not affect this alert." Drawing sources first `await drawingSync.flush()`.
`scale` comes from the drawing pane's price-scale mode. Drawing sources are disabled on brick chart types, and
a note on Heikin Ashi says values use regular candles. Validation uses `validateAlert` (the same as the
server), and errors show inline. Save -> POST (create) or PUT with `revision` (edit); the API being down ->
error toast, and the dialog stays open.

### 5.3 Entry points

| Entry                         | Command / args                                                                                                                  | Defaults                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Top bar "Alert" button, Alt+A | `alert.create` `{}`                                                                                                             | chart symbol, `close` crossing the last price                                                             |
| Price-scale "+" button        | engine event `priceAxisPlus {paneId, price}` -> `alert.create {price, paneId}`                                                  | `close` crossing `price` (on an indicator pane: the first indicator output of that pane crossing `price`) |
| Price axis / chart menus      | existing `alert.create {price}` items in `chart/contextMenus.ts`                                                                | as "+"                                                                                                    |
| Drawing right-click menu      | `alert.create {drawingId}` ("Add alert…", in `drawings/menu.ts`, for the tools in §2.6; disabled with a tooltip on brick types) | line tools: `close` crossing the line; channels: `close` entering the channel                             |
| Indicator legend/menu         | `alert.create {indicatorId}` (`indicators/menu.ts`)                                                                             | first output crossing its last value                                                                      |
| Watchlist row                 | existing `alert.create {symbol}` (`sidebar/watchlist/rowMenu.ts`)                                                               | that symbol, `close` crossing its last quote; only price sources unless it is the chart symbol            |
| Alerts panel "+"              | `alert.create {}`                                                                                                               | as the top bar                                                                                            |

The price-scale "+" is an engine feature (§5.5): a small "+" box at the left edge of the crosshair's price label
while the pointer is over the price axis or the pane. Option `priceAxisPlusButton` (default true).

### 5.4 Alerts panel (`sidebar/panels/Alerts.tsx`, `alerts/panel/`)

- Two tabs: **Alerts** and **Log** (with an unread badge, also on the sidebar icon).
- Alerts list: rows with a status dot (active, paused, triggered, expired, error), name, `describeCondition`,
  symbol and interval, trigger, expiry, fire count. Sort by created, name or symbol; filter all, active or
  inactive; search. A row click opens the symbol on the chart (interval too). The row menu (right click and a
  "…" button): Edit, Pause/Resume, Restart (for triggered, expired and error), Clone, Delete (confirm). Bulk
  actions in the header menu: pause all, resume all, delete inactive.
- Error rows show `statusReason`. When `GET /alerts/service` says offline: the banner "Alerts service is not
  running; alerts will not fire" (with the heartbeat age).
- Log: entries (time, alert name, message, delivery chips with tooltips for errors), "Mark all read" (sent
  automatically when the tab is visible), "Clear log", filter by the selected alert. Infinite scroll with
  `before`.

### 5.5 Chart markers and alert lines

Engine (additive, `packages/engine`):

```ts
interface ChartMarker { id: string; time: number; position: 'aboveBar' | 'belowBar' | 'price'; price?: number;
  color: string; shape: 'bell' | 'circle' | 'arrowUp' | 'arrowDown'; tooltip?: string }
interface ChartPriceLine { id: string; paneId: string; price: number; color: string;
  lineStyle: 'solid' | 'dashed' | 'dotted'; label?: string; axisLabel: boolean }
chart.setMarkers(group: string, markers: ChartMarker[]): void;     // replaces the group; [] clears
chart.setPriceLines(group: string, lines: ChartPriceLine[]): void;
// events: 'priceAxisPlus' {paneId, price}, 'markerClick' {group, id}, 'priceLineClick' {group, id}
```

Markers map `time` through `timeToLogical` (so they survive interval changes, like drawings), are culled to the
visible range, and are not part of `getState()`. The app re-applies them on symbol, interval or layout changes.

Web (`alerts/attach.ts`): markers group `alerts` = log entries of the chart symbol (the newest 500). Each is
placed at the bar containing `barTime`; `position: 'price'` at `values.x` for price-left alerts, `aboveBar`
otherwise, with the message as the tooltip. A click opens the Log tab on that entry. Alert lines group `alerts`:
active price alerts (§1.2) of the chart symbol get a dashed line at `value`, with a bell label on the axis.
Clicking a line opens `alert.edit`. Both can be toggled in Settings -> Alerts (setting `alerts.prefs`, synced
through `settingsSync.ts`).

### 5.6 In-app notifications (`alerts/notify.ts`, `alerts/sound.ts`)

On `onAlertFired(entry)`, per the alert's `notify` (as of the frame):

- **Toast** (`notify.toast`) in every open tab: `actionToast(message, [{label:'Open log'}])`, auto-hidden after
  `prefs.toastMs` (default 10 s; 0 = keep).
- **Sound** (`notify.sound`) only in **visible** tabs, so several open tabs normally ring once. Sounds are
  generated with WebAudio (no bundled third-party assets): `beep chime ding alarm`, with `prefs.sound` and
  `prefs.volume`. Settings -> Alerts has the picker and a preview.
- **Browser notification** (`notify.browser`) only when **no** tab is visible: each tab checks
  `document.visibilityState === 'hidden'` and shows `new Notification(name, {body: message, tag: 'alert-' +
entry.id})`. The tag merges duplicates across tabs. A click focuses the tab and opens the log.
  `Notification.permission` is requested from the dialog checkbox and from Settings -> Alerts. If it is denied,
  the checkbox shows the reason.
- With the browser closed, only the external channels reach the user; the next visit shows the unread count.

Settings dialog -> Alerts tab replaces the placeholder list: sound, volume, toast duration, alert lines, markers,
browser permission, channel status with "Send test".

## 6. Testing

### 6.1 Evaluator golden cases (vitest, `packages/alerts/src/*.test.ts`)

Table-driven, one file per area. Fixtures are JSON (`test/fixtures/cases/*.json`, `{name, spec, samples[],
expect: fires[]}`) so pytest can reuse the spec files. Required cases (y = 10 unless noted):

| Area             | Input -> expected                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| crossingUp       | x `9, 11` -> fire at 1 · `9, 10` -> none · `9, 10, 11` -> 2 · first sample `11` with no prev -> none · `9, NaN, 11` -> none                                                                                                     |
| crossingDown     | `11, 9` -> 1 · `10, 9` -> 1 · `9, 10, 9` -> 2 (touch rule)                                                                                                                                                                      |
| crossing         | `9, 11, 9` -> 1, 2                                                                                                                                                                                                              |
| greater / less   | `10` -> false; `10.000001` -> true; `NaN` -> false                                                                                                                                                                              |
| channels [9, 11] | entering `8, 9` -> 1 (inclusive) · exiting `11, 12` -> 1 · bounds given swapped (11, 9) -> same results · upper NaN -> none                                                                                                     |
| moving %         | closes `100, 102`, forming tick `105`, N = 2, 5 % -> true; `104.99` -> false; ref 0 -> false; i - N < 0 -> false                                                                                                                |
| oncePerBar       | true ticks t1, t2 in bar A, t3 in bar B -> fires at t1, t3                                                                                                                                                                      |
| oncePerBarClose  | bar0 close 9, ticks of bar1 `11, 9.5`, bar1 close 11 -> one fire at the bar1 close; ticks never fire                                                                                                                            |
| everyTime        | crossings at 0 s, 30 s, 61 s -> fires at 0 s and 61 s (60 s floor) · greater true every 10 s for 3 min -> 4 fires                                                                                                               |
| once             | the second true sample after a fire -> nothing; decision `final: true`                                                                                                                                                          |
| expiry           | sample at `expiresAt` -> not evaluated                                                                                                                                                                                          |
| activation       | state condition already true at activation -> fires on the first sample; edge condition -> needs a second sample; restored `prev` from bar n-3 -> discarded                                                                     |
| close detection  | intraday: next-bar rule; clock rule `end + grace`; RTH cap at the session end; daily session close in America/New_York incl. DST; a holiday gap emits no extra close                                                            |
| trend line       | daily Mon-Fri bars, A = (bar0, 100), B = (bar4, 104): bar2 -> 102; bar6 (next Tue) -> NaN, with extendRight -> 106; anchor on a Saturday -> maps to Monday's bar; A to the right of B with extendLeft extends to the right side |
| log line         | A = (0, 100), B = (2, 10000), scale log -> bar1 = 1000; scale linear -> 5050                                                                                                                                                    |
| future anchor    | B two slots past the last bar via the calendar (weekend skipped) equals `chart` mapping (`timeToLogical`) on the same bars                                                                                                      |
| horizontal ray   | anchor bar3, price 50: bar2 -> NaN, bar3 -> 50                                                                                                                                                                                  |
| parallel channel | P0 = (0, 100), P1 = (4, 104), P2 = (2, 110), linear: bar3 -> lower 103, upper 111, middle 107; log with P0 = (0, 100), P1 = (2, 400), P2 = (1, 400) -> bar2 upper 800, lower 400                                                |
| rectangle        | p 90/110 bars 2..5: bar1 -> NaN, bar3 -> 90/110; extendRight -> bar9 -> 90/110                                                                                                                                                  |
| vertical line    | l_A == l_B -> `DrawingLevelError('vertical line')`                                                                                                                                                                              |
| templates        | every placeholder; unknown kept; unclosed `{{` literal; truncation at 2000; price precision from the price hint                                                                                                                 |
| warm-up          | EMA 50 on 1000 synthetic bars with `warmupBars` lead-in == full-history EMA within 1e-8 relative                                                                                                                                |
| validation       | every file in `fixtures/valid` passes and every file in `fixtures/invalid` fails with its named error (same files in pytest)                                                                                                    |

`packages/engine/src/node.test.ts` (`// @vitest-environment node`): importing `@tickerglass/engine/node` works
without `document`, `window` or `OffscreenCanvas`, and its exports include the feed classes, `canonicalSymbol`,
`timeToLogical` and `buildTradingCalendar`.

### 6.2 Service (vitest, `services/alerts/src/*.test.ts`)

A fake API (`node:http` in process: alerts, states, fire with 409/idempotency, drawings), an injected
`ControlLike` instead of the control socket (Node has no built-in WebSocket server), and a `DataFeed` stub (or
`SyntheticFeed`), all passed to `createService({api, control, feed, clock})`. A fake clock drives close rule 2. Cases:
load and attach; tick crossing fires once with the right message and state; a 409 on fire drops the fire and
reloads; a lost connection retries the fire with the same `fireId`; pause via `alertsChanged` stops evaluation;
a drawing moved via `drawingsChanged` changes the level; a missing drawing leads to `status error`; a restart
restores state (no duplicate `oncePerBar` fire); close-mode catch-up after a restart fires once with `delayed`;
poll fallback after the feed connection stays down for 20 s; backoff on 502 without a status change; a 404 symbol
leads to `error`; trimming keeps values within tolerance; an expression series uses each leg's feed.

### 6.3 API (pytest, `api/tests/test_alerts.py`, `test_notifications.py`)

CRUD and validation (the shared fixtures; reserved ids; limits; a drawing operand needs a stored drawing); PUT
and PATCH revision conflicts with `current`; PUT/PATCH clear the state row; fire: the conditional update (stale
revision, paused, expired -> 409), idempotent `fireId`, `final` -> triggered with a bumped revision, a log row
plus deliveries rows (unconfigured -> failed), the state written with the right revision; lazy expiry; log paging
`before`/`after`, `unread`, read, clear, retention prune; `PUT /states` ignores stale rows; the internal token
when set; bundle export/import with `alerts` (merge, replace, absent key leaves alerts alone); `/ws` `op:
events`: topic set and reply, unknown topic error, `alerts.changed` after a POST (TestClient websocket),
`drawings.changed` after a drawing batch, publish from a sync route thread; the dispatcher with fake transports
(monkeypatched `urllib.request.urlopen` and `smtplib.SMTP`): retries and schedule, Telegram 429 `retry_after`,
HMAC header, raw webhook body, a restart resumes pending deliveries; migration upgrade/downgrade (existing
test). Race test like `test_userdata.py`: a PUT between the fire's read and write -> 409.

### 6.4 e2e (Playwright, `e2e/alerts.spec.ts`)

No real service and no DB. `e2e/persistence.ts` `MockServer` gets in-memory `/api/alerts*` (CRUD with
revisions, log, channels, service status). `e2e/market.ts` answers `op: events` and adds
`pushAlertFired(entry, alert)`. Notifications are stubbed with `page.addInitScript` (a fake `Notification` that
records calls, permission `granted`), and WebAudio is stubbed to count plays. Scenarios:

1. Top bar -> dialog -> save: the POST body matches the expected spec (price crossing the last price), and the
   row appears in the panel.
2. Price-axis "+" (hover the axis, click "+"): the dialog is prefilled with the hovered price.
3. Trend line -> right click -> "Add alert…": the spec has a drawing operand with `scale`; the drawing was
   flushed first (the batch request precedes the POST).
4. Watchlist row -> "Add alert…": the symbol of that row.
5. Panel: pause (PATCH), resume, clone (dialog, new id), delete (confirm), edit with a 409 -> "Keep mine".
6. `pushAlertFired` -> toast with the message, sound counted (visible tab), log entry unread -> read, a marker
   on the chart (screenshot or `chart.getMarkers` test hook), `Notification` not called while visible; with
   `visibilityState` forced hidden -> called with `tag`.
7. Service offline banner when `/api/alerts/service` reports `online: false`.
