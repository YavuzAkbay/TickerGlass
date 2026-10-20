import { formatInterval, parseInterval, tickIntervals } from '@investopen/engine';
import { FastForward, Pause, Play, Scissors, StepForward, TriangleAlert, X } from 'lucide-react';
import { useMemo } from 'react';
import { commands } from '../commands/registry';
import { useChartView } from '../store/chartView';
import { useChartStore } from '../store/chart';
import { IconButton } from '../ui/IconButton';
import { useCommand, firstShortcut } from '../topbar/useCommand';
import { replay, trading } from './instance';
import { selectTotal, useTrading } from './trading';
import { toast } from '../ui/Toast';
import { fmtSigned } from '../sidebar/format';
import { REPLAY_SPEEDS, useReplayStore } from './store';
import './replay.css';

const run = (id: string) => commands.execute(id);

/** Delay per step as shown in the speed picker. */
const speedLabel = (ms: number) => (ms < 100 ? `${ms} ms` : `${ms / 1000} s`);

/** Time zone to show the replay clock in, following the chart's timezone setting. */
function clockZone(setting: string, exchange: string | null | undefined): string | undefined {
  if (setting === 'exchange') return exchange ?? 'UTC';
  if (setting === 'local') return undefined;
  return setting;
}

export function formatReplayTime(
  unixSeconds: number,
  setting: string,
  exchange: string | null | undefined,
  intraday: boolean,
): string {
  if (!Number.isFinite(unixSeconds)) return '';
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(intraday ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  };
  try {
    const zone = clockZone(setting, exchange);
    return new Intl.DateTimeFormat('en-US', zone ? { ...opts, timeZone: zone } : opts).format(
      unixSeconds * 1000,
    );
  } catch {
    return new Date(unixSeconds * 1000).toISOString();
  }
}

/** Show an order error (null = filled). */
const order = (error: string | null) => {
  if (error) toast(error, 'error');
};

/** Replay controls, docked at the bottom of the chart while replay is on. */
export function ReplayBar() {
  const status = useReplayStore((s) => s.status);
  const last = useReplayStore((s) => s.last);
  const warning = useReplayStore((s) => s.warning);
  const speed = useReplayStore((s) => s.speed);
  const update = useReplayStore((s) => s.update);
  const interval = useChartView((s) => s.interval);
  const timezone = useChartView((s) => s.timezone);
  const exchange = useChartStore((s) => s.symbolInfo?.timezone);
  const qty = useTrading((s) => s.qty);
  const total = useTrading(selectTotal);
  const symbol = useChartView((s) => s.symbol);
  const open = useTrading((s) => (s.paper.positions[symbol]?.qty ?? 0) !== 0);
  const hasTrades = useTrading((s) => s.paper.trades.length > 0);
  const playPause = firstShortcut(useCommand('replay.playPause'));
  const step = firstShortcut(useCommand('replay.step'));

  const ticks = useMemo(() => {
    try {
      return tickIntervals(parseInterval(interval)).map(formatInterval);
    } catch {
      return [];
    }
  }, [interval]);
  const intraday = /[mh]$/.test(interval);
  const updateValue =
    update === 'auto' || update === 'bars' || ticks.includes(update) ? update : 'auto';

  const playing = status === 'playing';
  const busy = status === 'loading' || status === 'picking';
  const loaded = status === 'paused' || status === 'playing' || status === 'ended';
  const time = formatReplayTime(last, timezone, exchange, intraday);

  return (
    <div className="replay-bar" role="toolbar" aria-label="Replay controls" data-status={status}>
      <IconButton
        icon={Scissors}
        label="Select bar"
        className="rb-labeled"
        active={status === 'picking'}
        disabled={status === 'loading'}
        onClick={() => run('replay.selectBar')}
      >
        <span className="rb-label">Select bar</span>
      </IconButton>
      <div className="rb-sep" />
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? 'Pause' : 'Play'}
        {...(playPause ? { shortcut: playPause } : {})}
        disabled={!loaded || status === 'ended'}
        onClick={() => run('replay.playPause')}
      />
      <IconButton
        icon={StepForward}
        label="Step forward"
        {...(step ? { shortcut: step } : {})}
        disabled={status !== 'paused'}
        onClick={() => run('replay.step')}
      />
      <select
        className="io-input rb-select"
        aria-label="Replay speed"
        value={speed}
        disabled={busy}
        onChange={(e) => replay.setSpeed(Number(e.target.value))}
      >
        {REPLAY_SPEEDS.map((ms) => (
          <option key={ms} value={ms}>
            {speedLabel(ms)}
          </option>
        ))}
      </select>
      <select
        className="io-input rb-select"
        aria-label="Replay update interval"
        value={updateValue}
        disabled={busy}
        onChange={(e) => void replay.setUpdate(e.target.value)}
      >
        <option value="auto">Update: Auto</option>
        <option value="bars">Update: Bars</option>
        {ticks.map((t) => (
          <option key={t} value={t}>
            Update: {t}
          </option>
        ))}
      </select>
      {warning ? (
        <span className="rb-warning" role="status" title={warning} aria-label={warning}>
          <TriangleAlert size={16} />
        </span>
      ) : null}
      <span className="rb-time" data-testid="replay-time">
        {status === 'picking' ? 'Click a bar to start' : time}
      </span>
      <div className="rb-sep" />
      <input
        className="io-input rb-qty"
        type="number"
        min="0"
        step="any"
        aria-label="Order quantity"
        value={qty}
        onChange={(e) => useTrading.getState().set({ qty: Number(e.target.value) })}
      />
      <button
        type="button"
        className="rb-order rb-buy"
        disabled={!loaded}
        onClick={() => order(trading.order('buy', qty))}
      >
        Buy
      </button>
      <button
        type="button"
        className="rb-order rb-sell"
        disabled={!loaded}
        onClick={() => order(trading.order('sell', qty))}
      >
        Sell
      </button>
      <button
        type="button"
        className="rb-order"
        disabled={!loaded || !open}
        onClick={() => order(trading.close())}
      >
        Close
      </button>
      {hasTrades ? (
        <span
          className={`rb-pnl ${total > 0 ? 'up' : total < 0 ? 'down' : ''}`}
          title="Total P&L of replay trades"
          data-testid="replay-pnl"
        >
          {fmtSigned(total)}
        </span>
      ) : null}
      <div className="rb-sep" />
      <IconButton
        icon={FastForward}
        label="Jump to realtime"
        disabled={!loaded}
        onClick={() => run('replay.realtime')}
      />
      <IconButton icon={X} label="Exit replay" onClick={() => run('replay.exit')} />
    </div>
  );
}
