import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const metered = vi.hoisted(() => ({ value: false }));
vi.mock('../api/provider', () => ({ useMetered: () => metered.value }));
vi.mock('../chart/feed', () => ({ feed: { searchSymbols: () => Promise.resolve([]) } }));

import { searchPolicy, useSymbolSearch, type SymbolSearch } from './symbolSearch';

function probe(query: string): SymbolSearch {
  let result: SymbolSearch | undefined;
  function Probe() {
    result = useSymbolSearch(query);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!result) throw new Error('hook did not run');
  return result;
}

describe('searchPolicy', () => {
  it('debounces 200 ms and searches from one character on a free provider', () => {
    expect(searchPolicy(false)).toEqual({ debounceMs: 200, minChars: 1 });
  });
  it('debounces 400 ms and needs two characters on a metered provider', () => {
    expect(searchPolicy(true)).toEqual({ debounceMs: 400, minChars: 2 });
  });
});

describe('useSymbolSearch minimum length', () => {
  it('searches a single character on a free provider', () => {
    metered.value = false;
    const s = probe('A');
    expect(s.tooShort).toBe(false);
    expect(s.loading).toBe(true); // waiting for the search to run
  });

  it('does not search a single character on a metered provider', () => {
    metered.value = true;
    const s = probe(' A ');
    expect(s).toMatchObject({ tooShort: true, loading: false, items: [], minChars: 2 });
  });

  it('searches two characters on a metered provider', () => {
    metered.value = true;
    const s = probe('AA');
    expect(s.tooShort).toBe(false);
    expect(s.loading).toBe(true);
  });

  it('an empty query is neither short nor loading', () => {
    metered.value = true;
    expect(probe('')).toMatchObject({ tooShort: false, loading: false });
  });
});
