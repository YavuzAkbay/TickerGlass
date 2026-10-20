import type { CrosshairInfo } from '@investopen/engine';
import { createStore } from 'zustand/vanilla';
import { describe, expect, it, vi } from 'vitest';
import { createChartViewStore } from '../store/chartView';
import { DEFAULT_SYNC_FLAGS, type SyncFlags } from './grid';
import { SyncBus, type SyncSession } from './sync';

function fake(id: string, symbol = 'AAPL', interval = '1D') {
  const chart = {
    setSyncedCrosshair: vi.fn(),
    setRightEdgeTime: vi.fn(() => Promise.resolve()),
    setVisibleTimeRange: vi.fn(() => Promise.resolve()),
    showAllHistory: vi.fn(() => Promise.resolve()),
    scrollToTime: vi.fn(() => Promise.resolve()),
  };
  const view = createChartViewStore({ symbol, interval });
  const info = createStore(() => ({
    symbolInfo: { timezone: 'America/New_York' } as never,
    crosshair: null,
    loading: false,
  }));
  return { id, chart, view, info } as unknown as SyncSession & { chart: typeof chart };
}

function setup(flags: Partial<SyncFlags> = {}, n = 3) {
  const sessions = Array.from({ length: n }, (_, i) =>
    fake(`c${i + 1}`, 'AAPL', i === 1 ? '5m' : '1D'),
  );
  const state = { sessions, flags: { ...DEFAULT_SYNC_FLAGS, ...flags } };
  const frames: (() => void)[] = [];
  const bus = new SyncBus(() => state, { raf: (cb) => void frames.push(cb) });
  const frame = () => frames.splice(0).forEach((cb) => cb());
  return { sessions, state, bus, frames, frame };
}

const xh = (time: number | null, price: number | null = 10): CrosshairInfo => ({
  paneId: 'main',
  index: 3,
  time,
  price,
  bar: null,
});

describe('symbol and interval', () => {
  it('change only the source chart without the flag', () => {
    const { sessions, bus } = setup();
    bus.setSymbol('c1', 'msft');
    bus.setInterval('c2', '1h');
    expect(sessions.map((s) => s.view.getState().symbol)).toEqual(['MSFT', 'AAPL', 'AAPL']);
    expect(sessions.map((s) => s.view.getState().interval)).toEqual(['1D', '1h', '1D']);
  });

  it('change every chart with the flag', () => {
    const { sessions, bus } = setup({ symbol: true, interval: true });
    bus.setSymbol('c1', 'MSFT');
    bus.setInterval('c3', '1W');
    expect(sessions.map((s) => s.view.getState().symbol)).toEqual(['MSFT', 'MSFT', 'MSFT']);
    expect(sessions.map((s) => s.view.getState().interval)).toEqual(['1W', '1W', '1W']);
  });
});

