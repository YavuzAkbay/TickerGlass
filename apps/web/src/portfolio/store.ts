/**
 * Portfolio panel state: portfolios, the active one's transactions and journal, and the UI bits
 * that survive tab switches. Writes go to the API first and the response replaces the local row,
 * so the store never holds data the server rejected. Actions throw `ApiError`; callers show it.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { errorMessage } from '../api/client';
import * as api from '../api/portfolio';
import type {
  ImportResult,
  JournalEntry,
  JournalIn,
  Portfolio,
  PortfolioIn,
  Transaction,
} from '../api/portfolio';
import type { TxIn } from '@tickerglass/portfolio';
import type { RangeId } from './range';

export type PortfolioTab = 'holdings' | 'activity' | 'performance' | 'journal';
export const PORTFOLIO_TABS: readonly PortfolioTab[] = [
  'holdings',
  'activity',
  'performance',
  'journal',
];

/** "Log trade for current symbol": consumed by the Activity tab once a portfolio is open. */
export interface PendingTrade {
  symbol: string;
  symbolCurrency: string | null;
  last: number | null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface PortfolioState {
  portfolios: Portfolio[];
  listStatus: Status;
  listError: string | null;
  /** Selected portfolio (remembered in this browser). */
  activeId: string | null;
  tab: PortfolioTab;
  range: RangeId;
  /** Rows of the active portfolio, time ascending. */
  transactions: Transaction[];
  journal: JournalEntry[];
  dataStatus: Status;
  dataError: string | null;
  pendingTrade: PendingTrade | null;
  /** Bumped when a screenshot is replaced, so the thumbnail reloads. */
  shotVersion: Record<string, number>;
  set: (patch: Partial<PortfolioState>) => void;
}

export const usePortfolio = create<PortfolioState>()(
  persist(
    (set) => ({
      portfolios: [],
      listStatus: 'idle',
      listError: null,
      activeId: null,
      tab: 'holdings',
      range: 'All',
      transactions: [],
      journal: [],
      dataStatus: 'idle',
      dataError: null,
      pendingTrade: null,
      shotVersion: {},
      set: (patch) => set(patch),
    }),
    {
      name: 'tickerglass-portfolio',
      version: 1,
      partialize: (s) => ({ activeId: s.activeId, tab: s.tab, range: s.range }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Pick<PortfolioState, 'activeId' | 'tab' | 'range'>>;
        return {
          ...current,
          activeId: typeof p.activeId === 'string' ? p.activeId : null,
          tab: PORTFOLIO_TABS.includes(p.tab as PortfolioTab)
            ? (p.tab as PortfolioTab)
            : 'holdings',
          range: (['1M', '3M', 'YTD', '1Y', 'All'] as const).includes(p.range as RangeId)
            ? (p.range as RangeId)
            : 'All',
        };
      },
    },
  ),
);

const get = usePortfolio.getState;
const put = (patch: Partial<PortfolioState>) => usePortfolio.setState(patch);

/** The API order: time, then `seq` (never the id: it is random). */
export function sortTransactions(rows: Transaction[]): Transaction[] {
  return [...rows].sort((a, b) => {
    const d = Date.parse(a.time) - Date.parse(b.time);
    return d !== 0 && !Number.isNaN(d) ? d : a.seq - b.seq;
  });
}

export const activePortfolio = (s: Pick<PortfolioState, 'portfolios' | 'activeId'>) =>
  s.portfolios.find((p) => p.id === s.activeId) ?? null;

// ------------------------------------------------------------- loading

/** Guards against an older load finishing after a newer one. */
let dataToken = 0;

/** Load the portfolio list, then the data of the active one (first when none is chosen). */
export async function loadPortfolios(signal?: AbortSignal): Promise<void> {
  put({ listStatus: 'loading', listError: null });
  try {
    const portfolios = await api.listPortfolios(signal ? { signal } : undefined);
    const cur = get().activeId;
    const activeId = portfolios.some((p) => p.id === cur) ? cur : (portfolios[0]?.id ?? null);
    put({ portfolios, listStatus: 'ready', activeId });
    if (activeId) await loadData(activeId, signal);
    else put({ transactions: [], journal: [], dataStatus: 'idle', dataError: null });
  } catch (e) {
    if (signal?.aborted) return;
    put({ listStatus: 'error', listError: errorMessage(e) });
  }
}

/** Load transactions and journal of `id`. */
export async function loadData(id: string, signal?: AbortSignal): Promise<void> {
  const token = ++dataToken;
  put({ dataStatus: 'loading', dataError: null });
  try {
    const o = signal ? { signal } : undefined;
    const [transactions, journal] = await Promise.all([
      api.listTransactions(id, undefined, o),
      api.listJournal(id, o),
    ]);
    if (token !== dataToken || get().activeId !== id) return;
    put({ transactions: sortTransactions(transactions), journal, dataStatus: 'ready' });
  } catch (e) {
    if (token !== dataToken || signal?.aborted) return;
    put({ dataStatus: 'error', dataError: errorMessage(e) });
  }
}

export async function selectPortfolio(id: string): Promise<void> {
  if (get().activeId === id) return;
  put({ activeId: id, transactions: [], journal: [], dataStatus: 'loading' });
  await loadData(id);
}

// ---------------------------------------------------------- portfolios

export async function createPortfolio(input: PortfolioIn): Promise<Portfolio> {
  const created = await api.createPortfolio(input);
  put({ portfolios: [...get().portfolios, created] });
  await selectPortfolio(created.id);
  return created;
}

export async function savePortfolio(id: string, input: PortfolioIn): Promise<Portfolio> {
  const cur = get().portfolios.find((p) => p.id === id);
  const saved = await api.updatePortfolio(id, {
    ...input,
    ...(cur ? { revision: cur.revision } : {}),
  });
  put({ portfolios: get().portfolios.map((p) => (p.id === id ? saved : p)) });
  return saved;
}

export async function removePortfolio(id: string): Promise<void> {
  await api.deletePortfolio(id);
  const portfolios = get().portfolios.filter((p) => p.id !== id);
  const wasActive = get().activeId === id;
  put({ portfolios });
  if (wasActive) {
    put({ activeId: null, transactions: [], journal: [] });
    const next = portfolios[0];
    if (next) await selectPortfolio(next.id);
    else put({ dataStatus: 'idle' });
  }
}

// -------------------------------------------------------- transactions

export async function addTransaction(portfolioId: string, tx: TxIn): Promise<Transaction> {
  const row = await api.createTransaction(portfolioId, tx);
  if (get().activeId === portfolioId)
    put({ transactions: sortTransactions([...get().transactions, row]) });
  return row;
}

export async function saveTransaction(row: Transaction, tx: TxIn): Promise<Transaction> {
  const saved = await api.updateTransaction(row.id, { ...tx, revision: row.revision });
  put({
    transactions: sortTransactions(get().transactions.map((t) => (t.id === row.id ? saved : t))),
  });
  return saved;
}

export async function removeTransaction(id: string): Promise<void> {
  await api.deleteTransaction(id);
  put({
    transactions: get().transactions.filter((t) => t.id !== id),
    // The server unlinks entries (SET NULL); mirror that.
    journal: get().journal.map((j) => (j.transactionId === id ? { ...j, transactionId: null } : j)),
  });
}

/** Reload only the transactions (after an import or its undo). */
export async function reloadTransactions(portfolioId: string): Promise<void> {
  const rows = await api.listTransactions(portfolioId);
  if (get().activeId === portfolioId) put({ transactions: sortTransactions(rows) });
}

export async function importRows(
  portfolioId: string,
  rows: TxIn[],
  source: string,
): Promise<ImportResult> {
  const res = await api.importTransactions(portfolioId, { transactions: rows, source });
  await reloadTransactions(portfolioId);
  return res;
}

export async function undoImportBatch(portfolioId: string, batch: string): Promise<number> {
  const { deleted } = await api.undoImport(portfolioId, batch);
  await reloadTransactions(portfolioId);
  return deleted;
}

// ------------------------------------------------------------- journal

export async function addJournalEntry(
  portfolioId: string,
  input: JournalIn,
): Promise<JournalEntry> {
  const entry = await api.createJournalEntry(portfolioId, input);
  if (get().activeId === portfolioId) put({ journal: [entry, ...get().journal] });
  return entry;
}

/** Replace an entry in the list by the server's version. */
export function upsertJournal(entry: JournalEntry): void {
  const list = get().journal;
  put({
    journal: list.some((j) => j.id === entry.id)
      ? list.map((j) => (j.id === entry.id ? entry : j))
      : [entry, ...list],
  });
}

export function patchJournal(id: string, patch: Partial<JournalEntry>): void {
  put({ journal: get().journal.map((j) => (j.id === id ? { ...j, ...patch } : j)) });
}

export async function removeJournalEntry(id: string): Promise<void> {
  await api.deleteJournalEntry(id);
  put({ journal: get().journal.filter((j) => j.id !== id) });
}

export async function attachScreenshot(id: string, image: Blob): Promise<void> {
  await api.putScreenshot(id, image);
  // Not the response's entry: it may predate a concurrent autosave of the fields.
  patchJournal(id, { hasScreenshot: true });
  put({ shotVersion: { ...get().shotVersion, [id]: (get().shotVersion[id] ?? 0) + 1 } });
}

export async function removeScreenshot(id: string): Promise<void> {
  await api.deleteScreenshot(id);
  patchJournal(id, { hasScreenshot: false });
}

/** Test hook: back to the initial state. */
export function resetPortfolioStore(): void {
  dataToken++;
  usePortfolio.setState({
    portfolios: [],
    listStatus: 'idle',
    listError: null,
    activeId: null,
    tab: 'holdings',
    range: 'All',
    transactions: [],
    journal: [],
    dataStatus: 'idle',
    dataError: null,
    pendingTrade: null,
    shotVersion: {},
  });
}
