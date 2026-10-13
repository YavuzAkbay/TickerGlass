# InvestOpen

Open-source, self-hosted charting and technical-analysis platform that runs in your browser.
It aims for feature parity with professional charting tools: multiple chart types, drawing
tools, indicators, compare, alerts, watchlists, templates, and market replay. Market data
comes from Yahoo Finance via [yfinance](https://github.com/ranaroussi/yfinance).

> **Status:** early development. See [docs/ROADMAP.md](docs/ROADMAP.md) for progress.

## Disclaimer

- InvestOpen is **not affiliated with, endorsed by, or connected to reference, Yahoo, or
  any data vendor.** All trademarks belong to their owners.
- Yahoo Finance data is provided under Yahoo's terms, which allow **personal use only**.
  Each user runs their own instance and fetches data for themselves. Do not run a public
  instance that redistributes this data.
- Nothing here is financial advice. Data may be delayed, incomplete, or wrong.

## Quick start (Docker)

```sh
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:8080. The API is at http://localhost:8000/api/health.

Data is stored in SQLite in the `api-data` volume. To use Postgres instead, see `.env.example`.

## Development

Requirements: Node 22+, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/).

```sh
pnpm install
cd api && uv sync && cd ..

# terminal 1: API on :8000
cd api && uv run uvicorn investopen_api.app:app --reload

# terminal 2: web app on :5173 (proxies /api and /ws to :8000)
pnpm dev
```

Checks:

```sh
pnpm lint && pnpm typecheck && pnpm test
cd api && uv run ruff check . && uv run mypy && uv run pytest
```

### Layout

| Path                  | What                                           |
| --------------------- | ---------------------------------------------- |
| `apps/web`            | React app shell (toolbars, panels, dialogs)    |
| `packages/engine`     | Framework-free Canvas2D chart engine           |
| `packages/indicators` | Indicator library, shared by web and alerts    |
| `services/alerts`     | Node service that evaluates alerts server-side |
| `api`                 | FastAPI data API (yfinance, cache, storage)    |

## License

[AGPL-3.0](LICENSE). If you run a modified version for others, including as a network
service, you must publish your source under the same license.
