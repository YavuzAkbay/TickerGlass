import {
  AlarmClock,
  Camera,
  ChevronDown,
  Keyboard,
  Maximize,
  Minimize,
  Moon,
  PanelRightClose,
  PanelRightOpen,
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
import { useT } from '../i18n';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { useReplayStore } from '../replay/store';
import { useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { DropdownMenu, Menu, type MenuItem } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { CHART_TYPE_MENU, chartTypeDef } from './chartTypes';
import { IndicatorTemplatesButton } from './IndicatorTemplatesButton';
import { IntervalControl } from './IntervalControl';
import { LayoutMenu } from './LayoutMenu';
import { LayoutPicker } from './LayoutPicker';
import { firstShortcut, useCommand } from './useCommand';
import './topbar.css';

const run = (id: string, arg?: unknown) => commands.execute(id, arg);

/** Single-row command bar: symbol | interval | chart type | studies | alerts and replay | layout | settings. */
export function TopBar() {
  const t = useT();
  const replayOn = useReplayStore((s) => s.status !== 'off');
  return (
    <div className="top-bar" role="toolbar" aria-label={t('topbar.toolbar')}>
      <SymbolButton />
      <IconButton
        icon={Plus}
        label={t('topbar.compare')}
        className="tb-compare"
        onClick={() => run('chart.compare')}
      />
      <div className="tb-sep" />
      <IntervalControl />
      <div className="tb-sep" />
      <ChartTypeButton />
      <div className="tb-sep" />
      <CommandButton
        id="chart.indicators"
        icon={SquareFunction}
        label={t('topbar.indicators')}
        showLabel
      />
      <IndicatorTemplatesButton />
      <div className="tb-sep" />
      <CommandButton
        id="alert.create"
        icon={AlarmClock}
        label={t('topbar.alert')}
        text={t('topbar.alertShort')}
      />
      <CommandButton
        id="replay.toggle"
        icon={Rewind}
        label={t('topbar.replay')}
        text={t('topbar.replayShort')}
        active={replayOn}
      />
      <div className="tb-sep" />
      <LayoutPicker />
      <LayoutMenu />
      <div className="tb-sep" />
      <CommandButton id="chart.settings" icon={Settings} label={t('topbar.settings')} />
      <div className="tb-spacer" />
      <UndoRedo />
      <div className="tb-sep" />
      <FullscreenButton />
      <ScreenshotButton />
      <ThemeButton />
      <CommandButton id="view.shortcuts" icon={Keyboard} label={t('topbar.shortcuts')} />
      <div className="tb-sep" />
      <ToolRailToggle />
    </div>
  );
}

function ToolRailToggle() {
  const t = useT();
  const hidden = useUiStore((s) => s.toolRailHidden);
  const shortcut = firstShortcut(useCommand('view.toggleToolRail'));
  return (
    <IconButton
      icon={hidden ? PanelRightOpen : PanelRightClose}
      label={hidden ? t('topbar.showTools') : t('topbar.hideTools')}
      {...(shortcut ? { shortcut } : {})}
      active={!hidden}
      onClick={() => useUiStore.getState().toggleToolRail()}
    />
  );
}

function SymbolButton() {
  const t = useT();
  const symbol = useChartView((s) => s.symbol);
  return (
    <button
      type="button"
      className="tb-btn tb-symbol"
      aria-label={t('topbar.symbolSearchCurrent', { symbol })}
      data-tip={t('topbar.symbolSearch')}
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
  const t = useT();
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
        label={undoLabel ? t('topbar.undoItem', { label: undoLabel }) : t('topbar.undo')}
        {...(undo ? { shortcut: undo } : {})}
        disabled={!canUndo}
        onClick={() => run('edit.undo')}
      />
      <IconButton
        icon={Redo2}
        label={redoLabel ? t('topbar.redoItem', { label: redoLabel }) : t('topbar.redo')}
        {...(redo ? { shortcut: redo } : {})}
        disabled={!canRedo}
        onClick={() => run('edit.redo')}
      />
    </>
  );
}

function ChartTypeButton() {
  const t = useT();
  const chartType = useChartView((s) => s.chartType);
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
          onSelect: () => useChartView.getState().set({ chartType: t.id }),
        }
      : { type: 'separator' },
  );

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-charttype${open ? ' open' : ''}`}
        aria-label={t('topbar.chartType', { type: current?.label ?? chartType })}
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
  const t = useT();
  const full = useSyncExternalStore(subscribeFullscreen, () => !!document.fullscreenElement);
  const shortcut = firstShortcut(useCommand('view.fullscreen'));
  return (
    <IconButton
      icon={full ? Minimize : Maximize}
      label={full ? t('topbar.exitFullscreen') : t('topbar.fullscreen')}
      {...(shortcut ? { shortcut } : {})}
      onClick={() => run('view.fullscreen')}
    />
  );
}

function ScreenshotButton() {
  const t = useT();
  const hasChart = useChartStore((s) => !!s.chart);
  const shortcut = firstShortcut(useCommand('chart.screenshot'));
  const copyShortcut = firstShortcut(useCommand('chart.screenshot.copy'));
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const items: MenuItem[] = [
    {
      label: t('topbar.downloadImage'),
      icon: Camera,
      ...(shortcut ? { shortcut } : {}),
      onSelect: () => run('chart.screenshot'),
    },
    {
      label: t('topbar.copyImage'),
      ...(copyShortcut ? { shortcut: copyShortcut } : {}),
      onSelect: () => run('chart.screenshot.copy'),
    },
  ];
  return (
    <div className="tb-split">
      <IconButton
        icon={Camera}
        label={t('topbar.snapshot')}
        {...(shortcut ? { shortcut } : {})}
        disabled={!hasChart}
        onClick={() => run('chart.screenshot')}
      />
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-split-chevron${open ? ' open' : ''}`}
        aria-label={t('topbar.snapshotOptions')}
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
  const t = useT();
  const theme = useAppStore((s) => s.theme);
  return (
    <IconButton
      icon={theme === 'dark' ? Sun : Moon}
      label={theme === 'dark' ? t('topbar.themeLight') : t('topbar.themeDark')}
      onClick={() => run('view.toggleTheme')}
    />
  );
}
