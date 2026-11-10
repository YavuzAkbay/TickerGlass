/**
 * Entry points of the share dialogs: a tiny store (`ShareHost` renders what it holds) and
 * the functions that open it. Kept free of React and of the heavy dialog code, so the
 * watchlist commands and menus can import it without pulling the dialogs into the main chunk.
 */
import { create } from 'zustand';
import { t } from '../i18n';
import { toast } from '../ui/Toast';
import { flagRows, isFlagRef } from '../watchlist/model';
import { useWatchlistStore } from '../watchlist/store';
import type { FlagColor, ListRef, WatchlistItem } from '../watchlist/types';
import type { ScreenSpec } from '../screener/server/types';
import {
  MAX_DOCUMENT_BYTES,
  parseShareJson,
  payloadFromHash,
  ShareError,
  toShareItems,
  type ShareErrorCode,
  type SharePayload,
} from './codec';

export type ShareRequest =
  | { kind: 'share'; payload: SharePayload }
  | { kind: 'import'; payload: SharePayload; source: 'link' | 'file' }
  | { kind: 'error'; code: ShareErrorCode; source: 'link' | 'file' };

export const useShareUi = create<{ request: ShareRequest | null }>()(() => ({ request: null }));

/** Remove `#tg-import=...` from the address bar (the link was handled or dismissed). */
export function stripShareFragment(): void {
  if (typeof location === 'undefined' || payloadFromHash(location.hash) === null) return;
  history.replaceState(history.state, '', location.pathname + location.search);
}

export function closeShare(): void {
  const r = useShareUi.getState().request;
  useShareUi.setState({ request: null });
  if (r && r.kind !== 'share' && r.source === 'link') stripShareFragment();
}

export const openImport = (payload: SharePayload, source: 'link' | 'file'): void =>
  useShareUi.setState({ request: { kind: 'import', payload, source } });

export const openImportError = (error: unknown, source: 'link' | 'file'): void =>
  useShareUi.setState({
    request: {
      kind: 'error',
      code: error instanceof ShareError ? error.code : 'invalid',
      source,
    },
  });

/** Items of a list ref (flag lists: their symbols, oldest flag first) and its display name. */
function listContent(ref: ListRef): { name: string; items: WatchlistItem[] } | null {
  const { lists, flags } = useWatchlistStore.getState();
  if (isFlagRef(ref))
    return {
      name: `${ref.slice(5)} flag list`,
      items: flagRows(flags, ref.slice(5) as FlagColor).flatMap((r): WatchlistItem[] =>
        r.kind === 'symbol' ? [{ type: 'symbol', symbol: r.symbol }] : [],
      ),
    };
  const entry = lists[ref];
  return entry ? { name: entry.name, items: entry.items } : null;
}

/** Open the share dialog for a list. */
export function shareWatchlist(ref: ListRef | null): void {
  const content = ref ? listContent(ref) : null;
  if (!content) {
    toast(t('share.noList'), 'error');
    return;
  }
  useShareUi.setState({
    request: {
      kind: 'share',
      payload: { v: 1, type: 'watchlist', name: content.name, items: toShareItems(content.items) },
    },
  });
}

/** Open the share dialog for these symbols (a selection) as a list called `name`. */
export function shareSymbols(name: string, symbols: readonly string[]): void {
  useShareUi.setState({
    request: { kind: 'share', payload: { v: 1, type: 'watchlist', name, items: [...symbols] } },
  });
}

/**
 * Open the share dialog for a screen. A universe made of a local watchlist is replaced by the
 * list's symbols (a list id means nothing on another instance).
 */
export function shareScreen(name: string, spec: ScreenSpec): void {
  let universe = spec.universe;
  if (universe.kind === 'watchlist') {
    const list = useWatchlistStore.getState().lists[universe.id];
    if (!list) {
      toast(t('share.noList'), 'error');
      return;
    }
    const symbols = list.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : []));
    universe = { kind: 'symbols', symbols };
  }
  useShareUi.setState({
    request: {
      kind: 'share',
      payload: { v: 1, type: 'screen', name, spec: { ...spec, universe } },
    },
  });
}

/** Open the import dialog for the text of a share file. */
export function importShareText(text: string): void {
  try {
    openImport(parseShareJson(text), 'file');
  } catch (e) {
    openImportError(e, 'file');
  }
}

/** Open the import dialog for a share file (`.json` as downloaded from the share dialog). */
export async function importShareFile(file: File): Promise<void> {
  if (file.size > MAX_DOCUMENT_BYTES) {
    openImportError(new ShareError('too_large'), 'file');
    return;
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    toast(t('share.readFailed'), 'error');
    return;
  }
  importShareText(text);
}

/** File picker for a share file. */
export function pickShareFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.hidden = true;
  input.setAttribute('data-testid', 'share-import-input');
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void importShareFile(file);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.appendChild(input);
  input.click();
}