describe('crosshair', () => {
  it('mirrors to the others once per frame, latest position wins, never to the source', () => {
    const { sessions, bus, frame, frames } = setup();
    bus.crosshair('c1', xh(100, 1));
    bus.crosshair('c1', xh(200, 2));
    bus.crosshair('c1', xh(300, 3));
    expect(frames).toHaveLength(1);
    expect(sessions[1]!.chart.setSyncedCrosshair).not.toHaveBeenCalled();
    frame();
    // The source drops any crosshair mirrored onto it earlier; it never gets the new one.
    expect(sessions[0]!.chart.setSyncedCrosshair.mock.calls).toEqual([[null]]);
    for (const s of sessions.slice(1)) {
      expect(s.chart.setSyncedCrosshair).toHaveBeenCalledTimes(1);
      expect(s.chart.setSyncedCrosshair).toHaveBeenCalledWith({
        time: 300,
        interval: '1D',
        timezone: 'America/New_York',
        price: 3,
      });
    }
    // The next frame is scheduled again.
    bus.crosshair('c1', xh(400));
    expect(frames).toHaveLength(1);
  });

  it('omits the price across symbols', () => {
    const { sessions, bus, frame } = setup();
    sessions[2]!.view.getState().setSymbol('MSFT');
    bus.crosshair('c1', xh(100, 55));
    frame();
    expect(sessions[1]!.chart.setSyncedCrosshair).toHaveBeenCalledWith(
      expect.objectContaining({ price: 55 }),
    );
    expect(sessions[2]!.chart.setSyncedCrosshair).toHaveBeenCalledWith(
      expect.objectContaining({ price: null, time: 100 }),
    );
  });

  it('clears the others when the pointer leaves', () => {
    const { sessions, bus, frame } = setup();
    bus.crosshair('c1', xh(null, null));
    frame();
    expect(sessions[1]!.chart.setSyncedCrosshair).toHaveBeenLastCalledWith(null);
    bus.crosshair('c1', null);
    frame();
    expect(sessions[2]!.chart.setSyncedCrosshair).toHaveBeenCalledTimes(2);
    expect(sessions[2]!.chart.setSyncedCrosshair).toHaveBeenLastCalledWith(null);
  });

  it('does nothing with the flag off', () => {
    const { sessions, bus, frames } = setup({ crosshair: false });
    bus.crosshair('c1', xh(100));
    expect(frames).toHaveLength(0);
    expect(sessions[1]!.chart.setSyncedCrosshair).not.toHaveBeenCalled();
  });

  it('survives an interval the engine rejects', () => {
    const { sessions, bus, frame } = setup();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessions[1]!.chart.setSyncedCrosshair.mockImplementationOnce(() => {
      throw new Error('bad interval');
    });
    bus.crosshair('c1', xh(100));
    frame();
    expect(sessions[2]!.chart.setSyncedCrosshair).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('clearCrosshairs and drop remove mirrored crosshairs and pending work', () => {
    const { sessions, bus, frame } = setup();
    bus.crosshair('c1', xh(100));
    bus.drop('c1');
    expect(sessions[1]!.chart.setSyncedCrosshair).toHaveBeenCalledWith(null);
    expect(sessions[0]!.chart.setSyncedCrosshair).not.toHaveBeenCalled();
    frame();
    expect(sessions[1]!.chart.setSyncedCrosshair).toHaveBeenCalledTimes(1);
    bus.clearCrosshairs();
    expect(sessions[0]!.chart.setSyncedCrosshair).toHaveBeenCalledWith(null);
  });
});

describe('time', () => {
  it('moves the others to the right edge only with time sync, once per frame', () => {
    const on = setup({ time: true });
    on.bus.view('c1', 1000);
    on.bus.view('c1', 2000);
    on.frame();
    expect(on.sessions[0]!.chart.setRightEdgeTime).not.toHaveBeenCalled();
    for (const s of on.sessions.slice(1)) {
      expect(s.chart.setRightEdgeTime).toHaveBeenCalledTimes(1);
      expect(s.chart.setRightEdgeTime).toHaveBeenCalledWith(2000);
    }
    const off = setup();
    off.bus.view('c1', 1000);
    off.frame();
    expect(off.sessions[1]!.chart.setRightEdgeTime).not.toHaveBeenCalled();
  });
});

describe('date range', () => {
  it('applies to one chart without the flag and to all with it', async () => {
    const off = setup();
    await off.bus.range('c2', { from: 1, to: 9 });
    expect(off.sessions[1]!.chart.setVisibleTimeRange).toHaveBeenCalledWith(1, 9);
    expect(off.sessions[0]!.chart.setVisibleTimeRange).not.toHaveBeenCalled();

    const on = setup({ dateRange: true });
    await on.bus.range('c1', { from: 1, to: Infinity });
    for (const s of on.sessions)
      expect(s.chart.setVisibleTimeRange).toHaveBeenCalledWith(1, Infinity);
    await on.bus.range('c1', 'all');
    for (const s of on.sessions) expect(s.chart.showAllHistory).toHaveBeenCalledTimes(1);
    await on.bus.goTo('c3', 77);
    for (const s of on.sessions) expect(s.chart.scrollToTime).toHaveBeenCalledWith(77);
  });
});
