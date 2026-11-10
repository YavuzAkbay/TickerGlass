import { describe, expect, it } from 'vitest';
import {
  formatTradingViewTxt,
  parseTxt,
  toTradingViewSymbol,
  toYahooSymbol,
} from '../watchlist/model';
import type { WatchlistItem } from '../watchlist/types';

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const tv = (y: string) => toTradingViewSymbol(y).symbol;

describe('toTradingViewSymbol', () => {
  it.each([
    ['AAPL', 'AAPL'],
    ['BP.L', 'LSE:BP'],
    ['SAP.DE', 'XETR:SAP'],
    ['RY.TO', 'TSX:RY'],
    ['RCI-B.TO', 'TSX:RCI.B'],
    ['0700.HK', 'HKEX:700'],
    ['9988.HK', 'HKEX:9988'],
    ['7203.T', 'TSE:7203'],
    ['RELIANCE.NS', 'NSE:RELIANCE'],
    ['THYAO.IS', 'BIST:THYAO'],
    ['BHP.AX', 'ASX:BHP'],
    ['NESN.SW', 'SIX:NESN'],
    ['005930.KS', 'KRX:005930'],
    ['2330.TW', 'TWSE:2330'],
    ['PETR4.SA', 'BMFBOVESPA:PETR4'],
    ['EURUSD=X', 'FX_IDC:EURUSD'],
    ['USDTRY=X', 'FX_IDC:USDTRY'],
    ['BTC-USD', 'COINBASE:BTCUSD'],
    ['ETH-EUR', 'COINBASE:ETHEUR'],
    ['ES=F', 'CME_MINI:ES1!'],
    ['CL=F', 'NYMEX:CL1!'],
    ['GC=F', 'COMEX:GC1!'],
    ['^GSPC', 'SP:SPX'],
    ['^NDX', 'NASDAQ:NDX'],
    ['^VIX', 'TVC:VIX'],
    ['DX-Y.NYB', 'TVC:DXY'],
    ['BRK-B', 'NYSE:BRK.B'],
  ])('%s -> %s', (yahoo, expected) => {
    expect(tv(yahoo)).toBe(expected);
  });

  it('marks guesses and losses as approximate', () => {
    for (const y of ['AIR.PA', 'ASML.AS', 'ZZ=F', '^FTSE', 'JPY=X', 'BT-A.L'])
      expect(toTradingViewSymbol(y).approximate, y).toBe(true);
    for (const y of ['AAPL', 'BP.L', 'RCI-B.TO', 'BTC-USD', 'ES=F', '^GSPC', '0700.HK', 'BRK-B'])
      expect(toTradingViewSymbol(y).approximate, y).toBe(false);
    expect(tv('AIR.PA')).toBe('EURONEXT:AIR');
    expect(tv('JPY=X')).toBe('FX_IDC:USDJPY');
    expect(tv('ZZ=F')).toBe('ZZ1!');
    expect(tv('BT-A.L')).toBe('LSE:BT.A');
  });
});

describe('round trip with the importer', () => {
  // Re-importing the export gives the same Yahoo symbol.
  const LOSSLESS = [
    'AAPL',
    'MSFT',
    'BRK-B',
    'BF-B',
    'BP.L',
    'SAP.DE',
    'RY.TO',
    'RCI-B.TO',
    '0700.HK',
    '9988.HK',
    '7203.T',
    'RELIANCE.NS',
    'BHP.AX',
    'NESN.SW',
    '005930.KS',
    '2330.TW',
    'PETR4.SA',
    'EURUSD=X',
    'BTC-USD',
    'ETH-EUR',
    'ES=F',
    'NQ=F',
    'CL=F',
    'GC=F',
    '^GSPC',
    '^NDX',
    '^IXIC',
    '^DJI',
    '^VIX',
    'DX-Y.NYB',
  ];

  it.each(LOSSLESS)('%s', (y) => {
    expect(toYahooSymbol(tv(y))).toBe(y);
  });

  it('whole list with sections', () => {
    const items: WatchlistItem[] = [
      { type: 'section', id: 'a', title: 'Core' },
      ...LOSSLESS.slice(0, 5).map(S),
      { type: 'section', id: 'b', title: 'World' },
      ...LOSSLESS.slice(5).map(S),
    ];
    const { text, approximate } = formatTradingViewTxt(items);
    expect(approximate).toEqual([]);
    expect(text.startsWith('###Core,AAPL,MSFT')).toBe(true);
    expect(text).toContain(',###World,');
    const back = parseTxt(text);
    expect(back.unmapped).toEqual([]);
    expect(back.skipped + back.duplicates + back.truncated).toBe(0);
    expect(back.items.map((i) => (i.type === 'section' ? `###${i.title}` : i.symbol))).toEqual(
      items.map((i) => (i.type === 'section' ? `###${i.title}` : i.symbol)),
    );
  });

  it('lossy cases are listed and do not round-trip', () => {
    const { text, approximate } = formatTradingViewTxt([S('AIR.PA'), S('AAPL'), S('^FTSE')]);
    expect(approximate).toEqual(['AIR.PA', '^FTSE']);
    expect(text).toBe('EURONEXT:AIR,AAPL,^FTSE');
    expect(parseTxt(text).unmapped).toContain('EURONEXT:AIR'); // the importer cannot tell the market
  });

  it('US class shares keep the exchange so they read back as Yahoo symbols', () => {
    expect(tv('BRK-B')).toBe('NYSE:BRK.B');
    expect(parseTxt(formatTradingViewTxt([S('BRK-B')]).text).items).toEqual([S('BRK-B')]);
    expect(toYahooSymbol('BRK.B')).toBe('BRK.B'); // a bare dotted symbol is not guessed
  });

  it('uses a known US exchange', () => {
    expect(toTradingViewSymbol('LEN-B', 'NASDAQ').symbol).toBe('NASDAQ:LEN.B');
    expect(toTradingViewSymbol('AAPL', 'NASDAQ').symbol).toBe('NASDAQ:AAPL');
    expect(toTradingViewSymbol('AAPL', 'LSE').symbol).toBe('AAPL'); // not a US exchange: bare
    expect(toTradingViewSymbol('AAPL', null).symbol).toBe('AAPL');
    const { text } = formatTradingViewTxt([S('AAPL'), S('BRK-B')], (y) =>
      y === 'AAPL' ? 'NASDAQ' : 'NYSE',
    );
    expect(text).toBe('NASDAQ:AAPL,NYSE:BRK.B');
    expect(parseTxt(text).items.map((i) => (i.type === 'symbol' ? i.symbol : ''))).toEqual([
      'AAPL',
      'BRK-B',
    ]);
  });

  it('keeps commas out of section headers', () => {
    const { text } = formatTradingViewTxt([
      { type: 'section', id: 'a', title: 'Tech, AI\nNew' },
      S('AAPL'),
    ]);
    expect(text).toBe('###Tech AI New,AAPL');
  });
});
