/** Journal entry form state <-> API body. Pure. */
import { rMultiple, type ClosedLot } from '@tickerglass/portfolio';
import type { JournalEntry, JournalIn } from '../api/portfolio';
import { parseTyped } from './txForm';

export const MAX_TAGS = 20;
export const MAX_TAG_CHARS = 40;
export const MAX_SETUP = 80;
export const MAX_SYMBOL = 32;

export interface JournalDraft {
  transactionId: string | null;
  symbol: string;
  setup: string;
  tags: string[];
  /** Typed numbers; '' = none. */
  stop: string;
  rMultiple: string;
}

export type JournalDraftErrors = Partial<Record<'symbol' | 'setup' | 'stop' | 'rMultiple', string>>;

export function draftFromEntry(e: JournalEntry): JournalDraft {
  return {
    transactionId: e.transactionId,
    symbol: e.symbol ?? '',
    setup: e.setup ?? '',
    tags: [...e.tags],
    stop: e.stop === null ? '' : String(e.stop),
    rMultiple: e.rMultiple === null ? '' : String(e.rMultiple),
  };
}

/** Add tags typed as `a, b` to `tags`: trimmed, deduplicated, capped at MAX_TAGS / MAX_TAG_CHARS. */
export function addTags(tags: readonly string[], input: string): string[] {
  const out = [...tags];
  for (const raw of input.split(',')) {
    const tag = raw.trim().slice(0, MAX_TAG_CHARS);
    if (tag && !out.includes(tag) && out.length < MAX_TAGS) out.push(tag);
  }
  return out;
}

export type DraftResult =
  { ok: true; value: JournalIn } | { ok: false; errors: JournalDraftErrors };

export function draftToIn(d: JournalDraft, noteId: string | null): DraftResult {
  const errors: JournalDraftErrors = {};
  const symbol = d.symbol.trim().toUpperCase();
  if (symbol.length > MAX_SYMBOL) errors.symbol = `At most ${MAX_SYMBOL} characters`;
  const setup = d.setup.trim();
  if (setup.length > MAX_SETUP) errors.setup = `At most ${MAX_SETUP} characters`;

  let stop: number | null = null;
  const s = parseTyped(d.stop);
  if (s !== null) {
    if (!Number.isFinite(s) || s < 0) errors.stop = 'Must be 0 or more';
    else stop = s;
  }
  let rMultiple: number | null = null;
  const r = parseTyped(d.rMultiple);
  if (r !== null) {
    if (!Number.isFinite(r)) errors.rMultiple = 'Not a number';
    else rMultiple = r;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      transactionId: d.transactionId,
      symbol: symbol || null,
      noteId,
      setup: setup || null,
      tags: d.tags,
      stop,
      rMultiple,
    },
  };
}

/** Entries matching `filter`: `tag:<tag>`, `setup:<setup>`; '' keeps all. */
export function filterEntries(entries: readonly JournalEntry[], filter: string): JournalEntry[] {
  if (filter.startsWith('tag:')) {
    const tag = filter.slice(4);
    return entries.filter((e) => e.tags.includes(tag));
  }
  if (filter.startsWith('setup:')) {
    const setup = filter.slice(6);
    return entries.filter((e) => e.setup === setup);
  }
  return [...entries];
}

/** Distinct tags and setups across `entries`, sorted. */
export function filterOptions(entries: readonly JournalEntry[]): {
  tags: string[];
  setups: string[];
} {
  const tags = new Set<string>();
  const setups = new Set<string>();
  for (const e of entries) {
    for (const t of e.tags) tags.add(t);
    if (e.setup) setups.add(e.setup);
  }
  return { tags: [...tags].sort(), setups: [...setups].sort() };
}

/** Closed FIFO lots grouped by the transaction that opened them (one pass instead of one per entry). */
export function lotsByOpenTx(lots: readonly ClosedLot[]): Map<string, ClosedLot[]> {
  const by = new Map<string, ClosedLot[]>();
  for (const l of lots) {
    const list = by.get(l.openTxId);
    if (list) list.push(l);
    else by.set(l.openTxId, [l]);
  }
  return by;
}

/** R multiple of an entry: the manual override, else computed from its stop and linked trade. */
export function entryR(
  stop: number | null,
  override: number | null,
  transactionId: string | null,
  lots: ReadonlyMap<string, ClosedLot[]>,
): number | null {
  return rMultiple(stop, override, transactionId ? (lots.get(transactionId) ?? []) : []);
}
