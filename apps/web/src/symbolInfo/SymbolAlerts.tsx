import { Bell, NotebookPen, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { commands } from '../commands/registry';
import { useAlerts } from '../alerts/store';
import { useT } from '../i18n';
import { noteKey, useNotesStore } from '../persist/notes';
import { notePreview } from '../notes/state';
import { Empty } from './parts';
import { Section } from './Section';

interface Props {
  symbol: string;
}

/** The symbol's alerts (open one to edit it), a way to add one, and whether it has a note. */
export function SymbolAlerts({ symbol }: Props) {
  const t = useT();
  const all = useAlerts((s) => s.alerts);
  const noteText = useNotesStore((s) => s.notes[noteKey(symbol)]?.text ?? '');
  const preview = notePreview(noteText);
  const mine = useMemo(() => {
    const key = symbol.trim().toUpperCase();
    return Object.values(all)
      .filter((a) => a.symbol.toUpperCase() === key)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, symbol]);

  return (
    <Section
      id="alerts"
      title={t('si.alerts')}
      testId="si-alerts"
      actions={
        <button
          type="button"
          className="si-link-btn"
          data-testid="si-add-alert"
          onClick={() => commands.execute('alert.create', { symbol })}
        >
          <Plus size={12} aria-hidden="true" />
          {t('si.addAlert')}
        </button>
      }
    >
      {mine.length ? (
        <ul className="si-alerts">
          {mine.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="si-alert"
                aria-label={t('si.editAlert', { name: a.name })}
                onClick={() => commands.execute('alert.edit', { id: a.id })}
              >
                <Bell size={12} aria-hidden="true" />
                <span className="si-alert-name">{a.name}</span>
                <span className={`si-alert-status si-alert-${a.status}`}>{a.status}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{t('si.noAlerts')}</Empty>
      )}
      <div className="si-note-row">
        {preview ? (
          <p className="si-note" data-testid="si-note" title={preview}>
            {preview}
          </p>
        ) : (
          <span className="si-note" data-testid="si-note">
            {t('si.noteNone')}
          </span>
        )}
        <button
          type="button"
          className="si-link-btn"
          data-testid="si-open-note"
          aria-label={t(preview ? 'si.openNoteFor' : 'si.addNoteFor', { symbol })}
          onClick={() => commands.execute('notes.openForSymbol', { symbol })}
        >
          <NotebookPen size={12} aria-hidden="true" />
          {t(preview ? 'si.openNote' : 'si.addNote')}
        </button>
      </div>
    </Section>
  );
}
