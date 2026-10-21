import { KEY_BINDINGS } from '@investopen/engine';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { formatShortcut } from '../commands/registry';
import { normalize } from '../commands/shortcuts';
import { Modal } from '../ui/Modal';
import { useCommandList } from './useCommandList';
import './dialogs.css';

interface Item {
  title: string;
  keys: string[];
}

/** Keys handled outside the command registry. */
const GENERAL: Item[] = [
  { title: 'Open symbol search', keys: ['Any letter'] },
  { title: 'Change interval', keys: ['Any digit'] },
  { title: 'Close dialog or menu', keys: ['Esc'] },
];

/** Every command with a shortcut, grouped by category and searchable. */
export default function ShortcutsDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [query, setQuery] = useState('');
  const all = useCommandList();
  const q = query.trim().toLowerCase();

  const groups = new Map<string, Item[]>();
  for (const c of all) {
    if (!c.shortcut) continue;
    const list = Array.isArray(c.shortcut) ? c.shortcut : [c.shortcut];
    const cat = c.category ?? 'General';
    const items = groups.get(cat) ?? [];
    items.push({ title: c.title, keys: list.map((s) => formatShortcut(s)) });
    groups.set(cat, items);
  }
  // Built-in chart keys (from the engine's own table), unless a command already lists the combo.
  const listed = new Set(
    all
      .flatMap((c) => (Array.isArray(c.shortcut) ? c.shortcut : c.shortcut ? [c.shortcut] : []))
      .map(normalize),
  );
  for (const b of KEY_BINDINGS) {
    if (listed.has(normalize(b.key))) continue;
    const items = groups.get(b.group) ?? [];
    items.push({ title: b.description, keys: [b.key] });
    groups.set(b.group, items);
  }
  groups.set('General', [...GENERAL, ...(groups.get('General') ?? [])]);

  const sections = [...groups.entries()]
    .sort(([a], [b]) => (a === 'General' ? -1 : b === 'General' ? 1 : a.localeCompare(b)))
    .map(([cat, items]) => {
      const catHit = cat.toLowerCase().includes(q);
      const shown = items
        .filter(
          (i) =>
            !q ||
            catHit ||
            i.title.toLowerCase().includes(q) ||
            i.keys.some((k) => k.toLowerCase().includes(q)),
        )
        .sort((a, b) => a.title.localeCompare(b.title));
      return [cat, shown] as const;
    })
    .filter(([, items]) => items.length > 0);

  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={600} className="dlg-shortcuts">
      <div className="dlg-search dlg-search-boxed">
        <Search size={16} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Search shortcuts"
          aria-label="Search shortcuts"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="dlg-shortcut-list">
        {sections.length === 0 ? (
          <div className="dlg-empty">No shortcuts match &ldquo;{query.trim()}&rdquo;</div>
        ) : (
          sections.map(([cat, items]) => (
            <section key={cat} className="dlg-shortcut-group">
              <h3 className="dlg-section-head">{cat}</h3>
              {items.map((i) => (
                <div key={i.title} className="dlg-shortcut-row">
                  <span>{i.title}</span>
                  <span className="dlg-shortcut-keys">
                    {i.keys.map((k, n) => (
                      <span key={k}>
                        {n > 0 ? <span className="dlg-or">or</span> : null}
                        <kbd className="dlg-kbd">{k}</kbd>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </Modal>
  );
}
