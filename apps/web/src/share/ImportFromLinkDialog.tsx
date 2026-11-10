import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { useT } from '../i18n';
import { createScreen, listScreens } from '../screener/server/api';
import { Modal } from '../ui/Modal';
import { actionToast, toast } from '../ui/Toast';
import { useUiStore } from '../store/ui';
import { sortedLists } from '../watchlist/model';
import { useWatchlistStore } from '../watchlist/store';
import { MAX_NAME, symbolCount, type SharePayload } from './codec';
import {
  countRules,
  importWatchlist,
  sectionCount,
  summarizeSpec,
  uniqueName,
  universeText,
} from './importing';
import type { ShareRequest } from './open';
import './share.css';

type Request = Exclude<ShareRequest, { kind: 'share' }>;

const PREVIEW_SYMBOLS = 12;

/**
 * Preview of a shared watchlist or screen (from a link or a file) with the choice of where it goes.
 * Nothing is imported before "Import" is pressed.
 */
export default function ImportFromLinkDialog({
  request,
  onClose,
}: {
  request: Request;
  onClose: () => void;
}) {
  const t = useT();
  if (request.kind === 'error')
    return (
      <Modal
        title={t('share.import.title.error')}
        onClose={onClose}
        width={420}
        className="share-dlg"
        footer={
          <>
            <div className="io-spacer" />
            <button
              type="button"
              className="io-btn"
              data-testid="import-close"
              onClick={onClose}
              autoFocus
            >
              {t('share.import.close')}
            </button>
          </>
        }
      >
        <p className="share-warn" role="alert" data-testid="import-error">
          {t(`share.error.${request.code}` as const)}
        </p>
      </Modal>
    );
  return (
    <Modal
      title={t(
        request.payload.type === 'watchlist'
          ? 'share.import.title.watchlist'
          : 'share.import.title.screen',
      )}
      onClose={onClose}
      width={520}
      className="share-dlg"
    >
      <div data-testid="import-dialog">
        <p className="share-note">{t(`share.import.source.${request.source}` as const)}</p>
        {request.payload.type === 'watchlist' ? (
          <WatchlistImport payload={request.payload} onClose={onClose} />
        ) : (
          <ScreenImport payload={request.payload} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}

function Footer({
  disabled,
  busy,
  label,
  onCancel,
  onConfirm,
}: {
  disabled: boolean;
  busy?: boolean;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <div className="share-footer">
      <button type="button" className="io-btn" data-testid="import-cancel" onClick={onCancel}>
        {t('share.import.cancel')}
      </button>
      <button
        type="button"
        className="io-btn io-btn-primary"
        data-testid="import-confirm"
        disabled={disabled || busy}
        onClick={onConfirm}
      >
        {busy ? t('share.import.saving') : label}
      </button>
    </div>
  );
}

function WatchlistImport({
  payload,
  onClose,
}: {
  payload: Extract<SharePayload, { type: 'watchlist' }>;
  onClose: () => void;
}) {
  const t = useT();
  const lists = useWatchlistStore((s) => s.lists);
  const all = sortedLists(lists);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(() =>
    uniqueName(
      payload.name,
      Object.values(useWatchlistStore.getState().lists).map((l) => l.name),
    ),
  );
  const [picked, setPicked] = useState('');
  const target = all.some((l) => l.id === picked) ? picked : (all[0]?.id ?? '');
  const symbols = payload.items.filter((i): i is string => typeof i === 'string');
  const sections = sectionCount(payload.items);

  const confirm = () => {
    const done = importWatchlist(payload, mode === 'new' ? { mode, name } : { mode, id: target });
    if (!done) return;
    toast(
      mode === 'new'
        ? t('share.import.done', { name: done.name, count: done.added })
        : t('share.import.addedTo', { name: done.name, added: done.added, skipped: done.skipped }),
      'success',
    );
    onClose();
  };

  return (
    <>
      <div className="share-name" data-testid="import-name-preview">
        {payload.name}
      </div>
      <div className="share-summary" data-testid="import-summary">
        {t('share.summary.watchlist', { symbols: symbolCount(payload.items), sections })}
      </div>
      <div
        className="share-chips"
        aria-label={t('share.import.symbols')}
        data-testid="import-symbols"
      >
        {symbols.slice(0, PREVIEW_SYMBOLS).map((s) => (
          <span key={s} className="share-chip">
            {s}
          </span>
        ))}
        {symbols.length > PREVIEW_SYMBOLS ? (
          <span className="share-chip share-chip-more">
            {t('share.import.more', { count: symbols.length - PREVIEW_SYMBOLS })}
          </span>
        ) : null}
      </div>

      <div className="share-modes" role="radiogroup">
        <label>
          <input
            type="radio"
            name="share-import-mode"
            checked={mode === 'new'}
            data-testid="import-mode-new"
            onChange={() => setMode('new')}
          />
          {t('share.import.new')}
        </label>
        {mode === 'new' ? (
          <input
            className="io-input share-field"
            aria-label={t('share.import.listName')}
            data-testid="import-list-name"
            value={name}
            maxLength={MAX_NAME}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        <label>
          <input
            type="radio"
            name="share-import-mode"
            checked={mode === 'existing'}
            disabled={!all.length}
            data-testid="import-mode-existing"
            onChange={() => setMode('existing')}
          />
          {t('share.import.existing')}
        </label>
        {mode === 'existing' ? (
          <>
            <select
              className="io-input share-field"
              aria-label={t('share.import.target')}
              data-testid="import-target"
              value={target}
              onChange={(e) => setPicked(e.target.value)}
            >
              {all.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {sections ? <p className="share-note">{t('share.import.sectionsNote')}</p> : null}
          </>
        ) : null}
      </div>

      <Footer
        disabled={mode === 'new' ? !name.trim() : !target}
        label={t('share.import.confirm')}
        onCancel={onClose}
        onConfirm={confirm}
      />
    </>
  );
}

function ScreenImport({
  payload,
  onClose,
}: {
  payload: Extract<SharePayload, { type: 'screen' }>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(payload.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeSpec(payload.spec);

  // Dedupe against the screens saved already (when the server answers).
  useEffect(() => {
    let live = true;
    listScreens().then(
      (screens) => {
        if (live)
          setName((cur) =>
            cur === payload.name
              ? uniqueName(
                  cur,
                  screens.map((s) => s.name),
                )
              : cur,
          );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [payload.name]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await createScreen({
        id: crypto.randomUUID(),
        name: name.trim(),
        spec: payload.spec,
        alert: null,
      });
      actionToast(
        t('share.import.screenSaved', { name: saved.name }),
        [
          {
            label: t('share.import.openScreener'),
            run: () => useUiStore.getState().openScreen('screener'),
          },
        ],
        'success',
        8000,
      );
      onClose();
    } catch (e) {
      setError(t('share.import.screenFailed', { error: errorMessage(e) }));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="share-name" data-testid="import-name-preview">
        {payload.name}
      </div>
      <div className="share-summary" data-testid="import-summary">
        {t('share.summary.screen', {
          rules: countRules(payload.spec.filter),
          universe: universeText(t, payload.spec),
          sort: summary.sort,
        })}
      </div>
      <input
        className="io-input share-field share-field-full"
        aria-label={t('share.import.screenName')}
        data-testid="import-screen-name"
        value={name}
        maxLength={MAX_NAME}
        onChange={(e) => setName(e.target.value)}
      />
      {error ? (
        <p className="share-warn" role="alert" data-testid="import-screen-error">
          {error}
        </p>
      ) : null}
      <p className="share-note">{t('share.screen.note')}</p>
      <Footer
        disabled={!name.trim()}
        busy={busy}
        label={t('share.import.saveScreen')}
        onCancel={onClose}
        onConfirm={() => void confirm()}
      />
    </>
  );
}
