import type { ParseAssumptions, ParseBrokerOptions, TxIn } from '../types';

export interface MapperResult {
  transactions: TxIn[];
  warnings: string[];
  /** Inference choices the user may want to override (set only when they were not certain). */
  assumptions?: ParseAssumptions;
}

/** A broker mapper works on already tokenised rows. Column sets are best-effort per broker. */
export interface BrokerMapper {
  detect(rows: string[][]): boolean;
  parse(rows: string[][], opts?: ParseBrokerOptions): MapperResult;
}

/** Lower-case alphanumerics only, so "Date/Time", "date time" and "DateTime" compare equal. */
export function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface Table {
  header: string[];
  /** Normalised header names. */
  keys: string[];
  rows: string[][];
}

/** Index of the first column whose normalised name equals one of the aliases (normalised); -1 if none. */
export function col(t: Pick<Table, 'keys'>, ...aliases: string[]): number {
  for (const a of aliases) {
    const i = t.keys.indexOf(norm(a));
    if (i >= 0) return i;
  }
  return -1;
}

export function cell(row: string[], idx: number): string {
  return idx >= 0 ? (row[idx] ?? '').trim() : '';
}

/**
 * Split rows into tables: every row accepted by `isHeader` starts a new table whose data rows
 * follow until the next header. Rows before the first header are ignored.
 */
export function splitTables(rows: string[][], isHeader: (keys: string[]) => boolean): Table[] {
  const tables: Table[] = [];
  let current: Table | null = null;
  for (const row of rows) {
    const keys = row.map(norm);
    if (isHeader(keys)) {
      current = { header: row.map((c) => c.trim()), keys, rows: [] };
      tables.push(current);
    } else if (current) {
      current.rows.push(row);
    }
  }
  return tables;
}

/** 32-bit FNV-1a, hex encoded. Deterministic across runs; not cryptographic. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 64-bit hash (cyrb64: two 32-bit lanes of cyrb53 without truncation), 16 hex chars. Not cryptographic. */
export function hash64(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Hash of raw (trimmed) cell strings; field boundaries cannot collide thanks to the separator. */
export function hashCells(cells: readonly string[]): string {
  return hash64(cells.map((c) => c.trim()).join('\u001f'));
}

/**
 * Deterministic external ids, independent of row order and of how a file is parsed (ids come
 * from raw cell text, never from inferred numbers or dates).
 *  - `exec(id, raw)`: `id` is unique per execution/cash row (IBKR TradeID, T212 ID): used bare.
 *  - `order(id, raw)`: `id` identifies an order that may fill several times (Degiro Order ID):
 *    `<prefix>:<id>:<hash(raw time, qty, price cells)>`.
 * Without a broker id both fall back to `<prefix>:h<hash(raw)>`. Rows that produce the same id in
 * one file are identical in the hashed content, so a `#n` suffix (n = count of identical rows so
 * far) keeps legitimate repeats apart without depending on the order of different rows.
 */
export class IdMaker {
  private readonly seen = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  exec(brokerId: string | null | undefined, raw: readonly string[]): string {
    const id = (brokerId ?? '').trim();
    return this.unique(id !== '' ? `${this.prefix}:${id}` : `${this.prefix}:h${hashCells(raw)}`);
  }

  order(orderId: string | null | undefined, raw: readonly string[]): string {
    const id = (orderId ?? '').trim();
    return this.unique(
      id !== '' ? `${this.prefix}:${id}:${hashCells(raw)}` : `${this.prefix}:h${hashCells(raw)}`,
    );
  }

  private unique(base: string): string {
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }
}

export function blankTx(
  kind: TxIn['kind'],
  time: string,
  currency: string,
  rest: Partial<TxIn>,
): TxIn {
  return {
    kind,
    time,
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    fee: 0,
    currency,
    ...rest,
  };
}

export interface Withholding {
  symbol: string;
  currency: string;
  time: string;
  /** Negative = tax withheld, positive = refund. */
  amount: number;
  externalId: string;
  note: string;
}

/**
 * A withholding-tax cash line as its own row (never merged into a dividend): tax withheld is a
 * `fee` tagged with the symbol (note "Withholding tax"); a refund (positive amount) cannot be a
 * negative fee, so it becomes an `interest` credit tagged with the symbol and noted as a refund.
 */
export function withholdingTx(tax: Withholding): TxIn {
  return tax.amount < 0
    ? blankTx('fee', tax.time, tax.currency, {
        symbol: tax.symbol,
        amount: -tax.amount,
        externalId: tax.externalId,
        note: tax.note,
      })
    : blankTx('interest', tax.time, tax.currency, {
        symbol: tax.symbol,
        amount: tax.amount,
        externalId: tax.externalId,
        note: `${tax.note} refund`,
      });
}

/** Normalise a currency code; returns null when it is not three letters. */
export function ccyOf(raw: string | undefined): string | null {
  const c = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}
