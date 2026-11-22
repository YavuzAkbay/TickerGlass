import type { CostMethod, Tx } from './types';

export interface OpenLot {
  txId: string;
  time: string;
  quantity: number;
  /** Raw per-share trade price (split-adjusted to the current share count). */
  price: number;
  /** Per-share cost including the buy fee allocation (what enters the cost basis). */
  unitCost: number;
}

export interface Position {
  symbol: string;
  currency: string;
  quantity: number;
  /** Total cost of the open quantity, buy fees included. */
  costBasis: number;
  avgCost: number;
  /** Realized P&L for the display cost method, net of sell fees (and buy fees via the basis). */
  realized: number;
  /** Net dividends received (gross minus withholding). */
  dividends: number;
  /** Withholding tax taken from dividends (informational; already deducted from `dividends`). */
  withholding: number;
  /** Commissions on buys/sells plus `fee` transactions tagged with this symbol. */
  fees: number;
  openLots: OpenLot[];
}

export interface ClosedLot {
  symbol: string;
  currency: string;
  openTxId: string;
  closeTxId: string;
  quantity: number;
  /** Per-share open price, split-adjusted to the share count at close. */
  openPrice: number;
  closePrice: number;
  /**
   * Cumulative split multiplier applied to the lot between open and close (1 = no split; 4 after
   * a 4:1 split). A stop quoted at entry time is comparable with `openPrice` as `stop / splitFactor`.
   */
  splitFactor: number;
  /** FIFO P&L of this slice, net of the buy fee share and the sell fee share. */
  pnl: number;
  openTime: string;
  closeTime: string;
}

export interface LedgerTotals {
  realized: number;
  /** Net of withholding. */
  dividends: number;
  /** Net of withholding. */
  interest: number;
  /** `fee` transactions only (account fees); trade commissions live in `commissions`. */
  fees: number;
  commissions: number;
  withholding: number;
  deposits: number;
  withdrawals: number;
}

export type LedgerIssueCode =
  'oversell' | 'noPosition' | 'badSplit' | 'currencyMismatch' | 'invalid';

export interface LedgerIssue {
  txId: string;
  code: LedgerIssueCode;
  message: string;
}

export interface Ledger {
  costMethod: CostMethod;
  /** All symbols ever traded, in order of first appearance (closed ones have quantity 0). */
  positions: Position[];
  closedLots: ClosedLot[];
  cash: Record<string, number>;
  totals: Record<string, LedgerTotals>;
  issues: LedgerIssue[];
}

const EPS = 1e-9;

const finite = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/** Cash effect of a transaction in its own currency (design table). Invalid rows give 0. */
export function cashEffect(tx: Tx): number {
  const fee = finite(tx.fee) && tx.fee > 0 ? tx.fee : 0;
  switch (tx.kind) {
    case 'buy':
      return finite(tx.quantity) && finite(tx.price) ? -(tx.quantity * tx.price + fee) : 0;
    case 'sell':
      return finite(tx.quantity) && finite(tx.price) ? tx.quantity * tx.price - fee : 0;
    case 'dividend':
    case 'interest':
      return finite(tx.amount) ? tx.amount - fee : 0;
    case 'fee':
      return finite(tx.amount) ? -tx.amount : 0;
    case 'cashIn':
      return finite(tx.amount) ? tx.amount : 0;
    case 'cashOut':
      return finite(tx.amount) ? -tx.amount : 0;
    default:
      return 0;
  }
}

interface Lot {
  txId: string;
  time: string;
  quantity: number;
  price: number;
  feePerShare: number;
  splitFactor: number;
}

interface PosState {
  symbol: string;
  currency: string;
  lots: Lot[];
  pooledQty: number;
  pooledCost: number;
  pooledTxId: string;
  pooledTime: string;
  realized: number;
  dividends: number;
  withholding: number;
  fees: number;
}

function emptyTotals(): LedgerTotals {
  return {
    realized: 0,
    dividends: 0,
    interest: 0,
    fees: 0,
    commissions: 0,
    withholding: 0,
    deposits: 0,
    withdrawals: 0,
  };
}

