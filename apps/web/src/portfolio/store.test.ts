import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry, Portfolio, Transaction } from '../api/portfolio';

const api = vi.hoisted(() => ({
  listPortfolios: vi.fn(),
  listTransactions: vi.fn(),
  listJournal: vi.fn(),
  createTransaction: vi.fn(),
  deletePortfolio: vi.fn(),
  deleteTransaction: vi.fn(),
  putScreenshot: vi.fn(),
  createPortfolio: vi.fn(),
}));
vi.mock('../api/portfolio', () => api);

import {
  addTransaction,
  attachScreenshot,
  loadPortfolios,
  removePortfolio,
  removeTransaction,
  resetPortfolioStore,
  selectPortfolio,
  sortTransactions,
  usePortfolio,
} from './store';

const pf = (id: string): Portfolio => ({
  id,
  name: id,
  baseCurrency: 'USD',
  benchmark: 'SPY',
  costMethod: 'fifo',
  revision: 1,
  createdAt: '',
  updatedAt: '',
});

const tx = (id: string, seq: number, time = '2025-01-02T00:00:00Z'): Transaction => ({
  id,
  portfolioId: 'a',
  kind: 'buy',
  time,
  symbol: 'AAPL',
  quantity: 1,
  price: 1,
  amount: null,
  fee: 0,
  currency: 'USD',
  note: null,
  source: 'manual',
  externalId: null,
  importBatch: null,
  seq,
  revision: 1,
  createdAt: '',
  updatedAt: '',
});

const entry = (id: string, transactionId: string | null): JournalEntry => ({
  id,
  portfolioId: 'a',
  transactionId,
  symbol: null,
  noteId: null,
  setup: null,
  tags: [],
  stop: null,
  rMultiple: null,
  hasScreenshot: false,
  revision: 1,
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => {
  vi.clearAllMocks();
  resetPortfolioStore();
  api.listTransactions.mockResolvedValue([]);
  api.listJournal.mockResolvedValue([]);
});

describe('sortTransactions', () => {
  it('orders by time then seq, not by id', () => {
    const rows = [tx('z', 1), tx('a', 2), tx('m', 0, '2024-01-01T00:00:00Z')];
    expect(sortTransactions(rows).map((r) => r.id)).toEqual(['m', 'z', 'a']);
  });
});

describe('portfolio store', () => {
  it('loads the list and the first portfolio’s data', async () => {
    api.listPortfolios.mockResolvedValue([pf('a'), pf('b')]);
    api.listTransactions.mockResolvedValue([tx('t2', 2), tx('t1', 1)]);
    await loadPortfolios();
    const s = usePortfolio.getState();
    expect(s.activeId).toBe('a');
    expect(s.listStatus).toBe('ready');
    expect(s.dataStatus).toBe('ready');
    expect(s.transactions.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('keeps a remembered portfolio that still exists, else falls back', async () => {
    api.listPortfolios.mockResolvedValue([pf('a'), pf('b')]);
    usePortfolio.setState({ activeId: 'b' });
    await loadPortfolios();
    expect(usePortfolio.getState().activeId).toBe('b');
    usePortfolio.setState({ activeId: 'gone' });
    await loadPortfolios();
    expect(usePortfolio.getState().activeId).toBe('a');
  });

  it('records a list failure', async () => {
    api.listPortfolios.mockRejectedValue(new Error('down'));
    await loadPortfolios();
    expect(usePortfolio.getState()).toMatchObject({ listStatus: 'error', listError: 'down' });
  });

  it('ignores a slower response for a portfolio no longer selected', async () => {
    api.listPortfolios.mockResolvedValue([pf('a'), pf('b')]);
    await loadPortfolios();
    let release!: (rows: Transaction[]) => void;
    api.listTransactions.mockImplementationOnce(
      () => new Promise<Transaction[]>((r) => (release = r)),
    );
    const slow = selectPortfolio('b');
    api.listTransactions.mockResolvedValueOnce([tx('fast', 1)]);
    const fast = selectPortfolio('a');
    await fast;
    release([tx('stale', 1)]);
    await slow;
    expect(usePortfolio.getState().transactions.map((t) => t.id)).toEqual(['fast']);
  });

  it('adds a transaction in API order and unlinks journal entries on delete', async () => {
    api.listPortfolios.mockResolvedValue([pf('a')]);
    api.listTransactions.mockResolvedValue([tx('t1', 1)]);
    api.listJournal.mockResolvedValue([entry('j', 't1')]);
    await loadPortfolios();
    api.createTransaction.mockResolvedValue(tx('t0', 0, '2024-06-01T00:00:00Z'));
    await addTransaction('a', {} as never);
    expect(usePortfolio.getState().transactions.map((t) => t.id)).toEqual(['t0', 't1']);
    api.deleteTransaction.mockResolvedValue(undefined);
    await removeTransaction('t1');
    const s = usePortfolio.getState();
    expect(s.transactions.map((t) => t.id)).toEqual(['t0']);
    expect(s.journal[0]?.transactionId).toBeNull();
  });

  it('selects the next portfolio after deleting the active one', async () => {
    api.listPortfolios.mockResolvedValue([pf('a'), pf('b')]);
    await loadPortfolios();
    api.deletePortfolio.mockResolvedValue(undefined);
    await removePortfolio('a');
    expect(usePortfolio.getState().activeId).toBe('b');
    expect(usePortfolio.getState().portfolios.map((p) => p.id)).toEqual(['b']);
  });

  it('marks the entry and bumps the thumbnail version after a screenshot upload', async () => {
    api.listPortfolios.mockResolvedValue([pf('a')]);
    api.listJournal.mockResolvedValue([entry('j', null)]);
    await loadPortfolios();
    api.putScreenshot.mockResolvedValue(entry('j', null));
    await attachScreenshot('j', new Blob(['x'], { type: 'image/png' }));
    const s = usePortfolio.getState();
    expect(s.journal[0]?.hasScreenshot).toBe(true);
    expect(s.shotVersion.j).toBe(1);
  });
});
