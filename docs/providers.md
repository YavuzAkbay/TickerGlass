# Market data providers

The API fetches market data through one provider, chosen with `MARKET_PROVIDER` in `.env`
(read at start-up; restart the API after changing it). The web app shows the active provider and a
connection test on the first visit and under **More → Data source…**.

| `MARKET_PROVIDER` | Provider      | Network | Notes                                                                                                    |
| ----------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `yahoo` (default) | Yahoo Finance | yes     | Through [yfinance](https://github.com/ranaroussi/yfinance). Yahoo's terms allow personal use only.       |
| `demo`            | Demo data     | no      | A deterministic random walk per symbol (New York session hours). For trying the app, screenshots, tests. |

Bars are cached in the database per symbol and interval, so after switching providers the cache still
holds the old provider's bars until they are refreshed or pruned. Delete the database volume for a clean
start if that matters.

## Endpoints

- `GET /api/providers`: `{ active, setting, providers: [{ id, name, description, network, terms }] }`.
  `active` is `null` when the API was built with a custom provider (tests).
- `POST /api/providers/test`: asks the active provider for one quote of its probe symbol, through the
  upstream guard (it counts as one upstream request). `{ ok: true, symbol, price, latencyMs }` or
  `{ ok: false, symbol, error }`.

## Adding a provider

1. Implement `MarketDataProvider` (`api/src/tickerglass_api/providers/base.py`) in a new module next to
   `yahoo.py`: `history`, `symbol_info`, `search`, `quotes`, `extended_quotes`, `events`, `news`,
   `fundamentals`. Raise `SymbolNotFound`, `RateLimited` or `UpstreamUnavailable` as the docstrings say;
   the upstream guard and the caches depend on them.
2. Implement a `LiveSource` (`live.py`) for streaming ticks. A provider without streaming can return a
   source whose `listen` waits until `close`; the hub then polls quotes.
3. Add a `ProviderSpec` to `PROVIDERS` in `providers/registry.py` and the id to
   `Settings.market_provider` in `settings.py`.
4. Add tests next to `tests/test_demo.py`; `providers/demo.py` is a compact reference implementation.
