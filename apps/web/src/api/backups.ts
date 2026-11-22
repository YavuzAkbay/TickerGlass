/** Scheduled backups (admin; docs/design/scheduled-backups.md, "API"). Parsing is defensive. */

import { ApiError, notifyUnauthorized, requestJson } from './client';

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

/** What a run did on one target; `deleted`/`retentionError` come from its retention step. */
export interface TargetResult {
  target: string;
  ok: boolean;
  error: string | null;
  deleted: number | null;
  retentionError: string | null;
}

export interface BackupRun {
  id: string;
  startedAt: string | null;
  finishedAt: string | null;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  fileName: string | null;
  size: number | null;
  results: TargetResult[];
  error: string | null;
}

export interface BackupTarget {
  kind: 'local' | 's3';
  label: string;
  configured: boolean;
  warning: string | null;
}

export interface BackupFile {
  target: string;
  name: string;
  size: number;
  createdAt: string | null;
  encrypted: boolean;
}

/** A target whose stored backups could not be listed. */
export interface FileError {
  target: string;
  error: string;
}

export interface PendingRestore {
  source: string;
  stagedAt: string | null;
  revision: string | null;
}

/** Outcome of the last restore the server tried at startup. */
export interface LastRestore {
  status: 'applied' | 'failed';
  at: string | null;
  source: string;
  revision: string | null;
  error: string | null;
  preRestore: string | null;
}

export interface Retention {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupsState {
  enabled: boolean;
  supported: boolean;
  schedule: { at: string; tz: string; next: string | null } | null;
  targets: BackupTarget[];
  encrypted: boolean;
  includeCache: boolean;
  retention: Retention | null;
  /** A backup is running in the server right now. */
  running: boolean;
  last: BackupRun | null;
  runs: BackupRun[];
  files: BackupFile[];
  fileErrors: FileError[];
  pending: PendingRestore | null;
  lastRestore: LastRestore | null;
}

/** One target of `POST /backups/test`. */
export interface TargetTest {
  kind: string;
  label: string;
  ok: boolean;
  error: string | null;
}

/** Header the multipart upload must send (a cross-site form cannot add it without a preflight). */
export const UPLOAD_HEADER = 'X-TickerGlass-Request';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const RUN_STATUSES: readonly string[] = ['running', 'ok', 'partial', 'failed'];

function parseResult(raw: unknown): TargetResult[] {
  const o = obj(raw);
  const target = str(o.target);
  if (!target) return [];
  return [
    {
      target,
      ok: o.ok === true,
      error: str(o.error),
      deleted: num(o.deleted),
      retentionError: str(o.retentionError),
    },
  ];
}

export function parseRun(raw: unknown): BackupRun | null {
  const r = obj(raw);
  const id = typeof r.id === 'number' ? String(r.id) : str(r.id);
  if (!id) return null;
  const status: RunStatus =
    typeof r.status === 'string' && RUN_STATUSES.includes(r.status)
      ? (r.status as RunStatus)
      : 'failed';
  return {
    id,
    startedAt: str(r.startedAt),
    finishedAt: str(r.finishedAt),
    trigger: r.trigger === 'manual' ? 'manual' : 'schedule',
    status,
    fileName: str(r.fileName),
    size: num(r.size),
    results: list(r.results).flatMap(parseResult),
    error: str(r.error),
  };
}

export function parsePending(raw: unknown): PendingRestore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = obj(raw);
  const revision = typeof p.revision === 'number' ? String(p.revision) : str(p.revision);
  return { source: str(p.source) ?? '', stagedAt: str(p.stagedAt), revision };
}

export function parseLastRestore(raw: unknown): LastRestore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw);
  if (r.status !== 'applied' && r.status !== 'failed') return null;
  return {
    status: r.status,
    at: str(r.at),
    source: str(r.source) ?? '',
    revision: str(r.revision),
    error: str(r.error),
    preRestore: str(r.preRestore),
  };
}

function parseRetention(raw: unknown): Retention | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = obj(raw);
  const daily = num(r.daily);
  const weekly = num(r.weekly);
  const monthly = num(r.monthly);
  return daily === null || weekly === null || monthly === null ? null : { daily, weekly, monthly };
}

function parseTarget(raw: unknown): BackupTarget[] {
  const t = obj(raw);
  if (t.kind !== 'local' && t.kind !== 's3') return [];
  return [
    {
      kind: t.kind,
      label: str(t.label) ?? '',
      configured: t.configured !== false,
      warning: str(t.warning),
    },
  ];
}

function parseFile(raw: unknown): BackupFile[] {
  const f = obj(raw);
  const target = str(f.target);
  const name = str(f.name);
  if (!target || !name) return [];
  return [
    {
      target,
      name,
      size: num(f.size) ?? 0,
      createdAt: str(f.createdAt),
      encrypted: f.encrypted === true,
    },
  ];
}

