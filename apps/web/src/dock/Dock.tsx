import {
  AlarmClock,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  FileText,
  ListTree,
  Newspaper,
  NotebookPen,
  Plus,
  Rows3,
  TableProperties,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { useAlerts } from '../alerts/store';
import { commands } from '../commands/registry';
import { useT, type MessageKey } from '../i18n';
import { ReplayTrading } from '../replay/ReplayTrading';
import { useReplayStore } from '../replay/store';
import { Alerts } from '../sidebar/panels/Alerts';
import { DataWindow } from '../sidebar/panels/DataWindow';
import { Details } from '../sidebar/panels/Details';
import { News } from '../sidebar/panels/News';
import { Notes } from '../sidebar/panels/Notes';
import { ObjectTree } from '../sidebar/panels/ObjectTree';
import { Watchlist } from '../sidebar/panels/Watchlist';
import { DEFAULT_DOCK_HEIGHT, useUiStore, type RightPanel } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import '../sidebar/sidebar.css';
import './dock.css';

interface PanelDef {
  id: RightPanel;
  title: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render: () => ReactNode;
}

const PANELS: PanelDef[] = [
  { id: 'watchlist', title: 'dock.watchlist', icon: Rows3, render: () => <Watchlist /> },
  { id: 'details', title: 'dock.details', icon: FileText, render: () => <Details /> },
  { id: 'news', title: 'dock.news', icon: Newspaper, render: () => <News /> },
  { id: 'alerts', title: 'dock.alerts', icon: AlarmClock, render: () => <Alerts /> },
  {
    id: 'replayTrading',
    title: 'dock.replayTrading',
    icon: ArrowUpDown,
    render: () => <ReplayTrading />,
  },
  { id: 'objectTree', title: 'dock.objectTree', icon: ListTree, render: () => <ObjectTree /> },
  {
    id: 'dataWindow',
    title: 'dock.dataWindow',
    icon: TableProperties,
    render: () => <DataWindow />,
  },
  { id: 'notes', title: 'dock.notes', icon: NotebookPen, render: () => <Notes /> },
];

/** Drag handle on the top edge of the dock; double-click restores the default height. */
function ResizeHandle() {
  const t = useT();
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className="dock-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('dock.resize')}
      onPointerDown={(e) => {
        start.current = { y: e.clientY, h: useUiStore.getState().dockHeight };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) useUiStore.getState().setDockHeight(s.h + (s.y - e.clientY));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.classList.remove('dragging');
      }}
      onDoubleClick={() => useUiStore.getState().setDockHeight(DEFAULT_DOCK_HEIGHT)}
    />
  );
}

/** Bottom dock under the chart: a tab per panel, collapsible, resizable by its top edge. */
export function Dock() {
  const t = useT();
  const panel = useUiStore((s) => s.rightPanel);
  const dockTab = useUiStore((s) => s.dockTab);
  const height = useUiStore((s) => s.dockHeight);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const unreadAlerts = useAlerts((s) => s.unread);
  const replaying = useReplayStore((s) => s.status !== 'off');

  // Remember the last open tab, however it was opened (e.g. the alerts toast).
  useEffect(() => {
    if (panel && panel !== dockTab) useUiStore.setState({ dockTab: panel });
  }, [panel, dockTab]);

  const open = panel !== null;
  const def = PANELS.find((p) => p.id === panel);
  const expand = () => {
    const tab = PANELS.some((p) => p.id === dockTab) ? dockTab : 'watchlist';
    useUiStore.setState({ rightPanel: tab === 'replayTrading' && !replaying ? 'watchlist' : tab });
  };

  const visible = PANELS.filter((p) => p.id !== 'replayTrading' || replaying);

  /** Left/Right/Home/End move between tabs; an open dock follows the focused tab. */
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = visible.length - 1;
    const next =
      e.key === 'ArrowRight'
        ? index === last
          ? 0
          : index + 1
        : e.key === 'ArrowLeft'
          ? index === 0
            ? last
            : index - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1;
    const target = visible[next];
    if (!target) return;
    e.preventDefault();
    if (open) useUiStore.setState({ rightPanel: target.id, dockTab: target.id });
    // Focus after the roving tabindex has moved with the selection.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`#dock-tab-${target.id}`)?.focus(),
    );
  };

  return (
    <div className={`dock${open ? ' open' : ''}`} style={open ? { height } : undefined}>
      {open ? <ResizeHandle /> : null}
      <div className="dock-tabs">
        <div className="dock-tablist" role="tablist" aria-label={t('dock.panels')}>
          {visible.map((p, i) => {
            const Icon = p.icon;
            const selected = panel === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`dock-tab-${p.id}`}
                className={`dock-tab${selected ? ' active' : ''}`}
                aria-label={t(p.title)}
                aria-selected={selected}
                aria-controls={selected ? 'dock-panel' : undefined}
                tabIndex={selected || (!def && i === 0) ? 0 : -1}
                data-panel={p.id}
                onClick={() => togglePanel(p.id)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
              >
                <Icon size={15} strokeWidth={1.8} />
                <span className="dock-tab-text">{t(p.title)}</span>
                {p.id === 'alerts' && unreadAlerts ? (
                  <span
                    className="rs-badge rs-icon-badge"
                    aria-label={t('dock.unread', { count: unreadAlerts })}
                  >
                    {unreadAlerts > 99 ? '99+' : unreadAlerts}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="dock-spacer" />
        {def?.id === 'watchlist' ? (
          <IconButton
            icon={Plus}
            label={t('dock.addSymbol')}
            tipSide="top"
            className="rs-head-btn"
            onClick={() => commands.execute('watchlist.searchAdd')}
          />
        ) : null}
        {def?.id === 'alerts' ? (
          <IconButton
            icon={Plus}
            label={t('topbar.alert')}
            tipSide="top"
            className="rs-head-btn"
            onClick={() => commands.execute('alert.create', {})}
          />
        ) : null}
        <IconButton
          icon={open ? ChevronDown : ChevronUp}
          label={open ? t('dock.collapse') : t('dock.expand')}
          tipSide="top"
          className="rs-head-btn"
          onClick={() => (open ? useUiStore.setState({ rightPanel: null }) : expand())}
        />
      </div>
      {def ? (
        <section
          className="dock-body"
          id="dock-panel"
          role="tabpanel"
          aria-labelledby={`dock-tab-${def.id}`}
          key={def.id}
        >
          {def.render()}
        </section>
      ) : null}
    </div>
  );
}
