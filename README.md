# TickerGlass

TickerGlass is a self-hosted stock charting and technical analysis app. Run it on your own computer or server with Docker Compose and use it in a browser. The application and its storage run on infrastructure you control. Yahoo Finance is the recommended default provider, but you can add or select another supported provider. Yahoo mode contacts Yahoo Finance for data; for a fully offline demo, select the generated demo provider.

Features include multiple chart types, drawing tools, indicators, symbol comparisons, alerts, watchlists, templates, and market replay. Watchlists can be imported and exported as plain text ([guide](docs/watchlists.md)). See [known limitations](docs/LIMITATIONS.md), [market data providers](docs/providers.md), and [caching](docs/caching.md).

![alt text](https://github.com/user-attachments/assets/1dbc8e17-66e8-4bc8-bc0a-9a4fa009fef0)

## Run with Docker Compose

Requirements: Docker Engine and the Docker Compose plugin.

```sh
git clone https://github.com/yavuzakbay/TickerGlass.git
cd TickerGlass
cp .env.example .env
docker compose up -d --build
```

Open <http://localhost:8080>. The API health endpoint is <http://localhost:8000/api/health>.

The web and API ports bind to localhost by default. To access TickerGlass from another device, configure a reverse proxy and change the port bindings in `docker-compose.yml` deliberately. Use HTTPS and suitable access controls before exposing a server to the internet. Do not expose the API port publicly by default.

SQLite data is stored in the persistent `api-data` Docker volume. Back up that volume regularly. To use PostgreSQL, follow the commented configuration in `.env.example` and start the optional database profile:

```sh
docker compose --profile postgres up -d --build
```

To stop the services while keeping data:

```sh
docker compose down
```

To delete the database volume and its data, use `docker compose down -v`.

## Market data and offline use

TickerGlass recommends Yahoo Finance through `yfinance` as its default provider. The API requests data from the provider for your instance; TickerGlass does not package, own, or redistribute Yahoo Finance market data. You can implement or configure another provider; see [provider configuration](docs/providers.md). Each provider has its own availability, terms, and data rights, which are outside this project's control. Review the applicable terms and laws for your location and use case before accessing, displaying, storing, or sharing provider data.

For generated demo prices without market-data network requests, set this in `.env` and restart:

```dotenv
MARKET_PROVIDER=demo
```

To use a [Twelve Data](https://twelvedata.com) account instead, set `MARKET_PROVIDER=twelvedata`, `TWELVEDATA_API_KEY` and your `TWELVEDATA_PLAN` (`basic`, `grow`, `pro`, ...) and restart; the app paces its requests to the plan's credits. Switching provider clears the cached market data, not your own data.

Demo prices are synthetic and are not real quotes. The app itself can still use optional integrations you configure, such as Telegram, email, or webhooks for alert delivery. See [provider configuration](docs/providers.md).

## Alert notifications

Alerts are evaluated by the `alerts` service and continue to run while the browser is closed. In-app, sound, and browser notifications need no external service. Telegram, email, and webhooks are optional and require credentials or endpoints that you provide in `.env`. Keep that file private; do not commit secrets. Setup details are in [the alerts guide](docs/alerts.md#4-notification-delivery).

## Configuration

Copy `.env.example` to `.env`. Common settings include:

| Variable | Purpose |
| --- | --- |
| `WEB_PORT` | Local web UI port (default `8080`) |
| `API_PORT` | Local API port (default `8000`) |
| `MARKET_PROVIDER` | `yahoo` (default), `twelvedata` (needs `TWELVEDATA_API_KEY`) or generated `demo` data |
| `DATABASE_URL` | Optional database connection; SQLite is the default |

The example file documents database and alert settings. Avoid sharing `.env` because it may contain passwords, tokens, and webhook secrets.

## Development

Requirements: Node.js 22+, [pnpm](https://pnpm.io/), and [uv](https://docs.astral.sh/uv/).

```sh
pnpm install
cd api && uv sync && cd ..
```

Run the API in one terminal and the web app in another:

```sh
cd api && uv run uvicorn tickerglass_api.app:app --reload
```

```sh
pnpm dev
```

The web development server runs on port 5173 and proxies API and WebSocket requests to port 8000.

## Project layout

| Path | Contents |
| --- | --- |
| `apps/web` | React application and chart interface |
| `packages/engine` | Framework-independent Canvas 2D chart engine |
| `packages/indicators` | Indicators shared by the web app and alert service |
| `services/alerts` | Server-side alert evaluation |
| `api` | FastAPI market data API, caching, and storage |

## Privacy

Self-hosting lets you control where the application server and database run. Browser preferences and some chart data are also kept in that browser's local storage. With the default Yahoo provider, your server contacts Yahoo Finance for market data. If you configure notification integrations, alert messages are sent to the services you select. Review the code and configuration for your deployment before making privacy claims about a particular setup.

## Disclaimer

TickerGlass is provided for informational and educational purposes. It is not investment, financial, tax, or legal advice, and it does not recommend buying or selling any security. Market data may be delayed, incomplete, inaccurate, or unavailable. You are responsible for your decisions and for checking data before relying on it.

TickerGlass is independent and is not affiliated with or endorsed by Yahoo or any other data provider. Product names and trademarks belong to their respective owners. This project does not grant rights to third-party data or trademarks. Check each provider's terms before accessing, storing, displaying, or sharing its data.

## License

TickerGlass is licensed under the [GNU Affero General Public License, version 3](LICENSE). You may use, modify, and share the software under that license. If you modify it and let people interact with your modified version over a network, AGPL-3.0 requires you to offer those users the corresponding source code under the license terms. See the license text for the complete terms.

Third-party dependencies and data providers may have separate terms. This README is project information, not legal advice. No README wording can guarantee that a project or its users will never face a legal claim; review dependency, data-provider, and trademark obligations for your intended use.
