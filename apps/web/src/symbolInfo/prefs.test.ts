import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_OPEN, sanitizeOpen, useSymbolInfoPrefs } from './prefs';

describe('symbolInfo prefs', () => {
  beforeEach(() => useSymbolInfoPrefs.setState({ open: {} }));

  it('opens every section but "more stats" by default', () => {
    expect(DEFAULT_OPEN.performance).toBe(true);
    expect(DEFAULT_OPEN.news).toBe(true);
    expect(DEFAULT_OPEN.moreStats).toBe(false);
  });

  it('toggle flips the effective state, not the stored one', () => {
    const { toggle } = useSymbolInfoPrefs.getState();
    toggle('news');
    expect(useSymbolInfoPrefs.getState().open.news).toBe(false);
    toggle('news');
    expect(useSymbolInfoPrefs.getState().open.news).toBe(true);
    toggle('moreStats');
    expect(useSymbolInfoPrefs.getState().open.moreStats).toBe(true);
  });

  it('sanitizeOpen keeps booleans of known sections only', () => {
    expect(sanitizeOpen({ news: false, bogus: true, events: 'yes', alerts: true })).toEqual({
      news: false,
      alerts: true,
    });
    expect(sanitizeOpen(null)).toEqual({});
    expect(sanitizeOpen('x')).toEqual({});
  });
});
