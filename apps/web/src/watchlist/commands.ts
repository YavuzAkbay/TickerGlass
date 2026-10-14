import { commands, type Command } from '../commands/registry';
import { normalizeSymbol, useAppStore } from '../store/app';
import { useUiStore } from '../store/ui';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { DEFAULT_LIST_NAME, useWatchlistStore, validSymbol } from './store';
import { flagRows, formatTxt, isFlagRef, parseTxt, resolveActive, txtFileName } from './model';
import { useWatchlistPrefs } from './prefs';
import { FLAG_COLORS, type FlagColor, type ListRef, type WatchlistItem } from './types';

const MAX_IMPORT_BYTES = 1024 * 1024;

const activeRef = (): ListRef | null =>
  resolveActive(useWatchlistPrefs.getState().activeId, useWatchlistStore.getState().lists);

const flagColorOf = (ref: ListRef): FlagColor => ref.slice(5) as FlagColor;

/** The active real list (not a flag list), if any. */
function activeList() {
  const ref = activeRef();
  return ref && !isFlagRef(ref) ? (useWatchlistStore.getState().lists[ref] ?? null) : null;
}

/** Display name of a list ref. */
function refName(ref: ListRef): string {
  return isFlagRef(ref)
    ? `${flagColorOf(ref)} flag list`
    : (useWatchlistStore.getState().lists[ref]?.name ?? DEFAULT_LIST_NAME);
}

/** Symbols of a list ref in item order (flag lists: oldest flag first). */
export function listSymbols(ref: ListRef | null): string[] {
  if (!ref) return [];
  const { lists, flags } = useWatchlistStore.getState();
  if (isFlagRef(ref))
    return flagRows(flags, flagColorOf(ref)).flatMap((r) =>
      r.kind === 'symbol' ? [r.symbol] : [],
    );
  return (lists[ref]?.items ?? []).flatMap((i) => (i.type === 'symbol' ? [i.symbol] : []));
}

