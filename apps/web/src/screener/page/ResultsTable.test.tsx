import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildUniverse } from '../universe/types';
import { ResultsTable } from './ResultsTable';

const universe = buildUniverse('stocks', 'sector', 'mcap', [['AAA', 'Alpha', 'Tech', 'NYSE', 5]]);

const base = {
  universe,
  rows: [],
  quotes: {},
  missing: {},
  loadingQuotes: false,
  conflict: null,
  onHold: vi.fn(),
  columns: ['name', 'last'] as const,
  sort: null,
  pageSize: 20,
  density: 'cozy' as const,
  focus: null,
  onFocus: vi.fn(),
  onOpen: vi.fn(),
  onMenu: vi.fn(),
  searchRef: { current: null },
  onClearFilters: vi.fn(),
};

const render = (over: Partial<Parameters<typeof ResultsTable>[0]>) =>
  renderToStaticMarkup(<ResultsTable {...base} columns={[...base.columns]} {...over} />);

describe('ResultsTable empty states', () => {
  it('shows "no matches" with a clear button when nothing matches', () => {
    const html = render({});
    expect(html).toContain('data-testid="scr-empty"');
    expect(html).toContain('No matches');
    expect(html).toContain('Clear filters');
  });

  it('shows a loading state, not "no matches", while quote filters await quotes', () => {
    const html = render({ loadingQuotes: true });
    expect(html).toContain('data-testid="scr-loading-quotes"');
    expect(html).toContain('Loading quotes');
    expect(html).not.toContain('No matches');
    expect(html).not.toContain('Clear filters');
  });

  it('explains conflicting bounds instead of a bare "no matches"', () => {
    const html = render({
      conflict: 'Price: the minimum is above the maximum, so nothing can match.',
    });
    expect(html).toContain('Conflicting bounds');
    expect(html).toContain('minimum is above the maximum');
  });
});
