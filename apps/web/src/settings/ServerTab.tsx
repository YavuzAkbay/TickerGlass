import { Download, LogOut, RefreshCw, Server, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { leaveAfterLogout, logout } from '../api/auth';
import { useIsAdmin } from '../auth/access';
import { clearUserCache } from '../auth/cacheGuard';
import { getPersistence } from '../persist/bootstrap';
import { useAuthStore } from '../store/auth';
import { clearMarketCache, fetchServerStatus, type ServerStatus } from '../api/server';
import { checkForUpdate, type UpdateCheck } from '../api/updates';
import { useT } from '../i18n';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { Section } from '../dialogs/controls';
import { BackupsSection } from './BackupsSection';
import { formatBytes } from './serverFormat';
import { StatusRow } from './StatusRow';

/** "3d 4h" / "52m" for an uptime in seconds. */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Settings → Server: what the instance runs and holds, plus maintenance actions. */
export function ServerTab() {
  const t = useT();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'backup' | 'cache' | 'updates' | 'logout' | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const authInfo = useAuthStore((s) => s.info);
  const admin = useIsAdmin();

  const load = () =>
    fetchServerStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));

  useEffect(() => void load(), []);

  const downloadBackup = () => {
    setBusy('backup');
    // A plain link download; errors surface as a JSON blob instead of a file.
    fetch('/api/server/backup')
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tickerglass-backup-${new Date().toISOString().slice(0, 10)}.db`;
        a.click();
        URL.revokeObjectURL(url);
        toast(t('srv.backupDone'), 'success');
      })
      .catch((err) => toast(t('srv.backupFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const clearCache = async () => {
    const yes = await confirmDialog({
      title: t('srv.clearCacheConfirmTitle'),
      message: t('srv.clearCacheConfirmText'),
      okLabel: t('srv.clearCache'),
    });
    if (!yes) return;
    setBusy('cache');
    clearMarketCache()
      .then(() => {
        toast(t('srv.clearCacheDone'), 'success');
        void load();
      })
      .catch((err) => toast(t('srv.clearCacheFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const checkUpdates = () => {
    setBusy('updates');
    checkForUpdate()
      .then(setUpdate)
      .catch((err) => toast(errorMessage(err), 'error'))
      .finally(() => setBusy(null));
  };

  const signOut = () => {
    setBusy('logout');
    // Save what is pending, sign out, then stop syncing so no page-hide flush rewrites the
    // cache after it is cleared: the next account on this browser must not see this one's
    // offline copy.
    const persistence = getPersistence();
    (persistence ? persistence.flushAll().catch(() => undefined) : Promise.resolve())
      .then(() => logout())
      .then(async (redirect) => {
        await persistence?.halt();
        clearUserCache(undefined, undefined, true);
        leaveAfterLogout(redirect);
      })
      .catch((err) => {
        setBusy(null);
        toast(errorMessage(err), 'error');
      });
  };

  if (error)
    return (
      <Section title={t('settings.tab.server')}>
        <p className="dlg-note">{error}</p>
      </Section>
    );
  if (!status)
    return (
      <Section title={t('settings.tab.server')}>
        <p className="dlg-note">…</p>
      </Section>
    );

  const alerts = status.alertsService;
  const counts = status.counts;
  const updateNote = update
    ? update.updateAvailable
      ? t('srv.updateAvailable', { version: update.latest ?? '' })
      : t('srv.upToDate', { version: update.current })
    : null;

  return (
    <>
      <Section title={t('settings.tab.server')}>
        <StatusRow label={t('srv.version')} value={status.version} />
        {status.uptimeSeconds != null ? (
          <StatusRow label={t('srv.uptime')} value={formatUptime(status.uptimeSeconds)} />
        ) : null}
        <StatusRow
          label={t('srv.provider')}
          value={
            status.provider.name
              ? `${status.provider.name}${status.provider.configured ? '' : ` (${t('srv.notConfigured')})`}`
              : '—'
          }
        />
        {alerts ? (
          <StatusRow
            label={t('srv.alertsService')}
            value={alerts.online ? t('srv.alertsOnline') : t('srv.alertsOffline')}
          />
        ) : null}
        {status.database ? (
          <StatusRow
            label={t('srv.database')}
            value={`${status.database.kind}${status.database.sizeBytes !== null ? ` · ${formatBytes(status.database.sizeBytes)}` : ''}`}
          />
        ) : null}
        {counts ? (
          <StatusRow
            label={t('srv.dbBars')}
            value={`${counts.bars ?? 0} (${counts.series ?? 0} ${t('srv.dbSeries')})`}
          />
        ) : null}
        {status.auth.enabled && authInfo?.user ? (
          <p className="dlg-note">
            {t('srv.signedInAs', {
              name: authInfo.user.name,
              method: t(`srv.method.${authInfo.user.method}`),
            })}
          </p>
        ) : null}
      </Section>
      <Section title={t('srv.maintenance')}>
        <div className="srv-actions">
          <button type="button" className="io-btn" disabled={busy !== null} onClick={checkUpdates}>
            <RefreshCw size={14} /> {t('srv.checkUpdates')}
          </button>
          {admin ? (
            <>
              <button
                type="button"
                className="io-btn"
                disabled={busy !== null}
                onClick={downloadBackup}
              >
                <Download size={14} /> {t('srv.backup')}
              </button>
              <button
                type="button"
                className="io-btn"
                disabled={busy !== null}
                onClick={() => void clearCache()}
              >
                <Sparkles size={14} /> {t('srv.clearCache')}
              </button>
            </>
          ) : null}
          {status.auth.enabled && (authInfo?.logoutAvailable ?? true) ? (
            <button type="button" className="io-btn" disabled={busy !== null} onClick={signOut}>
              <LogOut size={14} /> {t('srv.logout')}
            </button>
          ) : null}
        </div>
        {updateNote ? (
          <p className="dlg-note srv-update">
            {updateNote}
            {update?.updateAvailable && update.releaseUrl ? (
              <>
                {' · '}
                <a href={update.releaseUrl} target="_blank" rel="noreferrer">
                  {t('srv.releaseNotes')}
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {alerts?.online && alerts.version ? (
          <p className="dlg-note">
            <Server size={12} className="srv-inline-icon" /> {t('srv.alertsOnline')} ·{' '}
            {alerts.version}
          </p>
        ) : null}
        {alerts && !alerts.online ? (
          <p className="dlg-note srv-warn">
            <ShieldCheck size={12} className="srv-inline-icon" /> {t('srv.alertsOffline')}
          </p>
        ) : null}
      </Section>
      {admin ? <BackupsSection /> : null}
    </>
  );
}
