# Design: portfolio and trade journal (roadmap v2 · 1.2)

Status: `done` (v1). User guide: [../portfolio.md](../portfolio.md). This note is the contract shared by the API, `packages/portfolio`, and the web UI.

## Split of responsibilities

| Layer                                      | Owns                                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API** (`api/`)                           | Storage + validation: portfolios, transactions, journal entries, journal screenshots. Import endpoint with `externalId` dedupe and undo by batch. Export/import bundle. No P&L math.     |
| **`packages/portfolio`** (pure TS, no DOM) | Ledger (lots, cost basis, realized/unrealized, cash per currency), valuation + allocation, performance series (TWR) vs benchmark, R-multiple, broker CSV mappers.                        |
| **Web** (`apps/web/src/portfolio`)         | Navigator section `portfolio`: Holdings / Activity / Performance / Journal. Fetches rows from the API, live prices from `useLiveQuotes`, daily bars from the bars API, runs the package. |

Why math on the client: live quotes are already there, the backtester set the pure-TS precedent,
one implementation, easy to unit test. The server never needs P&L in v1.

Single-user app (no user scoping). All JSON is camelCase (existing `ApiModel`).

## Data model (API)

Numbers are `Float` (double). Times are timezone-aware UTC. Symbols trimmed + upper-cased.
Currency is an ISO-4217 code, upper-case, 3 letters.

### `portfolios`

`id` (uuid str PK) · `name` (1..80) · `baseCurrency` (default `USD`) · `benchmark` (symbol, default
`SPY`, nullable = none) · `costMethod` (`fifo` | `average`, default `fifo`) · `revision` ·
`createdAt` · `updatedAt`.

### `portfolio_transactions`

`id` · `portfolioId` (FK cascade) · `kind` · `time` · `symbol` (nullable) · `quantity` ·
`price` · `amount` · `fee` (≥0, default 0) · `currency` · `note` (short text ≤2000, nullable) ·
`source` (`manual` | `import:<broker>`) · `externalId` (nullable; unique per portfolio) ·
`importBatch` (nullable str) · `revision` · `createdAt` · `updatedAt`. Index (portfolioId, time).

Field semantics by `kind` (server validates presence/sign; extra fields must be null):

| kind                 | symbol | quantity                                              | price | amount   | cash effect (in `currency`)            |
| -------------------- | ------ | ----------------------------------------------------- | ----- | -------- | -------------------------------------- |
| `buy`                | req    | >0                                                    | ≥0    | null     | −(q·p + fee)                           |
| `sell`               | req    | >0                                                    | ≥0    | null     | +(q·p − fee)                           |
| `dividend`           | req    | null                                                  | null  | >0 gross | +(amount − fee); fee = withholding tax |
| `split`              | req    | >0 = ratio (new per old: 4 = 4-for-1, 0.1 = 1-for-10) | null  | null     | none                                   |
| `fee`                | opt    | null                                                  | null  | >0       | −amount                                |
| `interest`           | null   | null                                                  | null  | >0       | +(amount − fee)                        |
| `cashIn` / `cashOut` | null   | null                                                  | null  | >0       | ±amount                                |

### `journal_entries`

`id` · `portfolioId` (FK cascade) · `transactionId` (FK, `SET NULL`, nullable) · `symbol`
(nullable) · `noteId` (FK `notes.id`, `SET NULL`, nullable; **reuse notes**: the client creates
the note through `/api/notes` with the entry's symbol and `kind: 'journal'`; `noteId` must reference a
note of kind `journal` (422 otherwise), so the entry can never link, edit or delete a Notes-panel
note. Journal notes are hidden from `GET /notes` unless `?kind=journal|all`, so they never reach the
Notes panel) ·
`setup` (≤80, nullable) · `tags` (JSON list of str, ≤20 tags, each ≤40, trimmed, deduped) ·
`stop` (initial stop price, nullable; drives R) · `rMultiple` (manual override, nullable) ·
`revision` · `createdAt` · `updatedAt`. Deleting an entry deletes its linked note.

### `journal_screenshots`

`entryId` (PK, FK cascade) · `mime` (`image/png|jpeg|webp`) · `data` (LargeBinary, ≤5 MB) ·
`createdAt`. Journal entry JSON carries `hasScreenshot: bool`.

## Routes (`/api`)

- `GET/POST /portfolios` · `GET/PUT/DELETE /portfolios/{id}` — PUT is revision-checked (409 + current
  row on stale revision, same as notes).
- `GET /portfolios/{id}/transactions?symbol=` (ordered by time, id) · `POST` same path.
- `PUT/DELETE /transactions/{id}` (PUT revision-checked).
- `POST /portfolios/{id}/transactions/import` body `{ transactions: TxIn[], dryRun?: bool, source: "import:<broker>" }`
  → `{ batch, created, skipped, errors: [{index, message}] }`. Validates all rows first; any error
  → 422 with the `errors` list and nothing written. Rows whose `externalId` already exists in the
  portfolio (or repeat inside the payload) are `skipped`. Max 20 000 rows.
