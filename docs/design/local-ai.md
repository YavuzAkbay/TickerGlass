# Ask AI about the chart (roadmap Tier 5)

Status: done 2026-11-27. User guide: [../ai.md](../ai.md).

Goal: ask a local model (Ollama) questions about the chart or a selected part of it, with nothing
leaving the user's own hardware.

## 1. Decisions

- **The API proxies Ollama; the browser never talks to it.** `OLLAMA_URL` is operator-set. This
  works for Docker, multi-user servers and phones, needs no CORS setup on Ollama, and lets the server
  enforce limits. Browser-direct ("use my laptop's Ollama") was considered and left out.
- **Text brief always, picture when the model can read images.** Numbers in text are exact; a
  picture adds shape and the user's drawings. Small local models are bad at arithmetic, so the brief
  carries precomputed statistics.
- **The browser builds the brief, the server owns the instructions.** The browser has the bars,
  indicator outputs and drawings already computed; the server adds the system prompt, checks sizes
  and models, and streams.
- **Conversations are ephemeral**, in memory per chart. No table, no migration, nothing to purge.

## 2. API (`api/src/tickerglass_api/ai/`, `routes/ai.py`)

### 2.1 Where the set-up comes from

Environment first (`OLLAMA_URL` or `AI_PROVIDER` set: in-app settings are read-only), else the
admin's in-app settings in `app_meta["ai_config"]` = `{url, models, defaultModel}` (`ai/config.py`),
else off. Resolved lazily into `app.state.ai_runtime` and replaced on save, so no restart.
Admin routes: `GET /api/ai/config` (env URL with its password redacted), `PUT /api/ai/config`
(409 when env-locked; `url: null` turns it off), `POST /api/ai/test {url?}`: probe one address, or
with none probe `localhost`, `127.0.0.1`, `host.docker.internal` and `ollama` on 11434 in parallel
(4 s each) and return the first that answers, with every chat model there (no allow-list). The
admin is trusted with the address like `OLLAMA_URL`; plain users never choose it. The web has a
Settings → AI tab (admins) and admins see the Ask AI section while it is off, with "Connect
Ollama…".

Model lists are live: `/api/tags` is read on every status call (2 s burst cache) and only the
per-model `/api/show` answer is cached, keyed by name and digest. The panel re-reads the status
when it opens and when the model picker is pointed at.

### 2.2 Routes

- `GET /api/ai/status` (any user): `{enabled: false}` or `{enabled, provider, reachable, error,
models: [{name, vision, parameterSize, sizeBytes}], defaultModel, numCtx, maxImageBytes}`.
  Models come from `/api/tags`; `/api/show` `capabilities` marks vision models and drops
  embedding-only ones (old Ollama without `capabilities`: `details.families` containing `clip` or
  `mllama`). Cached 60 s. `AI_MODELS` filters (`llama3` = `llama3:latest`).
