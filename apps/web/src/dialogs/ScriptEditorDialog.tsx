import { USER_SCRIPT_PREFIX, getIndicator } from '@investopen/indicators';
import { Check, Copy, FilePlus, PlusSquare, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';
import { errorMessage } from '../api/client';
import type { UserScript } from '../api/types';
import { addIndicator, removeIndicators } from '../indicators/actions';
import { studyTitle } from '../indicators/model';
import { useIndicatorStore } from '../indicators/store';
import { getPersistence } from '../persist/bootstrap';
import { UserScriptConflict, type UserScriptsSync } from '../persist/userScripts';
import {
  PROBE_TIMEOUT_MS,
  analyzeScript,
  checkRequestOf,
  loadTimedOut,
  loadTimeoutMessage,
  parseSource,
  probeScript,
  renameScript,
  saveScript,
  type Analysis,
  type Diagnostic,
  type SaveDeps,
} from '../scripts/editorSave';
import {
  NEW_SCRIPT_TEMPLATE,
  copyName,
  gutterText,
  insertIndent,
  instancesOfScript,
  newScriptId,
  offsetOf,
  uniqueName,
} from '../scripts/editorText';
import { useScriptsStore } from '../scripts/store';
import { getChart } from '../store/chart';
import { Modal } from '../ui/Modal';
import { confirmDialog, promptName } from '../ui/Prompt';
import { actionToast, toast } from '../ui/Toast';
import './dialogs.css';
import './scriptEditor.css';

/** Arg of the `scriptEditor` dialog: open this script, or start a new one. */
export interface ScriptEditorArg {
  scriptId?: string;
  new?: boolean;
}

const LINE_HEIGHT = 18;

/** The script being edited. `isNew`: not saved yet (no server copy). */
interface Draft {
  id: string;
  isNew: boolean;
  /** Only used while `isNew`; saved scripts take the name from the store. */
  name: string;
}

function newDraft(scripts: readonly UserScript[]): Draft {
  return {
    id: newScriptId(),
    isNew: true,
    name: uniqueName(
      'Untitled script',
      scripts.map((s) => s.name),
    ),
  };
}

function initialState(
  scripts: readonly UserScript[],
  arg: unknown,
): { draft: Draft; text: string; baseline: string } {
  const a = (arg ?? {}) as ScriptEditorArg;
  const wanted = a.new ? undefined : scripts.find((s) => s.id === a.scriptId);
  const open = wanted ?? (a.new ? undefined : scripts[0]);
  if (open)
    return {
      draft: { id: open.id, isNew: false, name: open.name },
      text: open.source,
      baseline: open.source,
    };
  return { draft: newDraft(scripts), text: NEW_SCRIPT_TEMPLATE, baseline: '' };
}

/** Script editor: list, source with line numbers, Save / Add to chart / Check, diagnostics. */
export default function ScriptEditorDialog({
  onClose,
  arg,
}: {
  onClose: () => void;
  arg?: unknown;
}) {
  const scripts = useScriptsStore((s) => s.scripts);
  const instances = useIndicatorStore((s) => s.instances);
  const [init] = useState(() => initialState(useScriptsStore.getState().scripts, arg));
  const [draft, setDraft] = useState(init.draft);
  const [text, setText] = useState(init.text);
  const [baseline, setBaseline] = useState(init.baseline);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [deleting, setDeleting] = useState<UserScript | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);

  const current = draft.isNew ? undefined : scripts.find((s) => s.id === draft.id);
  const name = current?.name ?? draft.name;
  const dirty = draft.isNew || text !== baseline;
  const sync: UserScriptsSync | undefined = getPersistence()?.userScripts;

  // ---------------------------------------------------------------- closing

  const confirmDiscard = async (): Promise<boolean> =>
    !dirty ||
    confirmDialog({
      title: 'Unsaved changes',
      message: `Discard the unsaved changes to "${name}"?`,
      okLabel: 'Discard',
      danger: true,
    });
  // Modal re-registers its Escape handler when `onClose` changes (and would then
  // outrank a dialog opened above it): hand it a stable function.
  const latest = useRef({ confirmDiscard, onClose });
  useEffect(() => {
    latest.current = { confirmDiscard, onClose };
  });
  const close = useCallback(() => {
    void latest.current.confirmDiscard().then((ok) => {
      if (ok) latest.current.onClose();
    });
  }, []);

  // Closing the page with unsaved changes asks too.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---------------------------------------------------------------- opening

  const open = (s: { draft: Draft; text: string; baseline: string }) => {
    setDraft(s.draft);
    setText(s.text);
    setBaseline(s.baseline);
    setDiagnostics([]);
  };
  const openScript = (s: UserScript) =>
    open({ draft: { id: s.id, isNew: false, name: s.name }, text: s.source, baseline: s.source });

  const select = async (s: UserScript) => {
    if (!draft.isNew && s.id === draft.id) return;
    if (await confirmDiscard()) openScript(s);
  };
  const create = async () => {
    if (!(await confirmDiscard())) return;
    open({ draft: newDraft(scripts), text: NEW_SCRIPT_TEMPLATE, baseline: '' });
  };
  const duplicate = async () => {
    if (!(await confirmDiscard())) return;
    open({
      draft: {
        id: newScriptId(),
        isNew: true,
        name: copyName(
          name,
          scripts.map((s) => s.name),
        ),
      },
      text,
      baseline: '',
    });
  };
  const afterRemoved = (id: string) => {
    const rest = useScriptsStore.getState().scripts.filter((s) => s.id !== id);
    const next = rest[0];
    if (next) openScript(next);
    else open({ draft: newDraft([]), text: NEW_SCRIPT_TEMPLATE, baseline: '' });
  };

  // ----------------------------------------------------------- persisting

  const requireSync = (): UserScriptsSync | null => {
    if (!sync) toast('Saving scripts needs the server connection', 'error');
    return sync ?? null;
  };

  /** 409: offer to take the stored version or to overwrite it with ours. */
  const conflictToast = (err: UserScriptConflict, overwrite: () => void) =>
    actionToast(
      `"${err.current.name}" was changed elsewhere.`,
      [
        {
          label: 'Reload',
          run: () => {
            sync?.adopt(err.current);
            openScript(err.current);
          },
        },
        { label: 'Overwrite', run: overwrite },
      ],
      'error',
    );

  const saveDeps = (
    s: UserScriptsSync,
    id: string,
    onAnalysis: (a: Analysis) => void = (a) => setDiagnostics(a.diagnostics),
  ): SaveDeps => ({
    parse: parseSource,
    probe: (source, withCheck) =>
      probeScript(source, id, withCheck ? () => checkRequestOf(getChart()) : null),
    save: (sid, input, opts) => s.save(sid, input, opts),
    onAnalysis,
  });

  /** Save the text: analyze, then store (scripts that do not compile are stored too). */
  const save = async (
    opts: { overwrite?: boolean; analysis?: Analysis; source?: string } = {},
  ): Promise<UserScript | null> => {
    const s = requireSync();
    if (!s || busy) return null;
    const { id } = draft;
    const source = opts.source ?? text;
    setBusy('save');
    let shown = opts.analysis;
    const deps = saveDeps(s, id, (a) => {
      shown = a;
      setDiagnostics(a.diagnostics);
    });
    try {
      const { saved, analysis } = await saveScript(id, name, source, deps, opts);
      setDraft({ id, isNew: false, name: saved.name });
      setBaseline(source);
      if (analysis.manifest) toast(`"${saved.name}" saved`, 'success', 1800);
      else if (loadTimedOut(analysis))
        toast(`Saved, but it cannot run: ${loadTimeoutMessage(PROBE_TIMEOUT_MS)}`, 'error');
      else toast('Saved, but the script has errors and cannot run yet', 'error');
      return saved;
    } catch (err) {
      if (err instanceof UserScriptConflict) {
        // The analysis was shown already; "Overwrite" stores that one.
        const analysis = shown;
        conflictToast(
          err,
          () => void save({ overwrite: true, source, ...(analysis ? { analysis } : {}) }),
        );
      } else toast(errorMessage(err), 'error');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    const s = requireSync();
    if (!s || busy) return;
    setBusy('check');
    try {
      const analysis = await analyzeScript(text, saveDeps(s, draft.id));
      setDiagnostics(analysis.diagnostics);
    } finally {
      setBusy(null);
    }
  };

  const addToChart = async () => {
    // Unsaved changes are saved first: the chart runs the saved script.
    const script = dirty ? await save() : (current ?? null);
    if (!script) return;
    if (!script.manifest) {
      toast('The script has errors: fix them and save before adding it', 'error');
      return;
    }
    if (addIndicator(USER_SCRIPT_PREFIX + script.id))
      toast(`Added "${script.name}"`, 'success', 1800);
  };

  const rename = async () => {
    const next = await promptName({
      title: 'Rename script',
      initial: name,
      okLabel: 'Rename',
    });
    if (!next || next === name) return;
    if (!current) {
      setDraft({ ...draft, name: next });
      return;
    }
    const s = requireSync();
    if (!s) return;
    await renameScript(current, next, {
      save: (id, input, opts) => s.save(id, input, opts),
      onConflict: (err, overwrite) => conflictToast(err, () => void overwrite()),
      onError: (err) => toast(errorMessage(err), 'error'),
    });
  };

  const remove = async (alsoInstances: boolean) => {
    const target = deleting;
    const s = requireSync();
    if (!target || !s) return;
    try {
      const ids = instancesOfScript(useIndicatorStore.getState().instances, target.id).map(
        (i) => i.id,
      );
      await s.delete(target.id);
      if (alsoInstances) removeIndicators(ids);
      toast(`"${target.name}" deleted`, 'success', 2500);
      setDeleting(null);
      if (target.id === draft.id) afterRemoved(target.id);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const askDelete = () => {
    if (current) setDeleting(current);
    else afterRemoved(draft.id); // An unsaved script: just drop it.
  };

  // ---------------------------------------------------------------- editing

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      // Not the app's "save layout" shortcut.
      e.preventDefault();
      e.stopPropagation();
      void save();
    }
  };

  const onTextKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: start, selectionEnd: end } = ta;
    // execCommand keeps the browser's undo history; fall back to setting the value.
    if (document.execCommand('insertText', false, '  ')) return;
    const next = insertIndent(ta.value, start, end);
    setText(next.text);
    requestAnimationFrame(() => ta.setSelectionRange(next.caret, next.caret));
  };

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
  };

  const jump = (d: Diagnostic) => {
    const ta = area.current;
    if (!ta || d.line === undefined) return;
    const at = offsetOf(text, d.line, d.col);
    ta.focus();
    ta.setSelectionRange(at, at);
    const top = (d.line - 1) * LINE_HEIGHT;
    if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 3 * LINE_HEIGHT)
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
  };

  const status =
    busy === 'save' ? 'Saving…' : busy === 'check' ? 'Checking…' : dirty ? 'Unsaved changes' : '';

  return (
    <Modal title="Script editor" onClose={close} width={1040} className="se-dialog">
      <div className="se-body" onKeyDown={onKeyDown}>
        <div className="se-side">
          <div className="se-side-tools">
            <button
              type="button"
              className="io-icon-btn"
              aria-label="New script"
              title="New script"
              onClick={() => void create()}
            >
              <FilePlus size={16} />
            </button>
            <button
              type="button"
              className="io-icon-btn"
              aria-label="Rename script"
              title="Rename"
              onClick={() => void rename()}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              className="io-icon-btn"
              aria-label="Duplicate script"
              title="Duplicate"
              onClick={() => void duplicate()}
            >
              <Copy size={16} />
            </button>
            <button
              type="button"
              className="io-icon-btn"
              aria-label="Delete script"
              title="Delete"
              onClick={askDelete}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="se-list" role="listbox" aria-label="Scripts">
            {draft.isNew ? (
              <button type="button" role="option" aria-selected className="se-script active">
                <span className="se-script-name">{draft.name}</span>
                <span className="se-script-flag">new</span>
              </button>
            ) : null}
            {scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={s.id === draft.id && !draft.isNew}
                className={`se-script${s.id === draft.id && !draft.isNew ? ' active' : ''}`}
                onClick={() => void select(s)}
              >
                <span className="se-script-name">{s.id === draft.id ? name : s.name}</span>
                {!s.manifest ? <span className="se-script-flag error">errors</span> : null}
                {s.id === draft.id && dirty ? <span className="se-script-flag">edited</span> : null}
              </button>
            ))}
            {!scripts.length && !draft.isNew ? (
              <div className="se-empty">No scripts yet.</div>
            ) : null}
          </div>
        </div>
        <div className="se-main">
          <div className="se-toolbar">
            <button
              type="button"
              className="io-btn io-btn-primary"
              disabled={!!busy}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="io-btn"
              disabled={!!busy}
              onClick={() => void addToChart()}
            >
              <PlusSquare size={15} />
              Add to chart
            </button>
            <button type="button" className="io-btn" disabled={!!busy} onClick={() => void check()}>
              <Check size={15} />
              Check
            </button>
            <div className="io-spacer" />
            <span className="se-status">{status}</span>
          </div>
          <div className="se-editor">
            <pre className="se-gutter" ref={gutter} aria-hidden="true">
              {gutterText(text)}
            </pre>
            <textarea
              ref={area}
              className="se-text"
              aria-label="Script source"
              value={text}
              wrap="off"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onTextKeyDown}
              onScroll={onScroll}
            />
          </div>
          <div className="se-diags" aria-label="Diagnostics">
            <div className="se-diags-title">Problems</div>
            {diagnostics.length === 0 ? (
              <div className="se-empty">Save or Check to analyze the script.</div>
            ) : (
              diagnostics.map((d, i) => {
                const body = (
                  <>
                    <span className="se-diag-sev">{d.severity}</span>
                    {d.line !== undefined ? (
                      <span className="se-diag-pos">
                        {d.line}
                        {d.col !== undefined ? `:${d.col}` : ''}
                      </span>
                    ) : null}
                    <span className="se-diag-msg">{d.message}</span>
                  </>
                );
                return d.line !== undefined ? (
                  <button
                    key={i}
                    type="button"
                    className={`se-diag ${d.severity}`}
                    onClick={() => jump(d)}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={i} className={`se-diag ${d.severity}`}>
                    {body}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
      {deleting ? (
        <DeleteScriptDialog
          script={deleting}
          onCancel={() => setDeleting(null)}
          onDelete={(alsoInstances) => void remove(alsoInstances)}
          instanceTitles={instancesOfScript(instances, deleting.id).map((i) => {
            const def = getIndicator(i.type);
            return def
              ? studyTitle(def, i.inputs, (id) => instances.find((x) => x.id === id))
              : deleting.name;
          })}
        />
      ) : null}
    </Modal>
  );
}

/** Delete confirmation: lists the instances on the current chart and offers to remove them. */
function DeleteScriptDialog({
  script,
  instanceTitles,
  onCancel,
  onDelete,
}: {
  script: UserScript;
  instanceTitles: string[];
  onCancel: () => void;
  onDelete: (alsoInstances: boolean) => void;
}) {
  const [alsoInstances, setAlsoInstances] = useState(true);
  return (
    <Modal
      title="Delete script"
      onClose={onCancel}
      width={440}
      className="io-prompt"
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="io-btn io-btn-danger"
            autoFocus
            onClick={() => onDelete(alsoInstances)}
          >
            Delete
          </button>
        </>
      }
    >
      <p className="io-prompt-message">Delete "{script.name}"? This cannot be undone.</p>
      {instanceTitles.length ? (
        <>
          <p className="io-prompt-message">It is used on this chart by:</p>
          <ul className="se-delete-list">
            {instanceTitles.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
          <label className="dlg-check">
            <input
              type="checkbox"
              checked={alsoInstances}
              onChange={(e) => setAlsoInstances(e.target.checked)}
            />
            <span>Also remove {instanceTitles.length === 1 ? 'it' : 'them'} from the chart</span>
          </label>
        </>
      ) : null}
    </Modal>
  );
}
