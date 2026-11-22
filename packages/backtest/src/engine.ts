/**
 * Bar-by-bar strategy simulation (docs/backtest.md §3). One position at a
 * time. Signals are decided on bar i's close and filled at bar i+1's open
 * ('nextOpen') or at bar i's close ('close'), so no rule sees a later bar.
 */
import { computeStats } from './stats';
import type {
  BacktestBars,
  BacktestResult,
  ExitReason,
  Side,
  Signals,
  StrategySettings,
  Trade,
} from './types';

interface Position {
  side: Side;
  qty: number;
  entryIndex: number;
  entryPrice: number;
  entryCommission: number;
  /** First bar whose range can hit the stop / target. */
  checkFrom: number;
  stop: number;
  target: number;
  /** Extremes seen while held (for MAE / MFE). */
  hi: number;
  lo: number;
}

type Pending =
  { kind: 'exit'; reason: ExitReason } | { kind: 'enter'; side: Side; reverse: boolean };

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function commissionOf(settings: StrategySettings, qty: number, price: number): number {
  const { mode, value } = settings.commission;
  if (!(value > 0)) return 0;
  switch (mode) {
    case 'percent':
      return (qty * price * value) / 100;
    case 'perOrder':
      return value;
    case 'perShare':
      return qty * value;
  }
}