- `POST /api/ai/chat` `{model, messages: [{role: user|assistant, content, images?}]}` answers
  `application/x-ndjson`, one event per line: `{"t":"delta","text"}`, `{"t":"thinking","text"}`
  (reasoning models), `{"t":"done","reason","promptTokens","evalTokens","durationMs"}`,
  `{"t":"error","message"}`. Before streaming: 404 feature off, 422 shape (last message must be the
  user's; at most 40 messages, 2 images each), 413 total text over `AI_MAX_CHARS` or an image over
  `AI_MAX_IMAGE_MB`, 422 image not base64 PNG/JPEG, 400 unknown model or image to a text model,
  429 the user already has an answer streaming, 503 Ollama unreachable.
- The server prepends its system prompt (`ai/prompt.py`) and sends `options.num_ctx =
AI_NUM_CTX` (Ollama's default context silently truncates) and `keep_alive` when set.
- **Transport**: `http.client` (no new dependency), one connection per chat. The blocking read runs
  in the threadpool; when the client disconnects, the response generator's `finally` calls
  `abort()`, which shuts the socket down, so the read fails and Ollama stops generating. Redirects
  are not followed. Userinfo in `OLLAMA_URL` becomes Basic auth; a path prefix is kept.
- `OLLAMA_URL` is trusted operator config, so private and loopback addresses are allowed (unlike
  per-alert webhook URLs).
- Upstream outcomes count in `tickerglass_upstream_requests_total{provider="ollama"}`.
- `AI_PROVIDER=demo` (`ai/demo.py`): canned streamed replies echoing what was received, two models
  (one "vision"). Used by tests and for trying the UI.
- nginx: `location = /api/ai/chat` with `client_max_body_size 16m`, `proxy_buffering off`,
  `proxy_read_timeout 1h` (a cold model load can exceed the 60 s default). The API also sends
  `X-Accel-Buffering: no` for other proxies.

## 3. The brief (`packages/ai-context`)

Pure TypeScript, no engine dependency: `buildChartBrief(input, { maxTokens })` takes columnar bars
(the `SeriesStore` shape), study outputs aligned to the bars, drawings and a focus (`selection` or
`visible`, inclusive bar times) and returns `{ text, stats, approxTokens, focusBars, focusBucket,
trimmed }`.

```
CHART CONTEXT
Symbol, interval, timezone / focus range and bar count / all data on chart, latest close / notes
FOCUS STATS        computed exactly: change, high/low + dates, up/down bars, biggest moves,
                   volatility, ATR(14), regression slope + R², volume vs prior, swings, before/after
BEFORE FOCUS       ~100 bars before, aggregated to ~25 rows (CSV)
FOCUS BARS         CSV, one row per bar up to 250 (else N bars per row), indicator columns
INDICATORS         values at the focus end
USER DRAWINGS      near the focus; freehand ones shortened to first/last point
END CHART CONTEXT
```

Times are in the chart's timezone; prices use the symbol's precision. Tokens are estimated at 3
characters each; over budget, reductions apply in order (fewer focus rows, shorter lead-in, no
indicator columns, no lead-in, fewer drawings). Statistics are always kept. The web app's budget is
`(AI_NUM_CTX - 2500) × 0.7` tokens.

## 4. Web (`apps/web/src/ai/`)

- Navigator section `ai`, hidden unless `/ai/status` says enabled. Model picker, conversation with
  streamed Markdown (own renderer that builds React elements only, no HTML), Stop, new
  conversation, suggestions, context disclosure per question.
- `context.ts` reuses `exportInputFromChart` (displayed bars + study plots, offsets applied) and
  `chart.getDrawings()`; adds notes for transformed chart types and the currency.
- A brief is sent when the symbol, interval, focus or last bar changed since the last one; only the
  latest brief stays in full in later requests (earlier ones become a short marker). The latest
  picture is resent with every follow-up because Ollama keeps no state.
- Synced setting `ai.prefs`: `{ model, includeImage }`.
- Picture (`image.ts`): `chart.takeScreenshot()`, or for a selection `takeScreenshot({ from, to,
minAspect: 0.9 })` (crop to the bars plus padding, widened so a narrow selection keeps its
  neighbours, legend left out, price axis kept); at most 1280 px; PNG, else JPEG / smaller, to fit
  `maxImageBytes`.

## 5. Engine: range selection

`RANGE_TOOL = 'range-select'` (generic, not AI-specific): drag across bars; on release the bars
whose slot centre is inside become the selection (clamped to real bars), drawn as a band over every
pane until Esc, a symbol/interval change, or `setRangeSelection(null)`. Event `rangeSelected
{ range: {from, to} | null }`; `getRangeSelection()` / `setRangeSelection()` (silent). The tool
returns to the cursor after one selection. Web: `attachAi` mirrors it into the AI store, opens the
panel and focuses the question box; armed by the panel, <kbd>Alt</kbd>+<kbd>Q</kbd>, the palette
or the chart context menu.

## 6. Not done / later

- Tool calling (the model asking for more bars or another indicator).
- Saved conversations.
- Other backends (OpenAI-compatible servers such as llama.cpp or LM Studio) behind the same
  `AiBackend` protocol.
- A left-toolbar button for the range tool.
