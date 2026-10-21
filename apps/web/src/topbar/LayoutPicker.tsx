import { LayoutGrid } from 'lucide-react';
import { useMemo, useState } from 'react';
import { applyTemplate, setSyncFlag } from '../layout/actions';
import { thumbCells } from '../layout/geometry';
import type { SyncFlags } from '../layout/grid';
import { useLayoutGrid } from '../layout/store';
import { TEMPLATES, template } from '../layout/templates';
import { Popover } from '../ui/Popover';

const SYNC_ROWS: { key: keyof SyncFlags; label: string }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'interval', label: 'Interval' },
  { key: 'crosshair', label: 'Crosshair' },
  { key: 'time', label: 'Time' },
  { key: 'dateRange', label: 'Date range' },
  { key: 'drawings', label: 'Drawings' },
];

/** Accessible name of a template: its picker id, or "N charts in rows" for generated ones. */
const templateLabel = (id: string, count: number) =>
  id.startsWith('rows-') ? `${count} charts in rows` : `${id} layout, ${count} charts`;

function Thumb({ id }: { id: string }) {
  const cells = useMemo(() => {
    const tree = template(id);
    return tree ? thumbCells(tree) : [];
  }, [id]);
  return (
    <span className="lp-thumb" aria-hidden>
      {cells.map((c, i) => (
        <span
          key={i}
          className="lp-thumb-cell"
          style={{ left: `${c.x}%`, top: `${c.y}%`, width: `${c.w}%`, height: `${c.h}%` }}
        />
      ))}
    </span>
  );
}

/** Layout picker: chart arrangements grouped by chart count, and the sync toggles. */
export function LayoutPicker() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = useLayoutGrid((s) => s.template);
  const sync = useLayoutGrid((s) => s.sync);
  const groups = useMemo(() => {
    const byCount = new Map<number, typeof TEMPLATES>();
    for (const t of TEMPLATES) byCount.set(t.count, [...(byCount.get(t.count) ?? []), t]);
    return [...byCount];
  }, []);

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-layout-picker${open ? ' open' : ''}`}
        aria-label="Chart layout"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={open ? undefined : 'Chart layout'}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        <LayoutGrid size={18} strokeWidth={1.8} />
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        ignore={[anchor]}
        className="lp-panel"
      >
        <div role="dialog" aria-label="Chart layout" className="lp-body">
          {groups.map(([count, list]) => (
            <div key={count} className="lp-group">
              <div className="lp-heading">
                {count} {count === 1 ? 'chart' : 'charts'}
              </div>
              <div className="lp-row">
                {list.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`lp-item${t.id === current ? ' selected' : ''}`}
                    aria-label={templateLabel(t.id, t.count)}
                    aria-pressed={t.id === current}
                    data-template={t.id}
                    onClick={() => {
                      setOpen(false);
                      void applyTemplate(t.id);
                    }}
                  >
                    <Thumb id={t.id} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="lp-group lp-sync">
            <div className="lp-heading">Sync across charts</div>
            {SYNC_ROWS.map(({ key, label }) => (
              <label key={key} className="lp-sync-row">
                <input
                  type="checkbox"
                  checked={sync[key]}
                  onChange={(e) => setSyncFlag(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}
