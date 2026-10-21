import type {
  Bar,
  BarColumns,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SubscribeRequest,
  SymbolInfo,
  SymbolSearchResult,
  Unsubscribe,
} from '../types';
import { intervalSeconds } from './intervals';

/** 32-bit FNV-1a hash of the UTF-16 code units of `s`. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic random-walk feed for offline development, benchmarks and e2e
 * tests. `totalBars` bars end at `end` (unix s); no live updates. By default
 * every symbol gets the same series; `perSymbol` derives a distinct series
 * (seed and start price) from each symbol.
 */
export class SyntheticFeed implements DataFeed {
  private readonly perSymbol: boolean;

  constructor(
    private readonly totalBars = 100_000,
    private readonly end = 1_790_000_000,
    private readonly seed = 42,
    opts?: { perSymbol?: boolean },
  ) {
    this.perSymbol = opts?.perSymbol ?? false;
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return {
      symbol: symbol.toUpperCase(),
      name: `Synthetic ${symbol.toUpperCase()}`,
      exchange: 'SYN',
      exchangeName: 'Synthetic',
      type: 'equity',
      currency: 'USD',
      timezone: 'UTC',
      session: null,
      priceHint: 2,
      minTick: 0.01,
    };
  }

  async searchSymbols(query: string): Promise<SymbolSearchResult[]> {
    return [
      { symbol: query.toUpperCase() || 'SYN', name: 'Synthetic', exchange: 'SYN', type: 'equity' },
    ];
  }

  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    const step = intervalSeconds(req.interval);
    const all = this.series(step, req.symbol.toUpperCase());
    let hi = all.time.length;
    if (req.to !== undefined) while (hi > 0 && all.time[hi - 1]! >= req.to) hi--;
    const lo = Math.max(0, hi - req.limit);
    const slice = (a: Float64Array) => a.slice(lo, hi);
    return {
      bars: {
        time: slice(all.time),
        open: slice(all.open),
        high: slice(all.high),
        low: slice(all.low),
        close: slice(all.close),
        volume: slice(all.volume),
      },
      hasMore: lo > 0,
    };
  }

  subscribe(_req: SubscribeRequest, _lastBar: Bar | null, _onBar: (bar: Bar) => void): Unsubscribe {
    return () => {};
  }

  private cache = new Map<number | string, BarColumns>();

  private series(step: number, symbol: string): BarColumns {
    const key = this.perSymbol ? `${symbol}|${step}` : step;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const n = this.totalBars;
    const cols: BarColumns = {
      time: new Float64Array(n),
      open: new Float64Array(n),
      high: new Float64Array(n),
      low: new Float64Array(n),
      close: new Float64Array(n),
      volume: new Float64Array(n),
    };
    const h = this.perSymbol ? fnv1a(symbol) : 0;
    let s = this.perSymbol ? (this.seed ^ h) >>> 0 : this.seed >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    let price = this.perSymbol ? 20 + (h % 180) : 100;
    for (let i = 0; i < n; i++) {
      const open = price;
      const close = Math.max(1, open * (1 + (rand() - 0.5) * 0.04));
      cols.time[i] = this.end - (n - 1 - i) * step;
      cols.open[i] = open;
      cols.close[i] = close;
      cols.high[i] = Math.max(open, close) * (1 + rand() * 0.01);
      cols.low[i] = Math.min(open, close) * (1 - rand() * 0.01);
      cols.volume[i] = Math.round(1e5 + rand() * 1e6);
      price = close;
    }
    this.cache.set(key, cols);
    return cols;
  }
}
