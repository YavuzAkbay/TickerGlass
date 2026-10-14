import { LayoutTemplate } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import type { IndicatorTemplate } from '../api/types';
import type { IndicatorState } from '../indicators/model';
import { useIndicatorStore } from '../indicators/store';
import {
  INDICATOR_TEMPLATE_SCHEMA_VERSION,
  applyIndicatorTemplate,
} from '../persist/indicatorTemplates';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';

type Template = IndicatorTemplate<IndicatorState>;

const fail = (what: string, err: unknown) => toast(`${what}: ${errorMessage(err)}`, 'error', 6000);

/** the common "Indicator templates" dropdown: save the current set, apply, rename, delete. */
export function IndicatorTemplatesButton() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasIndicators = useIndicatorStore((s) => s.instances.length > 0);

  const refresh = () =>
    persistence
      .listIndicatorTemplates<IndicatorState>()
      .then((list) => {
        setTemplates([...list].sort((a, b) => a.name.localeCompare(b.name)));
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
      await persistence.saveIndicatorTemplate({
        name,
        instances: useIndicatorStore.getState().instances,
        schemaVersion: INDICATOR_TEMPLATE_SCHEMA_VERSION,
      });
      toast(`Indicator template "${name}" saved`, 'success');
    } catch (err) {
      fail('Template could not be saved', err);
    }
  };

  const apply = (t: Template, mode: 'replace' | 'add') => {
    const problem = applyIndicatorTemplate(t.instances, mode, t.name);
    if (problem) toast(problem, 'error');
  };

  const rename = async (t: Template) => {
    const name = await promptName({ title: 'Rename template', initial: t.name, okLabel: 'Rename' });
    if (!name || name === t.name) return;
    try {
      await persistence.updateIndicatorTemplate(t.id, {
        name,
        instances: t.instances,
        schemaVersion: t.schemaVersion,
      });
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
      await persistence.deleteIndicatorTemplate(t.id);
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
