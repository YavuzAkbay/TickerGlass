import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseBackups, parseRun, type BackupsState, type TargetTest } from '../api/backups';
import { BackupsView } from './BackupsSection';

const make = (over: Record<string, unknown> = {}): BackupsState => {
  const s = parseBackups({ enabled: true, supported: true, ...over });
  if (!s) throw new Error('bad fixture');
  return s;
};

const render = (
  state: BackupsState,
  over: { running?: boolean; busy?: string | null; tests?: TargetTest[] | null } = {},
) =>
  renderToStaticMarkup(
    <BackupsView
      state={state}
      running={over.running ? parseRun({ id: 'r', status: 'running' }) : null}
      busy={over.busy ?? null}
      tests={over.tests ?? null}
      passphrase=""
      onPassphrase={() => undefined}
      onRun={() => undefined}
      onTest={() => undefined}
      onDownload={() => undefined}
      onRestore={() => undefined}
      onRestoreFile={() => undefined}
      onCancelPending={() => undefined}
    />,
  );

const full = {
  schedule: { at: '03:30', tz: 'Europe/Berlin', next: '2026-11-13T02:30:00Z' },
  targets: [
    { kind: 'local', label: '/backups', configured: true, warning: 'Same disk as the database' },
    { kind: 's3', label: 'bucket/tickerglass/', configured: true },
  ],
  encrypted: true,
  includeCache: false,
  retention: { daily: 7, weekly: 4, monthly: 6 },
  last: {
    id: 'r1',
    status: 'partial',
    finishedAt: '2026-11-12T02:31:00Z',
    results: [
      { target: 'local', ok: true, error: null, deleted: 0 },
      { target: 's3', ok: false, error: 'S3 AccessDenied' },
    ],
    error: 's3: S3 AccessDenied',
  },
  files: [
    {
      target: 'local',
      name: 'a.db.gz',
      size: 2048,
      createdAt: '2026-11-11T02:30:00Z',
      encrypted: false,
    },
    {
      target: 's3',
      name: 'b.db.gz.enc',
      size: 4096,
      createdAt: '2026-11-12T02:30:00Z',
      encrypted: true,
    },
  ],
};

