import { create } from 'zustand';
import type { LiveQuote, StreamStatus } from './types';

interface QuoteState {
  quotes: Record<string, LiveQuote>;
  /** Symbols a snapshot fetch succeeded for but returned no quote (unknown symbol). */
  missing: Record<string, true>;
  status: StreamStatus;
  /** Last snapshot fetch error (null after a success). */
  error: string | null;
}

/** Live quotes by upper-case symbol. Not persisted. */
export const useQuoteStore = create<QuoteState>()(() => ({
  quotes: {},
  missing: {},
  status: 'idle',
  error: null,
}));
