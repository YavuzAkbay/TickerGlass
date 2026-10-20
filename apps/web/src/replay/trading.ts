import type { ChartMarker, ChartPriceLine } from '@investopen/engine';
import { create } from 'zustand';
import type { ReplaySession } from './controller';
import {
  closeOrder,
  emptyPaper,
  fill,
  totalPnl,
  unrealized,
  type PaperState,
  type Side,
} from './paper';

export const TRADE_MARKER_GROUP = 'replay-trades';
export const POSITION_LINE_GROUP = 'replay-position';
const UP = '#26a69a';
const DOWN = '#ef5350';

interface TradingStore {
  paper: PaperState;
  /** Last revealed close per symbol (only the chart symbol has one). */
  marks: Record<string, number>;
  /** Order quantity input. */
  qty: number;
  set: (patch: Partial<Omit<TradingStore, 'set'>>) => void;
}

/** Paper trades of the running replay. Never persisted. */
export const useTrading = create<TradingStore>()((set) => ({
  paper: emptyPaper(),
  marks: {},
  qty: 1,
  set: (patch) => set(patch),
}));

interface Bar {
  time: number;
  close: number;
}

export interface ReplayTradingDeps {
  /** Chart symbol as the app holds it. */
  symbol: () => string;
  /** The last revealed (forming) bar of the chart, or null. */
  lastBar: () => Bar | null;
  /** Replay clock: open time of the last revealed tick. */
  clock: () => number;
  /** Whether orders are allowed (replay loaded). */
  ready: () => boolean;
  setMarkers: (group: string, markers: readonly ChartMarker[]) => void;
  setPriceLines: (group: string, lines: readonly ChartPriceLine[]) => void;
  notify: (message: string) => void;
}

const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(2)}`;

/**
 * Replay paper trading (docs/replay.md §6): market orders filled at the close of
 * the last revealed bar of the chart symbol, shown as chart markers and a
 * position line. State lives in `useTrading`; a replay start, seek or exit resets it.
 */
export class ReplayTrading implements ReplaySession {
  /** Chart bar time of each fill (the marker sits on the bar, the trade keeps the tick time). */
  private barTimes = new Map<number, number>();
  /** Chart symbol the markers and the position line were last drawn for. */
  private drawnSymbol: string | null = null;

  constructor(private readonly deps: ReplayTradingDeps) {}

  reset(): void {
    this.barTimes.clear();
    this.drawnSymbol = null;
    useTrading.setState({ paper: emptyPaper(), marks: {} });
    this.deps.setMarkers(TRADE_MARKER_GROUP, []);
    this.deps.setPriceLines(POSITION_LINE_GROUP, []);
  }

  prime(): void {
    this.mark();
  }

  step(): void {
    this.mark();
  }

  end(): void {
    const { paper, marks } = useTrading.getState();
    if (paper.trades.length === 0) return;
    this.deps.notify(
      `Replay finished: ${paper.trades.length} trades, realized ${money(paper.realized)}, total ${money(totalPnl(paper, marks))}`,
    );
  }

  /** Place a market order on the chart symbol. Returns an error message, or null when filled. */
  order(side: Side, qty: number): string | null {
    if (!this.deps.ready()) return 'Replay is not running';
    const bar = this.deps.lastBar();
    if (!bar || !Number.isFinite(bar.close)) return 'No price to trade at';
    if (!(qty > 0) || !Number.isFinite(qty)) return 'Enter a quantity above zero';
    const symbol = this.deps.symbol();
    const cur = useTrading.getState().paper;
    const next = fill(cur, { symbol, side, qty, price: bar.close, time: this.deps.clock() });
    this.barTimes.set(next.trades.length, bar.time);
    useTrading.setState({
      paper: next,
      marks: { ...useTrading.getState().marks, [symbol]: bar.close },
    });
    this.draw();
    return null;
  }

  /** Flatten the chart symbol's position. */
  close(): string | null {
    const o = closeOrder(useTrading.getState().paper, this.deps.symbol());
    return o ? this.order(o.side, o.qty) : 'No open position';
  }

  /** Update the mark price (state only when it changed); redraw only if the chart symbol changed. */
  private mark(): void {
    const symbol = this.deps.symbol();
    const bar = this.deps.lastBar();
    if (bar && Number.isFinite(bar.close) && useTrading.getState().marks[symbol] !== bar.close) {
      useTrading.setState((s) => ({ marks: { ...s.marks, [symbol]: bar.close } }));
    }
    if (symbol !== this.drawnSymbol) this.draw();
  }

  private draw(): void {
    const symbol = this.deps.symbol();
    this.drawnSymbol = symbol;
    const { paper } = useTrading.getState();
    const markers: ChartMarker[] = paper.trades
      .filter((t) => t.symbol === symbol)
      .map((t) => ({
        id: `trade-${t.id}`,
        time: this.barTimes.get(t.id) ?? t.time,
        position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: t.side === 'buy' ? UP : DOWN,
        shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
        tooltip: `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.qty} @ ${t.price.toFixed(2)}`,
      }));
    this.deps.setMarkers(TRADE_MARKER_GROUP, markers);
    const pos = paper.positions[symbol];
    this.deps.setPriceLines(
      POSITION_LINE_GROUP,
      pos
        ? [
            {
              id: 'position',
              paneId: 'main',
              price: pos.avg,
              color: pos.qty > 0 ? UP : DOWN,
              lineStyle: 'dashed',
              label: `${pos.qty > 0 ? 'Long' : 'Short'} ${Math.abs(pos.qty)} @ ${pos.avg.toFixed(2)}`,
              axisLabel: false,
            },
          ]
        : [],
    );
  }
}

/** Unrealized P&L of the open positions at the current marks. */
export const selectUnrealized = (s: TradingStore): number => unrealized(s.paper, s.marks);
export const selectTotal = (s: TradingStore): number => totalPnl(s.paper, s.marks);
