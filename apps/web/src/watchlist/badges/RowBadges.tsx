import { Bell, BellRing, StickyNote } from 'lucide-react';
import { memo, type MouseEvent } from 'react';
import { commands } from '../../commands/registry';
import { useT, type MessageKey } from '../../i18n';
import { useQuoteMissing, useStreamStatus } from '../../quotes/hooks';
import type { LiveQuote } from '../../quotes/types';
import { useUiStore } from '../../store/ui';
import { useSymbolAlertCount, useSymbolHasNote } from './counts';
import { quoteFreshness, type Freshness } from './freshness';
import { useNow } from './useNow';
import './badges.css';

/** Letter shown beside the dot so state is never colour-only. Live shows nothing. */
const LETTER: Record<Exclude<Freshness, 'live'>, string> = {
  delayed: 'D',
  stale: 'S',
  closed: 'C',
  pre: 'Pre',
  post: 'Post',
  missing: '!',
  unknown: '?',
};

const LABEL: Record<Exclude<Freshness, 'live'>, MessageKey> = {
  delayed: 'badge.delayed',
  stale: 'badge.stale',
  closed: 'badge.closed',
  pre: 'badge.pre',
  post: 'badge.post',
  missing: 'badge.missing',
  unknown: 'badge.unknown',
};

const stop = (e: MouseEvent) => e.stopPropagation();

function openAlerts(e: MouseEvent): void {
  e.stopPropagation();
  useUiStore.getState().showNav('alerts');
}

function openNote(e: MouseEvent, symbol: string): void {
  e.stopPropagation();
  commands.execute('notes.openForSymbol', { symbol });
}

interface Props {
  symbol: string;
  quote: LiveQuote | undefined;
  /** Dot-only mode for narrow rows. */
  compact?: boolean | undefined;
  /** States to stay silent about (e.g. `['delayed']` where most rows are HTTP-polled). */
  hide?: readonly Freshness[] | undefined;
}

interface ViewProps {
  symbol: string;
  active: number;
  triggered: number;
  hasNote: boolean;
  fresh: Freshness;
  /** A quote exists (before the first one, "unknown" stays quiet). */
  hasQuote: boolean;
  compact?: boolean | undefined;
  hide?: readonly Freshness[] | undefined;
}

/** Alert / note / freshness indicators for a symbol row. Renders nothing when there is nothing to say. */
export const RowBadges = memo(function RowBadges({ symbol, quote, compact, hide }: Props) {
  const { active, triggered } = useSymbolAlertCount(symbol);
  const hasNote = useSymbolHasNote(symbol);
  const streamStatus = useStreamStatus();
  const missing = useQuoteMissing(symbol);
  const now = useNow();
  const fresh = quoteFreshness(quote, now, {
    streamStatus,
    missing,
    updatedMs: quote?.snapshotMs,
  });
  return (
    <RowBadgesView
      symbol={symbol}
      active={active}
      triggered={triggered}
      hasNote={hasNote}
      fresh={fresh}
      hasQuote={!!quote}
      compact={compact}
      hide={hide}
    />
  );
});

/** The presentational part of `RowBadges` (separate so it renders without stores). */
export const RowBadgesView = memo(function RowBadgesView({
  symbol,
  active,
  triggered,
  hasNote,
  fresh,
  hasQuote,
  compact,
  hide,
}: ViewProps) {
  const t = useT();
  // Nothing is known about a symbol until its first quote: stay quiet, not "?".
  const showFresh =
    fresh !== 'live' && !(fresh === 'unknown' && !hasQuote) && !hide?.includes(fresh);
  const alerts = active + triggered;
  if (!alerts && !hasNote && !showFresh) return null;

  const freshLabel = fresh === 'live' ? '' : t(LABEL[fresh]);
  const alertLabel = triggered
    ? t('badge.alertsTriggered', { symbol, active, triggered })
    : t('badge.alerts', { symbol, count: active });

  const groupLabel = [
    alerts > 0 ? alertLabel : '',
    hasNote && !compact ? t('badge.note', { symbol }) : '',
    showFresh ? freshLabel : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <span
      role="group"
      className={`rb${compact ? ' rb-compact' : ''}`}
      data-testid={`rb-${symbol}`}
      aria-label={groupLabel}
    >
      {alerts > 0 &&
        (compact ? (
          <span
            className={`rb-dot rb-dot-alert${triggered ? ' rb-triggered' : ''}`}
            aria-hidden="true"
            title={alertLabel}
          />
        ) : (
          <button
            type="button"
            className={`rb-btn rb-alert${triggered ? ' rb-triggered' : ''}`}
            aria-label={alertLabel}
            title={alertLabel}
            onClick={openAlerts}
            onDoubleClick={stop}
          >
            {triggered ? (
              <BellRing size={11} aria-hidden="true" />
            ) : (
              <Bell size={11} aria-hidden="true" />
            )}
            <span className="rb-count">{alerts}</span>
          </button>
        ))}
      {hasNote && !compact && (
        <button
          type="button"
          className="rb-btn rb-note"
          aria-label={t('badge.openNote', { symbol })}
          title={t('badge.openNote', { symbol })}
          data-testid={`rb-note-${symbol}`}
          onClick={(e) => openNote(e, symbol)}
          onDoubleClick={stop}
        >
          <StickyNote size={11} aria-hidden="true" />
        </button>
      )}
      {showFresh && (
        <span className={`rb-fresh rb-${fresh}`} aria-hidden="true" title={freshLabel}>
          <span className="rb-fdot" aria-hidden="true" />
          {!compact && (
            <span className="rb-letter" aria-hidden="true">
              {LETTER[fresh]}
            </span>
          )}
        </span>
      )}
    </span>
  );
});
