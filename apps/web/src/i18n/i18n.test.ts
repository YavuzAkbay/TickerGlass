import { afterEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../store/ui';
import { DEFAULT_LOCALE, isLocale, t, translate } from './index';
import { en } from './en';

afterEach(() => useUiStore.setState({ locale: DEFAULT_LOCALE }));

describe('translate', () => {
  it('returns the English message', () => {
    expect(translate('en', 'modal.close')).toBe('Close');
  });

  it('interpolates {name} placeholders', () => {
    expect(translate('en', 'topbar.undoItem', { label: 'Move' })).toBe('Undo Move');
    expect(translate('en', 'chart.label', { symbol: 'AAPL', interval: '1D' })).toBe(
      'Chart: AAPL, 1D',
    );
    expect(translate('en', 'dock.unread', { count: 3 })).toBe('3 unread');
  });

  it('keeps placeholders without a parameter', () => {
    expect(translate('en', 'topbar.undoItem', {})).toBe('Undo {label}');
    expect(translate('en', 'topbar.undoItem')).toBe('Undo {label}');
  });

  it('falls back to English for unknown locales', () => {
    expect(translate('xx', 'modal.close')).toBe('Close');
    expect(isLocale('xx')).toBe(false);
    expect(isLocale('en')).toBe(true);
  });
});

describe('t', () => {
  it('uses the locale from the ui store', () => {
    expect(useUiStore.getState().locale).toBe('en');
    expect(t('dock.watchlist')).toBe('Watchlist');
  });
});

describe('catalog', () => {
  it('has no empty messages and balanced placeholders', () => {
    for (const [key, msg] of Object.entries(en)) {
      expect(msg.length, key).toBeGreaterThan(0);
      expect(msg.split('{').length, key).toBe(msg.split('}').length);
    }
  });
});
