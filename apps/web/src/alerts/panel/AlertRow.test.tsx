import { DEFAULT_NOTIFY, type Alert } from '@tickerglass/alerts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AlertRow, resumeTime } from './AlertRow';

const alert: Alert = {
  id: 'a1',
  name: 'SMA cross',
  symbol: 'AAPL',
  interval: '1m',
  prepost: false,
  spec: {
    schemaVersion: 1,
    left: { kind: 'price', field: 'close' },
    condition: { op: 'crossingUp', right: { kind: 'value', value: 100 } },
    trigger: 'everyTime',
  },
  message: '',
  notify: { ...DEFAULT_NOTIFY },
  expiresAt: null,
  status: 'active',
  statusReason: null,
  drawingId: null,
  revision: 1,
  fireCount: 0,
  lastFiredAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const w = {
  alertId: 'a1',
  reason: 'script exceeded its time limit',
  resumeAt: '2026-10-15T14:05:00Z',
};

describe('AlertRow waiting for a script', () => {
  it('shows when the alert resumes and why, without error styling', () => {
    const html = renderToStaticMarkup(<AlertRow alert={alert} waiting={w} />);
    expect(html).toContain('data-testid="al-waiting"');
    expect(html).toMatch(
      /Waiting for script — resumes ~[^<]+<span class="al-waiting-reason">script exceeded its time limit</,
    );
    expect(html).not.toContain('al-reason'); // that class is for errors
    expect(html).toContain('al-dot-active');
  });

  it('shows nothing without a waiting entry', () => {
    expect(renderToStaticMarkup(<AlertRow alert={alert} />)).not.toContain('al-waiting');
    expect(renderToStaticMarkup(<AlertRow alert={alert} waiting={null} />)).not.toContain(
      'al-waiting',
    );
  });

  it('does not show it for an alert that is no longer active', () => {
    expect(
      renderToStaticMarkup(<AlertRow alert={{ ...alert, status: 'paused' }} waiting={w} />),
    ).not.toContain('al-waiting');
  });

  it('resumeTime is a clock time, or the raw text when it is not a date', () => {
    expect(resumeTime('2026-10-15T14:05:00Z')).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(resumeTime('later')).toBe('later');
  });
});
