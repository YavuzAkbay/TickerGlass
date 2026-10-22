import {
  AlarmClock,
  Camera,
  Database,
  GitCompareArrows,
  Keyboard,
  Maximize,
  Moon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Rewind,
  Settings,
  Sun,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import { useHistory } from '../commands/history';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import { useReplayStore } from '../replay/store';
import { useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { firstShortcut, useCommand } from './useCommand';

/**
 * "More" menu: compare, alert, settings, snapshot, fullscreen, shortcuts and the
 * drawing toolbar toggle. `folded` also takes in the bar buttons that no longer
 * fit (replay, undo/redo, theme).
 */
export function OverflowMenu({ folded = false }: { folded?: boolean }) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const hasChart = useChartStore((s) => !!s.chart);
  const railHidden = useUiStore((s) => s.toolRailHidden);
  const settings = firstShortcut(useCommand('chart.settings'));
  const snap = firstShortcut(useCommand('chart.screenshot'));
  const snapCopy = firstShortcut(useCommand('chart.screenshot.copy'));
  const full = firstShortcut(useCommand('view.fullscreen'));
  const keys = firstShortcut(useCommand('view.shortcuts'));
  const rail = firstShortcut(useCommand('view.toggleToolRail'));
  const replayOn = useReplayStore((s) => s.status !== 'off');
  const theme = useAppStore((s) => s.theme);
  const canUndo = useHistory((s) => s.past.length > 0);
  const canRedo = useHistory((s) => s.future.length > 0);
  const undoLabel = useHistory((s) => s.past.at(-1)?.label);
  const redoLabel = useHistory((s) => s.future[0]?.label);
  const replay = firstShortcut(useCommand('replay.toggle'));
  const undo = firstShortcut(useCommand('edit.undo'));
  const redo = firstShortcut(useCommand('edit.redo'));

  // Put focus back on the trigger first so a dialog opened by the item records
  // "More" (not the closing menu) as the element to restore focus to.
  const act = (fn: () => void) => () => {
    anchor?.focus({ preventScroll: true });
    fn();
  };
  const run = (id: string) => act(() => void commands.execute(id));

  const compare = firstShortcut(useCommand('chart.compare'));
  const alert = firstShortcut(useCommand('alert.create'));

  const foldedItems: MenuItem[] = [
    {
      label: t('topbar.replay'),
      icon: Rewind,
      checked: replayOn,
      ...(replay ? { shortcut: replay } : {}),
      onSelect: run('replay.toggle'),
    },
    {
      label: undoLabel ? t('topbar.undoItem', { label: undoLabel }) : t('topbar.undo'),
      icon: Undo2,
      disabled: !canUndo,
      ...(undo ? { shortcut: undo } : {}),
      onSelect: run('edit.undo'),
    },
    {
      label: redoLabel ? t('topbar.redoItem', { label: redoLabel }) : t('topbar.redo'),
      icon: Redo2,
      disabled: !canRedo,
      ...(redo ? { shortcut: redo } : {}),
      onSelect: run('edit.redo'),
    },
    {
      label: theme === 'dark' ? t('topbar.themeLight') : t('topbar.themeDark'),
      icon: theme === 'dark' ? Sun : Moon,
      onSelect: run('view.toggleTheme'),
    },
    { type: 'separator' },
  ];

  const items: MenuItem[] = [
    ...(folded ? foldedItems : []),
    {
      label: t('topbar.compare'),
      icon: GitCompareArrows,
      disabled: !hasChart,
      ...(compare ? { shortcut: compare } : {}),
      onSelect: run('chart.compare'),
    },
    {
      label: t('topbar.alert'),
      icon: AlarmClock,
      ...(alert ? { shortcut: alert } : {}),
      onSelect: run('alert.create'),
    },
    { type: 'separator' },
    {
      label: t('topbar.settings'),
      icon: Settings,
      ...(settings ? { shortcut: settings } : {}),
      onSelect: run('chart.settings'),
    },
    {
      label: t('topbar.snapshotMenu'),
      icon: Camera,
      disabled: !hasChart,
      submenu: [
        {
          label: t('topbar.downloadImage'),
          ...(snap ? { shortcut: snap } : {}),
          onSelect: run('chart.screenshot'),
        },
        {
          label: t('topbar.copyImage'),
          ...(snapCopy ? { shortcut: snapCopy } : {}),
          onSelect: run('chart.screenshot.copy'),
        },
      ],
    },
    {
      label: document.fullscreenElement ? t('topbar.exitFullscreen') : t('topbar.fullscreen'),
      icon: Maximize,
      ...(full ? { shortcut: full } : {}),
      onSelect: run('view.fullscreen'),
    },
    { type: 'separator' },
    {
      label: t('topbar.dataSource'),
      icon: Database,
      onSelect: run('app.dataSource'),
    },
    {
      label: t('topbar.shortcuts'),
      icon: Keyboard,
      ...(keys ? { shortcut: keys } : {}),
      onSelect: run('view.shortcuts'),
    },
    {
      label: railHidden ? t('topbar.showTools') : t('topbar.hideTools'),
      icon: railHidden ? PanelRightOpen : PanelRightClose,
      ...(rail ? { shortcut: rail } : {}),
      onSelect: act(() => useUiStore.getState().toggleToolRail()),
    },
  ];

  return (
    <>
      <IconButton
        ref={setAnchor}
        icon={MoreHorizontal}
        label={t('topbar.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <DropdownMenu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        placement="bottom-end"
      />
    </>
  );
}
