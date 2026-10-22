import {
  getDrawingTool,
  logicalToTime,
  timeToLogical,
  type AnchorTimeline,
  type AnyDrawingToolDefinition,
  type Drawing,
  type DrawingPoint,
  type DrawingStyle,
} from '@tickerglass/engine';
import { ChevronDown, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { scopePatch, updateDrawings } from '../drawings/actions';
import { defaultStyleOf, type DrawingSettingsTab } from '../drawings/menu';
import { PropertyList, TextTab } from '../drawings/DrawingProperties';
import { keepPerDrawingStyle } from '../drawings/per-drawing';
import { useDrawingTemplates } from '../drawings/store';
import { DEFAULT_TEMPLATE_NAME } from '../persist/drawingTemplatesSync';
import { useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { Row, Section, Segmented } from '../dialogs/controls';
import { NumberInput, VisibilityTab } from './IndicatorSettings';
import '../indicators/indicators.css';
import '../drawings/drawings.css';
import '../dialogs/dialogs.css';

/**
 * Drawing settings in the Inspector, generated from the tool's `properties` schema:
 * Style and Text, Coordinates (anchors, honouring `axes`) and Visibility. Every
 * edit goes to the drawing store straight away; edits of one property coalesce
 * into one undo step.
 */
export function DrawingSettings({
  drawing,
  initialTab,
  saveTemplate = false,
}: {
  drawing: Drawing;
  initialTab?: DrawingSettingsTab | undefined;
  saveTemplate?: boolean;
}) {
  const def = getDrawingTool(drawing.type);
  const close = useUiStore((s) => s.closeInspector);
  const hasText = !!def?.text || !!def?.properties.some((p) => p.tab === 'text');
  const [tab, setTab] = useState<DrawingSettingsTab>(() =>
    initialTab === 'text' && !hasText ? 'style' : (initialTab ?? 'style'),
  );
  if (!def) return <div className="dlg-note">Nothing to style.</div>;

  const label = `Change ${def.name} settings`;
  const setStyle = (patch: DrawingStyle) => {
    const key = Object.keys(patch).join(',');
    updateDrawings([drawing.id], { style: patch }, label, `prop:${key}`);
  };
  const set = (patch: Partial<Drawing>) => {
    const key = Object.keys(patch).join(',');
    updateDrawings([drawing.id], patch, label, `prop:${key}`);
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
        style={drawing.style}
        set={setStyle}
        drawingId={drawing.id}
      />
    );
  else if (tab === 'text')
    content = <TextTab def={def} draft={drawing} set={set} setStyle={setStyle} />;
  else if (tab === 'coordinates') content = <CoordinatesTab def={def} draft={drawing} set={set} />;
  else
    content = (
      <>
        <VisibilityTab vis={drawing.visibility} set={(visibility) => set({ visibility })} />
        <Section title="Symbols">
          <Row label="Show on">
            <Segmented
              value={drawing.scope}
              options={[
                ['symbol', `${drawing.symbol || 'This symbol'} only`],
                ['all', 'All symbols'],
              ]}
              onChange={(scope) => set(scopePatch(drawing, scope))}
            />
          </Row>
        </Section>
      </>
    );

  return (
    <div className="insp-settings drw-settings">
      <div className="dlg-tabs" role="tablist" aria-label="Drawing settings sections">
        {tabs.map(([t, tabLabel]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`dlg-tab${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >
            {tabLabel}
          </button>
        ))}
      </div>
      <div className="ind-settings-body drw-settings-body insp-settings-body" role="tabpanel">
        {content}
      </div>
      <footer className="insp-footer">
        <TemplateMenu
          def={def}
          style={drawing.style}
          apply={(style) =>
            updateDrawings(
              [drawing.id],
              (d) => ({ style: keepPerDrawingStyle(d.type, style, d.style) }),
              `Apply ${def.name} template`,
            )
          }
          startSaving={saveTemplate}
        />
        <div className="dlg-footer-spacer" />
        <button type="button" className="io-btn io-btn-primary" onClick={close}>
          Done
        </button>
      </footer>
    </div>
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
