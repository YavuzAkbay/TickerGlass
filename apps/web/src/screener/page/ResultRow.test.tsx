import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { emptyQuote } from '../../quotes/merge';
import { buildUniverse } from '../universe/types';
import { scrColumns } from './pageColumns';
import { ResultRow } from './ResultRow';

const universe = buildUniverse('stocks', 'sector', 'mcap', [
  ['ZZZ', 'Zed Corp', 'Tech', 'NYSE', 5],
]);
const defs = scrColumns(universe);

const html = (over: { missing: boolean; columns?: Parameters<typeof ResultRow>[0]['columns'] }) =>
  renderToStaticMarkup(
    <ResultRow
      s={universe.symbols[0]!}
      q={undefined}
      columns={over.columns ?? ['name', 'last']}
      columnDefs={defs}
      active={false}
      current={false}
      onOpen={vi.fn()}
      onFocus={vi.fn()}
      onMenu={vi.fn()}
      missing={over.missing}
      index={0}
    />,
  );

describe('ResultRow', () => {
  it('dims rows the provider has no data for and says why', () => {
    const out = html({ missing: true });
    expect(out).toContain('scr-row missing');
    expect(out).toContain('No data from provider');
  });

  it('leaves normal rows alone', () => {
    const out = html({ missing: false });
    expect(out).not.toContain('missing');
    expect(out).not.toContain('No data from provider');
  });

  it('renders the opt-in range columns without data as empty tracks', () => {
    const out = html({ missing: false, columns: ['dayRange', 'week52Range'] });
    expect((out.match(/scr-range-empty/g) ?? []).length).toBe(2);
  });

  it('draws a 52-week bar once the quote carries both bounds', () => {
    const q = {
      ...emptyQuote('ZZZ'),
      last: 150,
      changePercent: 1,
      ...({ fiftyTwoWeekLow: 100, fiftyTwoWeekHigh: 200 } as object),
    };
    const out = renderToStaticMarkup(
      <ResultRow
        s={universe.symbols[0]!}
        q={q}
        columns={['week52Range']}
        columnDefs={defs}
        active={false}
        current={false}
        onOpen={vi.fn()}
        onFocus={vi.fn()}
        onMenu={vi.fn()}
        missing={false}
        index={0}
      />,
    );
    expect(out).toContain('scr-range-dot');
    expect(out).toContain('left:50.0%');
  });
});
