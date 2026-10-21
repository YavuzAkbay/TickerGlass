import {
  getDrawingTool,
  logicalToTime,
  timeToLogical,
  type AnchorTimeline,
  type AnyDrawingToolDefinition,
  type Drawing,
  type DrawingPoint,
  type DrawingStyle,
} from '@investopen/engine';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scopePatch, updateDrawings } from '../drawings/actions';
import { defaultStyleOf, type DrawingSettingsTab } from '../drawings/menu';
import { PropertyList, TextTab } from '../drawings/DrawingProperties';
import { deepEqual } from '../drawings/model';
import { keepPerDrawingStyle } from '../drawings/per-drawing';
import { lookupDrawing, useDrawingStore, useDrawingTemplates } from '../drawings/store';
import { DEFAULT_TEMPLATE_NAME } from '../persist/drawingTemplatesSync';
import { getChart, useChartStore } from '../store/chart';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { Row, Section, Segmented } from './controls';
import { NumberInput, VisibilityTab } from './IndicatorSettingsDialog';
import '../indicators/indicators.css';
import '../drawings/drawings.css';
import './dialogs.css';

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
  const stored = useDrawingStore((s) => lookupDrawing(s, a.id));
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
        drawingId={draft.id}
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
            apply={(style) =>
              setDraft((d) => d && { ...d, style: keepPerDrawingStyle(d.type, style, d.style) })
            }
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
      if (n === DEFAULT_TEMPLATE_NAME) {
        toast(`"${n}" is reserved for the saved default; use "Save as default"`, 'error');
        return;
      }
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

const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const roundPct = (n: number) => Math.round(n * 100) / 100;

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
  const pane = def.coords === 'pane';
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
        if (pane)
          return (
            <Section key={i} title={`Point ${i + 1}`}>
              <Row label="X (%)">
                <NumberInput
                  value={roundPct(p.time * 100)}
                  min={0}
                  max={100}
                  step={1}
                  label={`Point ${i + 1} X`}
                  onChange={(n) => setPoint(i, { time: clampPct(n) / 100 })}
                />
              </Row>
              <Row label="Y (%)">
                <NumberInput
                  value={roundPct(p.price * 100)}
                  min={0}
                  max={100}
                  step={1}
                  label={`Point ${i + 1} Y`}
                  onChange={(n) => setPoint(i, { price: clampPct(n) / 100 })}
                />
              </Row>
            </Section>
          );
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
