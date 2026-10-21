import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import type { IndicatorState } from '../indicators/model';
import { useIndicatorStore } from '../indicators/store';
import {
  INDICATOR_TEMPLATE_SCHEMA_VERSION,
  applyIndicatorTemplate,
} from '../persist/indicatorTemplates';
import { indicatorTemplates, type TemplateRow } from '../persist/templateCache';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';

type Template = TemplateRow<IndicatorState[]>;

const savedOffline = (what: string) =>
  toast(`${what} (server unreachable: it will sync later)`, 'info');

const fail = (what: string, err: unknown) => toast(`${what}: ${errorMessage(err)}`, 'error', 6000);

/** "Indicator templates" dropdown: save the current set, apply, rename, delete. */
export function IndicatorTemplatesButton() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasIndicators = useIndicatorStore((s) => s.instances.length > 0);

  const refresh = () =>
    indicatorTemplates
      .list()
      .then(({ items }) => {
        setTemplates([...items].sort((a, b) => a.name.localeCompare(b.name)));
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)));

  const toggle = () => {
    if (!open) void refresh();
    setOpen((o) => !o);
  };

  const save = async () => {
    const name = await promptName({ title: 'Save indicator template' });
    if (!name) return;
    const existing = templates?.find((t) => t.name === name);
    if (
      existing &&
      !(await confirmDialog({
        title: 'Replace template',
        message: `A template named "${name}" exists. Replace it?`,
        okLabel: 'Replace',
      }))
    )
      return;
    try {
      const { offline } = await indicatorTemplates.save(
        name,
        useIndicatorStore.getState().instances,
        INDICATOR_TEMPLATE_SCHEMA_VERSION,
      );
      if (offline) savedOffline(`Indicator template "${name}" saved`);
      else toast(`Indicator template "${name}" saved`, 'success');
    } catch (err) {
      fail('Template could not be saved', err);
    }
  };

  const apply = (t: Template, mode: 'replace' | 'add') => {
    const problem = applyIndicatorTemplate(t.data, mode, t.name);
    if (problem) toast(problem, 'error');
  };

  const rename = async (t: Template) => {
    const name = await promptName({ title: 'Rename template', initial: t.name, okLabel: 'Rename' });
    if (!name || name === t.name) return;
    try {
      await indicatorTemplates.save(name, t.data, t.schemaVersion);
      await indicatorTemplates.remove(t);
    } catch (err) {
      fail('Template could not be renamed', err);
    }
  };

  const remove = async (t: Template) => {
    const yes = await confirmDialog({
      title: 'Delete template',
      message: `Delete the indicator template "${t.name}"?`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await indicatorTemplates.remove(t);
    } catch (err) {
      fail('Template could not be deleted', err);
    }
  };

  const items: MenuItem[] = [
    {
      label: 'Save indicator template…',
      disabled: !hasIndicators,
      onSelect: () => void save(),
    },
  ];
  if (error)
    items.push({ type: 'custom', render: () => <div className="tb-menu-note">{error}</div> });
  else if (!templates)
    items.push({ type: 'custom', render: () => <div className="tb-menu-note">Loading…</div> });
  else if (templates.length) {
    items.push({ type: 'separator' }, { type: 'header', label: 'My templates' });
    for (const t of templates)
      items.push({
        label: t.name,
        submenu: [
          { label: 'Apply (replace indicators)', onSelect: () => apply(t, 'replace') },
          { label: 'Add to chart', onSelect: () => apply(t, 'add') },
          { type: 'separator' },
          { label: 'Rename…', onSelect: () => void rename(t) },
          { label: 'Delete', danger: true, onSelect: () => void remove(t) },
        ],
      });
  } else
    items.push({
      type: 'custom',
      render: () => <div className="tb-menu-note">No templates yet</div>,
    });

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn${open ? ' open' : ''}`}
        aria-label="Indicator templates"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : 'Indicator templates'}
        data-tip-side="bottom"
        onClick={toggle}
      >
        <LayoutTemplate size={18} strokeWidth={1.6} />
      </button>
      <DropdownMenu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        placement="bottom-start"
      />
    </>
  );
}
