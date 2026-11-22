/** Pure helpers between the API rows and `@tickerglass/portfolio` (no DOM, no store). */
import type { Tx } from '@tickerglass/portfolio';
import type { Transaction } from '../api/portfolio';

/** API transaction -> ledger input (drops the server fields the package does not know). */
export function toTx(t: Transaction): Tx {
  return {
    id: t.id,
    kind: t.kind,
    time: t.time,
    symbol: t.symbol,
    quantity: t.quantity,
    price: t.price,
    amount: t.amount,
    fee: t.fee,
    currency: t.currency,
  };
}

export const toTxs = (rows: readonly Transaction[]): Tx[] => rows.map(toTx);

/** Rows newest first (the reverse of the API order: time, then seq), as Activity lists them. */
export function newestFirst(rows: readonly Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => {
    const d = Date.parse(b.time) - Date.parse(a.time);
    return d !== 0 && !Number.isNaN(d) ? d : b.seq - a.seq;
  });
}

/** Distinct symbols (upper-case) traded in `rows`, in order of first appearance. */
export function tradedSymbols(rows: readonly Pick<Transaction, 'symbol'>[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.symbol) seen.add(r.symbol.toUpperCase());
  return [...seen];
}

/** Distinct currencies of `rows` other than `base`, sorted. */
export function foreignCurrencies(
  rows: readonly Pick<Transaction, 'currency'>[],
  base: string,
): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.currency && r.currency !== base) seen.add(r.currency);
  return [...seen].sort();
}

/** Yahoo style quote symbol for `ccy` priced in `base` ("EUR" in "USD" -> "EURUSD=X"). */
export const fxSymbol = (ccy: string, base: string): string => `${ccy}${base}=X`;

export interface ImportBatchInfo {
  batch: string;
  /** `import:<broker>`. */
  source: string;
  count: number;
  /** Newest `createdAt` of its rows (ISO). */
  createdAt: string;
}

/** Import batches present in `rows` (derived, so Undo survives reloads), newest first. */
export function importBatches(rows: readonly Transaction[]): ImportBatchInfo[] {
  const by = new Map<string, ImportBatchInfo>();
  for (const r of rows) {
    if (!r.importBatch) continue;
    const cur = by.get(r.importBatch);
    if (!cur) {
      by.set(r.importBatch, {
        batch: r.importBatch,
        source: r.source,
        count: 1,
        createdAt: r.createdAt,
      });
    } else {
      cur.count++;
      if (r.createdAt > cur.createdAt) cur.createdAt = r.createdAt;
    }
  }
  return [...by.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface ActivityFilter {
  /** Case-insensitive substring of the symbol; '' = all. */
  symbol: string;
  /** '' = all kinds. */
  kind: string;
}

export function filterActivity(
  rows: readonly Transaction[],
  filter: ActivityFilter,
): Transaction[] {
  const sym = filter.symbol.trim().toUpperCase();
  return rows.filter(
    (r) =>
      (!filter.kind || r.kind === filter.kind) &&
      (!sym || (r.symbol ?? '').toUpperCase().includes(sym)),
  );
}
