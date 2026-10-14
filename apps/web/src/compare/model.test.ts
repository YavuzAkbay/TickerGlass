import { describe, expect, it } from 'vitest';
import { normalizeSymbol } from '../store/app';
import {
  COMPARE_COLORS,
  MAX_COMPARES,
  comparePaneId,
  compareSymbol,
  isCompareId,
  newCompareId,
  nextCompareColor,
  parseCompareLayout,
  type CompareState,
} from './model';

const cmp = (id: string, patch: Partial<CompareState> = {}): CompareState => ({
  id,
  symbol: 'MSFT',
  placement: 'same',
  visible: true,
  color: '#f7a21b',
  lineWidth: 2,
  ...patch,
});

describe('compare model', () => {
  it('ids are unique, valid and recognisable; panes are named after them', () => {
    const ids = new Set(Array.from({ length: 100 }, newCompareId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^cmp-[a-z0-9]{1,24}$/);
    expect(isCompareId('cmp-abc')).toBe(true);
    expect(isCompareId('sma-1')).toBe(false);
    expect(comparePaneId('cmp-abc')).toBe('pane-cmp-abc');
  });

  it('canonicalizes overlay symbols and caps their length', () => {
    expect(compareSymbol(' aapl/msft ')).toEqual({ ok: true, symbol: 'AAPL/MSFT' });
    expect(compareSymbol('"brk/b"*2')).toEqual({ ok: true, symbol: '"BRK/B"*2' });
    expect(compareSymbol('brk-b')).toEqual({ ok: true, symbol: 'BRK-B' });
    expect(compareSymbol('AAPL/')).toMatchObject({ ok: false });
    expect(compareSymbol(`A${'+B'.repeat(70)}`)).toEqual({
      ok: false,
      message: 'Too long (max 128 characters)',
    });
  });

  it('picks the first unused palette colour', () => {
    expect(nextCompareColor([])).toBe(COMPARE_COLORS[0]);
    expect(nextCompareColor([cmp('cmp-a'), cmp('cmp-b', { color: COMPARE_COLORS[2]! })])).toBe(
      COMPARE_COLORS[1],
    );
    const all = COMPARE_COLORS.map((color, i) => cmp(`cmp-${i}`, { color }));
    expect(nextCompareColor(all)).toBe(COMPARE_COLORS[0]);
  });

  it('parses stored layouts: invalid items dropped, at most MAX_COMPARES', () => {
    const many = Array.from({ length: MAX_COMPARES + 3 }, (_, i) => cmp(`cmp-${i}`));
    expect(parseCompareLayout({ items: many, scaleRestore: 'percent' })).toEqual({
      items: many.slice(0, MAX_COMPARES),
      scaleRestore: 'percent',
    });
    expect(parseCompareLayout(undefined)).toEqual({ items: [], scaleRestore: null });
    expect(
      parseCompareLayout({ items: [cmp('cmp-a', { symbol: 'aapl - msft' }), cmp('CMP-B')] }),
    ).toEqual({ items: [cmp('cmp-a', { symbol: 'AAPL - MSFT' })], scaleRestore: null });
  });
});

describe('normalizeSymbol', () => {
  it('upper-cases plain symbols and canonicalizes expressions', () => {
    expect(normalizeSymbol(' (aapl+msft)/2 ')).toBe('(AAPL+MSFT)/2');
    expect(normalizeSymbol('brk-b')).toBe('BRK-B');
    expect(normalizeSymbol(' aapl ')).toBe('AAPL');
    expect(normalizeSymbol('aapl - msft')).toBe('AAPL - MSFT');
    expect(normalizeSymbol('((aapl))')).toBe('AAPL');
    // Not an expression: trimmed and upper-cased as before.
    expect(normalizeSymbol(' aapl/ ')).toBe('AAPL/');
    expect(normalizeSymbol('')).toBe('');
  });
});
