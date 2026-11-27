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

Install Ollama on a machine with enough memory (a GPU helps a lot, but is not required), then pull
a model:

```sh
ollama pull qwen2.5:7b        # text: good with numbers, about 5 GB
ollama pull qwen2.5vl:7b      # can also read the chart picture, about 6 GB
```

| Model          | Reads images | Memory | Notes                                               |
| -------------- | :----------: | ------ | --------------------------------------------------- |
| `qwen2.5:7b`   |              | ~5 GB  | Good default for text-only answers.                 |
| `llama3.1:8b`  |              | ~5 GB  | Solid alternative.                                  |
| `qwen2.5vl:7b` |      ✅      | ~6 GB  | Reads the chart picture as well as the data.        |
| `gemma3:12b`   |      ✅      | ~8 GB  | Better answers, slower.                             |
| `qwen2.5:14b`  |              | ~9 GB  | Noticeably better reasoning if you have the memory. |

Models under about 3 billion parameters run fast but often misread the numbers. Use them only to
try the feature.

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
docker compose exec ollama ollama pull qwen2.5:7b
# .env: OLLAMA_URL=http://ollama:11434
```

To try the interface without any model, set `AI_PROVIDER=demo`: answers are canned and only echo
what was received.

### 3. Optional settings

| Variable           | Default   | Meaning                                                                              |
| ------------------ | --------- | ------------------------------------------------------------------------------------ |
| `OLLAMA_URL`       | unset     | Ollama base URL; wins over Settings → AI. Unset: the in-app setting decides.         |
| `AI_PROVIDER`      | unset     | `ollama` or `demo`. Unset: `ollama` when `OLLAMA_URL` is set.                        |
| `AI_MODELS`        | all       | Comma list of the models users may pick, e.g. `qwen2.5:7b,qwen2.5vl:7b`.             |
| `AI_DEFAULT_MODEL` | first one | Preselected model.                                                                   |
| `AI_NUM_CTX`       | `8192`    | Context window sent to Ollama. The chart brief is sized to fit it.                   |
| `AI_TIMEOUT_S`     | `180`     | Seconds to wait for the answer to start (loading a model counts) and between chunks. |
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
