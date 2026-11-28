import type { Ledger } from '@tickerglass/portfolio';
import { ArrowLeft, Camera, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createAutosaver, type Autosaver } from '../api/autosave';
import { ApiError, errorMessage } from '../api/client';
import {
  journalConflict,
  screenshotUrl,
  updateJournalEntry,
  type JournalEntry,
  type Transaction,
} from '../api/portfolio';
import { createNote, getNote, noteConflict, updateNote } from '../api/persistence';
import { composeScreenshot } from '../chart/screenshot';
import { getChart } from '../store/chart';
import { Modal } from '../ui/Modal';
import { confirmDialog } from '../ui/Prompt';
import { actionToast, toast } from '../ui/Toast';
import { fmtDateTime, fmtR, fmtQty } from './fmt';
import {
  addTags,
  draftFromEntry,
  draftToIn,
  entryR,
  lotsByOpenTx,
  MAX_SETUP,
  MAX_TAGS,
  type JournalDraft,
} from './journalDraft';
import {
  attachScreenshot,
  removeJournalEntry,
  removeScreenshot,
  upsertJournal,
  usePortfolio,
} from './store';
import { parseTyped } from './txForm';

interface Snapshot {
  draft: JournalDraft;
  noteText: string;
}

type Saving = 'saved' | 'saving' | 'invalid' | 'error';

interface Props {
  entry: JournalEntry;
  transactions: readonly Transaction[];
  ledger: Ledger;
  onBack: () => void;
}

const finiteOrNull = (s: string): number | null => {
  const n = parseTyped(s);
  return n !== null && Number.isFinite(n) ? n : null;
};

