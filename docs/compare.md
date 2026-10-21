# Compare and symbol math (Phase 9)

Compare overlays other symbols on the chart; symbol expressions turn a formula over several symbols (`AAPL/MSFT`,
`(A+B)/2`) into a symbol of its own. Both are built on the same pieces: a small expression language, an
`ExpressionFeed` that wraps any `DataFeed`, and overlays that are engine studies whose data the app owns.

Code:

- `packages/engine/src/feed/expression/`: `lexer.ts`, `parser.ts`, `format.ts` (canonical printer), `evaluate.ts`,
  `align.ts`, `ast.ts`.
- `packages/engine/src/feed/expression-feed.ts`: the feed wrapper.
- `apps/web/src/compare/`: `model.ts`, `store.ts`, `controller.ts`, `actions.ts`, `attach.ts`, `Legend.tsx`, `menu.ts`.

Limitations and their status: [LIMITATIONS.md](LIMITATIONS.md#compare--symbol-expressions).

## 1. Expression grammar

The input is at most 256 characters. Parts outside quotes are upper-cased. Spaces and tabs separate tokens; any
other control character is an error.

```
expr    := term (('+' | '-') term)*
term    := unary (('*' | '/') unary)*
unary   := '-' unary | '+' unary | primary
primary := NUMBER | SYMBOL | '(' expr ')'
```

Operators are left-associative. Unary minus and plus bind tighter than `*` and `/`, so `2*-AAPL` is `2*(-AAPL)`. The
parser is recursive descent and never evaluates text.

### Symbols, numbers and the hyphen rule

An unquoted run starts with a letter, digit, `^` or `_` and continues with letters, digits, `_`, `.`, `=` and `&`.
This covers `^GSPC`, `EURUSD=X`, `GC=F`, `7203.T`, `0700.HK` and `M&M.NS`.

Yahoo symbols such as `BRK-B` and `BTC-USD` contain a hyphen, and a hyphen is also the minus operator. The lexer
resolves it with one rule: a `-` continues the current run only if the next character is a letter or digit **and**
the run so far contains a letter. Consequences:

| Input         | Tokens                         |
| ------------- | ------------------------------ |
| `BRK-B`       | one symbol                     |
| `BTC-USD`     | one symbol                     |
| `AAPL-MSFT`   | one symbol (not a subtraction) |
| `AAPL - MSFT` | `AAPL`, `-`, `MSFT`            |
| `AAPL- MSFT`  | `AAPL`, `-`, `MSFT`            |
| `10-AAPL`     | `10`, `-`, `AAPL`              |
| `(AAPL)-MSFT` | `)`, `-`, then `MSFT`          |

So a spread needs spaces around the minus. If a symbol like `AAPL-MSFT` is unknown, the lookup error names the
leg and repeats the hint to put spaces around the minus. If the leg contains `/` the error suggests quoting it
(`"BRK/B"`).

A symbol with characters outside the run alphabet is quoted: `"BRK/B"`. A quoted symbol is 1 to 32 characters from `A-Z 0-9 ^ _ . = & / space -` (letters are upper-cased), cannot start with `.`
and cannot contain `"`.

A run that matches `^[0-9]+(\.[0-9]+)?$` is a number (at most 15 significant digits). Any other run must contain a
letter or start with `^` to be a symbol (at most 32 characters); otherwise it is an error (`2.`, `1.2.3`). There
are no exponents and no leading `.` (`.5` is an error; write `0.5`).

### Limits

At most 8 distinct symbols, nesting depth 32, at least one symbol (`2+3` is rejected), 256 input characters, 32
characters per symbol. A main-symbol expression is capped at 32 canonical characters because drawings and notes
store the symbol in `String(32)` columns; overlays allow 128 (they live in the layout JSON).

### Errors

Every error is an `ExpressionError` with a 0-based position in the raw input, so the dialog can place a caret.

| Message                                    | Position                                            |
| ------------------------------------------ | --------------------------------------------------- |
| `Empty expression`                         |                                                     |
| `Unexpected character '$'`                 | the character                                       |
| `Expected a symbol, number or '('`         | where it was expected (the input length at the end) |
| `Missing ')'`                              | the opening `(`                                     |
| `Unexpected ')'`                           | the `)`                                             |
| `Expected an operator`                     | the second operand (`AAPL MSFT` is position 5)      |
| `Invalid number or symbol '2.'`            | the run                                             |
| `Symbol too long (max 32)`                 | the symbol                                          |
| `Expression too long (max 256 characters)` |                                                     |
| `Too many symbols (max 8)`                 |                                                     |
| `Too deeply nested (max 32)`               |                                                     |
| `Expression needs at least one symbol`     |                                                     |

### Canonical form

`canonicalSymbol` prints the parsed tree in one stable form, and that string is what is stored, compared and sent
to the feed. A plain symbol canonicalizes to itself. The rules:

- Precedence: `+ -` is 1, `* /` is 2. An operand gets parentheses if its precedence is lower than its parent's, or
  if it is the right operand with equal precedence. Associativity is never exploited, so `A+(B+C)` keeps its
  parentheses and the tree always round-trips exactly.
- Binary minus prints as `-`; `+`, `*` and `/` print without spaces. Unary minus prints as `-x`, with
  parentheses only around a binary operand.
- Numbers print in normalized form (`007.50` becomes `7.5`). Unary plus produces no node.
- A symbol prints bare if it lexes back as the same single run, otherwise quoted. This also holds for a plain
  symbol: `"brk/b"` stays `"BRK/B"`, because bare `BRK/B` would be a division.

Examples: `aapl/msft` is `AAPL/MSFT`; `(A-B)-C` is `A-B - C` (the unspaced `A-B` is one symbol); `A - B - C` stays as is; `A-(B-C)` is `A-(B - C)`; `(A*B)/C` is `A*B/C`;
`A/(B*C)` keeps its parentheses; `"brk/b"*2` is `"BRK/B"*2`. Both the printer and the hyphen rule are covered by
golden tests because stored layouts depend on them.

## 2. OHLC math

Evaluation is element-wise over aligned rows. Division by zero gives NaN, any non-finite intermediate gives NaN,
and NaN propagates.

Open and close are exact: `O = f(O of each leg)` and `C = f(C of each leg)`, where `f` is the expression.

High and low are a heuristic. The true high of `A/B` is the maximum over the bar of `A(t)/B(t)`, which depends on
the intrabar path of both legs, and OHLC data does not contain it. The feed therefore evaluates the expression on
the open, close, all legs' highs and all legs' lows, and takes the envelope:

```
H = max(O, C, f(H of each leg), f(L of each leg))
L = min(O, C, f(H of each leg), f(L of each leg))
```

Non-finite samples are skipped. The result always contains the open and close and is a plausible range, but it is
not the real extreme. For a ratio, `f(H legs)` puts the numerator's high over the denominator's high, which
neither occurred together nor is the worst case; for `A - B` it is a bit off in the other direction. Treat the
wicks of an expression as indicative and use the close for calculations.

Worked example with `A = {O10, H12, L9, C11}` and `B = {O5, H6, L4, C5.5}`: `A/B` gives O 2, H 2.25, L 2, C 2;
`(A+B)/2` gives O 7.5, H 9, L 6.5, C 8.25; `A - B` gives O 5, H 6, L 5, C 5.5. `A/(B-B)` has no valid row.

A stale (forward-filled) leg contributes its last close for open, high, low and close. Volume is always 0. A row
whose open or close is non-finite is omitted. Compare overlays use the close only.

## 3. Time alignment

### Primary leg

The time axis is the first symbol of the expression (the primary leg). Every other leg is joined onto it with a
left as-of join: for each primary bar, the latest bar of the other leg at or before that key. There is no
back-fill before a leg's first bar, and no lookahead. Reorder the symbols to change which market sets the axis:
`AAPL/BTC-USD` has weekday bars, `BTC-USD/AAPL` has a bar for every day.

### Instant versus calendar keys

- **Intraday intervals** (`instant`): the key is the UTC open time of the bar. Legs on different offset grids are
  sampled up to one bar apart, because a leg contributes its latest bar at or before the primary bar.
- **Daily and higher** (`calendar`): the key is the local calendar date of the bar's stamp, in that leg's **own**
  exchange timezone (`localDay * 86400`). Daily bars are stamped at the local midnight of the
  exchange (AAPL day D is 04:00 or 05:00Z, 7203.T day D is 15:00Z the day before, BTC-USD is 00:00Z), so a plain
  UTC date would put different markets on different days. Each leg is keyed by its own timezone, which puts all
  of them on the trading date.
- Verified against the live API (7203.T, BTC-USD, ^GSPC, EURUSD=X): daily bars are stamped 00:00 local time in the
  exchange timezone.
- Guard: if every stamp of a leg is a multiple of 86400, the leg is keyed in UTC regardless of the declared
  timezone (some providers stamp midnight UTC).

The join is a two-pointer pass, O(n+m), over ascending keys. Duplicate keys: the last wins. An empty leg yields no
rows. For calendar mode the fetch window is widened by two days to cover timezone shifts. DST changes use the
engine's existing hourly offset cache.

### Staleness limits

A leg is carried forward only for a bounded time. The limit is the larger of a base value per unit and three
intervals:

| Interval unit | Base limit |
| ------------- | ---------- |
| minute, hour  | 4 days     |
| day           | 10 days    |
| week          | 21 days    |
| month         | 93 days    |

Past the limit the row is dropped (no value), which is what produces a gap when a leg is delisted or a market is
closed for a long holiday. For example, a Tokyo leg whose last bar is 13 days old on a daily chart has no value;
an hourly overlay whose last bar is 325,800 s (3.8 days) old still matches, one that is 412,200 s (4.8 days) old
does not.

## 4. Percent scale math

"Same % scale" draws an overlay on the main pane's price scale so that it starts at the same height as the main
series at the left edge of the view. It works in every scale mode, because the overlay is mapped through the
pane's own price scale.

For each frame, with visible range `from..to`:

```
k      = first index in [max(from,0), min(to, length-1)] where ov[k] and ref(k) are finite
ref(i) = base value of the main series at i
factor = ref(k) / ov[k]   if k exists and ov[k] > 0 and ref(k) > 0, otherwise NaN
y(i)   = paneScale.priceToY(ov[i] * factor)
```

Drawing, autoscale, magnet and hit testing all use this one mapping. When the factor is NaN (no valid first
point, or a zero or negative value) the line is not drawn and does not take part in autoscale; the legend still
shows raw values. The factor is cached per visible range, series revision and length.

Example: main closes `[10,12,15,18]`, overlay `[50,55,60,54]`, view `1..3`: `factor = 12/55`, so the overlay at index
3 is drawn at `11.78`; in percent mode that is `-1.8%` relative to the base. With overlay `[50,NaN,60,54]` the
first valid point is index 2 and `factor = 0.25`.

Other placements:

- **New price scale** (`own`): the overlay gets its own full-height linear scale using the pane's margins (10% top,
  8% bottom), autoscaled to the overlay's visible range, and excluded from the pane's autoscale. It has no ticks,
  and the last-value label shows the raw value.
