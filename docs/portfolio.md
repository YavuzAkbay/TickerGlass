# Portfolio and trade journal

Track holdings, cost basis, P&L, dividends and performance against a benchmark, and keep a journal of
your trades. Open the **Portfolio** section in the navigator (briefcase icon) and create a portfolio.

Code: `packages/portfolio` (ledger, valuation, performance, R-multiples, broker CSV parsers; pure
TypeScript), `apps/web/src/portfolio` (panel), `api/src/tickerglass_api/routes/portfolio.py` (storage).
Design note: [design/portfolio.md](design/portfolio.md).

## 1. Portfolios

Each portfolio has a name, a **base currency** (totals are shown in it), a **benchmark** symbol
(default `SPY`, can be empty) and a **cost method**:

- **FIFO**: sells close the oldest lots first.
- **Average**: one pooled cost per symbol.

Changing the cost method only changes the numbers shown. Nothing stored is rewritten.

## 2. Transactions (Activity tab)

| Kind               | Fields                         | Cash effect                    |
| ------------------ | ------------------------------ | ------------------------------ |
| Buy                | symbol, quantity, price, fee   | −(quantity × price + fee)      |
| Sell               | symbol, quantity, price, fee   | +(quantity × price − fee)      |
| Dividend           | symbol, gross amount, withheld | +(amount − withheld)           |
| Split              | symbol, ratio                  | none (4 = 4-for-1, 0.1 = 1:10) |
| Fee                | amount, optional symbol        | −amount                        |
| Interest           | amount, withheld               | +(amount − withheld)           |
| Deposit / Withdraw | amount                         | ±amount                        |

Every transaction keeps its own currency. Totals are converted to the base currency at the current
FX rate (`EURUSD=X`-style quotes). A row whose currency has no FX quote is flagged and left out of
the totals. Quotes in pence or cents (`GBp`, `ZAc`, `ILA`) are converted to the major unit
automatically.

Holdings are long-only. If you sell more than you hold (common when an export starts after your first
buy), the position is clamped to zero and a warning appears. Cash still gets the full proceeds, so it
matches your broker.

**Log trade for current symbol** (command palette) opens a buy form prefilled with the chart's symbol
and its live price.

## 3. Importing broker CSVs

**Activity → Import CSV**: pick a file. The broker is detected automatically, and you can override it.
Before anything is written you see a preview, the parser's warnings, and a dry run. Supported formats:

| Broker      | File                                    | Notes                                                                       |
| ----------- | --------------------------------------- | --------------------------------------------------------------------------- |
| IBKR        | Flex Query CSV (Trades, Cash)           | stocks only; options, futures and FX trades are skipped with a warning      |
| Schwab      | Transactions export                     | splits only when the description states the ratio; otherwise add it by hand |
| DEGIRO      | Transactions.csv, Account.csv           | symbols are ISINs (rename to tickers to get prices)                         |
| Trading 212 | History export                          | UK tickers usually need a `.L` suffix for quotes                            |
| Generic     | any CSV with date/type/symbol/qty/price | columns matched by name; set date order and decimal mark when asked         |

The broker mappers are best-effort and have not been verified against every export version. Check the
preview, and please report files that parse wrongly.

**Re-importing is safe.** Every imported row gets a stable id built from the broker's own id or
from the raw cells. Rows you already imported are skipped, so overlapping exports don't create
duplicates. Each import is a batch: **Imports → Undo** removes exactly that batch. Withholding tax
arrives as a separate fee row.

## 4. Holdings

Totals: value, day change, unrealized and realized P&L, dividends, total return, cash. Then an
allocation bar and one row per position. Click a row to open the symbol on the chart.

The day change uses the previous close for all shares, including shares bought today.

## 5. Performance

A time-weighted return (TWR) of the portfolio against the benchmark over 1M / 3M / YTD / 1Y / All,
from daily closes, with max drawdown.

- With deposits and withdrawals recorded, value = holdings + cash, and deposits and withdrawals are
  the external flows.
- Without them, value = holdings (+ income received), and buys and sells are the flows.
- Deposits and buys count as invested from the start of their day. Withdrawals and sells count at
  the end of it.
- If the recorded cash goes clearly negative (deposits are missing from the history), the tab falls
  back to the holdings-only method and says so.

Record every split. Charts use split-adjusted closes, so a missing split shows up as a jump.

## 6. Journal

A journal entry can link to a buy and holds a setup, tags, the initial stop, a note and a chart
screenshot (**Attach chart** captures the active chart). Filter the list by tag or setup.

**R-multiple** = realized P&L of the shares opened by the linked buy ÷ (shares × |entry − stop|),
using FIFO matching whatever cost method the portfolio uses. Stops are adjusted for later splits. You
can type your own R to override it.

Journal notes are stored as notes of kind `journal`, so they don't show in the Notes panel. Deleting
an entry deletes its note and screenshot.

## 7. Storage and backups

Portfolios, transactions, journal entries and screenshots are server tables. They are included in
**Settings → Export** bundles (screenshots as base64) and in the whole-database backup. Big bundles
with many screenshots may need a higher request-body limit on your reverse proxy. Transaction imports
are capped at 20 000 rows and 32 MB per request.
