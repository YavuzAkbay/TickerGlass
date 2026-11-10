import {
  Bell,
  BellOff,
  BookmarkPlus,
  ChevronDown,
  Pencil,
  Save,
  Share2,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { useT } from '../../i18n';
import { shareScreen } from '../../share/open';
import { Popover } from '../../ui/Popover';
import { confirmDialog, promptName } from '../../ui/Prompt';
import { toast } from '../../ui/Toast';
import { createScreen, deleteScreen, listScreens, saveScreen, screenConflict } from '../server/api';
import { specKey } from '../server/spec';
import type { Preset, Screen, ScreenAlert, ScreenNotify, ScreenSpec } from '../server/types';

interface Props {
  /** The spec being edited (universe, filter, sort). */
  draft: ScreenSpec;
  /** Visible table columns, saved with the screen. */
  columns: string[];
  activeId: string | null;
  presets: Preset[];
  /** Load a saved screen (id) or a built-in preset (null) into the draft. */
  onLoad: (spec: ScreenSpec, id: string | null) => void;
  onActive: (id: string | null) => void;
}

const DEFAULT_NOTIFY: ScreenNotify = { webhook: true, telegram: false, email: false };
const CHANNELS = ['webhook', 'telegram', 'email'] as const;

/** Saved screens: save as, load, rename, delete, alert toggle; built-in presets below. */
export function SavedScreensMenu({ draft, columns, activeId, presets, onLoad, onActive }: Props) {
  const t = useT();
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [failed, setFailed] = useState(false);
  // Bumped by every local change (save, rename, delete). A list request issued before one
  // answers with the screens as they were, and must not overwrite the change.
  const edits = useRef(0);

  const reload = useCallback(async () => {
    const issued = edits.current;
    try {
      const all = await listScreens();
      if (edits.current === issued) setScreens(all);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  // On mount and each time the menu opens (another tab may have saved screens).
  useEffect(() => {
    let live = true;
    const issued = edits.current;
    listScreens().then(
      (all) => {
        if (!live || edits.current !== issued) return;
        setScreens(all);
        setFailed(false);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open]);

  const active = screens.find((s) => s.id === activeId) ?? null;
  const spec = (): ScreenSpec => ({ ...draft, schemaVersion: 1, columns });
  const dirty = !!active && specKey(active.spec) !== specKey(draft);

  const upsert = (screen: Screen) => {
    edits.current++;
    setScreens((all) =>
      all.some((s) => s.id === screen.id)
        ? all.map((s) => (s.id === screen.id ? screen : s))
        : [...all, screen],
    );
  };

  const fail = async (e: unknown) => {
    toast(t('scr.scr.failed').replace('{error}', errorMessage(e)), 'error');
    await reload();
  };

  const patch = async (
    screen: Screen,
    change: { name?: string; spec?: ScreenSpec; alert?: ScreenAlert },
    okMessage?: string,
  ) => {
    try {
      const { screen: saved, overwrote } = await saveScreen(screen, change);
      upsert(saved);
      if (overwrote) toast(t('scr.scr.overwrote').replace('{name}', saved.name), 'info');
      else if (okMessage) toast(okMessage, 'success');
    } catch (e) {
      if (screenConflict(e)) await reload();
      await fail(e);
    }
  };

  const saveAs = async () => {
    const name = await promptName({
      title: t('scr.scr.saveAs'),
      label: t('scr.scr.name'),
      initial: active ? `${active.name} (2)` : '',
      okLabel: t('scr.scr.save'),
    });
    if (!name) return;
    const id = crypto.randomUUID();
    try {
      const created = await createScreen({ id, name, spec: spec(), alert: null });
      upsert(created);
      onActive(created.id);
      toast(t('scr.scr.saved').replace('{name}', created.name), 'success');
    } catch (e) {
      await fail(e);
    }
  };

  const rename = async (screen: Screen) => {
    const name = await promptName({
      title: t('scr.scr.rename'),
      label: t('scr.scr.name'),
      initial: screen.name,
      okLabel: t('scr.scr.save'),
    });
    if (name && name !== screen.name) await patch(screen, { name });
  };

  const remove = async (screen: Screen) => {
    const ok = await confirmDialog({
      title: t('scr.scr.delete'),
      message: t('scr.scr.deleteConfirm').replace('{name}', screen.name),
      okLabel: t('scr.scr.delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteScreen(screen.id);
      edits.current++;
      setScreens((all) => all.filter((s) => s.id !== screen.id));
      if (activeId === screen.id) onActive(null);
    } catch (e) {
      await fail(e);
    }
  };

  const setAlert = (screen: Screen, next: ScreenAlert) => void patch(screen, { alert: next });
  const toggleAlert = (screen: Screen) =>
    setAlert(
      screen,
      screen.alert
        ? { ...screen.alert, enabled: !screen.alert.enabled }
        : { enabled: true, notify: { ...DEFAULT_NOTIFY } },
    );

  return (
    <>
      <button
        type="button"
        ref={setBtn}
        className={`scr-drop${active ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="scr-screens-btn"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="scr-screens-name">{active ? active.name : t('scr.scr.screens')}</span>
        {dirty ? (
          <span className="scr-screens-dirty" title={t('scr.scr.modified')}>
            *
          </span>
        ) : null}
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <Popover
        anchor={btn}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        className="scr-screens-pop"
        ignore={[btn]}
      >
        <div className="scr-screens" data-testid="scr-screens">
          <div className="scr-screens-actions">
            <button
              type="button"
              className="io-btn"
              data-testid="scr-save-as"
              onClick={() => void saveAs()}
            >
              <BookmarkPlus size={13} aria-hidden="true" />
              {t('scr.scr.saveAs')}
            </button>
            {active ? (
              <button
                type="button"
                className="io-btn"
                data-testid="scr-save-changes"
                disabled={!dirty}
                onClick={() => void patch(active, { spec: spec() }, t('scr.scr.updated'))}
              >
                <Save size={13} aria-hidden="true" />
                {t('scr.scr.update')}
              </button>
            ) : null}
          </div>

          <div className="scr-screens-head">{t('scr.scr.mine')}</div>
          {screens.length === 0 ? (
            <div className="scr-screens-empty">
              {failed ? t('scr.scr.unavailable') : t('scr.scr.none')}
            </div>
          ) : (
            <ul className="scr-screens-list">
              {screens.map((s) => (
                <li
                  key={s.id}
                  className={s.id === activeId ? 'on' : ''}
                  data-testid={`scr-screen-${s.id}`}
                >
                  <button
                    type="button"
                    className="scr-screens-load"
                    data-testid="scr-screen-load"
                    onClick={() => {
                      onLoad(s.spec, s.id);
                      setOpen(false);
                    }}
                  >
                    {s.name}
                  </button>
                  <button
                    type="button"
                    className={`rb-icon-btn${s.alert?.enabled ? ' on' : ''}`}
                    aria-pressed={!!s.alert?.enabled}
                    aria-label={t('scr.scr.alertToggle').replace('{name}', s.name)}
                    title={t('scr.scr.alertLabel')}
                    data-testid="scr-screen-alert"
                    onClick={() => toggleAlert(s)}
                  >
                    {s.alert?.enabled ? (
                      <Bell size={13} aria-hidden="true" />
                    ) : (
                      <BellOff size={13} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="rb-icon-btn"
                    aria-label={t('share.menu.shareScreen', { name: s.name })}
                    title={t('share.menu.share')}
                    data-testid="scr-screen-share"
                    onClick={() => {
                      setOpen(false);
                      shareScreen(s.name, s.spec);
                    }}
                  >
                    <Share2 size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="rb-icon-btn"
                    aria-label={t('scr.scr.rename')}
                    title={t('scr.scr.rename')}
                    onClick={() => void rename(s)}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="rb-icon-btn"
                    aria-label={t('scr.scr.delete')}
                    title={t('scr.scr.delete')}
                    onClick={() => void remove(s)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {active?.alert?.enabled ? (
            <fieldset className="scr-alert" data-testid="scr-alert-panel">
              <legend>{t('scr.scr.alertLabel')}</legend>
              {CHANNELS.map((ch) => (
                <label key={ch}>
                  <input
                    type="checkbox"
                    checked={active.alert!.notify[ch]}
                    data-testid={`scr-alert-${ch}`}
                    onChange={(e) =>
                      setAlert(active, {
                        enabled: true,
                        notify: { ...active.alert!.notify, [ch]: e.target.checked },
                      })
                    }
                  />
                  {t(`scr.scr.ch.${ch}`)}
                </label>
              ))}
            </fieldset>
          ) : null}

          {presets.length ? (
            <>
              <div className="scr-screens-head">{t('scr.scr.builtin')}</div>
              <ul className="scr-screens-list">
                {presets.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="scr-screens-load"
                      data-testid={`scr-builtin-${p.id}`}
                      onClick={() => {
                        onLoad({ ...p.spec, universe: draft.universe }, null);
                        setOpen(false);
                      }}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </Popover>
    </>
  );
}
