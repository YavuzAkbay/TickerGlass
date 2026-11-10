import { Pin, Undo2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { activeNoteKey, effectiveSymbol, useNotesTarget } from '../../notes/state';
import { GENERAL_NOTE, useNotesStore } from '../../persist/notes';
import { useLayoutStatus } from '../../persist/layouts';
import { useChartView } from '../../store/chartView';

/**
 * Notes for one symbol and a general note, saved to the server (offline: this browser).
 * The symbol follows the chart unless another one was opened (row badge, detail pane).
 */
export function Notes() {
  const t = useT();
  const chartSymbol = useChartView((s) => s.symbol);
  const target = useNotesTarget((s) => s.target);
  const scope = useNotesTarget((s) => s.scope);
  const pendingFocus = useNotesTarget((s) => s.pendingFocus);
  const symbol = effectiveSymbol(target, chartSymbol);
  const key = activeNoteKey(scope, target, chartSymbol);
  const note = useNotesStore((s) => s.notes[key]);
  const online = useLayoutStatus((s) => s.online);
  const input = useRef<HTMLTextAreaElement>(null);
  const text = note?.text ?? '';
  const status = note?.dirty
    ? online
      ? 'Saving…'
      : 'Offline: kept in this browser'
    : 'Saved automatically';

  // Opened from elsewhere: put the cursor in the editor (once).
  useEffect(() => {
    if (!pendingFocus) return;
    input.current?.focus();
    useNotesTarget.getState().consumeFocus();
  }, [pendingFocus, scope, key]);

  const setScope = useNotesTarget.getState().setScope;
  return (
    <div className="rs-notes" data-testid="notes-panel">
      <div className="rs-notes-tabs" role="tablist" aria-label="Note">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'symbol'}
          className={`rs-notes-tab${scope === 'symbol' ? ' active' : ''}`}
          data-testid="notes-tab-symbol"
          onClick={() => setScope('symbol')}
        >
          {symbol}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'general'}
          className={`rs-notes-tab${scope === 'general' ? ' active' : ''}`}
          onClick={() => setScope('general')}
        >
          General
        </button>
      </div>
      {scope === 'symbol' && (
        <div className="rs-notes-target" data-testid="notes-target">
          {target === null ? (
            <>
              <span className="rs-notes-follow">{t('notes.following')}</span>
              <button
                type="button"
                className="rs-notes-pin"
                aria-pressed={false}
                aria-label={t('notes.pin', { symbol })}
                title={t('notes.pin', { symbol })}
                data-testid="notes-pin"
                onClick={() => useNotesTarget.getState().setTarget(symbol)}
              >
                <Pin size={12} aria-hidden="true" />
              </button>
            </>
          ) : (
            <>
              <span className="rs-notes-follow">{t('notes.pinned', { symbol: target })}</span>
              <button
                type="button"
                className="rs-notes-pin rs-notes-back"
                data-testid="notes-back"
                onClick={() => useNotesTarget.getState().setTarget(null)}
              >
                <Undo2 size={12} aria-hidden="true" />
                {t('notes.back')}
              </button>
            </>
          )}
        </div>
      )}
      <textarea
        ref={input}
        className="rs-notes-input"
        aria-label={key === GENERAL_NOTE ? 'General notes' : `Notes for ${symbol}`}
        placeholder={
          key === GENERAL_NOTE ? 'Write your trading notes here...' : `Notes about ${symbol}...`
        }
        value={text}
        spellCheck
        onChange={(e) => useNotesStore.getState().edit(key, e.target.value)}
      />
      <div className="rs-notes-foot">
        {text.length ? `${text.length.toLocaleString()} characters · ${status}` : status}
      </div>
    </div>
  );
}
