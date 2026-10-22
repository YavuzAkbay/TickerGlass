import { ChevronsLeft, Plus } from 'lucide-react';
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import { useReplayStore } from '../replay/store';
import { DEFAULT_NAV_WIDTH, MAX_NAV_WIDTH, MIN_NAV_WIDTH, useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import '../sidebar/sidebar.css';
import { DeskButton } from '../desk/DeskButton';
import { NavRail } from './NavRail';
import { SECTIONS } from './sections';
import './navigator.css';

const KEY_STEP = 16;

/** Left-hand navigator: an always-visible rail plus a resizable, collapsible section panel. */
export function Navigator() {
  const t = useT();
  const navOpen = useUiStore((s) => s.navOpen);
  const navSection = useUiStore((s) => s.navSection);
  const width = useUiStore((s) => s.navWidth);
  const setNavWidth = useUiStore((s) => s.setNavWidth);
  const replaying = useReplayStore((s) => s.status !== 'off');
  const drag = useRef<{ x: number; w: number } | null>(null);

  const sections = SECTIONS.filter((s) => s.id !== 'replayTrading' || replaying);
  const def = sections.find((s) => s.id === navSection) ?? sections[0];
  const open = navOpen && !!def;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) setNavWidth(drag.current.w + e.clientX - drag.current.x);
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') setNavWidth(width - KEY_STEP);
    else if (e.key === 'ArrowRight') setNavWidth(width + KEY_STEP);
    else return;
    e.preventDefault();
  };

  return (
    <nav className={`navigator${open ? ' open' : ''}`} aria-label={t('nav.panels')}>
      <div className="nav-rail-col">
        <div className="nav-desk-slot">
          <DeskButton />
        </div>
        <NavRail sections={sections} active={open ? def.id : null} />
      </div>
      {open ? (
        <section
          className="nav-panel"
          id="nav-panel"
          role="tabpanel"
          aria-labelledby={`nav-tab-${def.id}`}
          style={{ width }}
        >
          <header className="nav-head">
            <h2 className="nav-title">{t(def.title)}</h2>
            <div className="nav-actions">
              {def.id === 'watchlist' ? (
                <IconButton
                  icon={Plus}
                  label={t('nav.addSymbol')}
                  className="rs-head-btn"
                  onClick={() => commands.execute('watchlist.searchAdd')}
                />
              ) : null}
              {def.id === 'alerts' ? (
                <IconButton
                  icon={Plus}
                  label={t('topbar.alert')}
                  className="rs-head-btn"
                  onClick={() => commands.execute('alert.create', {})}
                />
              ) : null}
              <IconButton
                icon={ChevronsLeft}
                label={t('nav.collapse')}
                className="rs-head-btn"
                onClick={() => useUiStore.getState().setNavOpen(false)}
              />
            </div>
          </header>
          <div className="nav-body" key={def.id}>
            {def.render()}
          </div>
          <div
            className="nav-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('nav.resize')}
            aria-valuenow={width}
            aria-valuemin={MIN_NAV_WIDTH}
            aria-valuemax={MAX_NAV_WIDTH}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => setNavWidth(DEFAULT_NAV_WIDTH)}
            onKeyDown={onResizeKey}
          />
        </section>
      ) : null}
    </nav>
  );
}
