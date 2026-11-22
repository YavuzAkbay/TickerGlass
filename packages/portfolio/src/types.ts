/**
 * Shared types for @tickerglass/portfolio (docs/design/portfolio.md).
 * Conventions: every `*Pct` field is in percent units (12.5 = 12.5 %), `weight` is a 0..1 fraction.
 */

export type TxKind =
  'buy' | 'sell' | 'dividend' | 'split' | 'fee' | 'interest' | 'cashIn' | 'cashOut';

/**
 * Callers must pass `Tx[]` to computeLedger()/performance() in API order: both sort stably by
 * (time, input index), so the input index is the tie-break for equal timestamps (ids are never used).
 */
export interface Tx {
  id: string;
  kind: TxKind;
  /** ISO-8601 timestamp (UTC). */
  time: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fee: number;
  currency: string;
}

export type TxIn = Omit<Tx, 'id'> & { externalId?: string | null; note?: string | null };

export type CostMethod = 'fifo' | 'average';

/** One daily close; `t` is unix seconds, `c` the (split-adjusted) close. */
export interface DailyClose {
  t: number;
  c: number;
}

export type BrokerId = 'ibkr' | 'schwab' | 'degiro' | 'trading212' | 'generic';

/** Overrides for ambiguous number/date formats in generic (and decimal for DEGIRO) CSV files. */
export interface ParseBrokerOptions {
  /** Order of day/month in numeric dates such as 03/04/2024. */
  dateOrder?: 'mdy' | 'dmy';
  /** Decimal mark of printed numbers. */
  decimal?: '.' | ',';
}

/** Format choices that were guessed (not certain), so a UI can offer an override. */
export interface ParseAssumptions {
  dateOrder?: 'mdy' | 'dmy';
  decimal?: '.' | ',';
}

export interface ParsedImport {
  broker: BrokerId;
  transactions: TxIn[];
  warnings: string[];
  /** Present only for choices that were ambiguous; pass them back as `opts` to override. */
  assumptions?: ParseAssumptions;
}
