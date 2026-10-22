import { create } from 'zustand';
import { Menu, type MenuItem } from './Menu';
import { Popover } from './Popover';

interface ContextMenuState {
  pos: { x: number; y: number } | null;
  items: MenuItem[];
}

const useContextMenu = create<ContextMenuState>()(() => ({ pos: null, items: [] }));

/** Open a context menu at viewport coordinates. Used by chart, scales,
 * drawings, indicators and watchlist rows. */
export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  useContextMenu.setState({ pos: { x, y }, items });
}

export function closeContextMenu(): void {
  useContextMenu.setState({ pos: null, items: [] });
}

export function ContextMenuHost() {
  const { pos, items } = useContextMenu();
  return (
    <Popover anchor={pos} open={!!pos} onClose={closeContextMenu} sheet>
      <Menu items={items} onClose={closeContextMenu} />
    </Popover>
  );
}
