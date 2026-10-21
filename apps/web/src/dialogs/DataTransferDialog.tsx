import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { ImportCounts, ImportMode, ImportSummary } from '../api/types';
import { getPersistence } from '../persist/bootstrap';
import { exportAllData, importLayoutFile, isLayoutFile, pickJsonFile } from '../persist/commands';
import { isObj, safeStorage } from '../persist/net';
import { importBundle, isFullBundle, latestOnly, type ImportBundle } from '../persist/transfer';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { Segmented } from './controls';
import './dialogs.css';
import './persist.css';

const ENTITIES: [keyof Omit<ImportSummary, 'mode' | 'dryRun'>, string][] = [
  ['layouts', 'Layouts'],
  ['drawings', 'Drawings'],
  ['indicatorTemplates', 'Indicator templates'],
  ['drawingTemplates', 'Drawing templates'],
  ['chartTemplates', 'Chart templates'],
  ['settings', 'Settings'],
  ['notes', 'Notes'],
  ['watchlists', 'Watchlists'],
  ['flags', 'Flags'],
];

export const isBundle = (v: unknown): v is ImportBundle =>
  isObj(v) && v.app === 'tickerglass' && typeof v.version === 'number' && v.kind === undefined;

/**
 * Export all data, or import a backup: the file is always dry-run first and
 * its summary shown; "Replace" (deletes everything first) needs an extra tick.
 */
export default function DataTransferDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [file, setFile] = useState<{ name: string; bundle: ImportBundle } | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [understood, setUnderstood] = useState(false);
  /** Persistence was stopped by a failed import: only a reload continues. */
  const [halted, setHalted] = useState(false);
  /** Latest dry run: older responses (e.g. before a mode switch) are ignored. */
  const [requests] = useState(latestOnly);

  const dryRun = async (bundle: ImportBundle, m: ImportMode) => {
    const isLatest = requests.begin();
    setSummary(null);
    setError(null);
    setBusy(true);
    try {
      const out = await persistence.importAll(bundle, { mode: m, dryRun: true });
      if (isLatest()) setSummary(out);
    } catch (err) {
      if (isLatest()) setError(errorMessage(err));
    } finally {
      if (isLatest()) setBusy(false);
    }
  };

  const pick = async () => {
    const picked = await pickJsonFile();
    if (!picked) return;
    if (isLayoutFile(picked.data)) {
      toast('This is a single layout; use "Import layout…" in the layout menu', 'info');
      return;
    }
    if (!isBundle(picked.data)) {
      setError(`"${picked.name}" is not an TickerGlass backup`);
      return;
    }
    setFile({ name: picked.name, bundle: picked.data });
    setUnderstood(false);
    // Replace needs a full backup: a partial file would leave a mix of old and new data.
    const m = isFullBundle(picked.data) ? mode : 'merge';
    setMode(m);
    await dryRun(picked.data, m);
  };

  const full = !!file && isFullBundle(file.bundle);

  const changeMode = (m: ImportMode) => {
    if (m === 'replace' && !full) return;
    setMode(m);
    setUnderstood(false);
    if (file) void dryRun(file.bundle, m);
  };

  const apply = async () => {
    if (!file || !summary) return;
    requests.invalidate(); // a late dry run must not overwrite the state below
    setBusy(true);
    setError(null);
    const p = getPersistence();
    try {
      await importBundle(file.bundle, mode, {
        storage: safeStorage(),
        persistence: p,
        // Every store changes: restart from the server's data.
        reload: () => {
          toast('Data imported; reloading…', 'success');
          setTimeout(() => location.reload(), 600);
        },
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      // Stopped before the import failed: saving is off until a reload.
      if (p && getPersistence() !== p) setHalted(true);
    }
  };

  const canImport = !!summary && !busy && !halted && (mode === 'merge' || (full && understood));

  return (
    <Modal
      title="Import and export data"
      onClose={onClose}
      width={560}
      className="dlg-transfer"
      footer={
        <>
          <div className="dlg-footer-spacer" />
          <button type="button" className="io-btn" onClick={onClose}>
            Close
          </button>
          {halted ? (
            <button
              type="button"
              className="io-btn io-btn-primary"
              onClick={() => location.reload()}
            >
              Reload app
            </button>
          ) : (
            <button
              type="button"
              className={`io-btn ${mode === 'replace' ? 'io-btn-danger' : 'io-btn-primary'}`}
              disabled={!canImport}
              onClick={() => void apply()}
            >
              {mode === 'replace' ? 'Replace all data' : 'Import'}
            </button>
          )}
        </>
      }
    >
      <div className="xfer-actions">
        <button type="button" className="io-btn" onClick={() => void exportAllData()}>
          <Download size={15} /> Export all data
        </button>
        <button type="button" className="io-btn" onClick={() => void pick()}>
          <Upload size={15} /> Choose backup file…
        </button>
        <button type="button" className="io-btn" onClick={() => void importLayoutFile()}>
          Import a single layout…
        </button>
      </div>
      {file ? (
        <div className="xfer-file">
          <div className="xfer-row">
            <span>
              File: <b>{file.name}</b>
            </span>
            <Segmented
              value={mode}
              options={[
                ['merge', 'Merge'],
                ['replace', 'Replace'],
              ]}
              onChange={changeMode}
            />
          </div>
          <p className="xfer-note">
            {mode === 'merge'
              ? 'Merge: items with the same id or name are overwritten, the rest is added.'
              : 'Replace: all current layouts, drawings, templates, settings and notes are deleted first, then the file is imported.'}
          </p>
          {!full ? (
            <p className="xfer-note">This file is not a full backup, so only Merge is available.</p>
          ) : null}
          {busy && !summary ? <div className="xfer-note">Checking the file…</div> : null}
          {summary ? (
            <table className="xfer-summary" aria-label="Import preview">
              <thead>
                <tr>
                  <th />
                  <th>New</th>
                  <th>Updated</th>
                  <th>Deleted</th>
                </tr>
              </thead>
              <tbody>
                {ENTITIES.map(([k, label]) => {
                  const c: ImportCounts = summary[k];
                  return (
                    <tr key={k}>
                      <td>{label}</td>
                      <td>{c.created}</td>
                      <td>{c.updated}</td>
                      <td>{c.deleted}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          {mode === 'replace' && summary ? (
            <label className="xfer-confirm">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              I understand that current data of these kinds is deleted and replaced by this file.
            </label>
          ) : null}
        </div>
      ) : (
        <p className="xfer-note">
          Backups contain all layouts, drawings, templates, settings and notes. Importing shows a
          preview first; nothing changes until you confirm.
        </p>
      )}
      {error ? (
        <div className="xfer-error" role="alert">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
