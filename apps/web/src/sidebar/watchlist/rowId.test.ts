import { describe, expect, it } from 'vitest';
import { rowDomId } from './rowId';

describe('rowDomId', () => {
  it('keeps plain tickers readable', () => {
    expect(rowDomId('wlp-r', 'AAPL')).toBe('wlp-r-AAPL');
    expect(rowDomId('wlp-r', 'BRK-B')).toBe('wlp-r-BRK-B');
  });

  it('escapes characters that are awkward in selectors', () => {
    expect(rowDomId('wl-r', '^GSPC')).toBe('wl-r-_5e_GSPC');
    expect(rowDomId('wl-r', 'ES=F')).toBe('wl-r-ES_3d_F');
    expect(rowDomId('wl-r', 'BRK.B')).toBe('wl-r-BRK_2e_B');
    expect(rowDomId('wl-r', 'EUR/USD')).toBe('wl-r-EUR_2f_USD');
  });

  it('never collides and yields only id-safe characters', () => {
    const syms = ['A_5e_', 'A^', 'A_', 'A', '^A', 'A.B', 'A=B', 'A/B', 'A&B'];
    const ids = syms.map((s) => rowDomId('x', s));
    expect(new Set(ids).size).toBe(syms.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
