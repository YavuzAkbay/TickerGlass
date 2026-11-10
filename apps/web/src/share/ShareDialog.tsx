import { Copy, Download, FileJson, Link } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { downloadBlob, safeFileName } from '../persist/layouts';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { formatTradingViewTxt, txtFileName } from '../watchlist/model';
import {
  buildShareLink,
  fromShareItems,
  shareFileText,
  symbolCount,
  type ShareLink,
  type SharePayload,
} from './codec';
import { countRules, sectionCount, summarizeSpec, universeText } from './importing';
import './share.css';

/**
 * Share a watchlist or a screen: a link (the content is in the URL fragment), a JSON file, and for a
 * watchlist also a TradingView `.txt` and the plain symbols. Nothing leaves this browser.
 */
export default function ShareDialog({
  payload,
  onClose,
}: {
  payload: SharePayload;
  onClose: () => void;
}) {
  const t = useT();
  const [link, setLink] = useState<ShareLink | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const watchlist = payload.type === 'watchlist';

  useEffect(() => {
    let live = true;
    buildShareLink(payload).then(
      (l) => live && setLink(l),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [payload]);

  const symbols = useMemo(
    () => (payload.type === 'watchlist' ? payload.items.filter((i) => typeof i === 'string') : []),
    [payload],
  );
  const tv = useMemo(
    () =>
      payload.type === 'watchlist' ? formatTradingViewTxt(fromShareItems(payload.items)) : null,
    [payload],
  );

  const copy = (text: string, ok: string) => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      toast(t('share.copyFailed'), 'error');
      input.current?.select();
      return;
    }
    write.then(
      () => toast(ok, 'success'),
      () => {
        toast(t('share.copyFailed'), 'error');
        input.current?.select();
      },
    );
  };

  const summary =
    payload.type === 'watchlist'
      ? t('share.summary.watchlist', {
          symbols: symbolCount(payload.items),
          sections: sectionCount(payload.items),
        })
      : t('share.summary.screen', {
          rules: countRules(payload.spec.filter),
          universe: universeText(t, payload.spec),
          sort: summarizeSpec(payload.spec).sort,
        });

  return (
    <Modal
      title={t(watchlist ? 'share.title.watchlist' : 'share.title.screen')}
      onClose={onClose}
      width={520}
      className="share-dlg"
    >
      <div className="share-name" data-testid="share-name">
        {payload.name}
      </div>
      <div className="share-summary" data-testid="share-summary">
        {summary}
      </div>

      {link?.tooLarge ? (
        <p className="share-warn" role="alert" data-testid="share-too-large">
          {t('share.link.tooLarge', { kb: Math.ceil(link.length / 1024) })}
        </p>
      ) : (
        <input
          ref={input}
          className="io-input share-link"
          readOnly
          aria-label={t('share.link.label')}
          data-testid="share-link"
          value={link?.link ?? (failed ? '' : t('share.link.building'))}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}

      <div className="share-actions">
        <button
          type="button"
          className="io-btn io-btn-primary"
          data-testid="share-copy-link"
          disabled={!link || link.tooLarge}
          onClick={() => link && copy(link.link, t('share.link.copied'))}
        >
          <Link size={14} aria-hidden="true" />
          {t('share.link.copy')}
        </button>
        {watchlist ? (
          <button
            type="button"
            className="io-btn"
            data-testid="share-copy-symbols"
            disabled={!symbols.length}
            onClick={() =>
              copy(symbols.join(', '), t('share.copiedSymbols', { count: symbols.length }))
            }
          >
            <Copy size={14} aria-hidden="true" />
            {t('share.copySymbols')}
          </button>
        ) : null}
        {tv ? (
          <button
            type="button"
            className="io-btn"
            data-testid="share-download-tv"
            onClick={() =>
              downloadBlob(new Blob([tv.text], { type: 'text/plain' }), txtFileName(payload.name))
            }
          >
            <Download size={14} aria-hidden="true" />
            {t('share.downloadTv')}
          </button>
        ) : null}
        <button
          type="button"
          className="io-btn"
          data-testid="share-download-json"
          onClick={() =>
            downloadBlob(
              new Blob([shareFileText(payload)], { type: 'application/json' }),
              `${safeFileName(payload.name)}.json`,
            )
          }
        >
          <FileJson size={14} aria-hidden="true" />
          {t('share.downloadJson')}
        </button>
      </div>

      {tv?.approximate.length ? (
        <p className="share-note" data-testid="share-tv-approx">
          {t('share.tv.approx', {
            count: tv.approximate.length,
            symbols:
              tv.approximate.slice(0, 5).join(', ') +
              (tv.approximate.length > 5 ? ` +${tv.approximate.length - 5}` : ''),
          })}
        </p>
      ) : null}
      <p className="share-note">
        {t('share.link.note')}
        {watchlist ? '' : ` ${t('share.screen.note')}`}
      </p>
    </Modal>
  );
}
