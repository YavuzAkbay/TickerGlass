import { afterEach, describe, expect, it } from 'vitest';
import {
  activeNoteKey,
  effectiveSymbol,
  normalizeTarget,
  notePreview,
  useNotesTarget,
} from './state';

afterEach(() => useNotesTarget.setState({ target: null, scope: 'symbol', pendingFocus: false }));

describe('normalizeTarget', () => {
  it('upper-cases and trims; blank follows the chart', () => {
    expect(normalizeTarget(' aapl ')).toBe('AAPL');
    expect(normalizeTarget('')).toBeNull();
    expect(normalizeTarget('   ')).toBeNull();
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget(undefined)).toBeNull();
  });
});

describe('which note is shown', () => {
  it('follows the chart without a pin', () => {
    expect(effectiveSymbol(null, 'msft')).toBe('MSFT');
    expect(activeNoteKey('symbol', null, 'msft')).toBe('MSFT');
  });
  it('the pin wins over the chart', () => {
    expect(effectiveSymbol('TSLA', 'MSFT')).toBe('TSLA');
    expect(activeNoteKey('symbol', 'TSLA', 'MSFT')).toBe('TSLA');
  });
  it('the general tab ignores both', () => {
    expect(activeNoteKey('general', 'TSLA', 'MSFT')).toBe('');
  });
});

describe('notePreview', () => {
  it('returns short text as is, whitespace collapsed to one line', () => {
    expect(notePreview('  buy\n\nthe   dip ')).toBe('buy the dip');
    expect(notePreview('')).toBe('');
    expect(notePreview(' \n ')).toBe('');
  });
  it('cuts at 120 characters with an ellipsis', () => {
    expect(notePreview('a'.repeat(300))).toBe(`${'a'.repeat(120)}…`);
    expect(notePreview('b'.repeat(120))).toBe('b'.repeat(120));
  });
  it('never splits a surrogate pair', () => {
    const out = notePreview('😀'.repeat(130));
    expect(Array.from(out)).toHaveLength(121);
    expect(out.endsWith('😀…')).toBe(true);
  });
  it('keeps markup as plain characters (rendered as text by the caller)', () => {
    expect(notePreview('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('useNotesTarget', () => {
  it('open pins the symbol, shows the symbol tab and requests focus once', () => {
    useNotesTarget.setState({ scope: 'general' });
    useNotesTarget.getState().open('aapl');
    expect(useNotesTarget.getState()).toMatchObject({
      target: 'AAPL',
      scope: 'symbol',
      pendingFocus: true,
    });
    useNotesTarget.getState().consumeFocus();
    expect(useNotesTarget.getState().pendingFocus).toBe(false);
  });
  it('open(null) follows the chart; setTarget does not request focus', () => {
    useNotesTarget.getState().open('AAPL');
    useNotesTarget.getState().consumeFocus();
    useNotesTarget.getState().setTarget(null);
    expect(useNotesTarget.getState()).toMatchObject({ target: null, pendingFocus: false });
    useNotesTarget.getState().open(null);
    expect(useNotesTarget.getState()).toMatchObject({ target: null, pendingFocus: true });
  });
});
