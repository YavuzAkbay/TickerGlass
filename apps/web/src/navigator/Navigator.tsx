import { ChevronsLeft, PencilRuler, Plus, X } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import { useReplayStore } from '../replay/store';
import { DEFAULT_NAV_WIDTH, MAX_NAV_WIDTH, MIN_NAV_WIDTH, useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { useIsMobile } from '../ui/useMediaQuery';
import '../sidebar/sidebar.css';
import { DeskButton } from '../desk/DeskButton';
import { NavRail } from './NavRail';
import { SECTIONS } from './sections';
import './navigator.css';

const KEY_STEP = 16;

/** Phones: hide the sheet without touching the synced desktop `navOpen` preference. */
const closeSheet = () => useUiStore.getState().set({ navSheet: false });

/**
 * Left-hand navigator: an always-visible rail plus a resizable, collapsible section panel.
 * Phones (useIsMobile): the rail becomes the bottom tab bar (with the drawing tools toggle)
 * and the panel a bottom sheet over the chart, closed by its scrim or Escape.
 */
export function Navigator() {
  const t = useT();
  const mobile = useIsMobile();
  const toolsOpen = useUiStore((s) => s.mobileToolsOpen);
  const navOpen = useUiStore((s) => (mobile ? s.navSheet : s.navOpen));
  const navSection = useUiStore((s) => s.navSection);
  const width = useUiStore((s) => s.navWidth);
  const setNavWidth = useUiStore((s) => s.setNavWidth);
  const replaying = useReplayStore((s) => s.status !== 'off');
  const drag = useRef<{ x: number; w: number } | null>(null);

  const sections = SECTIONS.filter((s) => s.id !== 'replayTrading' || replaying);
  const def = sections.find((s) => s.id === navSection) ?? sections[0];
  const open = navOpen && !!def;
  const sheet = mobile && open;

  // The sheet closes on Escape (anything with its own Escape handling goes first).
  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (useUiStore.getState().dialog) return;
      if ((e.target as Element | null)?.closest?.('[data-own-escape], .io-popover')) return;
      e.preventDefault();
      closeSheet();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

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
        <NavRail
          sections={sections}
          active={open ? def.id : null}
          orientation={mobile ? 'horizontal' : 'vertical'}
        />
        {mobile ? (
          <div className="nav-draw-slot">
            <button
              type="button"
              className={`nav-tab nav-draw${toolsOpen ? ' active' : ''}`}
              aria-label={t('rail.drawingTools')}
              aria-pressed={toolsOpen}
              onClick={() => useUiStore.getState().toggleMobileTools()}
            >
              <PencilRuler size={18} strokeWidth={1.6} />
            </button>
          </div>
        ) : null}
      </div>
      {sheet ? (
        <div className="sheet-scrim nav-scrim" aria-hidden="true" onClick={closeSheet} />
      ) : null}
      {open ? (
        <section
          className={`nav-panel${sheet ? ' sheet' : ''}`}
          id="nav-panel"
          role="tabpanel"
          aria-labelledby={`nav-tab-${def.id}`}
          style={mobile ? undefined : { width }}
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
                icon={mobile ? X : ChevronsLeft}
                label={t('nav.collapse')}
                className="rs-head-btn"
                onClick={() => (mobile ? closeSheet() : useUiStore.getState().setNavOpen(false))}
              />
            </div>
          </header>
          <div className="nav-body" key={def.id}>
            {def.render()}
          </div>
          {mobile ? null : (
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
          )}
        </section>
      ) : null}
    </nav>
  );
}