- **New pane** (`pane`): the overlay is the only series in a pane `pane-<id>`, with that pane's own scale.

The last-value label shows the percent value in percent and indexed modes and the raw value in linear and log
modes. The legend and `getStudyValues` always report raw values.

Auto-switch: adding the first visible "same" overlay while the main pane is linear or log switches it to percent
and remembers the previous mode (`scaleRestore`) in the same undo step. Hiding the last "same" overlay keeps percent mode; only removing it or moving it to another placement
restores the saved mode, and only if the pane is still in percent. Changing the scale by hand clears the saved mode.
Undoing an unrelated compare step does not touch the scale.
Spreads and other series that can cross zero should use a new scale or pane.

## 5. ExpressionFeed

`ExpressionFeed` wraps another `DataFeed` (in the app: `ExpressionFeed(ResamplingFeed(HttpDataFeed))`). Plain
symbols pass straight through to the inner feed. Expressions are parsed through a small LRU cache (64 entries).

### resolveSymbol

The legs are resolved in parallel. A failure becomes a `FeedError` that names the unknown leg and, if the leg
contains a hyphen, adds the hint to put spaces around the minus. The resulting `SymbolInfo` has the canonical
string as symbol and name, exchange name "Expression", type `expression`, the primary leg's timezone, and:

- currency only if the expression is linear (no symbol times symbol, no division by a symbol) and all legs share
  one;
- session only if all legs share timezone and session;
- price hint the maximum of the legs' hints, and at least 4 when the expression divides by a symbol; min tick is
  10 to the minus price hint.

### getBars paging

`getBars({symbol, interval, to, limit})` returns the newest `limit` bars before `to` (exclusive) plus `hasMore`.

1. The primary leg is fetched with the request as given, plus one extra older primary bar when available. That bar
   is a lead-in: it fixes the fill state of the first real row, so a page matches one big fetch exactly, including
   open, high and low. If the primary is empty the result is empty.
2. The other legs are fetched in parallel over the primary's time span, widened by the staleness limit (and two
   days in calendar mode), with a limit large enough to cover it (at most 20,000).
3. Keys are computed and each leg is joined onto the primary keys.
4. Cut rule: a leg that still has older history (`hasMore`) may begin later than the primary page. Rows older than
   the latest such first key are dropped from this page, so that they are refetched in a later page with the leg
   fully available, and `hasMore` stays true. Rows where a leg that is complete has no value are dropped for good. If the cut empties the page and the
   primary has more history, the feed steps back and fetches an older page, up to 5 fetches in total.
5. Remaining rows are evaluated and rows with a non-finite open or close are dropped.
6. The newest `limit` rows are kept; `hasMore` is true if the primary had more, rows were cut, or the page was
   truncated.