/** Editor of one journal entry: autosaves the fields and its note, with revision checks. */
export function JournalEditor({ entry, transactions, ledger, onBack }: Props) {
  const [draft, setDraft] = useState(() => draftFromEntry(entry));
  const [tagInput, setTagInput] = useState('');
  const [noteText, setNoteText] = useState('');
  const [noteState, setNoteState] = useState<'loading' | 'ready' | 'error'>(
    entry.noteId ? 'loading' : 'ready',
  );
  const [status, setStatus] = useState<Saving>('saved');
  const [zoom, setZoom] = useState(false);
  const [busyShot, setBusyShot] = useState(false);
  const shotVersion = usePortfolio((s) => s.shotVersion[entry.id] ?? 0);
  const live = usePortfolio((s) => s.journal.find((j) => j.id === entry.id) ?? entry);

  // Save bookkeeping lives in refs: the saver's callbacks must see the latest values.
  const revision = useRef(entry.revision);
  const noteId = useRef<string | null>(entry.noteId);
  const noteRevision = useRef<number | null>(null);
  const noteSaved = useRef<{ text: string; symbol: string | null } | null>(null);
  const entrySaved = useRef(JSON.stringify(draftToIn(draftFromEntry(entry), entry.noteId)));
  const conflictOn = useRef<'entry' | 'note'>('entry');
  const saver = useRef<Autosaver<Snapshot> | null>(null);
  const noteLoaded = useRef(!entry.noteId);

  const lots = useMemo(() => lotsByOpenTx(ledger.closedLots), [ledger.closedLots]);

  useEffect(() => {
    const save = async ({ draft: d, noteText: text }: Snapshot) => {
      const res = draftToIn(d, noteId.current);
      if (!res.ok) {
        setStatus('invalid');
        return;
      }
      const symbol = res.value.symbol;
      if (noteLoaded.current) {
        if (noteId.current === null) {
          if (text.trim()) {
            const n = await createNote({ text, symbol, kind: 'journal' });
            noteId.current = n.id;
            noteRevision.current = n.revision;
            noteSaved.current = { text, symbol };
          }
        } else if (
          noteSaved.current === null ||
          noteSaved.current.text !== text ||
          noteSaved.current.symbol !== symbol
        ) {
          try {
            const n = await updateNote(noteId.current, {
              text,
              symbol,
              ...(noteRevision.current !== null ? { revision: noteRevision.current } : {}),
            });
            noteRevision.current = n.revision;
            noteSaved.current = { text, symbol };
          } catch (e) {
            conflictOn.current = 'note';
            throw e;
          }
        }
      }
      const body = { ...res.value, noteId: noteId.current };
      const json = JSON.stringify({ ok: true, value: body });
      if (json === entrySaved.current) return;
      try {
        const saved = await updateJournalEntry(entry.id, { ...body, revision: revision.current });
        revision.current = saved.revision;
        entrySaved.current = json;
        upsertJournal(saved);
      } catch (e) {
        conflictOn.current = 'entry';
        throw e;
      }
    };

    const s = createAutosaver<Snapshot>(save, {
      delay: 800,
      onSaved: () => setStatus((cur) => (cur === 'invalid' ? cur : 'saved')),
      onError: (e) => {
        setStatus('error');
        toast(`Journal save failed: ${errorMessage(e)}`, 'error');
      },
      onConflict: (err: ApiError, value) => {
        setStatus('error');
        if (conflictOn.current === 'note') {
          const cur = noteConflict(err);
          if (!cur) return;
          actionToast('This entry’s note was changed elsewhere.', [
            {
              label: 'Keep mine',
              run: () => {
                noteRevision.current = cur.revision;
                s.schedule(value);
              },
            },
            {
              label: 'Use theirs',
              run: () => {
                noteRevision.current = cur.revision;
                noteSaved.current = { text: cur.text, symbol: cur.symbol };
                setNoteText(cur.text);
                setStatus('saved');
              },
            },
          ]);
          return;
        }
        const cur = journalConflict(err);
        if (!cur) return;
        actionToast('This journal entry was changed elsewhere.', [
          {
            label: 'Keep mine',
            run: () => {
              revision.current = cur.revision;
              s.schedule(value);
            },
          },
          {
            label: 'Use theirs',
            run: () => {
              revision.current = cur.revision;
              const d = draftFromEntry(cur);
              entrySaved.current = JSON.stringify(draftToIn(d, cur.noteId));
              setDraft(d);
              upsertJournal(cur);
              setStatus('saved');
            },
          },
        ]);
      },
    });
    saver.current = s;
    return () => {
      void s.dispose().catch(() => undefined);
      saver.current = null;
    };
  }, [entry.id]);

  // The note text is not part of the entry: fetch it (editing stays off until it is here).
  const initialNoteId = useRef(entry.noteId);
  useEffect(() => {
    const id = initialNoteId.current;
    if (!id) return;
    const ac = new AbortController();
    getNote(id, { signal: ac.signal })
      .then((n) => {
        noteLoaded.current = true;
        noteRevision.current = n.revision;
        noteSaved.current = { text: n.text, symbol: n.symbol };
        setNoteText(n.text);
        setNoteState('ready');
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          // Deleted elsewhere: start a fresh note on the next edit.
          noteId.current = null;
          noteLoaded.current = true;
          setNoteState('ready');
        } else setNoteState('error');
      });
    return () => ac.abort();
  }, []);

  const change = (nextDraft: JournalDraft, nextNote = noteText) => {
    setDraft(nextDraft);
    setNoteText(nextNote);
    const ok = draftToIn(nextDraft, noteId.current).ok;
    setStatus(ok ? 'saving' : 'invalid');
    saver.current?.schedule({ draft: nextDraft, noteText: nextNote });
  };

  const errors = useMemo(() => {
    const r = draftToIn(draft, null);
    return r.ok ? {} : r.errors;
  }, [draft]);

  const trades = useMemo(() => {
    const buys = transactions
      .filter((t) => t.kind === 'buy')
      .slice(-300)
      .reverse();
    const linked = draft.transactionId
      ? transactions.find((t) => t.id === draft.transactionId)
      : undefined;
    return linked && !buys.some((t) => t.id === linked.id) ? [linked, ...buys] : buys;
  }, [transactions, draft.transactionId]);

  const stop = finiteOrNull(draft.stop);
  const override = finiteOrNull(draft.rMultiple);
  const computed = entryR(stop, null, draft.transactionId, lots);
  const effective = entryR(stop, override, draft.transactionId, lots);

  const pickTrade = (id: string) => {
    const t = transactions.find((x) => x.id === id);
    change({
      ...draft,
      transactionId: t ? t.id : null,
      symbol: t?.symbol && !draft.symbol.trim() ? t.symbol : draft.symbol,
    });
  };

  const attach = async () => {
    const chart = getChart();
    if (!chart) {
      toast('Open a chart first', 'error');
      return;
    }
    setBusyShot(true);
    try {
      const canvas = composeScreenshot([chart], new Date());
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error('could not encode the image');
      await attachScreenshot(entry.id, blob);
    } catch (e) {
      toast(`Attach chart failed: ${errorMessage(e)}`, 'error');
    } finally {
      setBusyShot(false);
    }
  };

  const dropShot = async () => {
    try {
      await removeScreenshot(entry.id);
    } catch (e) {
      toast(`Could not remove the screenshot: ${errorMessage(e)}`, 'error');
    }
  };

  const del = async () => {
    const ok = await confirmDialog({
      title: 'Delete journal entry',
      message: 'Delete this entry, its note and screenshot? The transaction is kept.',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    saver.current?.cancel();
    try {
      await removeJournalEntry(entry.id);
      onBack();
    } catch (e) {
      toast(`Delete failed: ${errorMessage(e)}`, 'error');
    }
  };

  const commitTag = () => {
    if (!tagInput.trim()) return;
    change({ ...draft, tags: addTags(draft.tags, tagInput) });
    setTagInput('');
  };

  const src = screenshotUrl(entry.id, shotVersion || live.updatedAt);

  return (
    <div className="pf-editor">
      <div className="pf-editor-head">
        <button type="button" className="io-btn pf-btn" onClick={onBack}>
          <ArrowLeft size={14} /> Entries
        </button>
        <span className="pf-status" role="status">
          {status === 'saving'
            ? 'Saving…'
            : status === 'invalid'
              ? 'Fix the highlighted fields'
              : status === 'error'
                ? 'Not saved'
                : 'Saved'}
        </span>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="Delete entry"
          data-tip="Delete entry"
          onClick={() => void del()}
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="pf-form">
        <label className="pf-field wide">
          <span>Trade</span>
          <select
            className="io-input"
            value={draft.transactionId ?? ''}
            onChange={(e) => pickTrade(e.target.value)}
          >
            <option value="">No linked trade</option>
            {trades.map((t) => (
              <option key={t.id} value={t.id}>
                {`${fmtDateTime(t.time)} ${t.kind} ${fmtQty(t.quantity)} ${t.symbol ?? ''} @ ${t.price ?? ''}`}
              </option>
            ))}
          </select>
        </label>
        <label className="pf-field">
          <span>Symbol</span>
          <input
            className="io-input"
            maxLength={32}
            value={draft.symbol}
            aria-invalid={!!errors.symbol}
            onChange={(e) => change({ ...draft, symbol: e.target.value })}
          />
        </label>
        <label className="pf-field">
          <span>Setup</span>
          <input
            className="io-input"
            maxLength={MAX_SETUP}
            placeholder="Breakout, pullback…"
            value={draft.setup}
            onChange={(e) => change({ ...draft, setup: e.target.value })}
          />
        </label>
        <div className="pf-field wide">
          <span>Tags</span>
          <div className="pf-chips">
            {draft.tags.map((tag) => (
              <span key={tag} className="pf-chip">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => change({ ...draft, tags: draft.tags.filter((x) => x !== tag) })}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <input
            className="io-input"
            aria-label="Add tag"
            placeholder={
              draft.tags.length >= MAX_TAGS ? 'Tag limit reached' : 'Add a tag, press Enter'
            }
            disabled={draft.tags.length >= MAX_TAGS}
            value={tagInput}
            onChange={(e) => {
              const v = e.target.value;
              if (v.includes(',')) {
                change({ ...draft, tags: addTags(draft.tags, v) });
                setTagInput('');
              } else setTagInput(v);
            }}
            onBlur={commitTag}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTag();
              }
            }}
          />
        </div>
        <label className="pf-field">
          <span>Initial stop</span>
          <input
            className="io-input"
            inputMode="decimal"
            value={draft.stop}
            aria-invalid={!!errors.stop}
            onChange={(e) => change({ ...draft, stop: e.target.value })}
          />
          {errors.stop ? <span className="pf-field-err">{errors.stop}</span> : null}
        </label>
        <label className="pf-field">
          <span>Override R</span>
          <input
            className="io-input"
            inputMode="decimal"
            placeholder="auto"
            value={draft.rMultiple}
            aria-invalid={!!errors.rMultiple}
            onChange={(e) => change({ ...draft, rMultiple: e.target.value })}
          />
          {errors.rMultiple ? <span className="pf-field-err">{errors.rMultiple}</span> : null}
        </label>
      </div>
      <div className="pf-muted">
        Result:{' '}
        <span className={`pf-r ${effective === null ? '' : effective >= 0 ? 'pf-up' : 'pf-down'}`}>
          {fmtR(effective)}
        </span>
        {override !== null
          ? ` (manual; computed ${fmtR(computed)})`
          : effective === null
            ? draft.transactionId
              ? stop === null
                ? ' · add a stop to compute R'
                : ' · shown once the position is sold'
              : ' · link a buy to compute R'
            : ' (from stop and the sold lots)'}
      </div>

      <label className="pf-field">
        <span>
          Notes{' '}
          {noteState === 'loading' ? '(loading…)' : noteState === 'error' ? '(could not load)' : ''}
        </span>
        <textarea
          className="io-input"
          rows={6}
          disabled={noteState !== 'ready'}
          placeholder="Why this trade, what you saw, what you would do differently"
          value={noteText}
          onChange={(e) => change(draft, e.target.value)}
        />
      </label>

      <div className="pf-shot">
        <div className="pf-import-row">
          <button
            type="button"
            className="io-btn pf-btn"
            disabled={busyShot}
            onClick={() => void attach()}
          >
            <Camera size={14} /> {live.hasScreenshot ? 'Replace chart' : 'Attach chart'}
          </button>
          {live.hasScreenshot ? (
            <button type="button" className="io-btn pf-btn" onClick={() => void dropShot()}>
              Remove
            </button>
          ) : null}
        </div>
        {live.hasScreenshot ? (
          <img
            className="pf-thumb"
            src={src}
            alt="Chart when the entry was written"
            onClick={() => setZoom(true)}
          />
        ) : null}
      </div>
      {zoom ? (
        <Modal title="Chart" width={960} onClose={() => setZoom(false)}>
          <img className="pf-lightbox" src={src} alt="Chart when the entry was written" />
        </Modal>
      ) : null}
    </div>
  );
}
