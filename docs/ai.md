# Ask AI about the chart

Ask a language model questions about the chart you are looking at: "What happened here?", "Where
are support and resistance?", "What do the indicators say?". The model runs on your own hardware
through [Ollama](https://ollama.com). Your charts and questions go to that Ollama server only, never
to a cloud service.

The design notes are in [design/local-ai.md](design/local-ai.md).

## How it works

1. You open **Ask AI** in the right-hand navigator (the sparkle icon) and type a question.
2. The browser condenses the chart into a short text brief:
   - the symbol, interval and timezone;
   - statistics worked out in code: change, high and low with dates, biggest moves, volatility,
     ATR, trend slope, volume against the bars before, swing highs and lows, what came before and
     after;
   - the bars as a small table, with a column for every indicator on the chart;
   - your drawings near that part of the chart.
3. If the model can read images, a picture of the chart goes along too.
4. TickerGlass sends this to Ollama with instructions to use only the given data, to quote dates
   and prices from it, and not to give buy or sell advice. The answer streams back as it is
   written.

The model never sees your other charts, watchlists, portfolio or account. Click the context line
above any of your questions to see exactly what was sent.

## Set it up

### 1. Run Ollama and pull a model

Install Ollama on a machine with enough memory (a GPU or Apple Silicon helps a lot, but is not
required), then pull a model.

Two rules:

1. **7 billion parameters or more; 9B and up is better.** Smaller models misread numbers and
   usually ignore the chart tools.
2. **Tool calling** (Ollama's _tools_ capability) is needed for the AI to add indicators and draw.
   Settings → AI marks such models **chart tools**, and vision models **reads images**.

Recommended as of November 2026 (all with tool calling, vision and reasoning; Ollama downloads are 4-bit, the Unsloth rows
show their quant in the tag; allow 1–3 GB more for the context window; on Apple Silicon unified memory counts):

| Free memory (RAM or VRAM) | Model                                                                       | Download | Notes                                                                    |
| ------------------------- | --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| 8 GB                      | `qwen3.5:9b`                                                                | 6.6 GB   | Smallest model we recommend. Tools, vision, reasoning.                   |
| 8 GB                      | Unsloth Qwen3.8 27B, `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ2_XXS`            | 7.2 GB   | A 27B model at 2-bit: more knowledge, but 2-bit costs some precision.    |
| 12–16 GB                  | `gemma4:12b`                                                                | 7.7 GB   | Google Gemma 4. Tools and vision, leaves room for a 16K context.         |
| 12–16 GB                  | Unsloth Gemma 4 26B-A4B, `hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_XXS` | 11.4 GB  | Mixture of experts: 26B of knowledge, only 4B active per token, so fast. |
| 16–24 GB                  | Unsloth Qwen3.8 27B, `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL`            | 13.1 GB  | The same 27B at 3-bit, in about 13 GB.                                   |
| 24 GB +                   | `qwen3.8:27b`                                                               | 18 GB    | Best all-round pick: analysis, tool calling, chart pictures, reasoning.  |
| 24 GB +                   | `gemma4:26b`                                                                | 16 GB    | Faster alternative (mixture of experts).                                 |
| 32 GB +                   | `qwen3.6:35b`                                                               | 23 GB    | Larger mixture-of-experts model when you have the memory.                |

```sh
ollama pull qwen3.5:9b
# Unsloth Dynamic quants straight from Hugging Face:
ollama pull hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL
```

[Unsloth](https://unsloth.ai) Dynamic quants keep the important layers at higher precision, which
is how a 27B model runs on 8–16 GB. After pulling one from Hugging Face, check it shows the **chart
tools** tag in Settings → AI (Ollama reads the capability from the model's chat template).

### 2. Connect it in the app

As an admin, open **Settings → AI** (or click **Ask AI** in the right-hand navigator and then
**Connect Ollama…**):

1. The tab looks for Ollama by itself (this machine, the Docker host, an `ollama` container). If it
   is somewhere else, type its address, e.g. `http://192.168.1.10:11434`, and press **Test**.
2. The installed chat models are listed with their size and whether they read images. Leave
   **Users can pick any installed model** ticked, or untick it and choose which ones.
3. Pick a **Default model** and press **Connect**.

No restart is needed. Models you `ollama pull` later appear in this list and in everyone's model
picker straight away. **Turn off** disconnects.

#### Or with an environment variable

Set `OLLAMA_URL` for the API (in `.env`, the `api` container or the all-in-one image) and restart.
This wins over the in-app settings, which then show it read-only:

| Where Ollama runs                          | `OLLAMA_URL`                        |
| ------------------------------------------ | ----------------------------------- |
| Same machine, API run without Docker       | `http://localhost:11434`            |
| Same machine, TickerGlass in Docker        | `http://host.docker.internal:11434` |
| Another machine on your network            | `http://192.168.1.10:11434`         |
| The bundled container (`--profile ollama`) | `http://ollama:11434`               |

Ollama listens only on `127.0.0.1` by default. When TickerGlass runs in Docker or on another
machine, start Ollama with `OLLAMA_HOST=0.0.0.0` (on Linux: `systemctl edit ollama` and add
`Environment="OLLAMA_HOST=0.0.0.0"`). Do not expose port 11434 to the internet: Ollama has no
sign-in of its own.

The bundled `docker-compose.yml` already maps `host.docker.internal` to the host on Linux. To run
Ollama in the same stack instead:

```sh
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3.5:9b
# .env: OLLAMA_URL=http://ollama:11434
```

To try the interface without any model, set `AI_PROVIDER=demo`: answers are canned and only echo
what was received.

**Context window.** The model holds the chart data, the conversation, its reasoning and its answer
in one context window; there is no separate limit on reasoning or answer length. Settings → AI sets
the default (16K); each user can pick their own in the Ask AI panel (**Context window**, 8K–128K,
saved with their settings). Reasoning models (Qwen 3.x, Gemma 4) and chart tools work best with
32K or more. A larger window needs more memory on the Ollama machine. When it fills up, the answer
says so instead of stopping silently.

### 3. Optional settings

| Variable           | Default   | Meaning                                                                              |
| ------------------ | --------- | ------------------------------------------------------------------------------------ |
| `OLLAMA_URL`       | unset     | Ollama base URL; wins over Settings → AI. Unset: the in-app setting decides.         |
| `AI_PROVIDER`      | unset     | `ollama` or `demo`. Unset: `ollama` when `OLLAMA_URL` is set.                        |
| `AI_MODELS`        | all       | Comma list of the models users may pick, e.g. `qwen3.5:9b,qwen3.8:27b`.              |
| `AI_DEFAULT_MODEL` | first one | Preselected model.                                                                   |
| `AI_NUM_CTX`       | `16384`   | Context window sent to Ollama. The chart brief is sized to fit it.                   |
| `AI_TIMEOUT_S`     | `600`     | Seconds to wait for the answer to start (loading a model counts) and between chunks. |
| `AI_KEEP_ALIVE`    | Ollama's  | How long Ollama keeps the model loaded after a question: `5m`, `1h`, `-1` (forever). |
| `AI_MAX_IMAGE_MB`  | `4`       | Largest chart picture accepted.                                                      |
| `AI_MAX_CHARS`     | `400000`  | Largest conversation accepted, in characters.                                        |

A larger `AI_NUM_CTX` lets more bars through at full detail but uses more memory on the Ollama
machine. Ollama's own default is much smaller and would silently cut the data, so TickerGlass always
sends this value.

## Use it

- **The visible range.** With nothing selected, questions are about the part of the chart on
  screen. Scroll or zoom first to frame what you mean.
- **A range you pick.** Click **Select range** in the panel, press <kbd>Alt</kbd>+<kbd>Q</kbd>, or
  right-click the chart and choose **Ask AI about a range…**, then drag across the bars. A shaded
  band marks them and the panel shows a chip such as `3 Aug – 10 Sep · 29 bars`. Clear it with
  **×**, <kbd>Esc</kbd> on the chart, or by changing symbol or interval.
- **Follow-up questions** keep the conversation. The chart data is sent again only when the
  symbol, interval or range changes; older chart data in the conversation is then replaced by a
  short marker to save space.
- **Chart picture.** With a model that reads images, tick **Send a picture of the chart too**. For
  a selection the picture is cropped to the selected bars plus some on each side, with the band
  visible.
- **Stop** ends an answer; Ollama stops generating straight away. The trash button starts a new
  conversation. Conversations are kept per chart until you reload the page; they are not saved.
- The chosen model and the picture setting are saved with your settings and follow you to other
  devices.

## Let the AI work on the chart

Models with tool support (Settings → AI and the model picker mark them **chart tools**; e.g.
`qwen3.5`, `qwen3.8`, `gemma4`) can change the chart while they answer. Ask for example:

- "Find bullish and bearish RSI divergences and draw them."
- "Add a 20-day Bollinger Band and tell me if price is stretched."
- "Mark the main support and resistance levels."
- "Analyze this stock fundamentally. Does it look cheap or expensive?"
- "Plot revenue and P/E under the chart."

The model only changes the chart when you ask it to (draw, mark, show, add, remove…); a question
like "summarize the chart" is answered in words. With **Draw** off it still uses the read-only
tools (fundamentals, levels, swings, divergences) but cannot change the chart. Its tools:

| Tool                   | What it does                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `list_indicators`      | Reads the indicators on the chart and their latest values. Read-only.                            |
| `get_fundamentals`     | Reads the symbol's financial statements and valuation (see below). Read-only.                    |
| `find_levels`          | Finds support and resistance: prices where swings turned at least twice. Read-only.              |
| `find_swings`          | Lists swing highs and lows of price or an indicator, including one still forming. Read-only.     |
| `find_divergences`     | Finds regular and hidden, bullish and bearish divergences against RSI, MACD, … Read-only.        |
| `draw_level`           | Draws a found level as a line from where it formed (green support, red resistance).              |
| `draw_divergence`      | Draws a found divergence on price and on the oscillator (adds the oscillator if it is missing).  |
| `add_indicator`        | Adds RSI, MACD, … Volume, or a financial indicator (revenue, EPS, P/E, P/S, P/B, ROE, margins…). |
| `remove_indicator`     | Removes an indicator.                                                                            |
| `draw_trend_line`      | Draws a line between two points on price or an indicator pane.                                   |
| `draw_horizontal_line` | Draws a level at a given price.                                                                  |
| `clear_ai_drawings`    | Removes the lines it drew earlier in the conversation.                                           |

Levels, swings, divergences and fundamentals are **computed by TickerGlass**, not guessed by the
model:

- **Fundamentals:** from the provider's quarterly and annual statements (the same rows, trailing
  twelve months and split handling as the Financials indicators): TTM revenue, net income, EPS,
  cash flow, margins, year-over-year growth, ROE, cash, debt, debt to equity, current ratio; P/E,
  P/S, P/B, PEG, earnings and free cash flow yield at the latest price, and P/E and P/S at each past
  period end (at that day's close on the chart, so load a long daily range for more history); the
  last 8 quarters and 4 fiscal years. Needs a provider with financial statements (Yahoo); there is
  no peer, sector or estimate data, so valuation is judged against the stock's own history.

- **Levels:** swing highs and lows (3 bars on each side, plus a swing still forming at the end)
  within 4% of each other form a level; at least two touches; ranked by touches, use as both
  support and resistance, recency and distance from the price, over the price range of the last
  250 bars. A level is drawn from its first touch.
- **Divergences:** the latest swing (even one still forming) is compared with the earliest swing
  5–60 bars before it that still makes a clean line to it, against RSI 14 or the MACD histogram
  (the MACD line on request) computed directly; the indicator is added only when a divergence is
  drawn. Two swings count only if they belong to one move (no lows on either side of a whole
  rally), and each swing starts at most one divergence. Most recent first.

The model decides what to look for, draws what was found and explains it. Each action shows as a
line under your question ("Added RSI 14 · Found 3 divergences"), and everything one answer changed
is a single undo step; **Undo AI changes** under the answer removes it too. Untick **Let AI add
indicators and draw on the chart** in the panel to keep the model to words only.

Small models usually ignore the tools and only talk: in our tests `qwen2.5:0.5b` wrote Python code
instead of calling them, while a 26B model added RSI, found and drew the divergences and explained
them. Use 7B or larger, ideally 9B+.

## Not financial advice

Ask AI describes what a chart shows. **Nothing it says or draws is financial advice, an investment
recommendation or consultation.** Answers are generated automatically by a language model, can be
wrong or invented, and nobody reviews them. The model is instructed never to recommend buying,
selling or holding, and never to suggest entries, exits, stops, position sizes or targets; when
asked, it says that it is not financial advice and only describes the chart. The project's authors
are not licensed advisers and accept no liability for decisions made with it; see the
[disclaimer in the README](../README.md#disclaimer).

## Good to know

- The model can be wrong, especially small ones. The statistics in the brief are computed exactly;
  compare the answer with them (click the context line) when a number matters. Nothing here is
  financial advice.
- The model only knows what is in the brief: no news, fundamentals or other symbols.
- On Heikin Ashi, Renko and other transformed chart types the brief says the bars are not traded
  prices.
- Each user can have one answer being written at a time. Several users share the Ollama machine;
  Ollama queues their questions.
- When Ollama is down, the panel says so and offers **Retry**.