describe('BackupsView', () => {
  it('unsupported: only the pg_dump hint', () => {
    const html = render(make({ supported: false }));
    expect(html).toContain('pg_dump');
    expect(html).not.toContain('Run now');
    expect(html).not.toContain('Restore from file');
  });

  it('disabled: explains how to enable, no run controls, still offers restore from file', () => {
    const html = render(make({ enabled: false }));
    expect(html).toContain('BACKUP_DIR');
    expect(html).toContain('BACKUP_S3_ENDPOINT');
    expect(html).not.toContain('Run now');
    expect(html).toContain('Restore from file');
  });

  it('enabled: schedule, targets with warning, encryption, last run, files newest first', () => {
    const html = render(make(full));
    expect(html).toContain('Daily at 03:30 Europe/Berlin');
    expect(html).toContain('· next ');
    expect(html).toContain('Same disk as the database');
    expect(html).toContain('On (AES-256)');
    expect(html).toContain('Partly failed');
    expect(html).toContain('s3: S3 AccessDenied');
    expect(html).toContain('Newest 7 daily · 4 weekly · 6 monthly');
    expect(html).toContain('Left out (refetched after a restore)');
    expect(html).toContain('Run now');
    expect(html).toContain('Test targets');
    expect(html.indexOf('4.0 KB')).toBeGreaterThan(-1);
    expect(html.indexOf('4.0 KB')).toBeLessThan(html.indexOf('2.0 KB'));
    expect(html.match(/title="Encrypted"/g)).toHaveLength(1);
    expect(html.match(/ Download</g)).toHaveLength(2);
    expect(html.match(/ Restore</g)).toHaveLength(2);
    expect(html).not.toContain('bak-pending');
  });

  it('shows the passphrase field with its hint, always', () => {
    const html = render(make(full));
    expect(html).toContain('type="password"');
    expect(html).toContain('only for encrypted backups');
    expect(render(make({ enabled: false }))).toContain('only for encrypted backups');
  });

  it('enabled without backups says so', () => {
    expect(render(make({ targets: [{ kind: 'local', label: '/b' }] }))).toContain(
      'No backups stored yet.',
    );
  });

  it('running: progress note and the run button is disabled', () => {
    const html = render(make(full), { running: true });
    expect(html).toContain('bak-running');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="bak-run"/);
  });

  it('pending restore: banner with source, restart hint and cancel', () => {
    const html = render(
      make({
        ...full,
        pending: { source: 'local/a.db.gz', stagedAt: '2026-11-12T03:00:00Z', revision: 'abc' },
      }),
    );
    expect(html).toContain('bak-pending');
    expect(html).toContain('local/a.db.gz');
    expect(html).toContain('Restart the server to finish');
    expect(html).toContain('Cancel restore');
  });

  it('shows target test results', () => {
    const html = render(make(full), {
      tests: [
        { kind: 'local', label: '/backups', ok: true, error: null },
        { kind: 's3', label: 'bucket/tickerglass/', ok: false, error: 'S3 NoSuchBucket' },
      ],
    });
    expect(html).toContain('/backups: reachable');
    expect(html).toContain('bucket/tickerglass/: S3 NoSuchBucket');
  });

  it('the server reporting a running backup disables the run button without a local run', () => {
    const html = render(make({ ...full, running: true }));
    expect(html).toContain('bak-running');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="bak-run"/);
    expect(render(make(full))).not.toContain('bak-running');
  });

  it('shows a failed cleanup of old backups', () => {
    const html = render(
      make({
        ...full,
        last: {
          id: 'r2',
          status: 'ok',
          results: [{ target: 's3', ok: true, deleted: 0, retentionError: 'S3 AccessDenied' }],
        },
      }),
    );
    expect(html).toContain('bak-cleanup-problems');
    expect(html).toContain('Old backups could not be cleaned up: s3: S3 AccessDenied');
    expect(render(make(full))).not.toContain('bak-cleanup-problems');
  });

  it('shows targets whose backups could not be listed', () => {
    const html = render(
      make({ ...full, fileErrors: [{ target: 's3', error: 'S3 AccessDenied' }] }),
    );
    expect(html).toContain('bak-file-error');
    expect(html).toContain('Could not list the backups of bucket/tickerglass/: S3 AccessDenied');
    expect(render(make(full))).not.toContain('bak-file-error');
  });

  it('shows the outcome of the last restore, applied or not', () => {
    const applied = render(
      make({
        ...full,
        lastRestore: {
          status: 'applied',
          at: '2026-11-12T04:00:00Z',
          source: 'upload',
          preRestore: 'pre-restore-20261112T040000Z.db',
        },
      }),
    );
    expect(applied).toContain('data-testid="bak-last-restore"');
    expect(applied).toContain('data-status="applied"');
    expect(applied).toContain('applied from upload');
    expect(applied).toContain('kept as pre-restore-20261112T040000Z.db');
    expect(applied).not.toContain('srv-warn" role="status" data-testid="bak-last-restore"');

    const failed = render(
      make({
        ...full,
        lastRestore: {
          status: 'failed',
          at: '2026-11-12T04:00:00Z',
          source: 'local:a.db.gz',
          error: 'the backup contains a trigger (evil), which a TickerGlass backup never has',
        },
      }),
    );
    expect(failed).toContain('data-status="failed"');
    expect(failed).toContain('was not applied');
    expect(failed).toContain('which a TickerGlass backup never has');
    expect(failed).toMatch(/srv-warn"[^>]*data-testid="bak-last-restore"/);
    // It shows for a disabled section too (restore from file still works there), not at all
    // when there was no restore.
    expect(render(make({ enabled: false, lastRestore: { status: 'failed' } }))).toContain(
      'no reason recorded',
    );
    expect(render(make(full))).not.toContain('bak-last-restore');
  });

  it('busy disables the actions', () => {
    const html = render(make(full), { busy: 'test' });
    expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>(<svg[^>]*>.*?<\/svg>) Run now/);
    expect(html.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(7);
  });
});
