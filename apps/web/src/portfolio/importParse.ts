/** Broker CSV parsing with the format overrides (date order, decimal separator). Pure. */
import {
  detectBroker,
  parseBrokerCsv,
  type BrokerId,
  type ParsedImport,
} from '@tickerglass/portfolio';

export const MAX_IMPORT_ROWS = 20_000;
/** Bigger files are refused before reading (a broker export is a few MB at most). */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export type DateOrder = 'mdy' | 'dmy';
export type DecimalSep = '.' | ',';

export interface ParseOverrides {
  broker: BrokerId | 'auto';
  /** 'auto' lets the mapper guess. */
  dateOrder: DateOrder | 'auto';
  decimal: DecimalSep | 'auto';
}

export const DEFAULT_OVERRIDES: ParseOverrides = {
  broker: 'auto',
  dateOrder: 'auto',
  decimal: 'auto',
};

export const BROKER_LABEL: Record<BrokerId, string> = {
  ibkr: 'Interactive Brokers',
  schwab: 'Charles Schwab',
  degiro: 'DEGIRO',
  trading212: 'Trading 212',
  generic: 'Generic CSV',
};

/** Parse `text`; overrides set to 'auto' are left out so the mapper guesses. */
export function parseImport(text: string, o: ParseOverrides): ParsedImport {
  const opts = {
    ...(o.dateOrder !== 'auto' ? { dateOrder: o.dateOrder } : {}),
    ...(o.decimal !== 'auto' ? { decimal: o.decimal } : {}),
  };
  return parseBrokerCsv(text, o.broker, opts);
}

export const detect = (text: string): BrokerId | null => detectBroker(text);

/** Rows per kind, e.g. `{ buy: 12, dividend: 3 }`. */
export function countKinds(rows: readonly { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = (out[r.kind] ?? 0) + 1;
  return out;
}
