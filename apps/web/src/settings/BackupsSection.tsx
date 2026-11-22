import { Download, Lock, Play, PlugZap, RotateCcw, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  cancelRestore,
  fetchBackupFile,
  fetchBackupRun,
  fetchBackups,
  isBackupsUnavailable,
  startBackupRun,
  stageRestore,
  testBackupTargets,
  uploadRestore,
  type BackupFile,
  type BackupRun,
  type BackupsState,
  type PendingRestore,
  type TargetTest,
} from '../api/backups';
import { ApiError, errorMessage } from '../api/client';
import { Row, Section } from '../dialogs/controls';
import { useT } from '../i18n';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import {
  activeRun,
  backupsMode,
  formatBackupTime,
  isBackupRunning,
  isRunning,
  newestFirst,
  retentionProblems,
  RUN_POLL_MS,
  runProblems,
  runStatusKey,
  targetKindKey,
  targetLabel,
} from './backupsModel';
import { formatBytes } from './serverFormat';
import { StatusRow } from './StatusRow';

const fileKey = (f: Pick<BackupFile, 'target' | 'name'>) => `${f.target}/${f.name}`;

export interface BackupsViewProps {
  state: BackupsState;
  /** The backup in progress, if any. */
  running: BackupRun | null;
  /** What is being done right now (`run`, `test`, `upload`, `cancel`, or a file key). */
  busy: string | null;
  tests: readonly TargetTest[] | null;
  passphrase: string;
  onPassphrase: (value: string) => void;
  onRun: () => void;
  onTest: () => void;
  onDownload: (file: BackupFile) => void;
  onRestore: (file: BackupFile) => void;
  onRestoreFile: (file: File) => void;
  onCancelPending: () => void;
}

