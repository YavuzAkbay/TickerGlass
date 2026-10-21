/**
 * Replay paper trading, pure (docs/replay.md §6). Market orders only, filled at
 * the close of the last revealed bar; no commissions or slippage. One net
 * position per symbol with an average cost.
 */

export type Side = 'buy' | 'sell';

export interface Trade {
  id: number;
  symbol: string;
  side: Side;
  qty: number;
  /** Fill price: close of the last revealed bar. */
  price: number;
  /** Replay clock (unix seconds) at the fill. */
  time: number;
}

export interface Position {
  /** Signed: positive long, negative short. */
  qty: number;
  /** Average cost of the open quantity. */
  avg: number;
}

export interface PaperState {
  trades: readonly Trade[];
  positions: Readonly<Record<string, Position>>;
  /** Realized P&L over all symbols. */
  realized: number;
}

export const emptyPaper = (): PaperState => ({ trades: [], positions: {}, realized: 0 });

const FLAT: Position = { qty: 0, avg: 0 };

/** New position and the P&L realized by trading `n` (> 0) at `p` on `pos`. */
export function applyToPosition(
  pos: Position,
  side: Side,
  n: number,
  p: number,
): { position: Position; realized: number } {
  const delta = side === 'buy' ? n : -n;
  const q = pos.qty;
  if (q === 0) return { position: { qty: delta, avg: p }, realized: 0 };
  if (Math.sign(q) === Math.sign(delta)) {
    // Same direction: the average cost moves to the weighted mean.
    const avg = (pos.avg * Math.abs(q) + p * n) / (Math.abs(q) + n);
    return { position: { qty: q + delta, avg }, realized: 0 };
  }
  // Reduce (and maybe flip): realize on the closed part.
  const closed = Math.min(n, Math.abs(q));
  const realized = (p - pos.avg) * closed * Math.sign(q);
  const remaining = q + delta;
  if (remaining === 0) return { position: { ...FLAT }, realized };
  // Flipped: the rest opens a new position at the fill price.
  if (Math.sign(remaining) !== Math.sign(q))
    return { position: { qty: remaining, avg: p }, realized };
  return { position: { qty: remaining, avg: pos.avg }, realized };
}

/** Add a market fill. `qty` must be finite and > 0, `price` finite. */
export function fill(state: PaperState, trade: Omit<Trade, 'id'>): PaperState {
  if (!(trade.qty > 0) || !Number.isFinite(trade.qty) || !Number.isFinite(trade.price))
    throw new Error('Invalid order');
  const pos = state.positions[trade.symbol] ?? FLAT;
  const r = applyToPosition(pos, trade.side, trade.qty, trade.price);
  const positions = { ...state.positions };
  if (r.position.qty === 0) delete positions[trade.symbol];
  else positions[trade.symbol] = r.position;
  return {
    trades: [...state.trades, { ...trade, id: state.trades.length + 1 }],
    positions,
    realized: state.realized + r.realized,
  };
}

/** The order that flattens `symbol`, or null when flat. */
export function closeOrder(state: PaperState, symbol: string): { side: Side; qty: number } | null {
  const pos = state.positions[symbol];
  if (!pos || pos.qty === 0) return null;
  return { side: pos.qty > 0 ? 'sell' : 'buy', qty: Math.abs(pos.qty) };
}

/** Unrealized P&L of the open positions at `marks` (last price per symbol). */
export function unrealized(state: PaperState, marks: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const [symbol, pos] of Object.entries(state.positions)) {
    const m = marks[symbol];
    if (m !== undefined && Number.isFinite(m)) sum += (m - pos.avg) * pos.qty;
  }
  return sum;
}

export const totalPnl = (state: PaperState, marks: Readonly<Record<string, number>>): number =>
  state.realized + unrealized(state, marks);
