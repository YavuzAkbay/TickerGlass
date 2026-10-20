import { ChevronDown, Cloud, CloudAlert, CloudOff, CloudUpload } from 'lucide-react';
import { useState } from 'react';
import { commands } from '../commands/registry';
import { useLayoutStatus } from '../persist/layouts';
import { DropdownMenu, type MenuItem } from '../ui/Menu';

const run = (id: string) => commands.execute(id);

/** Current layout name with save status, and the layout menu ("Manage layouts"). */
export function LayoutMenu() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = useLayoutStatus((s) => s.current);
  const online = useLayoutStatus((s) => s.online);
  const ready = useLayoutStatus((s) => s.ready);
  const dirty = useLayoutStatus((s) => s.dirty || s.drawingsPending);
  const connected = online && !!current?.id;
  const name = current?.name ?? (ready ? 'Untitled' : 'Loading…');

  const status = !online
    ? 'Offline: changes are kept in this browser'
    : dirty
      ? 'Unsaved changes'
      : 'All changes saved';
  const Icon = !online ? CloudOff : dirty ? CloudUpload : current ? Cloud : CloudAlert;

  const items: MenuItem[] = [
    {
      label: 'Save layout',
      shortcut: 'Mod+s',
      disabled: !connected,
      onSelect: () => run('layout.save'),
    },
    { label: 'Save as…', disabled: !connected, onSelect: () => run('layout.saveAs') },
    { label: 'Rename…', disabled: !connected, onSelect: () => run('layout.rename') },
    { label: 'Make a copy…', disabled: !connected, onSelect: () => run('layout.copy') },
    { type: 'separator' },
    { label: 'Load layout…', disabled: !connected, onSelect: () => run('layout.load') },
    {
      label: 'Delete layout…',
      danger: true,
      disabled: !connected,
      onSelect: () => run('layout.delete'),
    },
    { type: 'separator' },
    { label: 'Export layout', disabled: !connected, onSelect: () => run('layout.export') },
    { label: 'Import layout…', disabled: !connected, onSelect: () => run('layout.import') },
    { type: 'separator' },
    { label: 'Export all data', disabled: !online, onSelect: () => run('data.export') },
    { label: 'Import data…', disabled: !online, onSelect: () => run('data.import') },
    { type: 'separator' },
    { type: 'custom', render: () => <div className="tb-menu-note">{status}</div> },
  ];

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-layout${open ? ' open' : ''}${dirty ? ' dirty' : ''}`}
        aria-label={`Layout: ${name}${dirty ? ' (unsaved changes)' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : status}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon size={16} strokeWidth={1.6} className="tb-muted" />
        <span className="tb-layout-name">{name}</span>
        {dirty ? <span className="tb-dirty" aria-hidden /> : null}
        <ChevronDown size={14} strokeWidth={1.6} className="tb-muted" />
      </button>
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
