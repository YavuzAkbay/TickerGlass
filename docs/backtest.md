# Strategy tester

Test entry and exit rules on the chart's history, without writing code. Open the **Strategy tester**
section in the navigator (flask icon), create a strategy, add conditions, press **Run**.

Code: `packages/backtest` (rules, simulation, statistics; pure TypeScript) and
`apps/web/src/backtest` (panel, chart wiring, storage).

## 1. Rules

A strategy has four rules: **long entry**, **long exit**, **short entry**, **short exit**. Each rule is
a list of conditions joined by **All** (every condition holds) or **Any** (at least one holds). A rule
without conditions never fires. Leave both short rules empty for a long-only strategy.

Conditions:

| Kind    | Reads                                                                        | Same as alerts |
| ------- | ---------------------------------------------------------------------------- | -------------- |
| Compare | `left` crosses above / crosses below / crosses / is above / is below `right` | yes            |
| Moving  | `left` rises / falls by an amount (or %) within N bars                       | yes            |
| Fires   | an indicator's marker (shape output) is on the bar                           | —              |

`left` and `right` are a price field (close, open, high, low, HL2, HLC3, OHLC4), any plot or marker of
an indicator on the chart, or (for `right`) a constant. Crossing semantics are the alert ones
([alerts.md](alerts.md) §2.3): "crosses above" holds on the bar where `left - right` goes from `<= 0` to
`> 0`. A value that is missing on a bar (indicator warm-up) makes the condition false there.

**User scripts work as they are.** Rules read the outputs the chart already computed, so any
[user script](user-scripts.md) that plots a line or draws a marker can drive a strategy. A script that
marks entries with a `shape` output is used with **Fires**.

### Indicators and charts

A condition stores the indicator's type, inputs and output, plus the chart instance it was built on.
On another chart (or after the indicator was re-added) it matches an indicator of the same type with
the same inputs. If none is on the chart, the Rules tab lists what to add, and the report says which
conditions were never true because of it.

## 2. Settings

| Setting         | Default         | Meaning                                                                |
| --------------- | --------------- | ---------------------------------------------------------------------- |
| Initial capital | 10,000          | Starting equity                                                        |
| Order size      | 100 % of equity | % of equity, a fixed number of units, or a fixed cash amount per entry |
| Fractional      | off             | Off: whole units (rounded down). On for crypto and fractional shares   |
| Commission      | 0.05 % of value | % of the order value, a fixed amount per order, or an amount per unit  |
| Slippage %      | 0               | Adverse: buys fill higher, sells lower (market and stop fills)         |
| Fill at         | Next bar open   | Or the signal bar's close                                              |
| Stop loss %     | 0 (off)         | From the entry price                                                   |
| Take profit %   | 0 (off)         | From the entry price                                                   |

## 3. Simulation

- Rules are evaluated on each bar's **close**. With _next bar open_ the order fills at the next bar's
  open; with _signal bar close_ it fills at that close. A rule never sees a later bar.
- **One position at a time.** While long: a short entry signal reverses (closes the long, opens a
  short); otherwise a long exit closes it. Short mirrors this. While flat, a long and a short entry on
  the same bar cancel out (nothing happens).
- **Stops and targets** are checked inside every bar after the fill (with _next bar open_, from the
  entry bar itself). A gap through the level fills at the open. When one bar touches both the stop and
  the target, the stop counts (the order inside a bar is unknown; this is the conservative choice).
  Targets fill at the level without slippage.
- **Prices**: Heikin Ashi charts evaluate rules on what the chart shows, but fill at the real OHLC.
  Renko, Kagi, Point & Figure, Line break and Range charts are refused: their bars are not time bars.
- A position still open at the last bar is reported as an **open trade** at the last close. It counts
  in equity, drawdown and _Open P&L_, not in the closed-trade statistics.

## 4. Report

Net profit (closed trades) and %, buy & hold %, max drawdown (on the bar-by-bar mark-to-market equity,
amount and % of the peak), profit factor (gross profit / gross loss), trades (long / short), win rate,
average trade / win / loss, payoff ratio, largest win / loss, open P&L, CAGR, Sharpe and Sortino
(per-bar equity returns, annualised by the number of bars per year in the data, risk-free rate 0),
exposure (% of bars in a position), average bars in a trade, longest winning / losing streak,
commission paid, final equity.

The equity curve shows the initial capital as a dashed line and the drawdown underneath. The trade
list (newest first, last 300) jumps the chart to a trade on click. Entries are arrows on the chart
(up for long, down for short), exits are dots at the exit price, coloured by the trade's result
(newest 400 trades). The markers disappear when the chart loads another symbol or interval; the report
stays and says it is stale.

## 5. Storage

Strategies are a synced user setting (`backtest.strategies`): they follow you to other browsers and are
part of **Settings → Server → Download backup**. The selected strategy and the last report are kept in
the browser only.

## 6. Limits

- The test runs on the bars loaded on the chart. Scroll back (or pick a longer range) to load more
  history first; intraday history depends on the provider ([LIMITATIONS.md](LIMITATIONS.md)).
- No pyramiding, partial exits, trailing stops or limit entries yet.
- Up to 16 conditions per rule, 200 strategies.
- Planned: input optimisation, a run over a whole watchlist, and server-side runs.
