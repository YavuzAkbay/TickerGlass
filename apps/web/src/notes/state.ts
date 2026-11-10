/**
 * Which note the Notes panel edits. By default it follows the chart's symbol; `target` pins it
 * to another symbol (opened from a row badge, the detail pane or a command). UI state only:
 * the notes themselves live in `persist/notes`.
 */
import { create } from 'zustand';
import { GENERAL_NOTE, noteKey } from '../persist/notes';

export type NoteScope = 'symbol' | 'general';

/** Longest note preview shown outside the panel. */
export const NOTE_PREVIEW_CHARS = 120;

/** Upper-case symbol to pin, or null (follow the chart) for a blank one. */
export function normalizeTarget(symbol: string | null | undefined): string | null {
  const key = noteKey(symbol ?? null);
  return key === GENERAL_NOTE ? null : key;
}

/** The symbol whose note is shown: the pinned one, else the chart's. */
export function effectiveSymbol(target: string | null, chartSymbol: string): string {
  return target ?? noteKey(chartSymbol);
}

/** Key into the notes store for the shown tab. */
export function activeNoteKey(
  scope: NoteScope,
  target: string | null,
  chartSymbol: string,
): string {
  return scope === 'general' ? GENERAL_NOTE : effectiveSymbol(target, chartSymbol);
}

/**
 * First `max` characters of a note as one line of plain text (whitespace collapsed), with an
 * ellipsis when cut. Counts code points so an emoji is never split. Render it as text only.
 */
export function notePreview(text: string, max = NOTE_PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : flat;
}

interface NotesTargetState {
  /** Pinned upper-case symbol; null follows the chart. */
  target: string | null;
  scope: NoteScope;
  /** The editor should take focus once it is on screen (consumed by the panel). */
  pendingFocus: boolean;
  /** Pin `symbol` (null: follow the chart), show its tab and ask for focus. */
  open: (symbol: string | null) => void;
  /** Pin or unpin without asking for focus. */
  setTarget: (symbol: string | null) => void;
  setScope: (scope: NoteScope) => void;
  consumeFocus: () => void;
}

export const useNotesTarget = create<NotesTargetState>()((set) => ({
  target: null,
  scope: 'symbol',
  pendingFocus: false,
  open: (symbol) => set({ target: normalizeTarget(symbol), scope: 'symbol', pendingFocus: true }),
  setTarget: (symbol) => set({ target: normalizeTarget(symbol) }),
  setScope: (scope) => set({ scope }),
  consumeFocus: () => set({ pendingFocus: false }),
}));
