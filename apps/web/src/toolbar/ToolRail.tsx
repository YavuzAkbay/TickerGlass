import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { commands, formatShortcut } from '../commands/registry';
import { useT } from '../i18n';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { Popover } from '../ui/Popover';
import {
  HIDE_MODES,
  toHideMode,
  registerToolbarCommands,
  setHideMode,
  setMagnet,
  type HideMode,
} from './commands';
import {
  categoryOf,
  DOCK_CATEGORIES,
  dockTools,
  filterSections,
  quickTools,
  type DockCategory,
} from './dock';
import { closeQuickTools, useQuickTools } from './quick';
import { FavoritesBar } from './FavoritesBar';
import * as I from './icons';
import {
  findTool,
  groupOf,
  ICON_TABS,
  isToolAvailable,
  selectTool,
  TOOL_GROUPS,
  toggleFavorite,
  UNAVAILABLE_HINT,
  type ToolDef,
  type ToolSection,
} from './tools';
import './toolbar.css';

interface SplitProps {
  label: string;
  shortcut?: string | undefined;
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  /** Flyout content; receives a close callback. */
  flyout: (close: () => void) => ReactNode;
  flyoutLabel: string;
  /** No drawing definition yet: dimmed, click shows a hint. */
  unavailable?: boolean;
}

