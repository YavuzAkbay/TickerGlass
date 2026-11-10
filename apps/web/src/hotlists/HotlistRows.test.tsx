import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyQuote } from '../quotes/merge';
import { HotlistRows } from './HotlistRows';

const rows = [
  { symbol: 'AAA', name: 'Alpha Inc', value: 3.2, last: 100, chg1d: 1 },
  { symbol: 'BBB', name: 'Beta Inc', value: null, last: null, chg1d: null },
];

describe('HotlistRows', () => {
  it('renders one button per row with the kind metric and the snapshot prices', () => {
    const html = renderToStaticMarkup(
      <HotlistRows rows={rows} kind="unusualVolume" quotes={{}} chartSymbol="BBB" label="x" />,
    );
    expect((html.match(/class="hl-row/g) ?? []).length).toBe(2);
    expect(html).toContain('data-testid="hl-metric-AAA">3.20x<');
    expect(html).toContain('data-testid="hl-last-AAA">100.00<');
    expect(html).toContain('data-testid="hl-chg-AAA">+1.00%<');
    expect(html).toContain('hl-row current'); // BBB is the chart symbol
    expect(html).toContain('data-testid="hl-metric-BBB">—<');
  });

  it('overlays live quotes', () => {
    const q = { ...emptyQuote('AAA'), last: 110, changePercent: -2 };
    const html = renderToStaticMarkup(
      <HotlistRows rows={rows} kind="gainers" quotes={{ AAA: q }} chartSymbol="" label="x" />,
    );
    expect(html).toContain('data-testid="hl-last-AAA">110.00<');
    expect(html).toContain('data-testid="hl-chg-AAA">−2.00%<');
  });
});
