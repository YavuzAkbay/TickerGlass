import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Usage } from '../api/provider';
import { BudgetChip, budgetNotice, formatResetTime } from './BudgetStatus';

const NOW = new Date('2026-10-27T10:00:00Z');

const usage = (over: Partial<Usage> = {}): Usage => ({
  plan: 'basic',
  metered: true,
  minute: { limit: 8, left: 8 },
  daily: { limit: 800, used: 100, resetAt: '2026-10-28T00:00:00Z' },
  state: 'ok',
  retryAfterS: 0,
  ...over,
});

describe('budgetNotice', () => {
  it('is silent while the budget is fine or unknown', () => {
    expect(budgetNotice(null, 'Twelve Data', NOW)).toBeNull();
    expect(budgetNotice(usage(), 'Twelve Data', NOW)).toBeNull();
  });

  it('names the provider and the local reset time when credits are exhausted', () => {
    const n = budgetNotice(
      usage({
        state: 'exhausted',
        retryAfterS: 50_000,
        daily: { limit: 800, used: 800, resetAt: '2026-10-28T00:00:00Z' },
      }),
      'Twelve Data',
      NOW,
    );
    expect(n?.kind).toBe('exhausted');
    const reset = formatResetTime(new Date('2026-10-28T00:00:00Z'), NOW);
    expect(n?.text).toBe(`Twelve Data credits exhausted: showing cached data until ${reset}`);
    expect(reset).toMatch(/\d{1,2}:\d{2}/);
  });

  it('says how long a throttle lasts', () => {
    const n = budgetNotice(usage({ state: 'throttled', retryAfterS: 30 }), 'Twelve Data', NOW);
    expect(n?.kind).toBe('throttled');
    expect(n?.text).toContain('Twelve Data request limit reached');
    expect(n?.text).toContain(formatResetTime(new Date(NOW.getTime() + 30_000), NOW));
  });

  it('falls back to a wait from now when the reset time is unusable', () => {
    const n = budgetNotice(
      usage({ state: 'exhausted', retryAfterS: 60, daily: { limit: 1, used: 1, resetAt: 'soon' } }),
      'Twelve Data',
      NOW,
    );
    expect(n?.text).toContain('credits exhausted');
    expect(n?.text).not.toContain('Invalid');
  });
});

describe('formatResetTime', () => {
  it('adds the weekday when the time is on another day', () => {
    const now = new Date(2026, 9, 27, 10, 0);
    const sameDay = formatResetTime(new Date(2026, 9, 27, 23, 30), now, 'en-US');
    const nextDay = formatResetTime(new Date(2026, 9, 28, 1, 5), now, 'en-US');
    expect(sameDay).toBe('11:30 PM');
    expect(nextDay).toBe('Wed 01:05 AM');
  });
});

describe('BudgetChip', () => {
  it('renders the notice as a status with the full text', () => {
    const n = budgetNotice(usage({ state: 'exhausted', retryAfterS: 600 }), 'Twelve Data', NOW);
    if (!n) throw new Error('expected a notice');
    const html = renderToStaticMarkup(<BudgetChip notice={n} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('tb-budget exhausted');
    expect(html).toContain('Twelve Data credits exhausted');
  });

  it('marks a throttle differently from an exhaustion', () => {
    const n = budgetNotice(usage({ state: 'throttled', retryAfterS: 10 }), 'Yahoo', NOW);
    if (!n) throw new Error('expected a notice');
    expect(renderToStaticMarkup(<BudgetChip notice={n} />)).toContain('tb-budget throttled');
  });
});
