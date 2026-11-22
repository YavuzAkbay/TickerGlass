/** Typed calls for the portfolio + trade journal endpoints (docs/design/portfolio.md). */
import type { CostMethod, TxIn, TxKind } from '@tickerglass/portfolio';
import { ApiError, requestJson, type RequestOptions } from './client';

type Opts = Pick<RequestOptions, 'signal'>;
const seg = encodeURIComponent;

export interface Portfolio {
  id: string;
  name: string;
  baseCurrency: string;
  /** null = no benchmark. */
  benchmark: string | null;
  costMethod: CostMethod;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioIn {
  name: string;
  baseCurrency?: string;
  benchmark?: string | null;
  costMethod?: CostMethod;
}

/** A stored transaction (`TxIn` plus server fields). */
export interface Transaction {
  id: string;
  portfolioId: string;
  kind: TxKind;
  /** ISO-8601, UTC. */
  time: string;
  symbol: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  fee: number;
  currency: string;
  note: string | null;
  /** `manual` or `import:<broker>`. */
  source: string;
  externalId: string | null;
  importBatch: string | null;
  /** Tie-break of rows with the same `time`; the API lists rows by (time, seq). */
  seq: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRowError {
  index: number;
  message: string;
}

export interface ImportResult {
  /** Batch id to undo with; null for a dry run or when nothing was created. */
  batch: string | null;
  created: number;
  skipped: number;
  errors: ImportRowError[];
}

export interface JournalEntry {
  id: string;
  portfolioId: string;
  transactionId: string | null;
  symbol: string | null;
  noteId: string | null;
  setup: string | null;
  tags: string[];
  /** Initial stop price (drives R). */
  stop: number | null;
  /** Manual R override. */
  rMultiple: number | null;
  hasScreenshot: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable fields of a journal entry (PUT replaces them all). */
export interface JournalIn {
  transactionId: string | null;
  symbol: string | null;
  noteId: string | null;
  setup: string | null;
  tags: string[];
  stop: number | null;
  rMultiple: number | null;
}

// ------------------------------------------------------------ portfolios

export const listPortfolios = (o?: Opts) =>
  requestJson<Portfolio[]>('GET', '/portfolios', undefined, o);
export const createPortfolio = (body: PortfolioIn, o?: Opts) =>
  requestJson<Portfolio>('POST', '/portfolios', body, o);
/** With `revision`, rejects with 409 (see `portfolioConflict`) if the portfolio changed elsewhere. */
export const updatePortfolio = (id: string, body: PortfolioIn & { revision?: number }, o?: Opts) =>
  requestJson<Portfolio>('PUT', `/portfolios/${seg(id)}`, body, o);
export const deletePortfolio = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/portfolios/${seg(id)}`, undefined, o);

// ---------------------------------------------------------- transactions

export const listTransactions = (portfolioId: string, symbol?: string, o?: Opts) =>
  requestJson<Transaction[]>('GET', `/portfolios/${seg(portfolioId)}/transactions`, undefined, {
    ...o,
    query: { symbol },
  });
export const createTransaction = (portfolioId: string, body: TxIn, o?: Opts) =>
  requestJson<Transaction>('POST', `/portfolios/${seg(portfolioId)}/transactions`, body, o);
/**
 * Full replace. With `revision`, rejects with 409 if the row changed elsewhere. Omitting
 * `externalId` keeps the stored one.
 */
export const updateTransaction = (id: string, body: TxIn & { revision?: number }, o?: Opts) =>
  requestJson<Transaction>('PUT', `/transactions/${seg(id)}`, body, o);
export const deleteTransaction = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/transactions/${seg(id)}`, undefined, o);

/**
 * Import rows. All rows are validated first: any invalid row rejects with 422 (see
 * `importErrors`) and nothing is written. `dryRun` only counts.
 */
export const importTransactions = (
  portfolioId: string,
  body: { transactions: TxIn[]; dryRun?: boolean; source: string },
  o?: Opts,
) =>
  requestJson<ImportResult>('POST', `/portfolios/${seg(portfolioId)}/transactions/import`, body, o);
export const undoImport = (portfolioId: string, batch: string, o?: Opts) =>
  requestJson<{ deleted: number }>(
    'DELETE',
    `/portfolios/${seg(portfolioId)}/imports/${seg(batch)}`,
    undefined,
    o,
  );

// --------------------------------------------------------------- journal

export const listJournal = (portfolioId: string, o?: Opts) =>
  requestJson<JournalEntry[]>('GET', `/portfolios/${seg(portfolioId)}/journal`, undefined, o);
export const createJournalEntry = (portfolioId: string, body: JournalIn, o?: Opts) =>
  requestJson<JournalEntry>('POST', `/portfolios/${seg(portfolioId)}/journal`, body, o);
/** Full replace. With `revision`, rejects with 409 if the entry changed elsewhere. */
export const updateJournalEntry = (id: string, body: JournalIn & { revision?: number }, o?: Opts) =>
  requestJson<JournalEntry>('PUT', `/journal/${seg(id)}`, body, o);
/** Also deletes the entry's linked note. */
export const deleteJournalEntry = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/journal/${seg(id)}`, undefined, o);
/** Upload (or replace) the screenshot; `image` must be a png/jpeg/webp blob. */
export const putScreenshot = (id: string, image: Blob, o?: Opts) =>
  requestJson<JournalEntry>('PUT', `/journal/${seg(id)}/screenshot`, undefined, {
    ...o,
    rawBody: image,
  });
export const deleteScreenshot = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/journal/${seg(id)}/screenshot`, undefined, o);
/** `<img src>` of an entry's screenshot (same-origin: the session cookie is sent). */
export const screenshotUrl = (id: string, version: string | number): string =>
  `/api/journal/${seg(id)}/screenshot?v=${encodeURIComponent(String(version))}`;

// ------------------------------------------------------------ conflicts

const isConflict = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409;

function conflictCurrent<T>(e: unknown): T | null {
  if (!isConflict(e)) return null;
  const d = (e.body as { detail?: unknown } | undefined)?.detail;
  const cur = d && typeof d === 'object' ? (d as { current?: unknown }).current : null;
  return cur && typeof cur === 'object' ? (cur as T) : null;
}

/** The stored portfolio from an `updatePortfolio` 409, else null. */
export const portfolioConflict = (e: unknown) => conflictCurrent<Portfolio>(e);
/** The stored transaction from an `updateTransaction` 409, else null. */
export const transactionConflict = (e: unknown) => conflictCurrent<Transaction>(e);
/** The stored entry from an `updateJournalEntry` 409, else null. */
export const journalConflict = (e: unknown) => conflictCurrent<JournalEntry>(e);

/** Row errors of an import 422 (`detail.errors`), else null. */
export function importErrors(e: unknown): ImportRowError[] | null {
  if (!(e instanceof ApiError) || e.status !== 422) return null;
  const d = (e.body as { detail?: unknown } | undefined)?.detail;
  const list = d && typeof d === 'object' ? (d as { errors?: unknown }).errors : null;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (x): x is ImportRowError =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as ImportRowError).index === 'number' &&
      typeof (x as ImportRowError).message === 'string',
  );
}