/** The Backups section for a loaded status; all state and actions come from the parent. */
export function BackupsView({
  state,
  running,
  busy,
  tests,
  passphrase,
  onPassphrase,
  onRun,
  onTest,
  onDownload,
  onRestore,
  onRestoreFile,
  onCancelPending,
}: BackupsViewProps) {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const mode = backupsMode(state);
  const idle = busy === null;

  if (mode === 'unsupported')
    return (
      <Section title={t('bak.title')}>
        <p className="dlg-note" data-testid="bak-unsupported">
          {t('bak.unsupported')}
        </p>
      </Section>
    );

  const enabled = mode === 'enabled';
  const files = newestFirst(state.files);
  const last = state.last;
  const problems = runProblems(last);
  const cleanup = retentionProblems(last);
  const sched = state.schedule;
  const inProgress = isBackupRunning(state, running);
  const lastRestore = state.lastRestore;

  return (
    <Section title={t('bak.title')}>
      {!enabled ? (
        <p className="dlg-note" data-testid="bak-disabled">
          {t('bak.disabled')}
        </p>
      ) : null}

      {state.pending ? (
        <div className="bak-banner" role="status" data-testid="bak-pending">
          <p>
            {t('bak.pending', {
              source: state.pending.source || '—',
              time: formatBackupTime(state.pending.stagedAt) || '—',
            })}
            {state.pending.revision
              ? ` ${t('bak.pendingRevision', { revision: state.pending.revision })}`
              : ''}
          </p>
          <button type="button" className="io-btn" disabled={!idle} onClick={onCancelPending}>
            <X size={14} /> {t('bak.pendingCancel')}
          </button>
        </div>
      ) : null}

      {lastRestore ? (
        <p
          className={`dlg-note${lastRestore.status === 'failed' ? ' srv-warn' : ''}`}
          role="status"
          data-testid="bak-last-restore"
          data-status={lastRestore.status}
        >
          {lastRestore.status === 'applied'
            ? t('bak.lastRestoreApplied', {
                source: lastRestore.source || '—',
                time: formatBackupTime(lastRestore.at) || '—',
              })
            : t('bak.lastRestoreFailed', {
                source: lastRestore.source || '—',
                time: formatBackupTime(lastRestore.at) || '—',
                error: lastRestore.error ?? t('bak.lastRestoreFailedNoDetail'),
              })}
          {lastRestore.status === 'applied' && lastRestore.preRestore
            ? ` ${t('bak.lastRestoreKept', { copy: lastRestore.preRestore })}`
            : ''}
        </p>
      ) : null}

      {enabled ? (
        <>
          {sched ? (
            <StatusRow
              label={t('bak.schedule')}
              value={
                t('bak.scheduleLine', { at: sched.at, tz: sched.tz }).trim() +
                (sched.next
                  ? // Same zone as the "Daily at" part, not the browser's.
                    ` · ${t('bak.scheduleNext', { time: formatBackupTime(sched.next, sched.tz || undefined) })}`
                  : '')
              }
            />
          ) : null}
          {state.targets.map((target) => (
            <div key={target.kind}>
              <StatusRow
                label={t(targetKindKey(target.kind))}
                value={`${target.label}${target.configured ? '' : ` (${t('bak.notConfigured')})`}`}
              />
              {target.warning ? <p className="dlg-note srv-warn">{target.warning}</p> : null}
            </div>
          ))}
          <StatusRow
            label={t('bak.encryption')}
            value={state.encrypted ? t('bak.encryptionOn') : t('bak.encryptionOff')}
          />
          {state.retention ? (
            <StatusRow
              label={t('bak.retention')}
              value={t('bak.retentionLine', {
                daily: state.retention.daily,
                weekly: state.retention.weekly,
                monthly: state.retention.monthly,
              })}
            />
          ) : null}
          <StatusRow
            label={t('bak.cache')}
            value={state.includeCache ? t('bak.cacheIncluded') : t('bak.cacheExcluded')}
          />
          <StatusRow
            label={t('bak.lastRun')}
            value={
              last
                ? t('bak.lastRunValue', {
                    status: t(runStatusKey(last.status)),
                    time: formatBackupTime(last.finishedAt ?? last.startedAt) || '—',
                  })
                : t('bak.noRuns')
            }
          />
          {last && last.status !== 'running' && problems.length ? (
            <p className="dlg-note srv-warn" data-testid="bak-problems">
              {problems.join(' · ')}
            </p>
          ) : null}
          {last && last.status !== 'running' && cleanup.length ? (
            <p className="dlg-note srv-warn" data-testid="bak-cleanup-problems">
              {t('bak.retentionFailed', { detail: cleanup.join(' · ') })}
            </p>
          ) : null}
          {inProgress ? (
            <p className="dlg-note" role="status" data-testid="bak-running">
              {t('bak.running')}
            </p>
          ) : null}
          <div className="srv-actions bak-actions">
            <button
              type="button"
              className="io-btn"
              disabled={!idle || inProgress}
              onClick={onRun}
              data-testid="bak-run"
            >
              <Play size={14} /> {inProgress ? t('bak.running') : t('bak.runNow')}
            </button>
            <button type="button" className="io-btn" disabled={!idle} onClick={onTest}>
              <PlugZap size={14} /> {t('bak.test')}
            </button>
          </div>
          {tests?.map((r) => (
            <p key={r.kind} className={`dlg-note${r.ok ? '' : ' srv-warn'}`}>
              {r.ok
                ? t('bak.testOk', { target: r.label || targetLabel(state.targets, r.kind) })
                : t('bak.testFail', {
                    target: r.label || targetLabel(state.targets, r.kind),
                    error: r.error ?? t('bak.testFailNoDetail'),
                  })}
            </p>
          ))}
        </>
      ) : null}

      {state.fileErrors.map((e) => (
        <p key={e.target} className="dlg-note srv-warn" data-testid="bak-file-error">
          {t('bak.fileError', {
            target: targetLabel(state.targets, e.target),
            error: e.error || t('bak.testFailNoDetail'),
          })}
        </p>
      ))}

      {files.length || enabled ? <h4 className="bak-subhead">{t('bak.files')}</h4> : null}
      {files.length ? (
        <ul className="bak-list" data-testid="bak-files">
          {files.map((f) => (
            <li key={fileKey(f)} className="bak-row">
              <div className="bak-main">
                <span className="bak-date">
                  {formatBackupTime(f.createdAt) || f.name}
                  {f.encrypted ? (
                    <span
                      className="bak-lock"
                      title={t('bak.encrypted')}
                      aria-label={t('bak.encrypted')}
                    >
                      <Lock size={12} />
                    </span>
                  ) : null}
                </span>
                <span className="bak-meta">
                  {targetLabel(state.targets, f.target)} · {formatBytes(f.size)}
                </span>
              </div>
              <button
                type="button"
                className="io-btn"
                disabled={!idle}
                onClick={() => onDownload(f)}
              >
                <Download size={14} /> {t('bak.download')}
              </button>
              <button
                type="button"
                className="io-btn"
                disabled={!idle}
                onClick={() => onRestore(f)}
              >
                <RotateCcw size={14} /> {t('bak.restore')}
              </button>
            </li>
          ))}
        </ul>
      ) : enabled ? (
        <p className="dlg-note">{t('bak.noFiles')}</p>
      ) : null}

      <Row label={t('bak.passphrase')} htmlFor="bak-passphrase">
        <input
          id="bak-passphrase"
          type="password"
          className="io-input"
          autoComplete="off"
          value={passphrase}
          onChange={(e) => onPassphrase(e.target.value)}
          disabled={!idle}
        />
      </Row>
      <p className="dlg-note">{t('bak.passphraseHint')}</p>
      <div className="srv-actions">
        <input
          ref={picker}
          type="file"
          hidden
          aria-label={t('bak.restoreFromFile')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onRestoreFile(file);
          }}
        />
        <button
          type="button"
          className="io-btn"
          disabled={!idle}
          onClick={() => picker.current?.click()}
        >
          <Upload size={14} /> {t('bak.restoreFromFile')}
        </button>
      </div>
    </Section>
  );
}