function addSymbol(arg: unknown): void {
  const sym = normalizeSymbol(typeof arg === 'string' ? arg : useAppStore.getState().symbol);
  if (!sym) return;
  if (!validSymbol(sym)) {
    toast(`Invalid symbol: ${sym}`, 'error');
    return;
  }
  const store = useWatchlistStore.getState();
  let ref = activeRef();
  if (!ref) {
    ref = store.createList(DEFAULT_LIST_NAME);
    useWatchlistPrefs.getState().setActive(ref);
  }
  if (isFlagRef(ref)) {
    const color = flagColorOf(ref);
    if (store.flags[sym]?.color === color) toast(`${sym} is already in ${refName(ref)}`);
    else {
      store.setFlag(sym, color);
      toast(`Added ${sym} to ${refName(ref)}`, 'success');
    }
    return;
  }
  const name = refName(ref);
  if (store.addSymbols(ref, [sym]).length) toast(`Added ${sym} to ${name}`, 'success');
  else toast(`${sym} is already in ${name}`);
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importFile(file: File): Promise<void> {
  if (file.size > MAX_IMPORT_BYTES) {
    toast('The file is larger than 1 MB', 'error');
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    toast('Could not read the file', 'error');
    return;
  }
  const { items, unmapped } = parseTxt(text);
  const count = items.filter((i) => i.type === 'symbol').length;
  if (!count) {
    toast('No symbols found in the file', 'error');
    return;
  }
  const stem = file.name.replace(/\.[^.]*$/, '').trim() || DEFAULT_LIST_NAME;
  const id = useWatchlistStore.getState().createList(stem, items);
  useWatchlistPrefs.getState().setActive(id);
  toast(
    `Imported ${count} symbols${unmapped.length ? ` (${unmapped.length} prefixes unmapped)` : ''}`,
    'success',
  );
}

function pickFile(): void {
  // The toolbar keeps a hidden input mounted while the panel is open.
  const mounted = document.querySelector<HTMLInputElement>('[data-testid="wl-import-input"]');
  if (mounted) {
    mounted.click();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,text/plain';
  input.hidden = true;
  input.setAttribute('data-testid', 'wl-import-input');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void importFile(file);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.appendChild(input);
  input.click();
}

/** Chart symbol one step along the active list. */
function step(dir: 1 | -1): void {
  const syms = listSymbols(activeRef());
  if (!syms.length) return;
  const cur = syms.indexOf(useAppStore.getState().symbol);
  const next = cur < 0 ? (dir > 0 ? 0 : syms.length - 1) : cur + dir;
  const sym = syms[next];
  if (sym) commands.execute('chart.setSymbol', sym);
}

export function registerWatchlistCommands(): () => void {
  const category = 'Watchlist';
  const list: Command[] = [
    {
      id: 'watchlist.addSymbol',
      title: 'Add symbol to watchlist',
      category,
      shortcut: 'Alt+w',
      run: addSymbol,
    },
    {
      id: 'watchlist.searchAdd',
      title: 'Search symbol to add to watchlist…',
      category,
      run: () => useUiStore.getState().openDialog('symbolSearch', { mode: 'watchlist' }),
    },
    {
      id: 'watchlist.create',
      title: 'Create watchlist…',
      category,
      run: async () => {
        const name = await promptName({
          title: 'Create watchlist',
          label: 'List name',
          okLabel: 'Create',
        });
        if (!name) return;
        useWatchlistPrefs.getState().setActive(useWatchlistStore.getState().createList(name));
      },
    },
    {
      id: 'watchlist.rename',
      title: 'Rename watchlist…',
      category,
      enabled: () => !!activeList(),
      run: async () => {
        const cur = activeList();
        if (!cur) return;
        const name = await promptName({
          title: 'Rename watchlist',
          label: 'List name',
          initial: cur.name,
        });
        if (name) useWatchlistStore.getState().renameList(cur.id, name);
      },
    },
    {
      id: 'watchlist.duplicate',
      title: 'Make a copy of watchlist…',
      category,
      enabled: () => !!activeList(),
      run: async () => {
        const cur = activeList();
        if (!cur) return;
        const name = await promptName({
          title: 'Make a copy',
          label: 'List name',
          initial: `${cur.name} copy`,
          okLabel: 'Copy',
        });
        if (!name) return;
        const id = useWatchlistStore.getState().duplicateList(cur.id, name);
        if (id) useWatchlistPrefs.getState().setActive(id);
      },
    },
    {
      id: 'watchlist.delete',
      title: 'Delete watchlist…',
      category,
      enabled: () => !!activeList(),
      run: async () => {
        const cur = activeList();
        if (!cur) return;
        const ok = await confirmDialog({
          title: 'Delete watchlist',
          message: `Delete “${cur.name}”? This cannot be undone.`,
          okLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        useWatchlistStore.getState().deleteList(cur.id);
        useWatchlistPrefs.getState().setActive(null);
      },
    },
    {
      id: 'watchlist.addSection',
      title: 'Add section to watchlist…',
      category,
      enabled: () => !!activeList(),
      run: async (arg) => {
        const cur = activeList();
        if (!cur) return;
        const at =
          arg && typeof arg === 'object' && typeof (arg as { at?: unknown }).at === 'number'
            ? (arg as { at: number }).at
            : undefined;
        const title = await promptName({
          title: 'Add section',
          label: 'Section name',
          okLabel: 'Add',
        });
        if (!title) return;
        if (!useWatchlistStore.getState().addSection(cur.id, title, at))
          toast('The list is full', 'error');
      },
    },
    { id: 'watchlist.import', title: 'Import watchlist (.txt)…', category, run: pickFile },
    {
      id: 'watchlist.export',
      title: 'Export watchlist (.txt)',
      category,
      enabled: () => activeRef() !== null,
      run: () => {
        const ref = activeRef();
        if (!ref) return;
        const items: WatchlistItem[] = isFlagRef(ref)
          ? listSymbols(ref).map((symbol) => ({ type: 'symbol', symbol }))
          : (useWatchlistStore.getState().lists[ref]?.items ?? []);
        download(txtFileName(refName(ref)), formatTxt(items));
      },
    },
    {
      id: 'watchlist.flag',
      title: 'Flag symbol',
      category,
      hidden: true,
      run: (arg) => {
        if (!arg || typeof arg !== 'object') return;
        const { symbol, color } = arg as { symbol?: unknown; color?: unknown };
        if (typeof symbol !== 'string') return;
        if (color === null) useWatchlistStore.getState().setFlag(symbol, null);
        else if ((FLAG_COLORS as readonly unknown[]).includes(color))
          useWatchlistStore.getState().setFlag(symbol, color as FlagColor);
      },
    },
    {
      id: 'watchlist.remove',
      title: 'Remove symbol from watchlist',
      category,
      hidden: true,
      run: (arg) => {
        if (typeof arg !== 'string') return;
        const ref = activeRef();
        if (!ref) return;
        if (isFlagRef(ref)) useWatchlistStore.getState().setFlag(arg, null);
        else useWatchlistStore.getState().removeSymbols(ref, [arg]);
      },
    },
    {
      id: 'watchlist.openInNewChart',
      title: 'Open symbol in new chart',
      category,
      hidden: true,
      run: () => toast('Multi-chart layouts arrive in Phase 14'),
    },
    { id: 'watchlist.next', title: 'Next symbol in watchlist', category, run: () => step(1) },
    { id: 'watchlist.prev', title: 'Previous symbol in watchlist', category, run: () => step(-1) },
  ];
  return commands.register(list);
}
