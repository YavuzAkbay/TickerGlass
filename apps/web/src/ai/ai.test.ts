import { describe, expect, it } from 'vitest';
import { apiMessages, OMITTED_CONTEXT, resolveModel } from './chat';
import { briefBudget } from './context';
import { parseBlocks } from './Markdown';
import { parseAiPrefs, type UiMessage } from './store';

const ctx = { label: 'x', text: 'CHART CONTEXT', tokens: 10, trimmed: [], images: 0 };

describe('apiMessages', () => {
  it('sends only the latest context in full and skips empty answers', () => {
    const msgs: UiMessage[] = [
      {
        id: '1',
        role: 'user',
        text: 'q1',
        content: 'B1\n\nQuestion: q1',
        context: ctx,
        images: ['A'],
      },
      { id: '2', role: 'assistant', text: 'a1', content: '' },
      { id: '3', role: 'user', text: 'q2', content: 'q2' },
      { id: '4', role: 'assistant', text: '', content: '', status: 'error' },
      {
        id: '5',
        role: 'user',
        text: 'q3',
        content: 'B2\n\nQuestion: q3',
        context: ctx,
        images: ['B'],
      },
    ];
    expect(apiMessages(msgs)).toEqual([
      { role: 'user', content: `${OMITTED_CONTEXT}\n\nq1` },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'user', content: 'B2\n\nQuestion: q3', images: ['B'] },
    ]);
  });
});

describe('apiMessages with tools', () => {
  it('keeps tool calls and results in order', () => {
    const msgs: UiMessage[] = [
      { id: '1', role: 'user', text: 'q', content: 'q' },
      {
        id: '2',
        role: 'assistant',
        text: '',
        content: '',
        status: 'done',
        toolCalls: [{ name: 'find_divergences', arguments: { oscillator: 'rsi' } }],
      },
      {
        id: '3',
        role: 'tool',
        text: 'Found 1',
        content: '{"divergences":[]}',
        toolName: 'find_divergences',
      },
      { id: '4', role: 'assistant', text: 'None found.', content: '' },
    ];
    expect(apiMessages(msgs)).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'find_divergences', arguments: { oscillator: 'rsi' } }],
      },
      { role: 'tool', content: '{"divergences":[]}', tool_name: 'find_divergences' },
      { role: 'assistant', content: 'None found.' },
    ]);
  });
});

describe('resolveModel', () => {
  const status = {
    enabled: true as const,
    provider: 'ollama',
    reachable: true,
    error: null,
    numCtx: 8192,
    maxImageBytes: 1,
    defaultModel: 'b',
    models: ['a', 'b'].map((name) => ({
      name,
      vision: false,
      tools: false,
      parameterSize: null,
      sizeBytes: null,
    })),
  };
  it('prefers the saved model, then the default', () => {
    expect(resolveModel(status, 'a')?.name).toBe('a');
    expect(resolveModel(status, 'gone')?.name).toBe('b');
    expect(resolveModel({ ...status, models: [] }, 'a')).toBeNull();
  });
});

describe('briefBudget', () => {
  it('leaves room for the answer', () => {
    expect(briefBudget(8192)).toBe(Math.floor((8192 - 2500) * 0.7));
    expect(briefBudget(2048)).toBe(800);
    // With tools: room for definitions, results and reasoning; at most 35% of the window.
    expect(briefBudget(16384, true)).toBe(Math.floor(Math.min((16384 - 7000) * 0.7, 16384 * 0.35)));
    expect(briefBudget(8192, true)).toBe(834);
  });
});

describe('parseAiPrefs', () => {
  it('keeps valid fields only', () => {
    expect(parseAiPrefs({ model: 'm', includeImage: 'yes', allowActions: false })).toEqual({
      model: 'm',
      allowActions: false,
    });
    expect(parseAiPrefs(null)).toEqual({});
  });
});

describe('markdown', () => {
  it('parses blocks', () => {
    const blocks = parseBlocks(
      [
        '## Trend',
        'Price rose **5%** over',
        'ten bars.',
        '',
        '- support 100',
        '- resistance 110',
        '1. first',
        '2) second',
        '```',
        'code <b>',
        '```',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '> quoted',
        '---',
      ].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'h', level: 2, text: 'Trend' },
      { kind: 'p', lines: ['Price rose **5%** over', 'ten bars.'] },
      { kind: 'ul', items: ['support 100', 'resistance 110'] },
      { kind: 'ol', items: ['first', 'second'] },
      { kind: 'code', text: 'code <b>' },
      {
        kind: 'table',
        rows: [
          ['a', 'b'],
          ['1', '2'],
        ],
      },
      { kind: 'quote', lines: ['quoted'] },
      { kind: 'hr' },
    ]);
  });

  it('handles an unterminated code fence while streaming', () => {
    expect(parseBlocks('```\npartial')).toEqual([{ kind: 'code', text: 'partial' }]);
  });
});

describe('fitSize', () => {
  it('scales the longest side down, never up', async () => {
    const { fitSize } = await import('./image');
    expect(fitSize(2560, 1440, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitSize(600, 1600, 800)).toEqual({ width: 300, height: 800 });
    expect(fitSize(400, 300, 1280)).toEqual({ width: 400, height: 300 });
  });
});

describe('parseBarTime', () => {
  it('maps brief dates, date-times and unix seconds to bars', async () => {
    const { parseBarTime } = await import('./tools');
    const DAY = 86_400;
    const t0 = Date.UTC(2026, 7, 3) / 1000; // 2026-08-03 00:00 UTC
    const time = Float64Array.from({ length: 10 }, (_, i) => t0 + i * DAY);
    const chart = { timezone: 'UTC', store: { length: 10, time } } as unknown as Parameters<
      typeof parseBarTime
    >[0];
    expect(parseBarTime(chart, '2026-08-05')).toBe(t0 + 2 * DAY);
    expect(parseBarTime(chart, String(t0 + 3 * DAY + 100))).toBe(t0 + 3 * DAY);
    expect(parseBarTime(chart, '2026-07-01')).toBe(t0); // before the data: first bar
    expect(parseBarTime(chart, 'not a date')).toBeNull();
    expect(parseBarTime(chart, '')).toBeNull();
  });
});
