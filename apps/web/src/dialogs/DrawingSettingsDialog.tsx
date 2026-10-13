import {
  getDrawingTool,
  logicalToTime,
  timeToLogical,
  type AnchorTimeline,
  type AnyDrawingToolDefinition,
  type Drawing,
  type DrawingLevel,
  type DrawingPoint,
  type DrawingProperty,
  type DrawingStyle,
  type JsonValue,
} from '@investopen/engine';
import { ChevronDown, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scopePatch, updateDrawings } from '../drawings/actions';
import { defaultStyleOf, type DrawingSettingsTab } from '../drawings/menu';
import { deepEqual } from '../drawings/model';
import { useDrawingStore, useDrawingTemplates, type DrawingBuckets } from '../drawings/store';
import { getChart, useChartStore } from '../store/chart';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { ColorSwatch } from './ColorPicker';
import { Check, Row, Section, Segmented } from './controls';
import { NumberInput, VisibilityTab } from './IndicatorSettingsDialog';
import '../indicators/indicators.css';
import '../drawings/drawings.css';
import './dialogs.css';

const LINE_STYLES: [string, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
];
const FONT_SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

function lookup(s: DrawingBuckets, id: unknown): Drawing | undefined {
  if (typeof id !== 'string') return undefined;
  for (const list of [s.synced, ...Object.values(s.bySymbol)]) {
    const d = list.find((x) => x.id === id);
    if (d) return d;
  }
  return undefined;
}

interface Arg {
  id?: unknown;
  tab?: DrawingSettingsTab;
  saveTemplate?: boolean;
}

/**
 * Properties dialog generated from the tool's `properties` schema: Style and
 * Text tabs, Coordinates (anchors, honouring `axes`) and Visibility. Edits are
 * a live preview on the chart (engine API only, no store/undo); Ok commits one
 * undo step, Cancel restores the stored drawing.
 */
