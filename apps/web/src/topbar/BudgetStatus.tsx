import { CircleAlert } from 'lucide-react';
import { useProviderName, useUsage, type Usage } from '../api/provider';
import { translate } from '../i18n';
import { useNow } from '../sidebar/hooks';
import { useUiStore } from '../store/ui';

export interface BudgetNotice {
  kind: 'throttled' | 'exhausted';
  text: string;
}

/** Local time of day ("14:05"); another day gets its weekday ("Wed 02:00"). */
export function formatResetTime(at: Date, now: Date, locale?: string): string {
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay ? time : `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
}

/**
 * What to tell the user about the provider's budget, or null while it is fine.
 * "Exhausted" names the daily reset (local time); "throttled" the moment the
 * per-minute allowance is back. `locale` is the UI locale (`useUiStore.locale`).
 */
export function budgetNotice(
  usage: Usage | null,
  provider: string,
  now: Date,
  locale = 'en',
): BudgetNotice | null {
  if (!usage || usage.state === 'ok') return null;
  const resetAt =
    usage.state === 'exhausted' && usage.daily
      ? new Date(usage.daily.resetAt)
      : new Date(now.getTime() + usage.retryAfterS * 1000);
  const time = formatResetTime(Number.isNaN(resetAt.getTime()) ? now : resetAt, now);
  return {
    kind: usage.state,
    text: translate(locale, usage.state === 'exhausted' ? 'budget.exhausted' : 'budget.throttled', {
      provider,
      time,
    }),
  };
}

/** Presentational chip: the notice's text next to an alert icon (the text folds away on narrow bars). */
export function BudgetChip({ notice }: { notice: BudgetNotice }) {
  return (
    <div
      className={`tb-budget ${notice.kind}`}
      role="status"
      aria-label={notice.text}
      data-tip={notice.text}
      data-tip-side="bottom"
    >
      <CircleAlert size={16} aria-hidden="true" />
      <span className="tb-label tb-collapsible">{notice.text}</span>
    </div>
  );
}

/**
 * Top bar chip, shown only while the data provider's credits are throttled or used up.
 * Usage is polled (once a minute) only for metered providers.
 */
export function BudgetStatus() {
  const locale = useUiStore((s) => s.locale);
  const usage = useUsage();
  const provider = useProviderName();
  const now = useNow(60_000);
  const notice = budgetNotice(usage, provider, new Date(now), locale);
  return notice ? <BudgetChip notice={notice} /> : null;
}
