import { isExpressionSymbol } from '@tickerglass/engine';
import { commands, type Command } from '../commands/registry';
import { addChartWithSymbol, canAddChart } from '../layout/actions';
import { normalizeSymbol } from '../store/app';
import { useChartView } from '../store/chartView';
import { useUiStore } from '../store/ui';
import { confirmDialog, promptName } from '../ui/Prompt';
import { useQuoteStore } from '../quotes/store';
import { peekSnapshots } from '../screener/server/snapshot';
import { importShareFile, pickShareFile, shareWatchlist } from '../share/open';
import { toast } from '../ui/Toast';
import { removeWithUndo } from './actions';
import { isSnapshotColumn } from './columns/registry';
import { DEFAULT_LIST_NAME, useWatchlistStore, validSymbol } from './store';
import {
  addBlocker,
  describeImport,
  displayOrder,
  flagRows,
  formatTxt,
  isFlagRef,
  parseTxt,
  type ParsedTxt,
  resolveActive,
  type SymbolMeta,
  txtFileName,
} from './model';
import { useWatchlistPagePrefs } from './page/pagePrefs';
import { peekSymbolMeta } from './page/symbolMeta';
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
  const sym = normalizeSymbol(typeof arg === 'string' ? arg : useChartView.getState().symbol);
  if (!sym) return;
  if (isExpressionSymbol(sym)) {
    toast("Symbol expressions can't be added to watchlists", 'error');
    return;
  }
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
  else if (addBlocker(store.lists[ref]?.items ?? [], sym) === 'full')
    toast('The list is full', 'error');
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
  // A file shared from a TickerGlass share dialog: preview first, import on confirmation.
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    await importShareFile(file);
    return;
  }
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
  const stem = file.name.replace(/\.[^.]*$/, '').trim() || DEFAULT_LIST_NAME;
  finishImport(parseTxt(text), stem, 'the file');
}

/** Create the list from a parse result and say what was (not) imported. */
function finishImport(parsed: ParsedTxt, name: string, source: string): boolean {
  const count = parsed.items.filter((i) => i.type === 'symbol').length;
  const issues = !!(
    parsed.unmapped.length ||
    parsed.skipped ||
    parsed.duplicates ||
    parsed.truncated
  );
  if (!count) {
    const detail = issues
      ? `: ${describeImport(parsed, 0).replace(/^Imported 0 symbols?; ?/, '')}`
      : '';
    toast(`No symbols found in ${source}${detail}`, 'error', issues ? 10_000 : 3500);
    return false;
  }
  const id = useWatchlistStore.getState().createList(name, parsed.items);
  useWatchlistPrefs.getState().setActive(id);
  toast(describeImport(parsed, count), issues ? 'info' : 'success', issues ? 10_000 : 3500);
  return true;
}

/**
 * Import pasted text (symbols separated by commas, spaces or new lines, the
 * `.txt` format's `EXCHANGE:TICKER` entries included) as a new list.
 */
export function importText(text: string, name = 'Pasted symbols'): boolean {
  if (new Blob([text]).size > MAX_IMPORT_BYTES) {
    toast('The text is larger than 1 MB', 'error');
    return false;
  }
  return finishImport(parseTxt(text, { loose: true }), name, 'the text');
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

/**
 * Symbols of the active list as the table shows them: the current sort of the
 * screen in front (page or sidebar), collapsed sections skipped.
 */
export function displayedSymbols(ref: ListRef | null): string[] {
  if (!ref) return [];
  const { lists } = useWatchlistStore.getState();
  const items: WatchlistItem[] = isFlagRef(ref)
    ? listSymbols(ref).map((symbol) => ({ type: 'symbol', symbol }))
    : (lists[ref]?.items ?? []);
  const onPage = useUiStore.getState().screen === 'watchlists';
  const sort = onPage ? useWatchlistPagePrefs.getState().sort : useWatchlistPrefs.getState().sort;
  let meta: Record<string, SymbolMeta | undefined> | undefined;
  if (sort?.key === 'name') {
    meta = {};
    for (const i of items)
      if (i.type === 'symbol') meta[i.symbol] = peekSymbolMeta(i.symbol) ?? undefined;
  }
  return displayOrder(
    items,
    sort,
    useQuoteStore.getState().quotes,
    useWatchlistPrefs.getState().collapsed,
    meta,
    sort && isSnapshotColumn(sort.key)
      ? peekSnapshots(items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])))
      : undefined,
  );
}

/** Chart symbol one step along the active list, in displayed order. */
function step(dir: 1 | -1): void {
  const syms = displayedSymbols(activeRef());
  if (!syms.length) return;
  const cur = syms.indexOf(useChartView.getState().symbol);
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
      id: 'watchlist.importText',
      title: 'Import from text…',
      category,
      run: async (arg) => {
        const given =
          typeof arg === 'string'
            ? arg
            : arg && typeof arg === 'object' && typeof (arg as { text?: unknown }).text === 'string'
              ? (arg as { text: string }).text
              : null;
        const text =
          given ??
          (await promptName({
            title: 'Import from text',
            label: 'Symbols (comma, space or new line separated)',
            okLabel: 'Import',
          }));
        if (text) importText(text);
      },
    },
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
      id: 'watchlist.share',
      title: 'Share watchlist…',
      category,
      enabled: () => activeRef() !== null,
      run: (arg) => shareWatchlist(typeof arg === 'string' ? arg : activeRef()),
    },
    {
      id: 'watchlist.importShared',
      title: 'Import shared watchlist or screen (.json)…',
      category,
      run: pickShareFile,
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
        if (ref) removeWithUndo(ref, [arg]); // toasts with "Undo"
      },
    },
    {
      id: 'watchlist.openInNewChart',
      title: 'Open symbol in new chart',
      category,
      hidden: true,
      enabled: canAddChart,
      run: (arg) => {
        const symbol = normalizeSymbol(
          typeof arg === 'string' ? arg : useChartView.getState().symbol,
        );
        if (symbol) addChartWithSymbol(symbol);
      },
    },
    { id: 'watchlist.next', title: 'Next symbol in watchlist', category, run: () => step(1) },
    { id: 'watchlist.prev', title: 'Previous symbol in watchlist', category, run: () => step(-1) },
    {
      id: 'view.watchlists',
      title: 'Open watchlists screen',
      category,
      shortcut: 'Alt+Shift+W',
      run: () => useUiStore.getState().openScreen('watchlists'),
    },
    {
      id: 'view.watchlists.close',
      title: 'Close watchlists screen',
      category,
      enabled: () => useUiStore.getState().screen === 'watchlists',
      run: () => useUiStore.getState().closeScreen(),
    },
  ];
  return commands.register(list);
}
