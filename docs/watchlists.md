# Watchlist plain-text format

TickerGlass plain-text watchlist format: one `EXCHANGE:TICKER` per entry, comma or newline separated,
optional `###Section` headers. The watchlist menu imports and exports `.txt` files in this format
(`apps/web/src/watchlist/model.ts`: `parseTxt`, `formatTxt`).

Example:

```
###Tech
NASDAQ:AAPL, NASDAQ:MSFT
###Europe
LSE:SHEL
XETR:SAP
```

- Entries are split on commas, `\r` and `\n`; blank entries are ignored.
- A bare ticker (no `EXCHANGE:` prefix) is accepted as is.
- Exchange prefixes are mapped to Yahoo symbols (for example `LSE:SHEL` becomes `SHEL.L`). Entries whose
  prefix cannot be mapped keep the bare ticker and are reported as unmapped after the import.
- Entries that are not valid symbols are skipped and counted; duplicates are dropped.
- Export writes one comma-separated line with sections as `###Title`.
