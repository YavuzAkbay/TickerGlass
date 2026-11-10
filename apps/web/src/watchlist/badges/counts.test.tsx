import type { Alert } from '@tickerglass/alerts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alertIndex, buildAlertIndex, selectAlertCounts, selectHasNote } from './counts';
import { RowBadgesView } from './RowBadges';

const al = (id: string, symbol: string, status: Alert['status']): Alert =>
  ({ id, symbol, status }) as Alert;

const rec = (...list: Alert[]): Record<string, Alert> =>
  Object.fromEntries(list.map((a) => [a.id, a]));

describe('buildAlertIndex', () => {
  it('counts active and triggered per upper-case symbol, ignoring other states', () => {
    const idx = buildAlertIndex(
      rec(
        al('1', 'AAPL', 'active'),
        al('2', 'aapl', 'active'),
        al('3', 'AAPL', 'triggered'),
        al('4', 'AAPL', 'paused'),
        al('5', 'AAPL', 'expired'),
        al('6', 'AAPL', 'error'),
        al('7', 'MSFT', 'paused'),
        al('8', ' tsla ', 'triggered'),
      ),
    );
    expect(idx.get('AAPL')).toEqual({ active: 2, triggered: 1 });
    expect(idx.has('MSFT')).toBe(false);
    expect(idx.get('TSLA')).toEqual({ active: 0, triggered: 1 });
  });

  it('is empty for no alerts', () => {
    expect(buildAlertIndex({}).size).toBe(0);
  });
});

describe('alertIndex', () => {
  it('rebuilds only when the alerts record changes identity', () => {
    const a = rec(al('1', 'AAPL', 'active'));
    expect(alertIndex(a)).toBe(alertIndex(a));
    const b = { ...a };
    expect(alertIndex(b)).not.toBe(alertIndex(a));
  });
});

describe('selectors', () => {
  it('read counts and notes from the state', () => {
    const alerts = rec(al('1', 'AAPL', 'active'), al('2', 'AAPL', 'triggered'));
    expect(selectAlertCounts(alerts, 'AAPL')).toEqual({ active: 1, triggered: 1 });
    expect(selectAlertCounts(alerts, 'MSFT')).toEqual({ active: 0, triggered: 0 });
    const notes = { AAPL: { id: null, text: 'hi', revision: null, dirty: false } };
    expect(selectHasNote(notes, 'aapl')).toBe(true);
    expect(selectHasNote(notes, 'MSFT')).toBe(false);
    expect(selectHasNote(notes, '')).toBe(false);
  });

  it('a blank note is no note', () => {
    const notes = { AAPL: { id: 'n', text: '  \n', revision: 1, dirty: false } };
    expect(selectHasNote(notes, 'AAPL')).toBe(false);
  });
});

describe('RowBadgesView', () => {
  const base = {
    symbol: 'AAPL',
    active: 0,
    triggered: 0,
    hasNote: false,
    fresh: 'live' as const,
    hasQuote: true,
  };
  const html = (over: Partial<Parameters<typeof RowBadgesView>[0]>) =>
    renderToStaticMarkup(<RowBadgesView {...base} {...over} />);

  it('renders nothing when live with no alerts or note', () => {
    expect(html({})).toBe('');
  });

  it('stays quiet before the first quote', () => {
    expect(html({ fresh: 'unknown', hasQuote: false })).toBe('');
    expect(html({ fresh: 'unknown' })).toContain('Waiting for a quote');
  });

  it('shows the alert count, note and a lettered state', () => {
    const out = html({ active: 2, hasNote: true, fresh: 'closed' });
    expect(out).toContain('2 active alerts on AAPL');
    expect(out).toContain('Note on AAPL');
    expect(out).toContain('aria-label="Open note for AAPL"');
    expect(out).toContain('Market closed');
    expect(out).toContain('>C<');
    expect(out).toContain('>2<');
  });

  it.each([
    ['delayed', 'D'],
    ['stale', 'S'],
    ['closed', 'C'],
    ['pre', 'Pre'],
    ['post', 'Post'],
  ] as const)('%s carries the letter %s', (fresh, letter) => {
    expect(html({ fresh })).toContain(`>${letter}<`);
  });

  it('compact mode drops letters, note icon and the alert button', () => {
    const out = html({ compact: true, active: 1, hasNote: true, fresh: 'pre' });
    expect(out).toContain('Pre-market');
    expect(out).toContain('1 active alerts on AAPL');
    expect(out).not.toContain('rb-letter');
    expect(out).not.toContain('Note on');
    expect(out).not.toContain('<button');
  });

  it('hide silences a state but not alerts or other states', () => {
    expect(html({ fresh: 'delayed', hide: ['delayed'] })).toBe('');
    expect(html({ fresh: 'stale', hide: ['delayed'] })).toContain('>S<');
    const out = html({ fresh: 'delayed', hide: ['delayed'], active: 1 });
    expect(out).toContain('1 active alerts on AAPL');
    expect(out).not.toContain('rb-fresh');
  });

  it('exposes one label on the container and hides the letters from assistive tech', () => {
    const out = html({ active: 2, hasNote: true, fresh: 'closed' });
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="2 active alerts on AAPL, Note on AAPL, Market closed"');
    expect(out).toContain('<span class="rb-letter" aria-hidden="true">C</span>');
    expect(out).not.toContain('role="img"');
  });

  it('marks triggered alerts distinctly', () => {
    const out = html({ active: 1, triggered: 2 });
    expect(out).toContain('rb-triggered');
    expect(out).toContain('2 triggered, 1 active alerts on AAPL');
    expect(out).toContain('>3<');
  });
});
