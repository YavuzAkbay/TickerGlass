import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { commands, formatShortcut } from '../commands/registry';
import { useT } from '../i18n';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { Menu, type MenuItem } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import {
  HIDE_MODES,
  toHideMode,
  registerToolbarCommands,
  setHideMode,
  setMagnet,
} from './commands';
import { FavoritesBar } from './FavoritesBar';
import * as I from './icons';
import {
  findSticker,
  findTool,
  groupOf,
  ICON_TABS,
  isToolAvailable,
  ICONS_GROUP_ID,
  MEASURE_TOOL,
  selectTool,
  TOOL_GROUPS,
  toggleFavorite,
  UNAVAILABLE_HINT,
  ZOOM_TOOL,
  type ToolDef,
  type ToolGroup,
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

function ToolFlyout({ group, onClose }: { group: ToolGroup; onClose: () => void }) {
  const activeTool = useUiStore((s) => s.activeTool);
  const favorites = useUiStore((s) => s.favoriteTools);
  const pick = (tool: ToolDef) => {
    selectTool(tool.id);
    onClose();
  };
  return (
    <div
      className="lt-fly"
      role="menu"
      aria-label={group.label}
      ref={focusInitialRow}
      onKeyDown={onRowsKeyDown}
    >
      {group.sections.map((section, si) => (
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
    </div>
  );
}

function IconsFlyout({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState(ICON_TABS[0]?.id ?? '');
  const activeTool = useUiStore((s) => s.activeTool);
  const current = ICON_TABS.find((x) => x.id === tab) ?? ICON_TABS[0];
  return (
    <div className="lt-icons" role="menu" aria-label="Icons">
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
      <div className="lt-icons-grid" ref={focusInitialRow}>
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

function ToolGroupButton({ group }: { group: ToolGroup }) {
  const activeTool = useUiStore((s) => s.activeTool);
  const last = useUiStore((s) => s.groupTools[group.id]);
  const first = group.sections[0]?.tools[0];
  const tool = (last ? findTool(last) : undefined) ?? first;
  if (!tool) return null;
  const Icon = tool.icon;
  return (
    <SplitButton
      label={tool.name}
      shortcut={tool.shortcut}
      active={groupOf(activeTool) === group.id}
      unavailable={!isToolAvailable(tool.id)}
      icon={<Icon />}
      onClick={() => selectTool(tool.id)}
      flyoutLabel={`More ${group.label.toLowerCase()}`}
      flyout={(close) => <ToolFlyout group={group} onClose={close} />}
    />
  );
}

function IconsGroupButton() {
  const activeTool = useUiStore((s) => s.activeTool);
  const last = useUiStore((s) => s.groupTools[ICONS_GROUP_ID]);
  const sticker = last ? findSticker(last) : undefined;
  return (
    <SplitButton
      label={sticker ? sticker.name : 'Icons'}
      active={groupOf(activeTool) === ICONS_GROUP_ID}
      unavailable={!!last && !isToolAvailable(last)}
      icon={sticker ? <span className="lt-glyph">{sticker.glyph}</span> : <I.IconSmile />}
      onClick={() => {
        if (last && sticker) selectTool(last);
      }}
      flyoutLabel="Icons, emojis and stickers"
      flyout={(close) => <IconsFlyout onClose={close} />}
    />
  );
}

function MenuFlyout({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return <Menu items={items} onClose={onClose} />;
}

function MagnetButton() {
  const t = useT();
  const magnet = useAppStore((s) => s.magnet);
  const remembered = useUiStore((s) => s.groupTools.magnet);
  const strong = (magnet === 'off' ? remembered : magnet) === 'strong';
  const label = strong ? t('rail.strongMagnet') : t('rail.weakMagnet');
  return (
    <SplitButton
      label={label}
      active={magnet !== 'off'}
      icon={strong ? <I.IconMagnetStrong /> : <I.IconMagnet />}
      onClick={() => commands.execute('drawings.toggleMagnet')}
      flyoutLabel={t('rail.magnetModes')}
      flyout={(close) => (
        <MenuFlyout
          onClose={close}
          items={[
            {
              label: t('rail.weakMagnet'),
              icon: magnetIcon,
              checked: magnet === 'weak',
              onSelect: () => setMagnet('weak'),
            },
            {
              label: t('rail.strongMagnet'),
              icon: magnetStrongIcon,
              checked: magnet === 'strong',
              onSelect: () => setMagnet('strong'),
            },
          ]}
        />
      )}
    />
  );
}

const magnetIcon = ({ size }: { size?: number }) => <I.IconMagnet size={(size ?? 16) + 4} />;
const magnetStrongIcon = ({ size }: { size?: number }) => (
  <I.IconMagnetStrong size={(size ?? 16) + 4} />
);
const trashIcon = ({ size }: { size?: number }) => <I.IconTrash size={(size ?? 16) + 4} />;

function HideButton() {
  const hideAll = useUiStore((s) => s.hideAll);
  const mode = toHideMode(useUiStore((s) => s.groupTools.hide));
  const label = HIDE_MODES.find((h) => h.id === mode)?.label ?? 'Hide drawings';
  return (
    <SplitButton
      label={hideAll ? label.replace('Hide', 'Show') : label}
      active={hideAll}
      icon={hideAll ? <I.IconEyeOff /> : <I.IconEye />}
      onClick={() => commands.execute('drawings.toggleHideAll')}
      flyoutLabel="Hide options"
      flyout={(close) => (
        <MenuFlyout
          onClose={close}
          items={HIDE_MODES.map((h) => ({
            label: h.label,
            checked: hideAll && mode === h.id,
            onSelect: () =>
              hideAll && mode === h.id
                ? useUiStore.getState().set({ hideAll: false })
                : setHideMode(h.id),
          }))}
        />
      )}
    />
  );
}

function RemoveButton() {
  const t = useT();
  return (
    <SplitButton
      label={t('rail.removeDrawings')}
      active={false}
      icon={<I.IconTrash />}
      onClick={() => commands.execute('drawings.removeAll')}
      flyoutLabel={t('rail.removeOptions')}
      flyout={(close) => (
        <MenuFlyout
          onClose={close}
          items={[
            {
              label: t('rail.removeDrawings'),
              icon: trashIcon,
              onSelect: () => commands.execute('drawings.removeAll'),
            },
            {
              label: t('rail.removeIndicators'),
              onSelect: () => commands.execute('drawings.removeIndicators'),
            },
            {
              label: t('rail.removeAll'),
              danger: true,
              onSelect: () => commands.execute('drawings.removeAllObjects'),
            },
          ]}
        />
      )}
    />
  );
}

function SingleToolButton({ tool }: { tool: ToolDef }) {
  const active = useUiStore((s) => s.activeTool === tool.id);
  const available = isToolAvailable(tool.id);
  const Icon = tool.icon;
  return (
    <div className="lt-group">
      <IconButton
        label={available ? tool.name : `${tool.name} (${UNAVAILABLE_HINT.toLowerCase()})`}
        tipSide="left"
        active={active}
        className={`lt-btn${available ? '' : ' unavailable'}`}
        onClick={() => selectTool(tool.id)}
      >
        <Icon />
      </IconButton>
    </div>
  );
}

function ToggleButton({
  label,
  active,
  icon,
  command,
}: {
  label: string;
  active: boolean;
  icon: ReactNode;
  command: string;
}) {
  return (
    <div className="lt-group">
      <IconButton
        label={label}
        tipSide="left"
        active={active}
        className="lt-btn"
        onClick={() => commands.execute(command)}
      >
        {icon}
      </IconButton>
    </div>
  );
}

/** Vertical drawing tool rail on the right edge. Tools without a registered
 * drawing definition are dimmed and only show a hint (drawings/attach syncs
 * the active tool and options to the chart). */
export function ToolRail() {
  const t = useT();
  const stay = useUiStore((s) => s.stayInDrawingMode);
  const syncNew = useUiStore((s) => s.syncNewDrawings);
  const lockAll = useUiStore((s) => s.lockAll);
  const showFav = useUiStore((s) => s.showFavoritesBar);
  const hasFavs = useUiStore((s) => s.favoriteTools.length > 0);

  useEffect(() => registerToolbarCommands(), []);

  return (
    <nav className="tool-rail" aria-label={t('rail.drawingTools')}>
      {TOOL_GROUPS.map((g) => (
        <ToolGroupButton key={g.id} group={g} />
      ))}
      <IconsGroupButton />
      <div className="lt-sep" role="separator" />
      <SingleToolButton tool={MEASURE_TOOL} />
      <SingleToolButton tool={ZOOM_TOOL} />
      <div className="lt-sep" role="separator" />
      <MagnetButton />
      <ToggleButton
        label={t('rail.stayDrawing')}
        active={stay}
        icon={<I.IconStayDrawing />}
        command="drawings.toggleStayInDrawingMode"
      />
      <ToggleButton
        label={syncNew ? t('rail.syncAll') : t('rail.syncOne')}
        active={syncNew}
        icon={<I.IconSyncDrawings />}
        command="drawings.toggleSyncNew"
      />
      <ToggleButton
        label={lockAll ? t('rail.unlockAll') : t('rail.lockAll')}
        active={lockAll}
        icon={lockAll ? <I.IconLock /> : <I.IconUnlock />}
        command="drawings.toggleLockAll"
      />
      <HideButton />
      <RemoveButton />
      <div className="lt-spacer" />
      <div className="lt-group">
        <IconButton
          label={showFav ? t('rail.hideFavorites') : t('rail.showFavorites')}
          tipSide="left"
          active={showFav}
          className="lt-btn lt-btn-fav"
          onClick={() => useUiStore.getState().set({ showFavoritesBar: !showFav })}
        >
          {showFav ? <I.IconStarFilled /> : <I.IconStar />}
        </IconButton>
      </div>
      {showFav && hasFavs ? <FavoritesBar /> : null}
    </nav>
  );
}
