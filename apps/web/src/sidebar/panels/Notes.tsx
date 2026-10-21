import { useState } from 'react';
import { GENERAL_NOTE, noteKey, useNotesStore } from '../../persist/notes';
import { useLayoutStatus } from '../../persist/layouts';
import { useChartView } from '../../store/chartView';

/** Notes for the current symbol and a general note, saved to the server (offline: this browser). */
export function Notes() {
  const symbol = useChartView((s) => s.symbol);
  const [scope, setScope] = useState<'symbol' | 'general'>('symbol');
  const key = scope === 'general' ? GENERAL_NOTE : noteKey(symbol);
  const note = useNotesStore((s) => s.notes[key]);
  const online = useLayoutStatus((s) => s.online);
  const text = note?.text ?? '';
  const status = note?.dirty
    ? online
      ? 'Saving…'
      : 'Offline: kept in this browser'
    : 'Saved automatically';
  return (
    <div className="rs-notes">
      <div className="rs-notes-tabs" role="tablist" aria-label="Note">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'symbol'}
          className={`rs-notes-tab${scope === 'symbol' ? ' active' : ''}`}
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
      <textarea
        className="rs-notes-input"
        aria-label={scope === 'general' ? 'General notes' : `Notes for ${symbol}`}
        placeholder={
          scope === 'general' ? 'Write your trading notes here...' : `Notes about ${symbol}...`
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
