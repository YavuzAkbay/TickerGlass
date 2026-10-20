import {
  AlarmClock,
  Camera,
  ChevronDown,
  Maximize,
  Minimize,
  Moon,
  Plus,
  Redo2,
  Rewind,
  Search,
  Settings,
  SquareFunction,
  Sun,
  Undo2,
} from 'lucide-react';
import { useState, useSyncExternalStore, type ComponentType } from 'react';
import { useHistory } from '../commands/history';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useReplayStore } from '../replay/store';
import { useChartStore } from '../store/chart';
import { IconButton } from '../ui/IconButton';
import { DropdownMenu, Menu, type MenuItem } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { CHART_TYPE_MENU, chartTypeDef } from './chartTypes';
import { IndicatorTemplatesButton } from './IndicatorTemplatesButton';
import { IntervalControl } from './IntervalControl';
import { LayoutMenu } from './LayoutMenu';
import { firstShortcut, useCommand } from './useCommand';
import './topbar.css';

const run = (id: string, arg?: unknown) => commands.execute(id, arg);

/** standard header: symbol, interval, chart type, tools, layout and view actions. */
export function TopBar() {
  const replayOn = useReplayStore((s) => s.status !== 'off');
  return (
    <div className="top-bar" role="toolbar" aria-label="Chart toolbar">
      <SymbolButton />
      <IconButton
        icon={Plus}
        label="Compare or add symbol"
        className="tb-compare"
        onClick={() => run('chart.compare')}
      />
      <div className="tb-sep" />
      <IntervalControl />
      <div className="tb-sep" />
      <ChartTypeButton />
      <div className="tb-sep" />
      <CommandButton id="chart.indicators" icon={SquareFunction} label="Indicators" showLabel />
      <IndicatorTemplatesButton />
      <div className="tb-sep" />
      <CommandButton id="alert.create" icon={AlarmClock} label="Create alert" text="Alert" />
      <CommandButton
        id="replay.toggle"
        icon={Rewind}
        label="Bar replay"
        text="Replay"
        active={replayOn}
      />
      <div className="tb-sep" />
      <UndoRedo />
      <div className="tb-spacer" />
      <LayoutMenu />
      <div className="tb-sep" />
      <CommandButton id="chart.settings" icon={Settings} label="Settings" />
      <FullscreenButton />
      <ScreenshotButton />
      <ThemeButton />
    </div>
  );
}

function SymbolButton() {
  const symbol = useAppStore((s) => s.symbol);
  return (
    <button
      type="button"
      className="tb-btn tb-symbol"
      aria-label={`Symbol search, current symbol ${symbol}`}
      data-tip="Symbol search"
      data-tip-side="bottom"
      onClick={() => run('chart.symbolSearch')}
    >
      <Search size={16} strokeWidth={2} />
      <span className="tb-symbol-text">{symbol}</span>
    </button>
  );
}

interface CommandButtonProps {
  id: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  /** Show `label` next to the icon. */
  showLabel?: boolean;
  /** Short text next to the icon (hidden on narrow screens). */
  text?: string;
  /** Pressed look (a mode that is on). */
  active?: boolean;
}

/** Icon button bound to a command; tooltip shows its shortcut. */
function CommandButton({ id, icon, label, showLabel, text, active }: CommandButtonProps) {
  const cmd = useCommand(id);
  const shortcut = firstShortcut(cmd);
  const visible = showLabel ? label : text;
  return (
    <IconButton
      icon={icon}
      label={label}
      {...(shortcut ? { shortcut } : {})}
      className={visible ? 'tb-labeled' : ''}
      {...(active === undefined ? {} : { active })}
      onClick={() => run(id)}
    >
      {visible ? (
        <span className={`tb-label${showLabel ? '' : ' tb-collapsible'}`}>{visible}</span>
      ) : null}
    </IconButton>
  );
}

function UndoRedo() {
  const canUndo = useHistory((s) => s.past.length > 0);
  const canRedo = useHistory((s) => s.future.length > 0);
  const undoLabel = useHistory((s) => s.past.at(-1)?.label);
  const redoLabel = useHistory((s) => s.future[0]?.label);
  const undo = firstShortcut(useCommand('edit.undo'));
  const redo = firstShortcut(useCommand('edit.redo'));
  return (
    <>
      <IconButton
        icon={Undo2}
        label={undoLabel ? `Undo ${undoLabel}` : 'Undo'}
        {...(undo ? { shortcut: undo } : {})}
        disabled={!canUndo}
        onClick={() => run('edit.undo')}
      />
      <IconButton
        icon={Redo2}
        label={redoLabel ? `Redo ${redoLabel}` : 'Redo'}
        {...(redo ? { shortcut: redo } : {})}
        disabled={!canRedo}
        onClick={() => run('edit.redo')}
      />
    </>
  );
}

function ChartTypeButton() {
  const chartType = useAppStore((s) => s.chartType);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = chartTypeDef(chartType);
  const Icon = current?.icon;

  const items: MenuItem[] = CHART_TYPE_MENU.map((t): MenuItem =>
    t
      ? {
          label: t.label,
          icon: t.icon,
          checked: t.id === chartType,
          onSelect: () => useAppStore.getState().set({ chartType: t.id }),
        }
      : { type: 'separator' },
  );

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-charttype${open ? ' open' : ''}`}
        aria-label={`Chart type: ${current?.label ?? chartType}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : current?.label}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        {Icon ? <Icon size={18} /> : null}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} ignore={[anchor]}>
        <Menu items={items} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

const subscribeFullscreen = (fn: () => void) => {
  document.addEventListener('fullscreenchange', fn);
  return () => document.removeEventListener('fullscreenchange', fn);
};

function FullscreenButton() {
  const full = useSyncExternalStore(subscribeFullscreen, () => !!document.fullscreenElement);
  const shortcut = firstShortcut(useCommand('view.fullscreen'));
  return (
    <IconButton
      icon={full ? Minimize : Maximize}
      label={full ? 'Exit fullscreen' : 'Fullscreen mode'}
      {...(shortcut ? { shortcut } : {})}
      onClick={() => run('view.fullscreen')}
    />
  );
}

function ScreenshotButton() {
  const hasChart = useChartStore((s) => !!s.chart);
  const shortcut = firstShortcut(useCommand('chart.screenshot'));
  const copyShortcut = firstShortcut(useCommand('chart.screenshot.copy'));
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = [
    {
      label: 'Download image',
      icon: Camera,
      ...(shortcut ? { shortcut } : {}),
      onSelect: () => run('chart.screenshot'),
    },
    {
      label: 'Copy image',
      ...(copyShortcut ? { shortcut: copyShortcut } : {}),
      onSelect: () => run('chart.screenshot.copy'),
    },
  ];
  return (
    <div className="tb-split">
      <IconButton
        icon={Camera}
        label="Take a snapshot"
        {...(shortcut ? { shortcut } : {})}
        disabled={!hasChart}
        onClick={() => run('chart.screenshot')}
      />
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-split-chevron${open ? ' open' : ''}`}
        aria-label="Snapshot options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!hasChart}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={14} strokeWidth={1.6} />
      </button>
      <DropdownMenu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        placement="bottom-end"
      />
    </div>
  );
}

function ThemeButton() {
  const theme = useAppStore((s) => s.theme);
  return (
    <IconButton
      icon={theme === 'dark' ? Sun : Moon}
      label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => run('view.toggleTheme')}
    />
  );
}
