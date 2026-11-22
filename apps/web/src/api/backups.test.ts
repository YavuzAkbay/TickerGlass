import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupFilePath,
  cancelRestore,
  fetchBackupFile,
  isBackupsUnavailable,
  parseBackups,
  parseLastRestore,
  parseRun,
  testBackupTargets,
  UPLOAD_HEADER,
  uploadRestore,
} from './backups';
import { ApiError, onUnauthorized } from './client';

// The shapes below are what the API sends (api/src/tickerglass_api/routes/backups.py).
const RUN = {
  id: 12,
  startedAt: '2026-11-12T02:30:00+00:00',
  finishedAt: '2026-11-12T02:31:00+00:00',
  trigger: 'manual',
  status: 'partial',
  fileName: 'tickerglass-20261112T023000Z.db.gz',
  size: 2048,
  results: [
    { target: 'local', ok: true, error: null, deleted: 2 },
    { target: 's3', ok: false, error: 'S3 AccessDenied' },
  ],
  error: 's3: S3 AccessDenied',
};

describe('parseBackups', () => {
  it('parses a full answer', () => {
    const s = parseBackups({
      enabled: true,
      supported: true,
      schedule: { at: '03:30', tz: 'Europe/Berlin', next: '2026-11-13T02:30:00Z' },
      encrypted: true,
      includeCache: true,
      retention: { daily: 7, weekly: 4, monthly: 6 },
      targets: [
        { kind: 'local', label: '/backups', configured: true, warning: 'same disk' },
        { kind: 's3', label: 'bucket', configured: false },
      ],
      running: true,
      last: RUN,
      runs: [RUN, { id: 11, status: 'ok', results: [{ target: 's3', ok: true, deleted: 0 }] }],
      files: [
        {
          target: 'local',
          name: 'x.db.gz.enc',
          size: 10,
          createdAt: '2026-11-12T01:00:00Z',
          encrypted: true,
        },
      ],
      fileErrors: [{ target: 's3', error: 'S3 AccessDenied' }, { error: 'no target' }],
      pending: { source: 'local:x', stagedAt: '2026-11-12T02:00:00Z', revision: 'b5e2f19c7a31' },
      lastRestore: {
        status: 'applied',
        at: '2026-11-12T04:00:00+00:00',
        source: 'upload',
        revision: 'b5e2f19c7a31',
        preRestore: 'pre-restore-20261112T040000Z.db',
      },
    });
    expect(s?.enabled).toBe(true);
    expect(s?.schedule).toEqual({ at: '03:30', tz: 'Europe/Berlin', next: '2026-11-13T02:30:00Z' });
    expect(s?.targets.map((t) => [t.kind, t.configured, t.warning])).toEqual([
      ['local', true, 'same disk'],
      ['s3', false, null],
    ]);
    expect(s?.includeCache).toBe(true);
    expect(s?.retention).toEqual({ daily: 7, weekly: 4, monthly: 6 });
    expect(s?.running).toBe(true);
    expect(s?.last).toEqual({
      id: '12',
      startedAt: '2026-11-12T02:30:00+00:00',
      finishedAt: '2026-11-12T02:31:00+00:00',
      trigger: 'manual',
      status: 'partial',
      fileName: 'tickerglass-20261112T023000Z.db.gz',
      size: 2048,
      results: [
        { target: 'local', ok: true, error: null, deleted: 2, retentionError: null },
        { target: 's3', ok: false, error: 'S3 AccessDenied', deleted: null, retentionError: null },
      ],
      error: 's3: S3 AccessDenied',
    });
    expect(s?.runs).toHaveLength(2);
    expect(s?.files[0]?.encrypted).toBe(true);
    expect(s?.fileErrors).toEqual([{ target: 's3', error: 'S3 AccessDenied' }]);
    expect(s?.pending).toEqual({
      source: 'local:x',
      stagedAt: '2026-11-12T02:00:00Z',
      revision: 'b5e2f19c7a31',
    });
    expect(s?.lastRestore).toEqual({
      status: 'applied',
      at: '2026-11-12T04:00:00+00:00',
      source: 'upload',
      revision: 'b5e2f19c7a31',
      error: null,
      preRestore: 'pre-restore-20261112T040000Z.db',
    });
  });

  it('tolerates missing and malformed fields', () => {
    const s = parseBackups({
      targets: [null, { kind: 'ftp' }, 'x'],
      runs: [{}, 5, { id: 7, status: 'weird' }],
      files: [{ target: 'local' }, { name: 'a' }, { target: 'local', name: 'a' }],
      schedule: 'daily',
      last: 'nope',
      pending: [],
      retention: { daily: 7 },
      fileErrors: 'x',
      lastRestore: { status: 'weird' },
    });
    expect(s).toEqual({
      enabled: false,
      supported: true,
      schedule: null,
      targets: [],
      encrypted: false,
      includeCache: false,
      retention: null,
      running: false,
      last: null,
      runs: [
        {
          id: '7',
          startedAt: null,
          finishedAt: null,
          trigger: 'schedule',
          status: 'failed',
          fileName: null,
          size: null,
          results: [],
          error: null,
        },
      ],
      files: [{ target: 'local', name: 'a', size: 0, createdAt: null, encrypted: false }],
      fileErrors: [],
      pending: null,
      lastRestore: null,
    });
  });

  it('rejects non-objects', () => {
    expect(parseBackups(null)).toBeNull();
    expect(parseBackups([])).toBeNull();
    expect(parseBackups('x')).toBeNull();
  });

  it('reads supported:false', () => {
    expect(parseBackups({ supported: false })?.supported).toBe(false);
  });
});