/** Run `signals` over `bars`. Bars with a non-finite OHLC value are skipped for fills. */
export function runBacktest(
  bars: BacktestBars,
  signals: Signals,
  settings: StrategySettings,
): BacktestResult {
  const n = bars.length;
  const { open, high, low, close, time } = bars;
  const slip = Math.max(0, settings.slippagePct) / 100;
  const sl = Math.max(0, settings.stopLossPct) / 100;
  const tp = Math.max(0, settings.takeProfitPct) / 100;

  let cash = settings.initialCapital;
  let pos: Position | null = null;
  let pending: Pending | null = null;
  const trades: Trade[] = [];
  const equity = new Float64Array(n);
  let inPositionBars = 0;
  let tradeNo = 0;

  /** Adverse slippage: buying pays more, selling gets less. */
  const slipped = (price: number, buy: boolean) => price * (buy ? 1 + slip : 1 - slip);

  const markEquity = (price: number): number => {
    if (!pos) return cash;
    return pos.side === 'long' ? cash + pos.qty * price : cash - pos.qty * price;
  };

  const sizeFor = (price: number): number => {
    const eq = markEquity(price);
    const { mode, value } = settings.sizing;
    let qty: number;
    if (mode === 'fixedQty') qty = value;
    else {
      const cashValue = mode === 'percentEquity' ? (eq * value) / 100 : value;
      // Leave room for the entry commission when it is a percentage.
      const pct = settings.commission.mode === 'percent' ? settings.commission.value / 100 : 0;
      qty = cashValue / (price * (1 + Math.max(0, pct)));
    }
    if (!settings.fractional) qty = Math.floor(qty + 1e-9);
    return qty > 0 && Number.isFinite(qty) ? qty : 0;
  };

  const enter = (side: Side, i: number, raw: number, checkFrom: number): void => {
    const price = slipped(raw, side === 'long');
    const qty = sizeFor(price);
    if (qty <= 0) return;
    const comm = commissionOf(settings, qty, price);
    cash += side === 'long' ? -qty * price - comm : qty * price - comm;
    pos = {
      side,
      qty,
      entryIndex: i,
      entryPrice: price,
      entryCommission: comm,
      checkFrom,
      stop: sl > 0 ? (side === 'long' ? price * (1 - sl) : price * (1 + sl)) : NaN,
      target: tp > 0 ? (side === 'long' ? price * (1 + tp) : price * (1 - tp)) : NaN,
      hi: price,
      lo: price,
    };
  };

  const toTrade = (
    p: Position,
    i: number,
    price: number,
    reason: ExitReason,
    comm: number,
  ): Trade => {
    const dir = p.side === 'long' ? 1 : -1;
    const commission = p.entryCommission + comm;
    const pnl = dir * (price - p.entryPrice) * p.qty - commission;
    const fav = p.side === 'long' ? p.hi - p.entryPrice : p.entryPrice - p.lo;
    const adv = p.side === 'long' ? p.entryPrice - p.lo : p.hi - p.entryPrice;
    return {
      n: 0,
      side: p.side,
      qty: p.qty,
      entryIndex: p.entryIndex,
      entryTime: time[p.entryIndex]!,
      entryPrice: p.entryPrice,
      exitIndex: i,
      exitTime: time[i]!,
      exitPrice: price,
      exitReason: reason,
      pnl,
      pnlPct: (pnl / (p.entryPrice * p.qty)) * 100,
      commission,
      bars: i - p.entryIndex,
      mae: (Math.max(0, adv) / p.entryPrice) * 100,
      mfe: (Math.max(0, fav) / p.entryPrice) * 100,
    };
  };

  /** Close the position at `price` (already slipped for market / stop exits). */
  const exit = (i: number, price: number, reason: ExitReason): void => {
    const p = pos;
    if (!p) return;
    const comm = commissionOf(settings, p.qty, price);
    cash += p.side === 'long' ? p.qty * price - comm : -p.qty * price - comm;
    const t = toTrade(p, i, price, reason, comm);
    t.n = ++tradeNo;
    trades.push(t);
    pos = null;
  };

  const track = (i: number): void => {
    if (!pos) return;
    if (finite(high[i])) pos.hi = Math.max(pos.hi, high[i]);
    if (finite(low[i])) pos.lo = Math.min(pos.lo, low[i]);
  };

  /** Stop / target inside bar i. Gaps through a level fill at the open; the stop wins a tie. */
  const checkBrackets = (i: number): void => {
    const p = pos;
    if (!p || i < p.checkFrom) return;
    const o = open[i]!;
    const h = high[i]!;
    const l = low[i]!;
    if (!finite(o) || !finite(h) || !finite(l)) return;
    const long = p.side === 'long';
    const hasStop = Number.isFinite(p.stop);
    const hasTarget = Number.isFinite(p.target);
    // Exiting a long sells (slip down); exiting a short buys (slip up).
    if (hasStop && (long ? o <= p.stop : o >= p.stop)) return exit(i, slipped(o, !long), 'stop');
    if (hasTarget && (long ? o >= p.target : o <= p.target)) return exit(i, o, 'target');
    if (hasStop && (long ? l <= p.stop : h >= p.stop))
      return exit(i, slipped(p.stop, !long), 'stop');
    if (hasTarget && (long ? h >= p.target : l <= p.target)) return exit(i, p.target, 'target');
  };

  /** What the signals of bar i ask for, given the position after its fills. */
  const decide = (i: number): Pending | null => {
    const le = !!signals.longEntry[i];
    const lx = !!signals.longExit[i];
    const se = !!signals.shortEntry[i];
    const sx = !!signals.shortExit[i];
    const p = pos as Position | null;
    if (p?.side === 'long') {
      if (se) return { kind: 'enter', side: 'short', reverse: true };
      if (lx) return { kind: 'exit', reason: 'signal' };
      return null;
    }
    if (p?.side === 'short') {
      if (le) return { kind: 'enter', side: 'long', reverse: true };
      if (sx) return { kind: 'exit', reason: 'signal' };
      return null;
    }
    // Flat: both entries on one bar are ambiguous, take neither.
    if (le && !se) return { kind: 'enter', side: 'long', reverse: false };
    if (se && !le) return { kind: 'enter', side: 'short', reverse: false };
    return null;
  };

  const execute = (order: Pending, i: number, raw: number, checkFrom: number): void => {
    if (order.kind === 'exit') {
      if (pos) exit(i, slipped(raw, (pos as Position).side === 'short'), order.reason);
      return;
    }
    if (pos) {
      if ((pos as Position).side === order.side) return;
      exit(i, slipped(raw, (pos as Position).side === 'short'), 'reverse');
    }
    enter(order.side, i, raw, checkFrom);
  };

  for (let i = 0; i < n; i++) {
    const o = open[i]!;
    const c = close[i]!;
    if (pending && finite(o)) {
      execute(pending, i, o, i);
      pending = null;
    }
    checkBrackets(i);
    track(i);
    if (finite(c)) {
      const order = decide(i);
      if (order) {
        if (settings.fillAt === 'close') execute(order, i, c, i + 1);
        else pending = order;
      }
    }
    if (pos) inPositionBars++;
    equity[i] = finite(c) ? markEquity(c) : i > 0 ? equity[i - 1]! : cash;
  }

  let openTrade: Trade | null = null;
  const held = pos as Position | null;
  if (held && n > 0) {
    const last = n - 1;
    openTrade = toTrade(held, last, close[last]!, 'open', 0);
    openTrade.n = tradeNo + 1;
  }

  const drawdown = new Float64Array(n);
  let peak = -Infinity;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, equity[i]!);
    drawdown[i] = peak > 0 ? ((equity[i]! - peak) / peak) * 100 : 0;
  }

  return {
    trades,
    openTrade,
    equity,
    drawdown,
    stats: computeStats({ bars, trades, openTrade, equity, settings, inPositionBars }),
  };
}
