/**
 * Notes panel data: one general note and one note per symbol, synced with
 * `/notes` (revision-checked). The store keeps a localStorage copy (offline
 * cache) with a dirty flag per note, so offline edits are pushed later.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createAutosaver, type Autosaver } from '../api/autosave';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { Note } from '../api/types';
import { isTransient } from './net';

/** Key of the general note (other keys are upper-case symbols). */
export const GENERAL_NOTE = '';

export interface NoteEntry {
  id: string | null;
  text: string;
  revision: number | null;
  /** Edited locally since the last successful save. */
  dirty: boolean;
}

interface NotesState {
  notes: Record<string, NoteEntry>;
  /** Local edit (marks the note dirty). */
  edit: (key: string, text: string) => void;
}

export const useNotesStore = create<NotesState>()(
  persist(
    (set) => ({
      notes: {},
      edit: (key, text) =>
        set((s) => {
          const cur = s.notes[key] ?? { id: null, text: '', revision: null, dirty: false };
          return { notes: { ...s.notes, [key]: { ...cur, text, dirty: true } } };
        }),
    }),
    { name: 'investopen-notes', version: 1, partialize: (s) => ({ notes: s.notes }) },
  ),
);

export const noteKey = (symbol: string | null): string =>
  symbol ? symbol.trim().toUpperCase() : GENERAL_NOTE;

export type NotesApi = Pick<typeof persistence, 'listNotes' | 'createNote' | 'updateNote'>;

export interface NotesSyncOptions {
  api?: NotesApi;
  delay?: number;
  retryDelay?: number;
  onError: (message: string) => void;
  /** Saving `key` hit a newer server version, which is now shown; `restore` re-applies mine. */
  onConflict: (key: string, restore: () => void) => void;
}

function setEntry(key: string, entry: NoteEntry): void {
  useNotesStore.setState((s) => ({ notes: { ...s.notes, [key]: entry } }));
}

export class NotesSync {
  private readonly api: NotesApi;
  private readonly opts: NotesSyncOptions;
  private saver: Autosaver<void>;
  private off: (() => void) | null = null;
  private loaded = false;
  /** Texts the server rejected (permanent error), by key. */
  private rejected = new Map<string, string>();

  constructor(opts: NotesSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    this.saver = createAutosaver<void>(() => this.flushOnce(), {
      delay: opts.delay ?? 800,
      retryDelay: opts.retryDelay ?? 5000,
    });
  }

  start(): void {
    this.off = useNotesStore.subscribe((s, prev) => {
      if (!this.loaded || s.notes === prev.notes) return;
      if (Object.values(s.notes).some((n) => n.dirty)) this.saver.schedule();
    });
  }

  /** Adopt the server's notes; dirty local notes are pushed instead. Throws if unreachable. */
  async load(): Promise<void> {
    const list = await this.api.listNotes();
    // Oldest first: the last note of a key wins (one note per key is created here).
    const latest = new Map<string, Note>();
    for (const n of list) latest.set(noteKey(n.symbol), n);
    const notes = { ...useNotesStore.getState().notes };
    const conflicts: { key: string; mine: string; server: Note }[] = [];
    for (const [key, n] of latest) {
      const local = notes[key];
      if (local?.dirty) {
        if (local.id === n.id && local.revision !== null) continue; // sent with my base revision
        if (local.text === n.text) {
          notes[key] = { id: n.id, text: n.text, revision: n.revision, dirty: false };
          continue;
        }
        // Written here before this note was synced, while the server has one too:
        // never overwrite it blindly. Show the saved one, offer mine.
        notes[key] = { id: n.id, text: n.text, revision: n.revision, dirty: false };
        conflicts.push({ key, mine: local.text, server: n });
        continue;
      }
      notes[key] = { id: n.id, text: n.text, revision: n.revision, dirty: false };
    }
    for (const [key, local] of Object.entries(notes)) {
      if (latest.has(key) || !local.id) continue;
      // Deleted elsewhere: drop a clean copy, re-create an edited one.
      if (local.dirty) notes[key] = { ...local, id: null, revision: null };
      else delete notes[key];
    }
    useNotesStore.setState({ notes });
    for (const c of conflicts)
      this.opts.onConflict(c.key, () =>
        setEntry(c.key, {
          id: c.server.id,
          text: c.mine,
          revision: c.server.revision,
          dirty: true,
        }),
      );
    this.loaded = true;
    if (Object.values(notes).some((n) => n.dirty)) this.saver.schedule();
  }

  private async flushOnce(): Promise<void> {
    const dirty = Object.entries(useNotesStore.getState().notes).filter(
      // A text the server rejected is not resent until it changes (it stays dirty,
      // so the next start does not replace it with the server's copy either).
      ([key, n]) => n.dirty && this.rejected.get(key) !== n.text,
    );
    for (const [key, entry] of dirty) {
      const symbol = key === GENERAL_NOTE ? null : key;
      let saved: Note;
      try {
        if (entry.id)
          saved = await this.api.updateNote(entry.id, {
            text: entry.text,
            symbol,
            ...(entry.revision !== null ? { revision: entry.revision } : {}),
          });
        else if (!entry.text) {
          setEntry(key, { ...entry, dirty: false });
          continue;
        } else saved = await this.api.createNote({ text: entry.text, symbol });
      } catch (err) {
        const server = persistence.noteConflict(err);
        if (server) {
          const mine = entry.text;
          setEntry(key, {
            id: server.id,
            text: server.text,
            revision: server.revision,
            dirty: false,
          });
          this.opts.onConflict(key, () =>
            setEntry(key, { id: server.id, text: mine, revision: server.revision, dirty: true }),
          );
          continue;
        }
        if (isTransient(err)) throw err;
        this.rejected.set(key, entry.text);
        this.opts.onError(
          `Note could not be saved: ${errorMessage(err)}. It is kept in this browser.`,
        );
        continue;
      }
      // Typed on while saving: stays dirty, based on the new revision.
      const now = useNotesStore.getState().notes[key];
      setEntry(key, {
        id: saved.id,
        text: now?.text ?? saved.text,
        revision: saved.revision,
        dirty: (now?.text ?? saved.text) !== entry.text,
      });
    }
  }

  flush(): Promise<void> {
    if (this.loaded && Object.values(useNotesStore.getState().notes).some((n) => n.dirty))
      this.saver.schedule();
    return this.saver.flush();
  }

  /** Stop without sending anything more (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.saver.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.off?.();
    await this.saver.dispose();
  }
}