- `DELETE /portfolios/{id}/imports/{batch}` → removes that batch (undo import), returns `{deleted}`.
- `GET/POST /portfolios/{id}/journal` · `PUT/DELETE /journal/{id}` (PUT revision-checked).
- `PUT /journal/{id}/screenshot` (raw body, `Content-Type` image/*) · `GET` (bytes, correct type,
  `Cache-Control: private, max-age=0`) · `DELETE`.

Export bundle (`/api/export`, `/api/import`): adds `portfolios`, `portfolioTransactions`,
`journalEntries` (screenshots as base64 `screenshot: {mime, data}` inside the entry). Optional
fields defaulting to `[]` so v1 bundles still import. Replace mode clears these tables too.

## `packages/portfolio` API

```ts
export type TxKind = 'buy'|'sell'|'dividend'|'split'|'fee'|'interest'|'cashIn'|'cashOut';
export interface Tx { id: string; kind: TxKind; time: string; symbol: string|null;
  quantity: number|null; price: number|null; amount: number|null; fee: number; currency: string; }
export type TxIn = Omit<Tx,'id'> & { externalId?: string|null; note?: string|null };

computeLedger(txs: Tx[], opts: { costMethod: 'fifo'|'average' }): Ledger
//  Ledger: positions (symbol, currency, quantity, costBasis, avgCost, realized, dividends, fees,
//  openLots), closedLots [{openTxId, closeTxId, quantity, openPrice, closePrice, pnl, openTime, closeTime}],
//  cash: Record<ccy, number>, totals per ccy (realized, dividends, interest, fees, deposits, withdrawals),
//  issues: [{txId, code: 'oversell'|'noPosition'|'badSplit', message}]
valuate(ledger, prices: Record<symbol, number|undefined>, fx: (ccy: string) => number|undefined, base: string): Valuation
//  rows with last, marketValue, unrealized, unrealizedPct, weight, dayChange (if prevClose given);
//  totals in base currency; rows whose currency has no FX are flagged and excluded from totals.
performance(txs, input: { closes: Record<symbol, Bar[]>, fx: Record<ccy, Bar[]>, benchmark?: Bar[], base: string,
  costMethod }): { points: {t, value, netFlow, twr, benchmark?}[], stats: {twr, benchmarkReturn?, maxDrawdownPct} }
rMultiple(stop: number|null, override: number|null, closedLots for the entry's opening tx): number|null
detectBroker(csvText): BrokerId|null
parseBrokerCsv(csvText, broker: BrokerId|'auto'): { broker, transactions: TxIn[], warnings: string[] }
// BrokerId: 'ibkr' (Flex Query trades + cash CSV) | 'schwab' | 'degiro' | 'trading212' | 'generic'
```

Ledger rules:

- Sorted by (time, original order). Long-only in v1: selling more than held clamps to the held
  quantity and records an `oversell` issue (shorts are "Later").
- Splits multiply open lot quantities by the ratio and divide lot prices (basis unchanged).
- `average`: one pooled lot per symbol; realized = (price − avgCost)·q − fee. `fifo`: per-lot.
  Fees on buys go into the basis; fees on sells reduce realized. `closedLots` are always produced
  with FIFO matching (used for R-multiples even when the display method is `average`).
- Everything stays in the transaction's currency; conversion to base only at valuation/performance
  time, with the current FX (`{CCY}{BASE}=X` quote) and historical FX daily closes.
- Sub-unit quotes: Yahoo quotes LSE in `GBp`/`GBX` (pence), JSE in `ZAc`/`ZAC`, TASE in `ILA`. The web
  (`portfolio/subunit.ts`) divides such prices (live last/prevClose, and daily bars via the symbol's
  live quote currency, since bars carry none) by 100 when the position's ledger currency is the major
  unit (GBP/ZAR/ILS). A ledger kept in the sub-unit code itself is left unchanged. "Log trade for
  current symbol" prefills the major currency with the converted price.

Performance rules:

- Daily points from the first transaction to the last bar. Bars' `close` is split-adjusted, so
  holdings on day d are expressed in post-split shares (quantity × product of later split ratios).
- If the portfolio has any `cashIn`/`cashOut`, value = holdings + cash and external flows =
  deposits − withdrawals. Otherwise value = holdings only and flows = net trade cash (buy cost
  in, sell proceeds out); dividends/interest count as return either way.
- TWR chains daily sub-period returns `(V_t − F_t) / V_{t−1} − 1`; benchmark is normalized to the
  same start. Missing closes carry the last known close forward.

R-multiple: override wins; else with a stop and closed FIFO lots for the linked opening tx,
`R = Σpnl / (Σqty · |openPrice − stop|)`; else null.

## Web UI

Navigator section `portfolio` (Briefcase icon, `nav.portfolio`), panel CSS in the
`backtest.css` style (opaque docked panel, no glass — see Instrument Glass rules). Top bar: portfolio
picker, new / rename / settings (base currency, benchmark, cost method) / delete. Tabs:

1. **Holdings** — totals (value, day change, unrealized, realized, dividends, total return),
   allocation bar by symbol, rows (symbol, qty, avg cost, last, value, P&L, %, weight). Click opens
   the symbol on the active chart. Issues shown as a warning strip.
2. **Activity** — transaction list (newest first, filter by symbol/kind), add/edit form with
   kind-dependent fields, delete. **Import CSV**: pick file → broker auto-detect (override) →
   preview + warnings → dry run → import; recent batches with Undo.
3. **Performance** — SVG line: portfolio TWR vs benchmark; ranges 1M/3M/YTD/1Y/All; stats.
4. **Journal** — entries (filter by tag/setup), editor: linked transaction, setup, tags, stop, R
   (computed, override), note text (notes API, debounced save), "Attach chart" (screenshot of the
   active chart via `composeScreenshot` → PNG → PUT), thumbnail, remove.

Command palette: "Open portfolio", "Log trade for current symbol" (prefilled buy form).

## Later

Shorts and options; auto-import dividends/splits from provider events; tax-lot reports;
multiple-portfolio aggregate view; server-side valuation for alerts on P&L.
