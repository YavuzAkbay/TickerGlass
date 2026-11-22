/**
 * @tickerglass/portfolio: ledger (lots, cost basis, cash), valuation, time-weighted performance,
 * R-multiples and broker CSV mappers (docs/design/portfolio.md). Pure TS, no DOM.
 */
export * from './types';
export { computeLedger, cashEffect } from './ledger';
export type {
  ClosedLot,
  Ledger,
  LedgerIssue,
  LedgerIssueCode,
  LedgerTotals,
  OpenLot,
  Position,
} from './ledger';
export { valuate } from './valuate';
export type { CashRow, FxLookup, Valuation, ValuationRow, ValuationTotals } from './valuate';
export { performance } from './performance';
export type {
  PerformanceInput,
  PerformancePoint,
  PerformanceResult,
  PerformanceStats,
} from './performance';
export { closedLotsForTx, rMultiple } from './r';
export { detectBroker, parseBrokerCsv } from './csv';
export {
  detectDelimiter,
  fnv1a,
  hash64,
  inferDecimalSeparator,
  analyzeDecimal,
  parseCsv,
  parseDate,
  parseNumber,
} from './csv';
export type { DateOptions, DecimalAnalysis, Delimiter } from './csv';
