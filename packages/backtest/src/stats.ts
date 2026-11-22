/** Performance summary of a backtest (docs/backtest.md §4). */
import type { BacktestBars, BacktestStats, StrategySettings, Trade } from './types';

const YEAR_S = 365.25 * 86_400;

export interface StatsInput {
  bars: BacktestBars;
  trades: readonly Trade[];
  openTrade: Trade | null;
  equity: Float64Array;
  settings: StrategySettings;
  inPositionBars: number;
}

function firstFinite(a: ArrayLike<number>): number {
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) return i;
  return -1;
}

function lastFinite(a: ArrayLike<number>): number {
  for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return i;
  return -1;
}

export function computeStats(input: StatsInput): BacktestStats {
  const { bars, trades, openTrade, equity, settings } = input;
  const n = bars.length;
  const initial = settings.initialCapital;

  let grossProfit = 0;
  let grossLoss = 0;
  let winners = 0;
  let losers = 0;
  let largestWin = 0;
  let largestLoss = 0;
  let barsSum = 0;
  let commissionPaid = 0;
  let streakW = 0;
  let streakL = 0;
  let maxW = 0;
  let maxL = 0;
  let longTrades = 0;
  for (const t of trades) {
    barsSum += t.bars;
    commissionPaid += t.commission;
    if (t.side === 'long') longTrades++;
    if (t.pnl > 0) {
      grossProfit += t.pnl;
      winners++;
      largestWin = Math.max(largestWin, t.pnl);
      streakW++;
      streakL = 0;
    } else {
      grossLoss += -t.pnl;
      losers++;
      largestLoss = Math.min(largestLoss, t.pnl);
      streakL++;
      streakW = 0;
    }
    maxW = Math.max(maxW, streakW);
    maxL = Math.max(maxL, streakL);
  }
  if (openTrade) commissionPaid += openTrade.commission;
  const total = trades.length;
  const netProfit = grossProfit - grossLoss;
  const avgWin = winners ? grossProfit / winners : NaN;
  const avgLoss = losers ? -grossLoss / losers : NaN;

  // Drawdown on the mark-to-market equity curve.
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (let i = 0; i < n; i++) {
    const e = equity[i]!;
    if (!Number.isFinite(e)) continue;
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, peak - e);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, ((peak - e) / peak) * 100);
  }

  // Per-bar returns, annualised by the bars per year the data actually has.
  const f = firstFinite(bars.time);
  const l = lastFinite(bars.time);
  const span = f >= 0 && l > f ? bars.time[l]! - bars.time[f]! : 0;
  const perYear = span > 0 ? (n - 1) / (span / YEAR_S) : NaN;
  let sum = 0;
  let sumSq = 0;
  let downSq = 0;
  let count = 0;
  for (let i = 1; i < n; i++) {
    const a = equity[i - 1]!;
    const b = equity[i]!;
    if (!(a > 0) || !Number.isFinite(b)) continue;
    const r = b / a - 1;
    sum += r;
    sumSq += r * r;
    if (r < 0) downSq += r * r;
    count++;
  }
  const mean = count ? sum / count : NaN;
  const sd = count > 1 ? Math.sqrt(Math.max(0, sumSq / count - mean * mean)) : NaN;
  const dd = count ? Math.sqrt(downSq / count) : NaN;
  const ann = Math.sqrt(perYear);
  const sharpe = sd > 0 ? (mean / sd) * ann : NaN;
  const sortino = dd > 0 ? (mean / dd) * ann : NaN;

  const finalEquity = n > 0 ? equity[n - 1]! : initial;
  const years = span / YEAR_S;
  const cagrPct =
    span >= 86_400 && initial > 0 && finalEquity > 0
      ? (Math.pow(finalEquity / initial, 1 / years) - 1) * 100
      : NaN;

  const cf = firstFinite(bars.close);
  const cl = lastFinite(bars.close);
  const buyHoldPct =
    cf >= 0 && cl > cf && bars.close[cf]! > 0 ? (bars.close[cl]! / bars.close[cf]! - 1) * 100 : NaN;

  return {
    initialCapital: initial,
    finalEquity,
    netProfit,
    netProfitPct: initial > 0 ? (netProfit / initial) * 100 : NaN,
    openPnl: openTrade?.pnl ?? 0,
    grossProfit,
    grossLoss,
    profitFactor:
      total === 0
        ? NaN
        : grossLoss === 0
          ? grossProfit > 0
            ? Infinity
            : NaN
          : grossProfit / grossLoss,
    totalTrades: total,
    winners,
    losers,
    winRate: total ? (winners / total) * 100 : NaN,
    avgTrade: total ? netProfit / total : NaN,
    avgWin,
    avgLoss,
    payoffRatio:
      Number.isFinite(avgWin) && Number.isFinite(avgLoss) && avgLoss < 0 ? avgWin / -avgLoss : NaN,
    largestWin,
    largestLoss,
    avgBarsInTrade: total ? barsSum / total : NaN,
    maxConsecutiveWins: maxW,
    maxConsecutiveLosses: maxL,
    commissionPaid,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    buyHoldPct,
    cagrPct,
    sharpe,
    sortino,
    exposurePct: n ? (input.inPositionBars / n) * 100 : 0,
    longTrades,
    shortTrades: total - longTrades,
  };
}