export function computeLedger(txs: Tx[], opts: { costMethod: CostMethod }): Ledger {
  const method = opts.costMethod;
  const issues: LedgerIssue[] = [];
  const closedLots: ClosedLot[] = [];
  const cash: Record<string, number> = {};
  const totals: Record<string, LedgerTotals> = {};
  const states = new Map<string, PosState>();

  const totalsOf = (ccy: string): LedgerTotals => (totals[ccy] ??= emptyTotals());
  const issue = (txId: string, code: LedgerIssueCode, message: string) =>
    issues.push({ txId, code, message });

  const ordered: { tx: Tx; ms: number; i: number }[] = [];
  txs.forEach((tx, i) => {
    const ms = Date.parse(tx.time);
    if (Number.isNaN(ms)) {
      issue(tx.id, 'invalid', `Unparseable time "${tx.time}".`);
      return;
    }
    ordered.push({ tx, ms, i });
  });
  ordered.sort((a, b) => a.ms - b.ms || a.i - b.i);

  const heldOf = (s: PosState) => s.lots.reduce((n, l) => n + l.quantity, 0);

  /** The position state for a tx's symbol, or null on a currency clash (issue recorded). */
  function stateFor(tx: Tx, create: boolean): PosState | null | undefined {
    const symbol = tx.symbol as string;
    const existing = states.get(symbol);
    if (existing) {
      if (existing.currency !== tx.currency) {
        issue(
          tx.id,
          'currencyMismatch',
          `${symbol} is held in ${existing.currency} but this transaction is in ${tx.currency}.`,
        );
        return null;
      }
      return existing;
    }
    if (!create) return undefined;
    const fresh: PosState = {
      symbol,
      currency: tx.currency,
      lots: [],
      pooledQty: 0,
      pooledCost: 0,
      pooledTxId: tx.id,
      pooledTime: tx.time,
      realized: 0,
      dividends: 0,
      withholding: 0,
      fees: 0,
    };
    states.set(symbol, fresh);
    return fresh;
  }

  for (const { tx } of ordered) {
    const ccy = tx.currency;
    const fee = finite(tx.fee) && tx.fee > 0 ? tx.fee : 0;
    const t = totalsOf(ccy);
    const needsSymbol =
      tx.kind === 'buy' || tx.kind === 'sell' || tx.kind === 'dividend' || tx.kind === 'split';
    if (needsSymbol && !tx.symbol) {
      issue(tx.id, 'invalid', `${tx.kind} needs a symbol.`);
      continue;
    }

    switch (tx.kind) {
      case 'buy': {
        const q = tx.quantity;
        const p = tx.price;
        if (!finite(q) || q <= 0 || !finite(p) || p < 0) {
          issue(tx.id, 'invalid', 'Buy needs a positive quantity and a price.');
          continue;
        }
        const s = stateFor(tx, true);
        // A rejected buy (currency clash) is skipped entirely: no lot and no cash effect.
        if (!s) continue;
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        s.lots.push({
          txId: tx.id,
          time: tx.time,
          quantity: q,
          price: p,
          feePerShare: fee / q,
          splitFactor: 1,
        });
        if (s.pooledQty <= EPS) {
          s.pooledTxId = tx.id;
          s.pooledTime = tx.time;
        }
        s.pooledQty += q;
        s.pooledCost += q * p + fee;
        s.fees += fee;
        t.commissions += fee;
        break;
      }
      case 'sell': {
        const q = tx.quantity;
        const p = tx.price;
        if (!finite(q) || q <= 0 || !finite(p) || p < 0) {
          issue(tx.id, 'invalid', 'Sell needs a positive quantity and a price.');
          continue;
        }
        const s = stateFor(tx, false);
        if (s === null) continue; // currency clash: skipped, no cash effect
        // Cash takes the FULL proceeds even when the sell is clamped below (oversell / noPosition):
        // the broker really paid them out, e.g. the shares were bought before the imported history.
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        const held = s ? heldOf(s) : 0;
        if (!s || held <= EPS) {
          issue(tx.id, 'noPosition', `Sell of ${tx.symbol} with nothing held.`);
          t.commissions += fee;
          continue;
        }
        let sold = q;
        if (q > held + EPS) {
          sold = held;
          issue(
            tx.id,
            'oversell',
            `Sold ${q} ${tx.symbol} but only ${held} held; clamped to ${held}.`,
          );
        }
        const sellFee = fee * (sold / q);
        // FIFO matching always runs (closedLots feed R-multiples).
        let remaining = sold;
        let fifoPnl = 0;
        for (const lot of s.lots) {
          if (remaining <= EPS) break;
          const take = Math.min(lot.quantity, remaining);
          const pnl = (p - lot.price) * take - lot.feePerShare * take - sellFee * (take / sold);
          closedLots.push({
            symbol: s.symbol,
            currency: s.currency,
            openTxId: lot.txId,
            closeTxId: tx.id,
            quantity: take,
            openPrice: lot.price,
            closePrice: p,
            splitFactor: lot.splitFactor,
            pnl,
            openTime: lot.time,
            closeTime: tx.time,
          });
          fifoPnl += pnl;
          lot.quantity -= take;
          remaining -= take;
        }
        s.lots = s.lots.filter((l) => l.quantity > EPS);
        let realized = fifoPnl;
        if (method === 'average') {
          const avg = s.pooledQty > EPS ? s.pooledCost / s.pooledQty : 0;
          realized = (p - avg) * sold - sellFee;
          s.pooledCost -= avg * sold;
          s.pooledQty -= sold;
        } else {
          s.pooledQty -= sold;
        }
        if (s.lots.length === 0) {
          s.pooledQty = 0;
          s.pooledCost = 0;
        }
        s.realized += realized;
        s.fees += fee;
        t.realized += realized;
        t.commissions += fee;
        break;
      }
      case 'dividend': {
        const a = tx.amount;
        if (!finite(a) || a <= 0) {
          issue(tx.id, 'invalid', 'Dividend needs a positive amount.');
          continue;
        }
        // A dividend is cash plus an attribution to a position: it never opens a position or fixes
        // its currency (the first buy does that).
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        t.dividends += a - fee;
        t.withholding += fee;
        const s = stateFor(tx, false);
        if (s) {
          s.dividends += a - fee;
          s.withholding += fee;
        }
        break;
      }
      case 'split': {
        const r = tx.quantity;
        if (!finite(r) || r <= 0) {
          issue(tx.id, 'badSplit', `Split ratio must be a positive number (got ${String(r)}).`);
          continue;
        }
        // The ratio applies to the symbol's position whatever currency the row is tagged with.
        const s = states.get(tx.symbol as string);
        if (!s) {
          issue(tx.id, 'noPosition', `Split of ${tx.symbol} with no position.`);
          continue;
        }
        for (const lot of s.lots) {
          lot.quantity *= r;
          lot.price /= r;
          lot.feePerShare /= r;
          lot.splitFactor *= r;
        }
        s.pooledQty *= r;
        break;
      }
      case 'fee': {
        const a = tx.amount;
        if (!finite(a) || a <= 0) {
          issue(tx.id, 'invalid', 'Fee needs a positive amount.');
          continue;
        }
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        t.fees += a;
        if (tx.symbol) {
          const s = stateFor(tx, false);
          if (s) s.fees += a;
        }
        break;
      }
      case 'interest': {
        const a = tx.amount;
        if (!finite(a) || a <= 0) {
          issue(tx.id, 'invalid', 'Interest needs a positive amount.');
          continue;
        }
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        t.interest += a - fee;
        t.withholding += fee;
        break;
      }
      case 'cashIn':
      case 'cashOut': {
        const a = tx.amount;
        if (!finite(a) || a <= 0) {
          issue(tx.id, 'invalid', `${tx.kind} needs a positive amount.`);
          continue;
        }
        cash[ccy] = (cash[ccy] ?? 0) + cashEffect(tx);
        if (tx.kind === 'cashIn') t.deposits += a;
        else t.withdrawals += a;
        break;
      }
      default:
        issue(tx.id, 'invalid', `Unknown kind "${String(tx.kind)}".`);
    }
  }

  const positions: Position[] = [];
  for (const s of states.values()) {
    let quantity: number;
    let costBasis: number;
    let openLots: OpenLot[];
    if (method === 'average') {
      quantity = s.pooledQty > EPS ? s.pooledQty : 0;
      costBasis = quantity > 0 ? s.pooledCost : 0;
      const avg = quantity > 0 ? costBasis / quantity : 0;
      openLots =
        quantity > 0
          ? [{ txId: s.pooledTxId, time: s.pooledTime, quantity, price: avg, unitCost: avg }]
          : [];
    } else {
      openLots = s.lots.map((l) => ({
        txId: l.txId,
        time: l.time,
        quantity: l.quantity,
        price: l.price,
        unitCost: l.price + l.feePerShare,
      }));
      quantity = openLots.reduce((n, l) => n + l.quantity, 0);
      costBasis = openLots.reduce((n, l) => n + l.quantity * l.unitCost, 0);
    }
    positions.push({
      symbol: s.symbol,
      currency: s.currency,
      quantity,
      costBasis,
      avgCost: quantity > 0 ? costBasis / quantity : 0,
      realized: s.realized,
      dividends: s.dividends,
      withholding: s.withholding,
      fees: s.fees,
      openLots,
    });
  }

  return { costMethod: method, positions, closedLots, cash, totals, issues };
}
