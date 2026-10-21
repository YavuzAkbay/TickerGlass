import { type KeyboardEvent } from 'react';
import { useAlerts } from '../alerts/store';
import { useT } from '../i18n';
import { useUiStore } from '../store/ui';
import type { SectionDef } from './sections';

interface Props {
  sections: SectionDef[];
  /** Section whose panel is open, or null while collapsed. */
  active: string | null;
}

/** Vertical tablist: one icon button per section; always visible. */
export function NavRail({ sections, active }: Props) {
  const t = useT();
  const unread = useAlerts((s) => s.unread);
  const toggleNav = useUiStore((s) => s.toggleNav);

  /** Up/Down/Home/End move between tabs; an open panel follows the focused tab. */
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = sections.length - 1;
    const next =
      e.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1;
    const target = sections[next];
    if (!target) return;
    e.preventDefault();
    if (active) useUiStore.getState().showNav(target.id);
    // Focus after the roving tabindex has moved with the selection.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`#nav-tab-${target.id}`)?.focus(),
    );
  };

  return (
    <div
      className="nav-rail"
      role="tablist"
      aria-label={t('nav.panels')}
      aria-orientation="vertical"
    >
      {sections.map((s, i) => {
        const Icon = s.icon;
        const selected = active === s.id;
        const label = t(s.title);
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`nav-tab-${s.id}`}
            className={`nav-tab${selected ? ' active' : ''}`}
            aria-label={label}
            aria-selected={selected}
            aria-controls={selected ? 'nav-panel' : undefined}
            tabIndex={selected || (!active && i === 0) ? 0 : -1}
            data-panel={s.id}
            data-tip={label}
            data-tip-side="right"
            onClick={() => toggleNav(s.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <Icon size={18} strokeWidth={1.6} />
            {s.id === 'alerts' && unread ? (
              <span
                className="rs-badge rs-icon-badge"
                aria-label={t('nav.unread', { count: unread })}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
