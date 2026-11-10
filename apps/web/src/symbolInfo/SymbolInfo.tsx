import type { LiveQuote } from '../quotes/types';
import { useDebouncedValue } from './hooks';
import { KeyStats } from './KeyStats';
import { PerformanceStrip } from './PerformanceStrip';
import { SymbolAlerts } from './SymbolAlerts';
import { SymbolNews } from './SymbolNews';
import { UpcomingEvents } from './UpcomingEvents';
import './symbolInfo.css';

interface Props {
  symbol: string;
  quote: LiveQuote | undefined;
  /** The pane shows the market cap itself (screener universe). */
  showMarketCap?: boolean;
  /** List this symbol's alerts and notes. */
  withAlerts?: boolean;
}

/**
 * The detail sections shared by the Watchlists and Screener panes. The symbol is debounced
 * before anything is fetched, so moving through rows with the keyboard asks for nothing until
 * the selection rests; the sections show placeholders meanwhile, never the previous symbol.
 */
export function SymbolInfo({ symbol, quote, showMarketCap = true, withAlerts = false }: Props) {
  const settled = useDebouncedValue(symbol);
  const shown = settled === symbol ? symbol : null;
  return (
    <div className="si-root" data-testid="si-root" data-symbol={shown ?? ''}>
      <PerformanceStrip symbol={shown} />
      <KeyStats symbol={shown} quote={quote} showMarketCap={showMarketCap} />
      <UpcomingEvents symbol={shown} />
      <SymbolNews symbol={shown} />
      {withAlerts ? <SymbolAlerts symbol={symbol} /> : null}
    </div>
  );
}
