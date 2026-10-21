import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ChartMarker } from '@tickerglass/engine';
import type { EventsResponse } from './api';
import { attachEvents, buildEventMarkers, splitLabel } from './attach';
import { useReplayStore } from '../replay/store';
import { DEFAULT_EVENT_PREFS, parseEventPrefs, useEventPrefs } from './prefs';

const fetchEvents = vi.fn<(symbol: string) => Promise<EventsResponse>>();
vi.mock('./api', () => ({ fetchEvents: (s: string) => fetchEvents(s) }));

const DATA: EventsResponse = {
  dividends: [{ t: 1000, amount: 0.24 }],
  splits: [
    { t: 2000, ratio: 4 },
    { t: 2100, ratio: 0.5 },
  ],
  earnings: [
    { t: 3000, epsEstimate: 1.2, epsActual: 1.3, surprisePercent: 8.33333 },
    { t: 9_999_999_999, epsEstimate: 2 },
  ],
};

describe('buildEventMarkers', () => {
  it('builds D, S and E badges below the bars with tooltips', () => {
    const m = buildEventMarkers(DATA, DEFAULT_EVENT_PREFS, Infinity, 5000);
    expect(m.map((x) => x.text)).toEqual(['D', 'S', 'S', 'E', 'E']);
    expect(m.every((x) => x.position === 'paneBottom' && x.shape === 'letter')).toBe(true);
    expect(m.map((x) => x.tooltip)).toEqual([
      'Dividend 0.24',
      'Split 4:1',
      'Split 1:2',
      'Earnings · estimate 1.2 · actual 1.3 · surprise +8.3333%',
      'Earnings (upcoming) · estimate 2',
    ]);
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);
  });

  it('honours the per-type toggles', () => {
    const only = (k: 'dividends' | 'splits' | 'earnings') => ({
      dividends: false,
      splits: false,
      earnings: false,
      [k]: true,
    });
    expect(buildEventMarkers(DATA, only('dividends'))).toHaveLength(1);
    expect(buildEventMarkers(DATA, only('splits'))).toHaveLength(2);
    expect(buildEventMarkers(DATA, only('earnings'))).toHaveLength(2);
  });

  it('hides events at or after the replay clock', () => {
    const m = buildEventMarkers(DATA, DEFAULT_EVENT_PREFS, 2000);
    expect(m.map((x) => x.id)).toEqual(['div-1000']);
  });

  it('skips malformed rows and empty data', () => {
    expect(buildEventMarkers(null, DEFAULT_EVENT_PREFS)).toEqual([]);
    const bad = {
      splits: [
        { t: 1, ratio: 0 },
        { t: 2, ratio: null },
      ],
      dividends: [{ t: NaN, amount: 1 }],
    };
    expect(buildEventMarkers(bad, DEFAULT_EVENT_PREFS)).toEqual([]);
  });
});

describe('splitLabel', () => {
  it('writes new:old', () => {
    expect(splitLabel(2)).toBe('2:1');
    expect(splitLabel(0.1)).toBe('1:10');
  });
});

describe('parseEventPrefs', () => {
  it('keeps only booleans', () => {
    expect(parseEventPrefs({ dividends: false, splits: 1, earnings: true, x: 1 })).toEqual({
      dividends: false,
      earnings: true,
    });
    expect(parseEventPrefs(null)).toEqual({});
  });
});

describe('attachEvents', () => {
  afterEach(() => {
    useEventPrefs.setState(DEFAULT_EVENT_PREFS);
    fetchEvents.mockReset();
  });

  const setup = (symbol: string, id = 'c1') => {
    const calls: ChartMarker[][] = [];
    const chart = { setMarkers: (_g: string, m: ChartMarker[]) => calls.push(m) };
    const view = createStore(() => ({ symbol }));
    const off = attachEvents({ id, chart, view } as unknown as Parameters<typeof attachEvents>[0]);
    return { calls, view, off };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('sets markers after the fetch, reacts to toggles and clears on dispose', async () => {
    fetchEvents.mockResolvedValue(DATA);
    const { calls, off } = setup('AAPL');
    await flush();
    expect(calls.at(-1)).toHaveLength(5);
    useEventPrefs.getState().set({ earnings: false });
    expect(calls.at(-1)).toHaveLength(3);
    off();
    expect(calls.at(-1)).toEqual([]);
  });

  it('applies the replay clock only on the replay chart', async () => {
    fetchEvents.mockResolvedValue(DATA);
    const replaying = setup('AAPL', 'r');
    const other = setup('AAPL', 'o');
    await flush();
    const all = replaying.calls.at(-1)!.length;
    expect(all).toBeGreaterThan(0);
    useReplayStore.getState().set({ status: 'paused', next: 0, chartId: 'r' });
    expect(replaying.calls.at(-1)).toHaveLength(0);
    expect(other.calls.at(-1)).toHaveLength(all);
    useReplayStore.getState().set({ status: 'off', next: Number.NaN, chartId: null });
    replaying.off();
    other.off();
  });

  it('does not fetch for expressions and ignores stale responses', async () => {
    const { calls, off } = setup('AAPL/MSFT');
    await flush();
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(calls.at(-1)).toEqual([]);
    off();
  });
});