function parseFileError(raw: unknown): FileError[] {
  const e = obj(raw);
  const target = str(e.target);
  return target ? [{ target, error: str(e.error) ?? '' }] : [];
}

/** `GET /backups` body; null when it is not an object at all. Missing fields get safe defaults. */
export function parseBackups(raw: unknown): BackupsState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = obj(raw);
  const sched = b.schedule && typeof b.schedule === 'object' ? obj(b.schedule) : null;
  const runs = list(b.runs).flatMap((r) => parseRun(r) ?? []);
  return {
    enabled: b.enabled === true,
    supported: b.supported !== false,
    schedule: sched
      ? { at: str(sched.at) ?? '', tz: str(sched.tz) ?? '', next: str(sched.next) }
      : null,
    targets: list(b.targets).flatMap(parseTarget),
    encrypted: b.encrypted === true,
    includeCache: b.includeCache === true,
    retention: parseRetention(b.retention),
    running: b.running === true,
    last: parseRun(b.last),
    runs,
    files: list(b.files).flatMap(parseFile),
    fileErrors: list(b.fileErrors).flatMap(parseFileError),
    pending: parsePending(b.pending),
    lastRestore: parseLastRestore(b.lastRestore),
  };
}

/** Older APIs have no `/backups`: the section hides itself. */
export function isBackupsUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export async function fetchBackups(): Promise<BackupsState> {
  const state = parseBackups(await requestJson<unknown>('GET', '/backups'));
  if (!state) throw new ApiError('Unexpected answer from the server', 200);
  return state;
}

/** Start a manual run; resolves to its id. 409 (ApiError) when one is already running. */
export async function startBackupRun(): Promise<string> {
  const body = obj(await requestJson<unknown>('POST', '/backups/run'));
  const id = typeof body.runId === 'number' ? String(body.runId) : str(body.runId);
  if (!id) throw new ApiError('Unexpected answer from the server', 202);
  return id;
}

export async function fetchBackupRun(id: string): Promise<BackupRun> {
  const run = parseRun(
    await requestJson<unknown>('GET', `/backups/runs/${encodeURIComponent(id)}`),
  );
  if (!run) throw new ApiError('Unexpected answer from the server', 200);
  return run;
}

/** `POST /backups/test`: `{ targets: [{ kind, label, ok, error }] }`. */
export async function testBackupTargets(): Promise<TargetTest[]> {
  const body = obj(await requestJson<unknown>('POST', '/backups/test'));
  return list(body.targets).flatMap((t) => {
    const o = obj(t);
    const kind = str(o.kind);
    return kind
      ? [{ kind, label: str(o.label) ?? '', ok: o.ok === true, error: str(o.error) }]
      : [];
  });
}

/** Stage a backup file of a target for restore at the next start. */
export async function stageRestore(target: string, name: string): Promise<PendingRestore | null> {
  const body = obj(await requestJson<unknown>('POST', '/backups/restore', { target, name }));
  return parsePending(body.pending);
}

/** Error from a non-OK response, with the API's `detail` when it sent one. A 401 reaches the
 * same handler as every other request (the app returns to its login screen). */
async function responseError(res: Response): Promise<ApiError> {
  if (res.status === 401) notifyUnauthorized();
  let detail = `${res.status} ${res.statusText}`.trim();
  let parsed: unknown;
  try {
    parsed = await res.json();
    const d = obj(parsed).detail;
    if (typeof d === 'string') detail = d;
    else if (d !== undefined) detail = JSON.stringify(d);
  } catch {
    // Non-JSON error body: keep the status text.
  }
  return new ApiError(detail, res.status, parsed);
}

/** Stage an uploaded backup (multipart; the passphrase is only for encrypted files). */
export async function uploadRestore(
  file: File,
  passphrase: string,
): Promise<PendingRestore | null> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (passphrase) form.append('passphrase', passphrase);
  let res: Response;
  try {
    res = await fetch('/api/backups/restore/upload', {
      method: 'POST',
      headers: { [UPLOAD_HEADER]: '1' },
      body: form,
    });
  } catch {
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (!res.ok) throw await responseError(res);
  return parsePending(obj(await res.json()).pending);
}

/** Cancel a staged restore (deletes the staged files); false when nothing was staged. */
export async function cancelRestore(): Promise<boolean> {
  const body = obj(await requestJson<unknown>('DELETE', '/backups/restore'));
  return body.cancelled === true;
}

/** URL path (under /api) of a backup file download. */
export function backupFilePath(target: string, name: string): string {
  return `/backups/files/${encodeURIComponent(target)}/${encodeURIComponent(name)}`;
}

/** Fetch a backup file as a blob (errors carry the API's detail). */
export async function fetchBackupFile(target: string, name: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`/api${backupFilePath(target, name)}`);
  } catch {
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (!res.ok) throw await responseError(res);
  return res.blob();
}
