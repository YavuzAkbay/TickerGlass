import { describe, expect, it, vi } from 'vitest';
import type { AiStatus } from './api';
import { ask, isAsking } from './chat';
import { useAiChat } from './store';

const chart = {
  getSymbol: () => 'AAPL',
  getInterval: () => '1D',
  timezone: 'UTC',
  store: { length: 1, time: [1_700_000_000] },
};

vi.mock('../store/chart', () => ({
  getActiveSession: () => ({ id: 'c1', chart }),
  // Throws between the claim on the chart and the answer's own try/finally.
  runInSession: () => {
    throw new Error('session gone');
  },
}));
vi.mock('./context', () => ({
  visibleFocus: () => ({ kind: 'visible', from: 0, to: 1 }),
  briefBudget: () => 1000,
  briefFromChart: () => ({ text: 'brief', approxTokens: 1, trimmed: false, stats: null }),
}));

const status = {
  enabled: true,
  models: [{ name: 'm', vision: false, tools: false, tier: 'basic' }],
  defaultModel: 'm',
} as unknown as Extract<AiStatus, { enabled: true }>;

describe('ask', () => {
  it('releases the chart when something throws after it was claimed', async () => {
    await expect(ask('why?', { status })).rejects.toThrow('session gone');
    expect(isAsking('c1')).toBe(false);
    expect(useAiChat.getState().asking).toEqual({});
  });
});
