import { Database, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { errorMessage } from '../../api/client';
import { toast } from '../../ui/Toast';
import { isRunConflict, runConflictMessage, triggerRun } from '../server/api';
import { ageOf, bannerKind, etaOf } from '../server/mode';
import type { StatusResponse } from '../server/types';

interface Props {
  status: StatusResponse | null;
  /** Re-read the status (after a run was requested). */
  onRefresh: () => void;
}

/**
 * Strip under the header: how fresh the server snapshot is, run progress, and why the
 * server screener is off (the page then runs the live-only screener).
 */
export function SnapshotBanner({ status, onRefresh }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!status) return null;

  const kind = bannerKind(status);
  const run = status.running;
  const age = ageOf(status.computedAt, now);
  const eta = etaOf(run?.etaS);
  const pct = run && run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;

  const refresh = async () => {
    setBusy(true);
    try {
      await triggerRun('snapshot');
      toast(t('scr.srv.refreshStarted'), 'info');
    } catch (e) {
      if (isRunConflict(e)) toast(runConflictMessage(e) ?? t('scr.srv.alreadyRunning'), 'info');
      else toast(t('scr.srv.refreshFailed').replace('{error}', errorMessage(e)), 'error');
    } finally {
      setBusy(false);
      onRefresh();
    }
  };

  const progress = run
    ? t('scr.srv.progress')
        .replace('{done}', String(run.done))
        .replace('{total}', String(run.total))
    : '';
  const etaStr = eta ? t(eta.key).replace('{n}', String(eta.n)) : '';

  let text: string;
  switch (kind) {
    case 'ready':
      text = t('scr.srv.asOf')
        .replace('{date}', status.asOf ?? '')
        .replace('{age}', age ? t(age.key).replace('{n}', String(age.n)) : '');
      break;
    case 'first_run':
      text = run ? t('scr.srv.building').replace('{progress}', progress) : t('scr.srv.noSnapshot');
      break;
    case 'disabled':
      text = t('scr.srv.disabled');
      break;
    default:
      text = t('scr.srv.unsupported').replace('{provider}', status.provider);
  }
  const canRefresh = (kind === 'ready' || kind === 'first_run') && status.supported;

  return (
    <div className="scr-banner" data-testid="scr-banner" data-kind={kind} role="status">
      <Database size={13} aria-hidden="true" />
      <span className="scr-banner-text" data-testid="scr-banner-text">
        {text}
      </span>
      {run && kind === 'ready' ? (
        <span className="scr-banner-run rs-num" data-testid="scr-banner-run">
          {t('scr.srv.updating').replace('{progress}', progress)}
          {etaStr ? ` · ${etaStr}` : ''}
        </span>
      ) : null}
      {run && kind === 'first_run' && etaStr ? (
        <span className="scr-banner-run rs-num">{etaStr}</span>
      ) : null}
      {run ? (
        <span
          className="scr-banner-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={t('scr.srv.runProgress')}
        >
          <span style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      {kind !== 'ready' ? (
        <span className="scr-banner-note" data-testid="scr-banner-fallback">
          {t('scr.srv.liveOnly')}
        </span>
      ) : null}
      <span className="scr-banner-spacer" />
      {canRefresh ? (
        <button
          type="button"
          className="scr-banner-btn"
          data-testid="scr-refresh"
          disabled={busy || !!run}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} aria-hidden="true" />
          {t('scr.srv.refreshNow')}
        </button>
      ) : null}
    </div>
  );
}
