import { describe, expect, it } from 'vitest';
import { footerText, layoutPlacements, screenshotFilename, utcStamp } from './screenshot';

const when = new Date(Date.UTC(2026, 9, 21, 7, 5, 59));

describe('screenshot helpers', () => {
  it('formats the UTC stamp and filename', () => {
    expect(utcStamp(when)).toBe('2026-10-21 07:05');
    expect(screenshotFilename('AAPL', '1D', when)).toBe('AAPL_1D_2026-10-21_07-05.png');
  });

  it('keeps file names safe', () => {
    expect(screenshotFilename('BTC/USD', '15m', when)).toBe('BTC_USD_15m_2026-10-21_07-05.png');
    expect(screenshotFilename('^GSPC', '1D', when)).toMatch(/^\^GSPC_1D_/);
  });

  it('builds the footer with every chart', () => {
    expect(footerText([{ symbol: 'AAPL', interval: '1D' }], when)).toBe(
      'AAPL 1D  ·  2026-10-21 07:05 UTC',
    );
    expect(
      footerText(
        [
          { symbol: 'AAPL', interval: '1D' },
          { symbol: 'MSFT', interval: '1h' },
        ],
        when,
      ),
    ).toBe('AAPL 1D  |  MSFT 1h  ·  2026-10-21 07:05 UTC');
  });

  it('places cells relative to the grid and adds the footer height', () => {
    const origin = { x: 10, y: 20, w: 400, h: 200 };
    const out = layoutPlacements(
      [
        { x: 10, y: 20, w: 198, h: 200 },
        { x: 212, y: 20, w: 198, h: 200 },
      ],
      origin,
      2,
      24,
    );
    expect(out.width).toBe(800);
    expect(out.height).toBe(448);
    expect(out.placements).toEqual([
      { x: 0, y: 0 },
      { x: 404, y: 0 },
    ]);
  });
});
