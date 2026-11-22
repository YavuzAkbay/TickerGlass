/** Pure helpers of Settings → Server → Backups (docs/design/scheduled-backups.md). */

import type { BackupFile, BackupRun, BackupsState, BackupTarget, RunStatus } from '../api/backups';
import type { MessageKey } from '../i18n';

/** How the section presents itself: Postgres hint, how-to-enable hint, or the full controls. */
export type BackupsMode = 'unsupported' | 'disabled' | 'enabled';

export function backupsMode(s: BackupsState): BackupsMode {
  if (!s.supported) return 'unsupported';
  return s.enabled ? 'enabled' : 'disabled';
}

/** Poll interval of a running backup. */
export const RUN_POLL_MS = 2000;

export const isRunning = (run: BackupRun | null | undefined): boolean =>
  !!run && run.status === 'running';

/** The run to show progress for: a locally started one, else a running one the server reports. */
export function activeRun(s: BackupsState, local: BackupRun | null): BackupRun | null {
  if (local && isRunning(local)) return local;
  if (s.last && isRunning(s.last)) return s.last;
  return s.runs.find((r) => isRunning(r)) ?? null;
}

const timestamp = (iso: string | null): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};

/** Newest first by creation time (unparsable dates last). Does not mutate. */
export function newestFirst(files: readonly BackupFile[]): BackupFile[] {
  return [...files].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}

/** "Nov 12, 2026, 03:30" for an ISO timestamp; the raw text when it is not a date; '' when empty. */
export function formatBackupTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, ...(timeZone ? { timeZone } : {}) }).format(
      ms,
    );
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(ms);
  }
}

export const runStatusKey = (status: RunStatus): MessageKey => `bak.status.${status}`;

/** Label of a target by its kind (`local`, `s3`); the raw id for an unknown one. */
export function targetLabel(targets: readonly BackupTarget[], id: string): string {
  const hit = targets.find((t) => t.kind === id);
  return hit?.label || id;
}

export const targetKindKey = (kind: BackupTarget['kind']): MessageKey => `bak.kind.${kind}`;

/**
 * What went wrong in a run ("s3: S3 AccessDenied"). The API's run `error` already lists every
 * failed target, so the per-target errors only stand in for it when it is missing.
 */
export function runProblems(run: BackupRun | null): string[] {
  if (!run) return [];
  if (run.error) return [run.error];
  return run.results.flatMap((r) => (r.error ? [`${r.target}: ${r.error}`] : []));
}

/** Targets whose old backups could not be cleaned up in this run ("s3: S3 AccessDenied"). */
export function retentionProblems(run: BackupRun | null): string[] {
  if (!run) return [];
  return run.results.flatMap((r) => (r.retentionError ? [`${r.target}: ${r.retentionError}`] : []));
}

/** A backup is running: this page started one, or the server says so. */
export const isBackupRunning = (s: BackupsState, active: BackupRun | null): boolean =>
  !!active || s.running;
