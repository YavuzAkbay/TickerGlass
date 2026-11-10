/**
 * Wire types of the server-side screener (docs/design/server-screener.md, section 4,
 * FROZEN contract, `schemaVersion: 1`). Field ids are camelCase; percent fields are
 * in percent (5 = 5 %); `mcap` is USD (null for symbols quoted in another currency);
 * `avgDollarVol30` is close * volume in each symbol's quote currency (unit "ccy", not
 * converted); `nextEarnings` is unix seconds.
 */
import type { ScreenerClass } from '../universe/types';

export type { ScreenerClass };

export type Universe =
  | { kind: 'class'; cls: ScreenerClass }
  | { kind: 'list'; id: string }
  | { kind: 'watchlist'; id: string }
  /** At most 1000 symbols. */
  | { kind: 'symbols'; symbols: string[] };

/** A literal or another field of the same dimension. */
export type Operand = number | { field: string };

export type RuleOp =
  | '>'
  | '<'
  | '>='
  | '<='
  | '='
  | 'between'
  | 'in'
  | 'crossesAbove'
  | 'crossesBelow'
  | 'abovePct'
  | 'belowPct';

export type RuleValue =
  | Operand
  | [number, number]
  | string[]
  | boolean
  /** `=` on an enum / string field (the contract's value union omits it; see report). */
  | string
  | { field: string; pct: number };

export interface Rule {
  field: string;
  op: RuleOp;
  value: RuleValue;
}

/**
 * Formula rule (design doc section 10, additive to schema version 1): an arithmetic
 * expression over numeric field ids (`last / sma200 - 1`, `abs(chg1d)`, `prev(rsi14)`)
 * compared with a number or a `[lo, hi]` range. At most 10 per filter; each counts as a rule.
 * Told apart from a `Rule` by the presence of `formula`.
 */
export interface FormulaRule {
  formula: string;
  op: '>' | '<' | '>=' | '<=' | 'between';
  value: number | [number, number];
}

/** Depth <= 2 (a group may hold one level of nested groups), <= 50 rules in total. */
export interface Group {
  op: 'and' | 'or';
  rules: (Rule | FormulaRule | Group)[];
}

export type SortDir = 'asc' | 'desc';

export interface ScanSort {
  field: string;
  dir: SortDir;
}

export interface ScanRequest {
  universe: Universe;
  filter: Group | null;
  sort: ScanSort;
  /** 1..500, default 100. */
  limit: number;
  offset: number;
  /** Field ids; an entry `"=<formula>"` (at most 3) returns that formula's value under the same key. */
  fields?: string[];
}

export type FieldValue = number | string | boolean | null;

export interface ScanRow {
  symbol: string;
  name: string;
  cls: string;
  group: string;
  exchange: string | null;
  stale: boolean;
  values: Record<string, FieldValue>;
}

export interface ScanResponse {
  asOf: string | null;
  computedAt: string | null;
  provider: string;
  total: number;
  offset: number;
  limit: number;
  coverage: { universe: number; withSnapshot: number };
  rows: ScanRow[];
}

export type FieldCategory =
  'meta' | 'price' | 'performance' | 'technical' | 'volume' | 'fundamental';

export type FieldType =
  'number' | 'percent' | 'money' | 'int' | 'bool' | 'enum' | 'date' | 'string';

export interface FieldDef {
  id: string;
  category: FieldCategory;
  type: FieldType;
  unit: string | null;
  /** Fields of one dimension can be compared with each other. */
  dimension: string;
  ops: RuleOp[];
  crossable: boolean;
  /** False when the active provider has no source for it. */
  available: boolean;
  enumValues: string[] | null;
}

export interface FieldsResponse {
  version: number;
  fields: FieldDef[];
}

export type StatusReason = 'disabled' | 'provider_unsupported' | 'first_run' | null;

export interface StatusRunning {
  runId: number;
  kind: 'snapshot' | 'fundamentals';
  done: number;
  total: number;
  startedAt: string;
  etaS: number | null;
}

export interface StatusResponse {
  enabled: boolean;
  supported: boolean;
  reason: StatusReason;
  provider: string;
  asOf: string | null;
  computedAt: string | null;
  fundamentalsAsOf: string | null;
  coverage: { tracked: number; fresh: number; stale: number; failed: number; tombstoned: number };
  running: StatusRunning | null;
  nextRunAt: string | null;
  budget: { ratePerMin: number; tokensLastRun: number };
  barsRows: number;
}

export interface ScreenSpec {
  schemaVersion: 1;
  universe: Universe;
  filter: Group | null;
  sort: ScanSort;
  columns?: string[];
}

export interface ScreenNotify {
  webhook: boolean;
  telegram: boolean;
  email: boolean;
  webhookUrl?: string;
}

/** `null` = no alert. */
export type ScreenAlert = { enabled: boolean; notify: ScreenNotify } | null;

export interface Screen {
  id: string;
  name: string;
  spec: ScreenSpec;
  alert: ScreenAlert;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Preset {
  id: string;
  name: string;
  spec: ScreenSpec;
}

export interface ListInfo {
  id: string;
  name: string;
  kind: 'index' | 'custom';
  asOf: string;
  source: 'bundled' | 'upload';
  count: number;
}

export interface RunResponse {
  runId: number;
}

/** Error codes of a 422 scan response (`detail.code`). */
export type ScanErrorCode =
  'unknown_field' | 'bad_op' | 'field_unavailable' | 'bad_value' | 'too_complex' | 'bad_formula';

export interface ScanErrorDetail {
  code: ScanErrorCode | string;
  message: string;
  path?: string | null;
  /** Character offset inside a formula (formula errors only). */
  offset?: number;
}
