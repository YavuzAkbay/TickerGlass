# Watchlists

The sidebar panel and the full-screen Watchlists page share one column registry, one set of row badges and
the symbol detail sections. This page covers the table features; the plain-text format is described
[further down](#watchlist-plain-text-format).

## Columns

Every column is defined once (`apps/web/src/watchlist/columns/registry.ts`): header, width, sort value, cell
formatting and CSV values. The page offers every column; the sidebar offers all but Company name and Day range.

| Column                                              | Notes                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Company name (page), Last, Change, Change %, Volume | From every provider.                                                                                                       |
| Pre/post-market price and change %                  | Only while a pre/post session has data.                                                                                    |
| Day range (page only), 30-day trend                 | Range bar and sparkline.                                                                                                   |
| Open                                                | Needs the provider's open price.                                                                                           |
| Gap %                                               | Open vs previous close.                                                                                                    |
| Rel vol                                             | Today's volume over the average volume; highlighted at 2x or more.                                                         |
| Avg vol                                             | Average daily volume.                                                                                                      |
| Mkt cap                                             | Market cap in USD.                                                                                                         |
| 52W range                                           | Range bar of the last price between the 52-week low and high.                                                              |
| % from 52W high                                     | Distance below the 52-week high.                                                                                           |
| 1M %, YTD %, 1Y %                                   | Performance over one month, year to date and one year. Snapshot column.                                                    |
| RSI                                                 | 14-day RSI; `↓` below 30 (oversold) and `↑` above 70 (overbought) mark the extremes, not only the colour. Snapshot column. |
| % SMA200                                            | Distance from the 200-day simple moving average. Snapshot column.                                                          |
| Earnings                                            | Next earnings date ("Jan 30"; the tooltip says "in 3 days"). Highlighted at 7 days or less. Snapshot column.               |

Data source: Open, Gap %, Rel vol, Avg vol, Mkt cap, 52W range and % from 52W high come from the quote
snapshot extras that only Yahoo returns (`open`, `averageVolume`, `marketCap`, `fiftyTwoWeekHigh/Low`). With another
provider the cells show "—" and the column header explains that the source does not provide the data; other
columns keep working. Gap % and Rel vol are derived on the client from those fields.

### Snapshot columns

1M %, YTD %, 1Y %, RSI, % SMA200 and Earnings are **opt-in** and come from the server screener's nightly snapshot
([screener](screener.md)), not from live quotes. They are off by default and nothing is requested until one is
visible (or the list is sorted by one). Then the table asks `GET /api/screener/snapshot?symbols=` for the
whole list at once (batched, up to 200 symbols per request, so sorting covers every row) and keeps the answer
for 30 minutes or until a newer snapshot date shows up. Values are as of the last close.

- A symbol the screener does not track (outside the universe or the cap) shows "—".
- When the API has no screener the columns show "—" with the tooltip "Server screener not available" and the web
  app stops requesting for the session; the other columns are not affected.
- Sorting puts rows without a value last in both directions. CSV export writes numbers (the earnings date as
  `YYYY-MM-DD`), empty when missing.
- Rel vol stays the live-quote column (today's volume over the average); the snapshot's own `relVol` is only
  available in the screener.

### Column presets

The columns menu starts with a Presets submenu: the built-ins Default, Performance (Gap %, Rel vol, 52W range),
Fundamentals (Mkt cap, Avg vol, 52W range), Technical (1M %, RSI, % SMA200, Earnings; needs the server screener)
and Minimal, then your own. "Save current columns as..." stores the
visible columns and, on the page, the custom widths under a name (up to 20 presets, names up to 40 characters;
saving under an existing name replaces it). Presets are stored with the page preferences and synced; a preset
applied on the other surface keeps the columns that surface offers. Built-in presets also reset widths.

### Per-list views

"Remember columns & sort per list" (columns menu, page) keeps a separate column set and sort for each list and
flag view; switching lists restores that list's view. Up to 50 views are remembered, views of deleted lists are
dropped. With the option off, one layout applies to every list.

### Reordering and resizing (page)

- Click a header to sort; drag a header, or press **Alt+Left / Alt+Right** on it, to move the column. Focus
  follows the column and the move is announced.
- Drag the right edge of a header, or press **Alt+Shift+Left / Alt+Shift+Right**, to resize (widths are clamped to
  44-600 px).
- **Alt+Up / Alt+Down** in the table moves the selected symbols within the list; **Alt+1..7** sets a flag.

## Row badges

Small indicators at the end of the symbol cell (`apps/web/src/watchlist/badges`). Nothing shows when a quote is
live and there is nothing to say.

| Badge             | Meaning                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Bell with a count | Active alerts on the symbol; highlighted (ringing bell) when some have triggered. Click opens the Alerts panel. |
| Note icon         | The symbol has a note. Click opens it (see Notes).                                                              |
| `D` delayed       | Polled or snapshot data under 2 minutes old, or a tick older than 1 minute, or the stream is not live.          |
| `S` stale         | The newest data (tick or snapshot update) is 2 minutes old or more.                                             |
| `C` closed        | Market closed. Closed symbols never go stale.                                                                   |
| `Pre` / `Post`    | Pre-market or after-hours session.                                                                              |
| `!`               | The provider has no data for the symbol.                                                                        |

The letter is always shown beside the dot (state is never colour-only); the narrow sidebar rows show dots only.
Screen readers read one label for the whole badge group ("2 active alerts on AAPL, Market closed").

Crypto and similar 24/7 pairs have no closed or pre/post states. Snapshots carry no timestamp of their own, so a
snapshot-only quote ages from the moment the app received it; a symbol whose polling stops turns `S`.

On the Watchlists page `D` is kept as is: only symbols without a recent tick show it. At most 200 symbols are streamed over the
socket, so in practice that is a short-lived state while the socket connects, or the whole table while the stream
falls back to polling (which is what `D` is for). The screener hides `D` because most of its rows are HTTP-polled by design.

## Heatmap view

The **Table | Heatmap** switch in the page header (remembered per device) draws the current list as a treemap. It honors
the filter box; collapsed sections are ignored, every symbol is a tile.

- **Size** (toolbar): market cap (default), equal, volume or average dollar volume. Market cap comes from the live quote
  (Yahoo) and the nightly snapshot; a tile without a size gets the smallest known one, and a list with none at all falls
  back to equal tiles (a note says so). Sizes are laid out once and only re-laid out when they change; volume-based sizes
  are sampled every 15 s, never per tick.
- **Color**: 1D change (default, saturates at +-3 %), 1W / 1M / YTD performance (+-5 / 10 / 25 %), relative volume (0x to
  2x) or RSI distance from 50 (30 to 70). Only the 1D change is live; the others read the snapshot. Tiles print the symbol
  and the signed value, so the map never relies on color alone.
- **Group**: None, Section (the list's sections) or Sector (snapshot `sector`; symbols without one are "Ungrouped"). Group
  headers show the cap-weighted value of the group.
- **Keyboard**: Tab to the map, arrows move to the nearest tile, Home / End jump to the largest / smallest, Enter opens the
  chart, the context-menu key (or right click) opens the same menu as a table row. Double-click opens the chart too.
- Hover (or focus) a tile for name, price, change and the size metric. Tiny tiles hide their text.
- **Live quotes** are subscribed for the 200 largest tiles only (by snapshot market cap); the rest show snapshot values.

## Detail pane

Click a row to preview it on the right (Enter opens the chart). Below the quote header, the pane shows the
sections shared with the screener (`apps/web/src/symbolInfo`), fetched only once the selection rests:

- **Performance**: returns for 1W, 1M, 3M, 6M, YTD and 1Y.
- **Key stats**: from the live quote at no cost; "More stats" lazily fetches the fundamentals (hidden when the
  provider has none, for example without Yahoo).
- **Upcoming events**: next earnings, ex-dividend date and last split.
- **News**: recent headlines.
- **Alerts**: alerts and the note of the symbol (Watchlists page). The note shows as a plain-text preview
  (first 120 characters) with an "Open note" / "Add note" button.

## Notes

The Notes panel edits one note per symbol plus a general note. It follows the chart's symbol ("Following chart")
until another symbol is opened: the note badge on a row, the detail pane's "Open note" / "Add note" button, or the
`notes.openForSymbol` command (palette: "Open note for current symbol", which follows the chart). Opening leaves
any full-window screen, shows the panel (never toggles it closed) and focuses the editor. The header then reads
"Pinned to AAPL"; "Back to chart symbol" returns to following the chart, and the pin button pins the current one.
The pin is not saved across reloads. Edits go to the pinned symbol's note. Code: `apps/web/src/notes`.

## Watchlist plain-text format

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

## Import from text

The command "Import from text…" (watchlist menu / command palette) takes pasted symbols and creates a new list
"Pasted symbols" from them (`importText`). Separators are commas, spaces or new lines, and `EXCHANGE:TICKER` entries
and `###Section` headers work as in the `.txt` format above. Text over 1 MB is refused.

## Import report

Both imports (file and text) finish with a toast saying what happened (`describeImport`): how many symbols were
imported, then what was not: entries whose exchange prefix is unknown (listed, up to five, as "not imported"),
invalid entries, duplicates, and symbols left out because a list holds at most 1000 items. A file or text without
any symbol creates no list and reports why.

## Undo

Removing symbols (row menu, Delete key, bulk menu, flag removal) or a section (with or without its symbols) shows a
toast with "Undo" for 8 seconds. Undo puts the removed items back; if the list changed in the
meantime it reports how many could be restored. Moving symbols to another list reports the real outcome (moved,
already in the target, did not fit).

Collapsing a section is a per-device preference and is not synced.

## Sharing

TickerGlass is single-user, so "sharing" moves a copy of a list between people or instances; there is no public
link on a server and nothing stays connected afterwards. "Share…" is in the list switcher menu, the list tab menu
of the Watchlists screen, the multi-selection menu (shares just those symbols) and the command palette
("Share watchlist…"). The dialog offers:

- **Copy link**: `<your address>/#tg-import=<payload>`. The payload (the list as versioned JSON,
  `{v:1, type:'watchlist', name, items}`, deflated and base64url encoded) sits after the `#`, which browsers never
  send to a server, so it appears in no access log. Up to about 16 KB of payload (a full 1000-symbol list fits);
  beyond that the dialog says so and offers the JSON file instead.
- **Copy symbols**: the plain symbols, comma separated.
- **Download TradingView .txt**: `EXCHANGE:SYMBOL` entries with `###Section` headers, the reverse of the
  [plain-text import](#watchlist-plain-text-format) mapping (`BP.L` -> `LSE:BP`, `0700.HK` -> `HKEX:700`,
  `EURUSD=X` -> `FX_IDC:EURUSD`, `BTC-USD` -> `COINBASE:BTCUSD`, `ES=F` -> `CME_MINI:ES1!`, `^GSPC` -> `SP:SPX`).
  A plain US ticker is written bare (TradingView picks its primary listing). Lossy cases: US class shares
  (`BRK-B` is written `BRK.B`, which TickerGlass reads back as `BRK.B`), Euronext listings (`EURONEXT:AIR`; the
  prefix does not say which market, so TickerGlass cannot import it), non-Canadian class shares (`BT-A.L` ->
  `LSE:BT.A`), `JPY=X` (-> `FX_IDC:USDJPY`), and futures or indices TickerGlass has no TradingView name for
  (written as they are). The dialog lists the symbols that have no exact equivalent.
- **Download JSON**: the same document as the link, for sending as a file.

Opening a link (on load, or by changing the `#` of an open tab) shows a **preview** (name, symbols, sections) and
nothing is imported until you press Import: either a new list (the name is editable; a taken name becomes
"Name (2)") or add to an existing list (only the missing symbols are added, not sections). The fragment is then
removed from the address bar. "Import shared file (.json)…" (list switcher menu or palette) takes the downloaded
JSON through the same preview.

Everything that comes in is untrusted and validated strictly: the format version, field types, lengths, symbols
against the symbol pattern, at most 1000 items, 100 characters per section title; unknown fields are dropped, a
decompressed size over 256 KB is refused, and nothing is ever evaluated. An invalid link or file shows why and
imports nothing.
