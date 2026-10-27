/**
 * Built-in starter watchlists, seeded on first run next to the default list
 * (`WatchlistSync.seedIfEmpty`). Broad, liquid symbols a beginner can follow
 * right away; sections group futures vs. funds where both exist.
 */
import type { WatchlistItem } from './types';

export interface StarterList {
  name: string;
  items: WatchlistItem[];
}

const syms = (...symbols: string[]): WatchlistItem[] =>
  symbols.map((symbol) => ({ type: 'symbol' as const, symbol }));

const section = (title: string, symbols: string[]): WatchlistItem[] => [
  { type: 'section', id: crypto.randomUUID(), title, collapsed: false },
  ...syms(...symbols),
];

export const STARTER_LISTS: StarterList[] = [
  {
    name: 'U.S. Stocks',
    items: syms('AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'BRK-B', 'JPM', 'V'),
  },
  {
    name: 'ETF',
    items: syms('SPY', 'QQQ', 'VTI', 'VOO', 'IWM', 'DIA', 'ARKK', 'TLT', 'GLD', 'EEM'),
  },
  {
    name: 'Precious Metals',
    items: [
      ...section('Futures', ['GC=F', 'SI=F', 'PL=F', 'PA=F']),
      ...section('ETFs & miners', ['GLD', 'SLV', 'GDX', 'GDXJ']),
    ],
  },
  {
    name: 'Commodities',
    items: [
      ...section('Energy', ['CL=F', 'BZ=F', 'NG=F']),
      ...section('Metals', ['HG=F']),
      ...section('Agriculture', ['ZW=F', 'ZC=F', 'ZS=F', 'KC=F', 'SB=F']),
      ...section('Broad', ['DBC']),
    ],
  },
  {
    name: 'Crypto',
    items: syms(
      'BTC-USD',
      'ETH-USD',
      'SOL-USD',
      'XRP-USD',
      'BNB-USD',
      'ADA-USD',
      'DOGE-USD',
      'LTC-USD',
    ),
  },
];