/** Settings → Server → Backups (admin): the scheduled-backup status and its actions. */
export function BackupsSection() {
  const t = useT();
  const [state, setState] = useState<BackupsState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [localRun, setLocalRun] = useState<BackupRun | null>(null);
  const [tests, setTests] = useState<TargetTest[] | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const load = () =>
    fetchBackups()
      .then((s) => {
        setState(s);
        setError(null);
        return s;
      })
      .catch((err) => {
        if (isBackupsUnavailable(err)) setUnavailable(true);
        else setError(errorMessage(err));
        return null;
      });

  useEffect(() => void load(), []);

  const running = state ? activeRun(state, localRun) : localRun;
  const runId = running?.id ?? null;

  // Poll the running backup until it settles, then refresh the whole status.
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      fetchBackupRun(runId)
        .then((run) => {
          if (stop) return;
          if (isRunning(run)) {
            setLocalRun(run);
            timer = setTimeout(tick, RUN_POLL_MS);
            return;
          }
          setLocalRun(null);
          toast(
            t(
              run.status === 'ok'
                ? 'bak.runDone'
                : run.status === 'partial'
                  ? 'bak.runPartial'
                  : 'bak.runFailed',
            ),
            run.status === 'ok' ? 'success' : 'error',
            run.status === 'ok' ? undefined : 6000,
          );
          void load();
        })
        .catch((err) => {
          if (stop) return;
          // A vanished run cannot be polled any longer; anything else is likely transient.
          if (err instanceof ApiError && err.status === 404) {
            setLocalRun(null);
            void load();
          } else timer = setTimeout(tick, RUN_POLL_MS);
        });
    };
    timer = setTimeout(tick, RUN_POLL_MS);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
    // `load` and `t` are stable enough for a poll loop keyed by the run id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (unavailable) return null;
  if (error && !state)
    return (
      <Section title={t('bak.title')}>
        <p className="dlg-note">{t('bak.loadFail', { error })}</p>
      </Section>
    );
  if (!state)
    return (
      <Section title={t('bak.title')}>
        <p className="dlg-note">…</p>
      </Section>
    );

  const run = () => {
    setBusy('run');
    startBackupRun()
      .then((id) => {
        toast(t('bak.runStarted'), 'success');
        setLocalRun({
          id,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          trigger: 'manual',
          status: 'running',
          fileName: null,
          size: null,
          results: [],
          error: null,
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) {
          toast(t('bak.runBusy'), 'info');
          void load();
        } else toast(t('bak.runFail', { error: errorMessage(err) }), 'error', 6000);
      })
      .finally(() => setBusy(null));
  };

  const test = () => {
    setBusy('test');
    setTests(null);
    testBackupTargets()
      .then(setTests)
      .catch((err) => toast(t('bak.testError', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const download = (f: BackupFile) => {
    setBusy(fileKey(f));
    // Same blob download as "Download backup"; errors surface as a toast instead of a file.
    fetchBackupFile(f.target, f.name)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => toast(t('bak.downloadFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const staged = (pending: PendingRestore | null) => {
    setState((s) => (s ? { ...s, pending } : s));
    toast(t('bak.restoreStaged'), 'success');
    void load();
  };

  const restore = async (f: BackupFile) => {
    const yes = await confirmDialog({
      title: t('bak.restoreConfirmTitle'),
      message: t('bak.restoreConfirmText', { date: formatBackupTime(f.createdAt) || f.name }),
      okLabel: t('bak.restore'),
      danger: true,
    });
    if (!yes) return;
    setBusy(fileKey(f));
    stageRestore(f.target, f.name)
      .then(staged)
      .catch((err) => toast(t('bak.restoreFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const restoreFile = async (file: File) => {
    const yes = await confirmDialog({
      title: t('bak.restoreConfirmTitle'),
      message: t('bak.restoreConfirmFileText', { date: file.name }),
      okLabel: t('bak.restore'),
      danger: true,
    });
    if (!yes) return;
    setBusy('upload');
    uploadRestore(file, passphrase)
      .then((pending) => {
        setPassphrase('');
        staged(pending);
      })
      .catch((err) => toast(t('bak.restoreFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  const cancelPending = () => {
    setBusy('cancel');
    cancelRestore()
      .then((cancelled) => {
        setState((s) => (s ? { ...s, pending: null } : s));
        toast(t(cancelled ? 'bak.pendingCancelled' : 'bak.pendingNothing'), 'success');
      })
      .catch((err) => toast(t('bak.cancelFail', { error: errorMessage(err) }), 'error', 6000))
      .finally(() => setBusy(null));
  };

  return (
    <BackupsView
      state={state}
      running={running}
      busy={busy}
      tests={tests}
      passphrase={passphrase}
      onPassphrase={setPassphrase}
      onRun={run}
      onTest={test}
      onDownload={download}
      onRestore={(f) => void restore(f)}
      onRestoreFile={(f) => void restoreFile(f)}
      onCancelPending={cancelPending}
    />
  );
}
