import type { ReactNode } from 'react';
import { useT } from '../../i18n';
import { CLASS_LABEL } from '../model';
import { SCREENER_CLASSES, type ScreenerClass, type Universe } from '../universe/types';

interface Props {
  /** `null`: another universe (a list, watchlist or symbols) is scanned, no class is active. */
  active: ScreenerClass | null;
  onPick: (cls: ScreenerClass) => void;
  /** Loaded universes, for per-class symbol counts. */
  loaded: Partial<Record<ScreenerClass, Universe>>;
  /** Extra controls after the tabs (the server screener's list / symbols picker). */
  children?: ReactNode;
}

/** The asset-class tab strip of the screener screen. */
export function ClassTabs({ active, onPick, loaded, children }: Props) {
  const t = useT();
  return (
    <div className="scr-tabs" role="tablist" aria-label={t('scr.title')} data-testid="scr-tabs">
      {SCREENER_CLASSES.map((cls) => {
        const count = loaded[cls]?.symbols.length;
        return (
          <button
            key={cls}
            type="button"
            role="tab"
            id={`scr-tab-${cls}`}
            aria-selected={cls === active}
            aria-controls="scr-panel"
            data-testid={`scr-tab-${cls}`}
            className={`scr-tab${cls === active ? ' on' : ''}`}
            onClick={() => onPick(cls)}
          >
            {CLASS_LABEL[cls]}
            {count !== undefined ? <span className="scr-tab-count rs-num">{count}</span> : null}
          </button>
        );
      })}
      {children}
    </div>
  );
}
