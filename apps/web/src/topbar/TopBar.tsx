import {
  AlarmClock,
  Moon,
  Plus,
  Redo2,
  Rewind,
  Search,
  SquareFunction,
  Sun,
  Undo2,
} from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { useHistory } from '../commands/history';
import { useT } from '../i18n';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { useReplayStore } from '../replay/store';
import { IconButton } from '../ui/IconButton';
import { Menu, type MenuItem } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { CHART_TYPE_MENU, chartTypeDef } from './chartTypes';
import { IndicatorTemplatesButton } from './IndicatorTemplatesButton';
import { IntervalControl } from './IntervalControl';
import { LayoutMenu } from './LayoutMenu';
import { LayoutPicker } from './LayoutPicker';
import { OverflowMenu } from './OverflowMenu';
import { PaletteButton } from './PaletteButton';
import { firstShortcut, useCommand } from './useCommand';
import './topbar.css';

const run = (id: string, arg?: unknown) => commands.execute(id, arg);

/** Single-row command bar: symbol | interval | chart type | studies | alerts and replay | layout | settings. */
export function TopBar() {
  const t = useT();
  const replayOn = useReplayStore((s) => s.status !== 'off');
  return (
    <div className="top-bar" role="toolbar" aria-label={t('topbar.toolbar')}>
      <PaletteButton />
      <div className="tb-sep" />
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
      <div className="tb-spacer" />
      <LayoutPicker />
      <LayoutMenu />
      <div className="tb-sep" />
      <div className="tb-sep" />
      <UndoRedo />
      <ThemeButton />
      <OverflowMenu />
    </div>
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