describe('parseRun', () => {
  it('needs an id and knows the four statuses', () => {
    expect(parseRun({ status: 'ok' })).toBeNull();
    expect(parseRun({ id: 'a', status: 'running' })?.status).toBe('running');
    expect(parseRun({ id: 'a', status: 'partial' })?.status).toBe('partial');
    expect(parseRun({ id: 'a' })?.status).toBe('failed');
  });

  it('keeps the retention outcome of a target', () => {
    const r = parseRun({
      id: 1,
      status: 'ok',
      results: [{ target: 's3', ok: true, deleted: 3, retentionError: 'S3 AccessDenied' }],
    });
    expect(r?.results[0]).toEqual({
      target: 's3',
      ok: true,
      error: null,
      deleted: 3,
      retentionError: 'S3 AccessDenied',
    });
  });
});

describe('parseLastRestore', () => {
  it('knows applied and failed only', () => {
    expect(parseLastRestore({ status: 'failed', source: 'x', error: 'boom' })).toEqual({
      status: 'failed',
      at: null,
      source: 'x',
      revision: null,
      error: 'boom',
      preRestore: null,
    });
    expect(parseLastRestore({ status: 'skipped' })).toBeNull();
    expect(parseLastRestore(null)).toBeNull();
    expect(parseLastRestore([])).toBeNull();
  });
});

describe('helpers', () => {
  it('only a 404 hides the section', () => {
    expect(isBackupsUnavailable(new ApiError('x', 404))).toBe(true);
    expect(isBackupsUnavailable(new ApiError('x', 403))).toBe(false);
    expect(isBackupsUnavailable(new Error('x'))).toBe(false);
  });

  it('encodes download paths', () => {
    expect(backupFilePath('local', 'a b.db.gz')).toBe('/backups/files/local/a%20b.db.gz');
  });
});

describe('requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it('reads the per-target test answer', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        json({
          targets: [
            { kind: 'local', label: '/backups', ok: true, error: null },
            { kind: 's3', label: 'tg @ minio:9000/p/', ok: false, error: 'S3 NoSuchBucket' },
            { label: 'no kind' },
          ],
        }),
      ),
    );
    expect(await testBackupTargets()).toEqual([
      { kind: 'local', label: '/backups', ok: true, error: null },
      { kind: 's3', label: 'tg @ minio:9000/p/', ok: false, error: 'S3 NoSuchBucket' },
    ]);
  });

  it('cancelling reports whether something was staged', async () => {
    const answers = [json({ cancelled: true }), json({ cancelled: false })];
    vi.stubGlobal('fetch', () => Promise.resolve(answers.shift()));
    expect(await cancelRestore()).toBe(true);
    expect(await cancelRestore()).toBe(false);
  });

  it('the upload sends the request header the API insists on', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      seen.push(init);
      return Promise.resolve(json({ pending: { source: 'upload', stagedAt: 'x', revision: 'r' } }));
    });
    const pending = await uploadRestore(new File(['x'], 'a.db.gz'), 'pw');
    expect(pending?.source).toBe('upload');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers).toEqual({ [UPLOAD_HEADER]: '1' });
    expect(seen[0]?.body).toBeInstanceOf(FormData);
    expect((seen[0]?.body as FormData).get('passphrase')).toBe('pw');
  });

  it('a 401 on the upload or a download reaches the shared unauthorized handler', async () => {
    const handler = vi.fn();
    const off = onUnauthorized(handler);
    try {
      vi.stubGlobal('fetch', () => Promise.resolve(json({ detail: 'sign in' }, 401)));
      await expect(uploadRestore(new File(['x'], 'a.db'), '')).rejects.toMatchObject({
        status: 401,
        message: 'sign in',
      });
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(fetchBackupFile('local', 'a.db.gz')).rejects.toBeInstanceOf(ApiError);
      expect(handler).toHaveBeenCalledTimes(2);
      // Other errors do not.
      vi.stubGlobal('fetch', () => Promise.resolve(json({ detail: 'too big' }, 413)));
      await expect(uploadRestore(new File(['x'], 'a.db'), '')).rejects.toMatchObject({
        status: 413,
        message: 'too big',
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });
});