export default function DrawingSettingsDialog({
  onClose,
  arg,
}: {
  onClose: () => void;
  arg?: unknown;
}) {
  const a = (arg ?? {}) as Arg;
  const stored = useDrawingStore((s) => lookup(s, a.id));
  const def = stored ? getDrawingTool(stored.type) : undefined;
  const [draft, setDraft] = useState<Drawing | null>(() =>
    stored ? structuredClone(stored) : null,
  );
  const hasText = !!def?.text || !!def?.properties.some((p) => p.tab === 'text');
  const [tab, setTab] = useState<DrawingSettingsTab>(() =>
    a.tab === 'text' && !hasText ? 'style' : (a.tab ?? 'style'),
  );
  const settled = useRef(false);
  const original = useRef(stored);

  // Live preview straight on the engine (never the store), replaced wholesale
  // so a template without some style key previews without it.
  useEffect(() => {
    if (draft) getChart()?.replaceDrawing(draft);
  }, [draft]);

  // Leaving without Ok restores the stored drawing on the chart.
  useEffect(
    () => () => {
      const d = original.current;
      if (!settled.current && d) getChart()?.replaceDrawing(d);
    },
    [],
  );

  if (!stored || !def || !draft) {
    return (
      <Modal title="Drawing settings" onClose={onClose} width={420}>
        <div className="dlg-empty">This drawing is no longer on the chart.</div>
      </Modal>
    );
  }

  const setStyle = (patch: DrawingStyle) =>
    setDraft((d) => d && { ...d, style: { ...d.style, ...patch } });
  const set = (patch: Partial<Drawing>) => setDraft((d) => d && { ...d, ...patch });

  const ok = () => {
    settled.current = true;
    if (!deepEqual(draft, stored)) {
      const { id: _id, type: _type, ...patch } = draft;
      updateDrawings([stored.id], patch, `Change ${def.name} settings`);
    }
    onClose();
  };
  const cancel = () => {
    settled.current = true;
    getChart()?.replaceDrawing(stored);
    onClose();
  };

  const tabs: [DrawingSettingsTab, string][] = [
    ['style', 'Style'],
    ...(hasText ? [['text', 'Text'] as [DrawingSettingsTab, string]] : []),
    ['coordinates', 'Coordinates'],
    ['visibility', 'Visibility'],
  ];

  let content: ReactNode;
  if (tab === 'style')
    content = (
      <PropertyList
        props={def.properties.filter((p) => (p.tab ?? 'style') === 'style')}
        style={draft.style}
        set={setStyle}
      />
    );
  else if (tab === 'text')
    content = <TextTab def={def} draft={draft} set={set} setStyle={setStyle} />;
  else if (tab === 'coordinates') content = <CoordinatesTab def={def} draft={draft} set={set} />;
  else
    content = (
      <>
        <VisibilityTab vis={draft.visibility} set={(visibility) => set({ visibility })} />
        <Section title="Symbols">
          <Row label="Show on">
            <Segmented
              value={draft.scope}
              options={[
                ['symbol', `${draft.symbol || 'This symbol'} only`],
                ['all', 'All symbols'],
              ]}
              onChange={(scope) => set(scopePatch(draft, scope))}
            />
          </Row>
        </Section>
      </>
    );

  return (
    <Modal
      title={def.name}
      onClose={cancel}
      width={480}
      className="dlg-settings drw-settings"
      footer={
        <>
          <TemplateMenu
            def={def}
            style={draft.style}
            apply={(style) => setDraft((d) => d && { ...d, style })}
            startSaving={!!a.saveTemplate}
          />
          <div className="dlg-footer-spacer" />
          <button type="button" className="io-btn" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="io-btn io-btn-primary" onClick={ok}>
            Ok
          </button>
        </>
      }
    >
      <div className="dlg-tabs" role="tablist" aria-label="Drawing settings sections">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`dlg-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="ind-settings-body drw-settings-body" role="tabpanel">
        {content}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ templates

function TemplateMenu({
  def,
  style,
  apply,
  startSaving,
}: {
  def: AnyDrawingToolDefinition;
  style: DrawingStyle;
  apply: (style: DrawingStyle) => void;
  startSaving: boolean;
}) {
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(startSaving);
  const [name, setName] = useState('');
  const saved = useDrawingTemplates((s) => s.byType[def.type]) ?? [];
  const hasDefault = useDrawingTemplates((s) => !!s.defaults[def.type]);
  const templates = useDrawingTemplates.getState();

  if (naming) {
    const save = () => {
      const n = name.trim();
      if (!n) return;
      templates.saveTemplate(def.type, n, structuredClone(style));
      toast(`Template "${n}" saved`, 'success');
      setNaming(false);
      setName('');
    };
    return (
      <div className="drw-template-save" data-own-escape>
        <input
          className="io-input"
          aria-label="Template name"
          placeholder="Template name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') setNaming(false);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <button type="button" className="io-btn" disabled={!name.trim()} onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="Cancel saving template"
          onClick={() => setNaming(false)}
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  const items: MenuItem[] = [
    { label: 'Save as…', onSelect: () => setNaming(true) },
    {
      label: 'Save as default',
      onSelect: () => {
        templates.saveDefault(def.type, structuredClone(style));
        toast(`Saved as default for ${def.name}`, 'success');
      },
    },
    {
      label: 'Apply default',
      onSelect: () => {
        const s = defaultStyleOf(def.type);
        if (s) apply(s);
      },
    },
    { label: 'Reset', onSelect: () => apply(structuredClone(def.defaults)) },
  ];
  if (saved.length) {
    items.push({ type: 'separator' }, { type: 'header', label: 'Apply template' });
    for (const t of saved)
      items.push({
        label: t.name,
        onSelect: () => apply({ ...structuredClone(def.defaults), ...structuredClone(t.style) }),
      });
    items.push({
      label: 'Remove template',
      submenu: saved.map((t) => ({
        label: t.name,
        onSelect: () => templates.removeTemplate(def.type, t.name),
      })),
    });
  }
  if (hasDefault)
    items.push(
      { type: 'separator' },
      { label: 'Remove saved default', onSelect: () => templates.clearDefault(def.type) },
    );
  return (
    <>
      <button
        ref={setBtn}
        type="button"
        className="io-btn dlg-template"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Template <ChevronDown size={14} />
      </button>
      <DropdownMenu
        anchor={btn}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-start"
        items={items}
      />
    </>
  );
}

// ------------------------------------------------------------ properties

const str = (v: JsonValue | undefined, fallback: string) => (typeof v === 'string' ? v : fallback);
const num = (v: JsonValue | undefined, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function isLevel(v: unknown): v is DrawingLevel {
  const o = v as DrawingLevel | null;
  return !!o && typeof o.value === 'number' && typeof o.color === 'string';
}

/** One control for a schema property. */
function PropertyControl({
  p,
  style,
  set,
}: {
  p: DrawingProperty;
  style: DrawingStyle;
  set: (patch: DrawingStyle) => void;
}) {
  const v = style[p.key];
  switch (p.kind) {
    case 'color':
      return (
        <ColorSwatch
          value={str(v, '#2962ff')}
          label={p.label}
          onChange={(c) => set({ [p.key]: c })}
        />
      );
    case 'lineWidth':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={num(v, 1)}
          onChange={(e) => set({ [p.key]: Number(e.target.value) })}
        >
          {[1, 2, 3, 4].map((w) => (
            <option key={w} value={w}>
              {w}px
            </option>
          ))}
        </select>
      );
    case 'lineStyle':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={str(v, 'solid')}
          onChange={(e) => set({ [p.key]: e.target.value })}
        >
          {LINE_STYLES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      );
    case 'fontSize':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={num(v, 14)}
          onChange={(e) => set({ [p.key]: Number(e.target.value) })}
        >
          {[...new Set([...FONT_SIZES, num(v, 14)])]
            .sort((x, y) => x - y)
            .map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
        </select>
      );
    case 'bool':
      return <Check checked={v === true} label={p.label} onChange={(b) => set({ [p.key]: b })} />;
    case 'number':
      return (
        <NumberInput
          value={num(v, 0)}
          min={p.min}
          max={p.max}
          step={p.step ?? 1}
          label={p.label}
          onChange={(n) =>
            set({
              [p.key]: Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, n)),
            })
          }
        />
      );
    case 'enum':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={str(v, p.options[0] ?? '')}
          onChange={(e) => set({ [p.key]: e.target.value })}
        >
          {p.options.map((o, i) => (
            <option key={o} value={o}>
              {p.labels?.[i] ?? o}
            </option>
          ))}
        </select>
      );
    case 'levels':
      return (
        <LevelsEditor
          levels={Array.isArray(v) ? v.filter(isLevel) : []}
          set={(levels) => set({ [p.key]: levels })}
        />
      );
  }
}

function LevelsEditor({
  levels,
  set,
}: {
  levels: DrawingLevel[];
  set: (levels: DrawingLevel[]) => void;
}) {
  const update = (i: number, patch: Partial<DrawingLevel>) =>
    set(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="drw-levels">
      {levels.map((l, i) => (
        <div key={i} className="drw-level">
          <input
            type="checkbox"
            aria-label={`Level ${i + 1} visible`}
            checked={l.visible}
            onChange={(e) => update(i, { visible: e.target.checked })}
          />
          <NumberInput
            value={l.value}
            step={0.001}
            label={`Level ${i + 1} value`}
            onChange={(value) => update(i, { value })}
          />
          <ColorSwatch
            value={l.color}
            label={`Level ${i + 1} colour`}
            onChange={(color) => update(i, { color })}
          />
          <button
            type="button"
            className="io-icon-btn"
            aria-label={`Remove level ${i + 1}`}
            onClick={() => set(levels.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="io-btn drw-level-add"
        onClick={() =>
          set([
            ...levels,
            { value: (levels.at(-1)?.value ?? 0) + 0.5, color: '#787b86', visible: true },
          ])
        }
      >
        <Plus size={14} /> Add level
      </button>
    </div>
  );
}

/** Properties grouped into sections (`group`) and shared rows (`inline`), in schema order. */
function PropertyList({
  props,
  style,
  set,
}: {
  props: readonly DrawingProperty[];
  style: DrawingStyle;
  set: (patch: DrawingStyle) => void;
}) {
  if (!props.length) return <div className="dlg-note">Nothing to style.</div>;
  const sections: { title: string | undefined; rows: DrawingProperty[][] }[] = [];
  for (const p of props) {
    let sec = sections.at(-1);
    if (!sec || sec.title !== p.group) {
      sec = { title: p.group, rows: [] };
      sections.push(sec);
    }
    const row = sec.rows.at(-1);
    if (p.inline && row && row[0]!.inline === p.inline) row.push(p);
    else sec.rows.push([p]);
  }
  const renderRow = (row: DrawingProperty[]) => {
    const first = row[0]!;
    if (row.length === 1 && first.kind === 'bool')
      return (
        <div key={first.key} className="drw-prop-row">
          <PropertyControl p={first} style={style} set={set} />
        </div>
      );
    return (
      <Row key={first.key} label={first.label}>
        <div className="drw-inline">
          {row.map((p) => (
            <PropertyControl key={p.key} p={p} style={style} set={set} />
          ))}
        </div>
      </Row>
    );
  };
  return (
    <>
      {sections.map((s, i) =>
        s.title ? (
          <Section key={i} title={s.title}>
            {s.rows.map(renderRow)}
          </Section>
        ) : (
          <div key={i} className="dlg-section">
            {s.rows.map(renderRow)}
          </div>
        ),
      )}
    </>
  );
}

function TextTab({
  def,
  draft,
  set,
  setStyle,
}: {
  def: AnyDrawingToolDefinition;
  draft: Drawing;
  set: (patch: Partial<Drawing>) => void;
  setStyle: (patch: DrawingStyle) => void;
}) {
  return (
    <>
      <PropertyList
        props={def.properties.filter((p) => p.tab === 'text')}
        style={draft.style}
        set={setStyle}
      />
      {def.text ? (
        <div className="dlg-section">
          {def.text.multiline ? (
            <textarea
              className="io-input drw-text-input"
              aria-label="Text"
              rows={5}
              value={draft.text}
              placeholder="Add text"
              onChange={(e) => set({ text: e.target.value })}
            />
          ) : (
            <input
              className="io-input drw-text-input"
              aria-label="Text"
              value={draft.text}
              placeholder="Add text"
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
        </div>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------ coordinates

/** The chart's anchor timeline: displayed bars (bricks on brick types), as the engine maps anchors. */
function useTimeline(): AnchorTimeline | null {
  const chart = useChartStore((s) => s.chart);
  if (!chart || !chart.store.length) return null;
  return chart.getAnchorTimeline();
}

/** Unix seconds <-> `datetime-local` value in UTC. */
const toUtcInput = (t: number) => new Date(t * 1000).toISOString().slice(0, 16);
const fromUtcInput = (s: string) => {
  const ms = Date.parse(`${s}:00Z`);
  return Number.isFinite(ms) ? ms / 1000 : null;
};

function CoordinatesTab({
  def,
  draft,
  set,
}: {
  def: AnyDrawingToolDefinition;
  draft: Drawing;
  set: (patch: Partial<Drawing>) => void;
}) {
  const tl = useTimeline();
  const axes = def.axes ?? 'both';
  const minTick = useChartStore((s) => s.symbolInfo?.minTick ?? 0.01);
  const setPoint = (i: number, patch: Partial<DrawingPoint>) =>
    set({
      points: draft.points.map((p, j) => {
        if (j !== i) return p;
        const next = { ...p, ...patch };
        if ('time' in patch && !('brick' in patch)) delete next.brick;
        return next;
      }),
    });
  return (
    <div className="dlg-section">
      {draft.points.map((p, i) => {
        const bar = tl ? Math.round(timeToLogical(tl, p)) : NaN;
        return (
          <Section key={i} title={`Point ${i + 1}`}>
            {axes !== 'time' ? (
              <Row label="Price">
                <NumberInput
                  value={p.price}
                  step={minTick}
                  label={`Point ${i + 1} price`}
                  onChange={(price) => setPoint(i, { price })}
                />
              </Row>
            ) : null}
            {axes !== 'price' ? (
              <>
                <Row label="Bar #">
                  <NumberInput
                    value={Number.isFinite(bar) ? bar : 0}
                    step={1}
                    label={`Point ${i + 1} bar`}
                    onChange={(n) => {
                      const t = tl && logicalToTime(tl, Math.round(n));
                      if (t) setPoint(i, t);
                    }}
                  />
                </Row>
                <Row label="Time (UTC)">
                  <input
                    type="datetime-local"
                    className="io-input"
                    aria-label={`Point ${i + 1} time`}
                    value={toUtcInput(p.time)}
                    onChange={(e) => {
                      const t = fromUtcInput(e.target.value);
                      if (t !== null) setPoint(i, { time: t });
                    }}
                  />
                </Row>
              </>
            ) : null}
          </Section>
        );
      })}
    </div>
  );
}
