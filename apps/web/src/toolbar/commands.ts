import type { MagnetMode } from '@tickerglass/engine';
import { commands, type Command } from '../commands/registry';
import { removeAllDrawings, removeAllObjects } from '../drawings/actions';
import { removeAllIndicators } from '../indicators/actions';
import { useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { dockTools } from './dock';
import { openQuickTools } from './quick';
import { isCursorTool, isToolAvailable, resetToCursor, selectTool, TOOL_GROUPS } from './tools';

/** Hide-button modes; the chosen one is remembered in `groupTools.hide`. */
export type HideMode = 'drawings' | 'indicators' | 'positions' | 'all';

export const HIDE_MODES: { id: HideMode; label: string }[] = [
  { id: 'drawings', label: 'Hide drawings' },
  { id: 'indicators', label: 'Hide indicators' },
  { id: 'positions', label: 'Hide practice trades' },
  { id: 'all', label: 'Hide everything' },
];

export function toHideMode(m: string | undefined): HideMode {
  return HIDE_MODES.find((h) => h.id === m)?.id ?? 'drawings';
}

/** Last non-off magnet mode, remembered in `groupTools.magnet` (default weak). */
export function lastMagnet(): Exclude<MagnetMode, 'off'> {
  return useUiStore.getState().groupTools.magnet === 'strong' ? 'strong' : 'weak';
}

export function setMagnet(mode: MagnetMode): void {
  useAppStore.getState().set({ magnet: mode });
  if (mode !== 'off') {
    const ui = useUiStore.getState();
    ui.set({ groupTools: { ...ui.groupTools, magnet: mode } });
  }
}

export function setHideMode(mode: HideMode): void {
  const ui = useUiStore.getState();
  ui.set({ hideAll: true, groupTools: { ...ui.groupTools, hide: mode } });
}

const modalOpen = () => !!document.querySelector('[data-modal-open], .io-popover');

export function registerToolbarCommands(): () => void {
  const shortcutCommands: Command[] = TOOL_GROUPS.flatMap((g) =>
    g.sections.flatMap((s) =>
      s.tools.flatMap((tool): Command[] =>
        tool.commandId && tool.shortcut
          ? [
              {
                id: tool.commandId,
                title: tool.name,
                category: 'Drawings',
                shortcut: tool.shortcut,
                run: () => selectTool(tool.id),
              },
            ]
          : [],
      ),
    ),
  );

  // Every other tool is reachable by name from the palette ("Draw: Gann box").
  const drawCommands: Command[] = dockTools().flatMap((tool): Command[] =>
    tool.commandId && tool.shortcut
      ? []
      : [
          {
            id: `tool.draw.${tool.id}`,
            title: tool.name,
            category: 'Draw',
            searchOnly: true,
            enabled: () => isToolAvailable(tool.id),
            run: () => selectTool(tool.id),
          },
        ],
  );

  const list: Command[] = [
    {
      id: 'tools.quick',
      title: 'Quick drawing tools at the cursor',
      category: 'Drawings',
      shortcut: 'Alt+d',
      enabled: () => !modalOpen(),
      run: openQuickTools,
    },
    ...drawCommands,
    {
      id: 'tool.select',
      title: 'Select drawing tool',
      category: 'Drawings',
      hidden: true,
      run: (arg) => {
        if (typeof arg === 'string') selectTool(arg);
      },
    },
    {
      id: 'tool.cancel',
      title: 'Back to cursor',
      category: 'Drawings',
      shortcut: 'Escape',
      hidden: true,
      enabled: () => !isCursorTool(useUiStore.getState().activeTool) && !modalOpen(),
      run: resetToCursor,
    },
    ...shortcutCommands,
    {
      id: 'view.toggleToolRail',
      title: 'Show or hide the drawing tool rail',
      category: 'Drawings',
      shortcut: 'Shift+t',
      run: () => useUiStore.getState().toggleToolRail(),
    },
    {
      id: 'drawings.toggleMagnet',
      title: 'Toggle magnet mode',
      category: 'Drawings',
      run: () => setMagnet(useAppStore.getState().magnet === 'off' ? lastMagnet() : 'off'),
    },
    {
      id: 'drawings.toggleStayInDrawingMode',
      title: 'Toggle keep the tool after drawing',
      category: 'Drawings',
      run: () => useUiStore.setState((s) => ({ stayInDrawingMode: !s.stayInDrawingMode })),
    },
    {
      id: 'drawings.toggleSyncNew',
      title: 'Toggle sync new drawings to all symbols',
      category: 'Drawings',
      run: () => useUiStore.setState((s) => ({ syncNewDrawings: !s.syncNewDrawings })),
    },
    {
      id: 'drawings.toggleLockAll',
      title: 'Toggle lock all drawings',
      category: 'Drawings',
      run: () => useUiStore.setState((s) => ({ lockAll: !s.lockAll })),
    },
    {
      id: 'drawings.toggleHideAll',
      title: 'Toggle hide drawings',
      category: 'Drawings',
      run: () => useUiStore.setState((s) => ({ hideAll: !s.hideAll })),
    },
    {
      id: 'drawings.removeAll',
      title: 'Remove drawings',
      category: 'Drawings',
      run: removeAllDrawings,
    },
    {
      id: 'drawings.removeIndicators',
      title: 'Remove indicators',
      category: 'Drawings',
      run: removeAllIndicators,
    },
    {
      id: 'drawings.removeAllObjects',
      title: 'Clear the chart',
      category: 'Drawings',
      run: removeAllObjects,
    },
  ];
  return commands.register(list);
}