Fetching two consecutive pages with `to` gives the same bars as one large fetch, with no gaps or duplicates. When
`to` is undefined (the latest page) the feed keeps the last 16 bars of every leg, keyed by symbol, interval and
extended-hours flag (LRU 32), so that live updates can start from them.

### subscribe (live)

Each leg is subscribed with `inner.subscribe`, using that leg's **own** timezone and session, never the
expression's. Each leg keeps a short ring of recent bars (same time replaces, newer appends, older is ignored).

- A primary-leg bar computes the row at that key.
- A bar on another leg only recomputes the current row (the primary's latest bar), by an as-of lookup with the
  staleness limit.
- If a leg has no value or the result's open or close is non-finite, nothing is emitted.
- A row is emitted only if its time is not earlier than the last emitted one. A non-primary bar that is newer than
  the current row is held until the primary leg appends that bar.
- Unsubscribe releases every leg.
- Symbols outside the server's `/ws` charset (for example `M&M.NS` or `BRK/B`) get history but no live updates.

### Compare overlays

The `CompareController` fetches each overlay with the same feed and aligns it to the main series in the same way
(`asOfIndex` on the main keys, with the overlay's own timezone and the staleness limit), then pushes the close
column to the study with the chart's series revision. Data is cached by symbol, interval and extended-hours flag
and survives a change of the main symbol. When the main series prepends older history, the overlay is extended
backwards (up to 10 pages) while it starts after the main series' first key. Live main updates patch only the
last row; overlay ticks patch from the key of the tick. On brick chart types the overlay is "unavailable" and no
data is requested. An overlay whose fetch failed is retried only when it is re-added or when the interval or
extended-hours setting changes.

## 6. Persistence (layout schema v3)

Overlays are saved in the layout state under `compares`:

```
compares: { items: CompareState[], scaleRestore: PriceScaleMode | null }

CompareState {
  id: string          // /^cmp-[a-z0-9]{1,24}$/, also the engine study id
  symbol: string      // canonical, up to 128 characters, plain or expression
  placement: 'same' | 'own' | 'pane'
  visible: boolean
  color: string       // #rrggbb
  lineWidth: number   // integer 1..4
}
```

A `pane` overlay lives in the pane `pane-<id>`. At most 10 overlays are allowed. `parseCompareLayout` drops invalid
items and re-canonicalizes the symbols, so hand-edited or older data cannot break the chart.

`LAYOUT_SCHEMA_VERSION` is 3. The step `UPGRADES[2]` adds `{items: [], scaleRestore: null}` to a v2 layout.
Applying a layout restores the compare store before `chart.setState`, because `setState` clears the studies and
the controller then re-adds the overlays. Compares are stored only in the layout (there is no localStorage key of their own). Panes named `pane-cmp-*` that no
overlay owns are removed when a layout is applied. A client that only knows v2 refuses a v3 layout. The server stores the
state as opaque JSON and needs no change. Compares are not part of indicator or chart templates. The general
layout contract is in [persistence.md](persistence.md) §5 and §6.

## 7. Where expressions are accepted

The Compare and symbol search dialogs accept expressions. For queries that look like a company name (two or more
alphabetic words) they fall back to a normal symbol search instead of a parse error. Known gap: `S&P (500)` shows a
parse error. Watchlists reject expressions with a toast; Details and News show "Not available for symbol
expressions".

## 8. Testing

- Engine unit tests: `feed/expression/{parser,evaluate,align}.test.ts` (golden canonical forms, error positions,
  500-case printer round trip, OHLC and alignment fixtures) and `feed/expression-feed.test.ts` (paging, cut rule,
  live behavior, resolveSymbol).
- `SyntheticFeed` returns the same series for every symbol by default; with `perSymbol: true` each symbol has its
  own deterministic series. The app enables it with `?feed=synthetic-multi`, which `e2e/compare.spec.ts` (4 tests) uses.
