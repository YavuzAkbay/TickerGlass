/** Layout and data commands (top-bar layout menu, shortcuts, command palette). */
import { CloudUpload, FolderOpen } from 'lucide-react';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { LayoutFile } from '../api/types';
import { commands, type Command } from '../commands/registry';
import { useUiStore } from '../store/ui';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { getPersistence } from './bootstrap';
import { downloadJson, safeFileName, useLayoutStatus } from './layouts';
import { isObj } from './net';

const session = () => {
  const p = getPersistence();
  if (!p?.layouts.connected) {
    toast('The server is unreachable; layouts can be managed when it is back', 'error');
    void p?.reconnect();
    return null;
  }
  return p.layouts;
};

const currentName = () => useLayoutStatus.getState().current?.name ?? '';

/** Run a layout operation, reporting failures. */
async function attempt(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(`${what}: ${errorMessage(err)}`, 'error', 6000);
  }
}

export const confirmDiscard = () =>
  confirmDialog({
    title: 'Unsaved changes',
    message: `Changes to "${currentName()}" could not be saved to the server. Switch anyway and discard them?`,
    okLabel: 'Discard changes',
    danger: true,
  });

export async function saveLayout(): Promise<void> {
  const s = session();
  if (!s) return;
  await attempt('Layout could not be saved', async () => {
    if (await s.save()) toast('Layout saved', 'success', 2000);
    else toast('Layout not saved yet; retrying', 'error');
  });
}

export async function saveLayoutAs(): Promise<void> {
  const s = session();
  if (!s) return;
  const name = await promptName({ title: 'Save layout as', initial: `${currentName()} copy` });
  if (name) await attempt('Layout could not be saved', () => s.saveAs(name));
}

export async function renameLayout(): Promise<void> {
  const s = session();
  if (!s) return;
  const name = await promptName({
    title: 'Rename layout',
    initial: currentName(),
    okLabel: 'Rename',
  });
  if (name && name !== currentName())
    await attempt('Layout could not be renamed', () => s.rename(name));
}

export async function copyLayout(): Promise<void> {
  const s = session();
  if (!s) return;
  const name = await promptName({
    title: 'Make a copy',
    initial: `${currentName()} copy`,
    okLabel: 'Copy',
  });
  if (name) await attempt('Layout could not be copied', () => s.copy(name));
}

export async function loadLayout(id: string): Promise<boolean> {
  const s = session();
  if (!s) return false;
  let ok = false;
  await attempt('Layout could not be loaded', async () => {
    ok = await s.load(id, confirmDiscard);
  });
  return ok;
}

export async function deleteLayout(id: string, name: string): Promise<boolean> {
  const s = session();
  if (!s) return false;
  const yes = await confirmDialog({
    title: 'Delete layout',
    message: `Delete "${name}"? This cannot be undone.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!yes) return false;
  let ok = false;
  await attempt('Layout could not be deleted', async () => {
    await s.remove(id);
    ok = true;
    toast(`Layout "${name}" deleted`, 'success', 2500);
  });
  return ok;
}

export async function exportLayout(): Promise<void> {
  const s = session();
  if (!s) return;
  await attempt('Layout could not be exported', async () => {
    const { file, name } = await s.exportCurrent();
    downloadJson(file, `${safeFileName(name)}.layout.json`);
  });
}

/** Pick a JSON file; resolves to its parsed content (null when cancelled or unreadable). */
export function pickJsonFile(): Promise<{ name: string; data: unknown } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, data: JSON.parse(await file.text()) });
      } catch {
        toast(`"${file.name}" is not a valid JSON file`, 'error');
        resolve(null);
      }
    };
    input.click();
  });
}

export const isLayoutFile = (v: unknown): v is LayoutFile =>
  isObj(v) && v.kind === 'layout' && isObj(v.layout) && typeof v.version === 'number';

export async function importLayoutFile(): Promise<void> {
  const s = session();
  if (!s) return;
  const picked = await pickJsonFile();
  if (!picked) return;
  if (!isLayoutFile(picked.data)) {
    toast('Not a layout file (use "Import data…" for full backups)', 'error');
    return;
  }
  const file = picked.data;
  await attempt('Layout could not be imported', async () => {
    if (await s.importFile(file, confirmDiscard))
      toast(`Layout "${file.layout.name}" imported`, 'success');
  });
}

/** Download all user data (layouts, drawings, templates, settings, notes). */
export async function exportAllData(): Promise<void> {
  await attempt('Data could not be exported', async () => {
    await getPersistence()?.flushAll();
    const bundle = await persistence.exportAll();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(bundle, `investopen-backup-${stamp}.json`);
  });
}

export function registerLayoutCommands(): () => void {
  const list: Command[] = [
    {
      id: 'layout.save',
      title: 'Save layout',
      category: 'Layout',
      shortcut: 'Mod+s',
      allowInInput: true,
      icon: CloudUpload,
      run: saveLayout,
    },
    { id: 'layout.saveAs', title: 'Save layout as…', category: 'Layout', run: saveLayoutAs },
    { id: 'layout.rename', title: 'Rename layout…', category: 'Layout', run: renameLayout },
    { id: 'layout.copy', title: 'Make a copy of the layout…', category: 'Layout', run: copyLayout },
    {
      id: 'layout.load',
      title: 'Load layout…',
      category: 'Layout',
      icon: FolderOpen,
      run: () => useUiStore.getState().openDialog('loadLayout'),
    },
    {
      id: 'layout.delete',
      title: 'Delete layout…',
      category: 'Layout',
      run: async () => {
        const id = useLayoutStatus.getState().current?.id;
        if (id) await deleteLayout(id, currentName());
      },
    },
    { id: 'layout.export', title: 'Export layout', category: 'Layout', run: exportLayout },
    { id: 'layout.import', title: 'Import layout…', category: 'Layout', run: importLayoutFile },
    { id: 'data.export', title: 'Export all data', category: 'Data', run: exportAllData },
    {
      id: 'data.import',
      title: 'Import data…',
      category: 'Data',
      run: () => useUiStore.getState().openDialog('dataTransfer'),
    },
  ];
  return commands.register(list);
}
