import { describe, expect, it } from 'vitest';
import { parseBackups, parseRun, type BackupRun } from '../api/backups';
import {
  activeRun,
  backupsMode,
  formatBackupTime,
  isBackupRunning,
  newestFirst,
  retentionProblems,
  runProblems,
  targetLabel,
} from './backupsModel';
import { formatBytes } from './serverFormat';

const state = (over: Record<string, unknown> = {}) => {
  const s = parseBackups({ enabled: true, supported: true, ...over });
  if (!s) throw new Error('bad fixture');
  return s;
};
const run = (id: string, status: string): BackupRun => {
  const r = parseRun({ id, status });
  if (!r) throw new Error('bad fixture');
  return r;
};

describe('backupsMode', () => {
  it('unsupported wins, then disabled, else enabled', () => {
    expect(backupsMode(state({ supported: false, enabled: true }))).toBe('unsupported');
    expect(backupsMode(state({ enabled: false }))).toBe('disabled');
    expect(backupsMode(state())).toBe('enabled');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(20 * 1024 ** 3)).toBe('20 GB');
  });
});

describe('formatBackupTime', () => {
  it('formats in the given zone', () => {
    expect(formatBackupTime('2026-11-12T03:30:00Z', 'UTC')).toBe('Nov 12, 2026, 03:30');
    expect(formatBackupTime('2026-11-12T03:30:00Z', 'Europe/Berlin')).toBe('Nov 12, 2026, 04:30');
  });
  it('is forgiving', () => {
    expect(formatBackupTime(null)).toBe('');
    expect(formatBackupTime('')).toBe('');
    expect(formatBackupTime('soon')).toBe('soon');
    expect(formatBackupTime('2026-11-12T03:30:00Z', 'Nowhere/Land')).toBe('Nov 12, 2026, 03:30');
  });
});

describe('newestFirst', () => {
  it('sorts by creation time, unparsable last, without mutating', () => {
    const files = state({
      files: [
        { target: 'local', name: 'old', createdAt: '2026-11-10T00:00:00Z' },
        { target: 'local', name: 'odd', createdAt: 'x' },
        { target: 's3', name: 'new', createdAt: '2026-11-12T00:00:00Z' },
      ],
    }).files;
    expect(newestFirst(files).map((f) => f.name)).toEqual(['new', 'old', 'odd']);
    expect(files.map((f) => f.name)).toEqual(['old', 'odd', 'new']);
  });
});

describe('activeRun', () => {
  it('prefers the local run, then a running run the server reports', () => {
    const local = run('L', 'running');
    expect(activeRun(state(), local)?.id).toBe('L');
    expect(activeRun(state({ last: { id: 'S', status: 'running' } }), null)?.id).toBe('S');
    expect(activeRun(state({ runs: [{ id: 'R', status: 'running' }] }), null)?.id).toBe('R');
    expect(activeRun(state({ last: { id: 'S', status: 'ok' } }), run('L', 'ok'))).toBeNull();
  });
});

describe('runProblems / targetLabel', () => {
  it("shows the run's error, which already names every failed target", () => {
    const r = parseRun({
      id: 'a',
      status: 'partial',
      error: 's3: S3 NoSuchBucket',
      results: [
        { target: 'local', ok: true },
        { target: 's3', ok: false, error: 'S3 NoSuchBucket' },
      ],
    });
    expect(runProblems(r)).toEqual(['s3: S3 NoSuchBucket']);
    expect(runProblems(null)).toEqual([]);
  });

  it('falls back to the per-target errors when the run has none', () => {
    const r = parseRun({
      id: 'a',
      status: 'partial',
      results: [
        { target: 'local', ok: true },
        { target: 's3', ok: false, error: 'S3 NoSuchBucket' },
      ],
    });
    expect(runProblems(r)).toEqual(['s3: S3 NoSuchBucket']);
  });

  it('lists the targets whose cleanup failed', () => {
    const r = parseRun({
      id: 'a',
      status: 'ok',
      results: [
        { target: 'local', ok: true, deleted: 1 },
        { target: 's3', ok: true, deleted: 0, retentionError: 'S3 AccessDenied' },
      ],
    });
    expect(retentionProblems(r)).toEqual(['s3: S3 AccessDenied']);
    expect(runProblems(r)).toEqual([]);
    expect(retentionProblems(null)).toEqual([]);
  });

  it('a backup is running when this page started one or the server says so', () => {
    expect(isBackupRunning(state(), null)).toBe(false);
    expect(isBackupRunning(state({ running: true }), null)).toBe(true);
    expect(isBackupRunning(state(), run('L', 'running'))).toBe(true);
  });

  it('names targets by kind, falling back to the id', () => {
    const s = state({ targets: [{ kind: 's3', label: 'my-bucket' }] });
    expect(targetLabel(s.targets, 's3')).toBe('my-bucket');
    expect(targetLabel(s.targets, 'local')).toBe('local');
  });
});