/** 40x40 rail button with a hover corner arrow that opens a flyout. */
function SplitButton({
  label,
  shortcut,
  active,
  icon,
  onClick,
  flyout,
  flyoutLabel,
  unavailable,
}: SplitProps) {
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div ref={setWrap} className={`lt-group${open ? ' open' : ''}`}>
      <IconButton
        label={unavailable ? `${label} (${UNAVAILABLE_HINT.toLowerCase()})` : label}
        {...(shortcut && !unavailable ? { shortcut } : {})}
        tipSide="left"
        active={active}
        className={`lt-btn${unavailable ? ' unavailable' : ''}`}
        onClick={() => {
          setOpen(false);
          onClick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {icon}
      </IconButton>
      <button
        type="button"
        className="lt-arrow"
        aria-label={flyoutLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="5" height="5" viewBox="0 0 5 5" aria-hidden="true">
          <path d="M5 0v5H0z" fill="currentColor" />
        </svg>
      </button>
      <Popover
        anchor={wrap}
        open={open}
        onClose={close}
        placement="left-start"
        ignore={[wrap]}
        className="lt-popover"
      >
        {flyout(close)}
      </Popover>
    </div>
  );
}

/** Arrow-key navigation between rows of a flyout. */
function onRowsKeyDown(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-row]')];
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
  rows[next]?.focus();
  e.preventDefault();
}

/** Focus the active row (or the first) when a flyout opens. */
function focusInitialRow(el: HTMLDivElement | null) {
  if (!el) return;
  const row = el.querySelector<HTMLElement>('[data-row].active') ?? el.querySelector('[data-row]');
  row?.focus({ preventScroll: true });
}

function ToolRows({ sections, onPick }: { sections: ToolSection[]; onPick: () => void }) {
  const activeTool = useUiStore((s) => s.activeTool);
  const favorites = useUiStore((s) => s.favoriteTools);
  const pick = (tool: ToolDef) => {
    selectTool(tool.id);
    onPick();
  };
  return (
    <>
      {sections.map((section, si) => (
        <div key={si} className="lt-fly-section">
          {section.title ? <div className="lt-fly-header">{section.title}</div> : null}
          {section.tools.map((tool) => {
            const fav = favorites.includes(tool.id);
            const available = isToolAvailable(tool.id);
            const Icon = tool.icon;
            return (
              <div
                key={tool.id}
                data-row
                role="menuitem"
                tabIndex={-1}
                aria-disabled={!available}
                title={available ? undefined : UNAVAILABLE_HINT}
                className={`lt-fly-row${activeTool === tool.id ? ' active' : ''}${available ? '' : ' unavailable'}`}
                onClick={() => pick(tool)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(tool);
                  }
                }}
              >
                <span className="lt-fly-icon">
                  <Icon />
                </span>
                <span className="lt-fly-name">{tool.name}</span>
                {available ? null : <span className="lt-fly-soon">{UNAVAILABLE_HINT}</span>}
                {available && tool.shortcut ? (
                  <span className="lt-fly-shortcut">{formatShortcut(tool.shortcut)}</span>
                ) : null}
                <button
                  type="button"
                  className={`lt-star${fav ? ' on' : ''}`}
                  aria-label={
                    fav ? `Remove ${tool.name} from favorites` : `Add ${tool.name} to favorites`
                  }
                  aria-pressed={fav}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(tool.id);
                  }}
                >
                  {fav ? <I.IconStarFilled size={18} /> : <I.IconStar size={18} />}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Search box over a tool list: arrows move into the rows, Enter picks the first match. */
function ToolSearch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <input
      className="lt-fly-search"
      value={value}
      placeholder="Search tools"
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      autoFocus
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const first = e.currentTarget
          .closest('[role="menu"]')
          ?.querySelector<HTMLElement>('[data-row]:not([aria-disabled="true"])');
        if (first) {
          e.preventDefault();
          first.click();
        }
      }}
    />
  );
}

/** A dock category's flyout: search, then its sections (and the sticker grid for Text). */
function CategoryFlyout({ cat, onClose }: { cat: DockCategory; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const sections = filterSections(cat.sections, query);
  return (
    <div className="lt-fly" role="menu" aria-label={cat.label} onKeyDown={onRowsKeyDown}>
      <ToolSearch value={query} onChange={setQuery} label={`Search ${cat.label.toLowerCase()}`} />
      <ToolRows sections={sections} onPick={onClose} />
      {cat.stickers && !query ? <IconsFlyout onClose={onClose} /> : null}
      {sections.length === 0 && (query || !cat.stickers) ? (
        <div className="lt-fly-empty">No tools match &ldquo;{query}&rdquo;</div>
      ) : null}
    </div>
  );
}

function IconsFlyout({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(ICON_TABS[0]?.id ?? '');
  const activeTool = useUiStore((s) => s.activeTool);
  const current = ICON_TABS.find((x) => x.id === tab) ?? ICON_TABS[0];
  return (
    <div className="lt-icons" role="group" aria-label="Icons, emojis and stickers">
      <div className="lt-icons-tabs" role="tablist">
        {ICON_TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={x.id === tab}
            className={`lt-icons-tab${x.id === tab ? ' active' : ''}`}
            onClick={() => setTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="lt-icons-grid">
        {current?.items.map((it) => {
          const available = isToolAvailable(it.id);
          return (
            <button
              key={it.id}
              type="button"
              data-row
              role="menuitem"
              title={available ? it.name : `${it.name} (${UNAVAILABLE_HINT.toLowerCase()})`}
              aria-label={it.name}
              {...(available ? {} : { 'aria-disabled': true })}
              className={`lt-icons-cell${available ? '' : ' unavailable'}${activeTool === it.id ? ' active' : ''}`}
              onClick={() => {
                selectTool(it.id);
                onClose();
              }}
            >
              {it.glyph}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Cursor modes (cross, dot, arrow, eraser) as one split button. */
function CursorButton() {
  const activeTool = useUiStore((s) => s.activeTool);
  const last = useUiStore((s) => s.groupTools['cursors']);
  const group = TOOL_GROUPS.find((g) => g.id === 'cursors');
  const first = group?.sections[0]?.tools[0];
  const tool = (last ? findTool(last) : undefined) ?? first;
  if (!group || !tool) return null;
  const Icon = tool.icon;
  return (
    <SplitButton
      label={tool.name}
      active={groupOf(activeTool) === 'cursors'}
      icon={<Icon />}
      onClick={() => selectTool(tool.id)}
      flyoutLabel="Cursor modes"
      flyout={(close) => (
        <div
          className="lt-fly"
          role="menu"
          aria-label={group.label}
          ref={focusInitialRow}
          onKeyDown={onRowsKeyDown}
        >
          <ToolRows sections={group.sections} onPick={close} />
        </div>
      )}
    />
  );
}

/** Dock button: opens its category's searchable flyout. */
function CategoryButton({ cat }: { cat: DockCategory }) {
  const activeTool = useUiStore((s) => s.activeTool);
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const active = categoryOf(activeTool)?.id === cat.id;
  // Show the category's active tool, so the dock tells what is armed.
  const armed = active ? findTool(activeTool) : undefined;
  const Icon = armed?.icon ?? cat.icon;
  return (
    <div ref={setWrap} className={`lt-group${open ? ' open' : ''}`}>
      <IconButton
        label={cat.label}
        tipSide="left"
        active={active}
        aria-haspopup="menu"
        aria-expanded={open}
        className="lt-btn"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon />
      </IconButton>
      <Popover
        anchor={wrap}
        open={open}
        onClose={() => setOpen(false)}
        placement="left-start"
        ignore={[wrap]}
        className="lt-popover"
      >
        <CategoryFlyout cat={cat} onClose={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

/** Pressed-state toggle row of the options panel. */
function OptionToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`lt-opt-toggle${active ? ' on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="lt-opt-switch" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Segmented choice: one pressed button per option. */
function OptionSegments<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <div className="lt-opt-row">
      <span className="lt-opt-label">{label}</span>
      <div className="lt-opt-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={value === o.id}
            className={value === o.id ? 'on' : ''}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const HIDE_SHORT: Record<HideMode, string> = {
  drawings: 'Drawings',
  indicators: 'Indicators',
  positions: 'Trades',
  all: 'All',
};

/** Global drawing behaviour: magnet, modes, lock, hide, cleanup and the favorites bar. */
function DrawingOptions({ onClose }: { onClose: () => void }) {
  const t = useT();
  const magnet = useAppStore((s) => s.magnet);
  const stay = useUiStore((s) => s.stayInDrawingMode);
  const syncNew = useUiStore((s) => s.syncNewDrawings);
  const lockAll = useUiStore((s) => s.lockAll);
  const hideAll = useUiStore((s) => s.hideAll);
  const hideMode = toHideMode(useUiStore((s) => s.groupTools.hide));
  const showFav = useUiStore((s) => s.showFavoritesBar);
  const run = (id: string) => commands.execute(id);
  return (
    <div className="lt-opts" role="group" aria-label={t('rail.options')}>
      <OptionSegments
        label="Magnet"
        options={[
          { id: 'off', label: 'Off' },
          { id: 'weak', label: 'Weak' },
          { id: 'strong', label: 'Strong' },
        ]}
        value={magnet}
        onChange={(m) => setMagnet(m)}
      />
      <OptionSegments
        label="Hide"
        options={[
          { id: 'none' as const, label: 'None' },
          ...HIDE_MODES.map((h) => ({ id: h.id, label: HIDE_SHORT[h.id] })),
        ]}
        value={hideAll ? hideMode : 'none'}
        onChange={(m) =>
          m === 'none' ? useUiStore.getState().set({ hideAll: false }) : setHideMode(m)
        }
      />
      <div className="lt-opt-sep" />
      <OptionToggle
        label={t('rail.stayDrawing')}
        active={stay}
        onClick={() => run('drawings.toggleStayInDrawingMode')}
      />
      <OptionToggle
        label={t('rail.syncNew')}
        active={syncNew}
        onClick={() => run('drawings.toggleSyncNew')}
      />
      <OptionToggle
        label={t('rail.lockAll')}
        active={lockAll}
        onClick={() => run('drawings.toggleLockAll')}
      />
      <OptionToggle
        label={t('rail.showFavorites')}
        active={showFav}
        onClick={() => useUiStore.getState().set({ showFavoritesBar: !showFav })}
      />
      <div className="lt-opt-sep" />
      <div className="lt-opt-actions">
        {(
          [
            ['drawings.removeAll', t('rail.removeDrawings')],
            ['drawings.removeIndicators', t('rail.removeIndicators')],
            ['drawings.removeAllObjects', t('rail.removeAll')],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`lt-opt-action${id === 'drawings.removeAllObjects' ? ' danger' : ''}`}
            onClick={() => {
              onClose();
              run(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="lt-opt-hint">
        Quick tools at the cursor: <kbd>{formatShortcut('Alt+d')}</kbd>
      </p>
    </div>
  );
}

function OptionsButton() {
  const t = useT();
  const [wrap, setWrap] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const magnet = useAppStore((s) => s.magnet);
  const lockAll = useUiStore((s) => s.lockAll);
  const hideAll = useUiStore((s) => s.hideAll);
  // A dot tells that something non-default is on, since the toggles are tucked away.
  const busy = magnet !== 'off' || lockAll || hideAll;
  return (
    <div ref={setWrap} className={`lt-group${open ? ' open' : ''}`}>
      <IconButton
        label={t('rail.options')}
        tipSide="left"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`lt-btn${busy ? ' lt-busy' : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <I.IconSliders />
      </IconButton>
      <Popover
        anchor={wrap}
        open={open}
        onClose={() => setOpen(false)}
        placement="left-start"
        ignore={[wrap]}
        className="lt-popover"
      >
        <DrawingOptions onClose={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

/** Searchable tool picker opened at the pointer (Alt+D): starred tools, or a few
 * everyday ones, as big buttons; typing searches every tool. */
export function QuickTools() {
  const at = useQuickTools((s) => s.at);
  // A fresh menu per opening: the search starts empty.
  return at ? <QuickToolsMenu key={`${at.x},${at.y}`} at={at} /> : null;
}

function QuickToolsMenu({ at }: { at: { x: number; y: number } }) {
  const t = useT();
  const favorites = useUiStore((s) => s.favoriteTools);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const tools = quickTools(favorites);
  const results = query ? filterSections([{ tools: dockTools() }], query) : [];
  return (
    <>
      <div ref={setAnchor} className="lt-quick-anchor" style={{ left: at.x, top: at.y }} />
      <Popover anchor={anchor} open={!!anchor} onClose={closeQuickTools} className="lt-popover">
        <div
          className="lt-fly lt-quick"
          role="menu"
          aria-label={t('rail.quickTools')}
          onKeyDown={onRowsKeyDown}
        >
          <ToolSearch value={query} onChange={setQuery} label="Search all drawing tools" />
          {query ? (
            <>
              <ToolRows sections={results} onPick={closeQuickTools} />
              {results.length === 0 ? (
                <div className="lt-fly-empty">No tools match &ldquo;{query}&rdquo;</div>
              ) : null}
            </>
          ) : (
            <>
              <div className="lt-quick-grid">
                {tools.map((tool) => {
                  const Icon = tool.icon;
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      data-row
                      role="menuitem"
                      aria-label={tool.name}
                      title={tool.name}
                      className="lt-quick-cell"
                      onClick={() => {
                        selectTool(tool.id);
                        closeQuickTools();
                      }}
                    >
                      <Icon />
                      <span>{tool.name}</span>
                    </button>
                  );
                })}
              </div>
              <p className="lt-opt-hint">
                {favorites.length
                  ? 'Your starred tools.'
                  : 'Star tools in the dock to pin them here.'}
              </p>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

/** Drawing dock on the right edge: cursor, five tool categories and the options panel.
 * Tools without a registered drawing definition are dimmed and only show a hint
 * (drawings/attach syncs the active tool and options to the chart). */
export function ToolRail() {
  const t = useT();
  const showFav = useUiStore((s) => s.showFavoritesBar);
  const hasFavs = useUiStore((s) => s.favoriteTools.length > 0);

  useEffect(() => registerToolbarCommands(), []);

  return (
    <nav className="tool-rail" aria-label={t('rail.drawingTools')}>
      <CursorButton />
      <div className="lt-sep" role="separator" />
      {DOCK_CATEGORIES.map((c) => (
        <CategoryButton key={c.id} cat={c} />
      ))}
      <div className="lt-sep" role="separator" />
      <OptionsButton />
      {showFav && hasFavs ? <FavoritesBar /> : null}
    </nav>
  );
}
