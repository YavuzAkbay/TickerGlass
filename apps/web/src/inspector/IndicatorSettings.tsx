import {
  coerceInputs,
  externalRefSymbol,
  getIndicator,
  isExternalRef,
  isOutputRef,
  isUserScriptType,
  resolveInputs,
  resolveOutputs,
  type AnyIndicatorDefinition,
  type InputDef,
  type InputValueMap,
  type LineStyle,
  type OutputStyleOverride,
  type PlotKind,
  type ResolvedOutput,
  type ShapeSize,
  type SourceValue,
} from '@tickerglass/indicators';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  commitPreview,
  discardPreview,
  findIndicator,
  previewIndicator,
} from '../indicators/actions';
import { overlayOption, sourceOptions } from '../indicators/menu';
import {
  VISIBILITY_UNITS,
  defaultVisibility,
  type IndicatorState,
  type IntervalVisibility,
  type VisibilityUnit,
} from '../indicators/model';
import { useEffectiveInstances, useIndicatorPrefs } from '../indicators/store';
import { useCompareStore } from '../compare/store';
import { INTERVAL_GROUPS, intervalLabel } from '../topbar/intervals';
import { DropdownMenu } from '../ui/Menu';
import { toast } from '../ui/Toast';
import { ColorSwatch } from '../dialogs/ColorPicker';
import { Check, Row, Section } from '../dialogs/controls';
import { SymbolField } from '../dialogs/SymbolField';
import { useUiStore } from '../store/ui';
import '../indicators/indicators.css';
import '../dialogs/dialogs.css';

type TabId = 'inputs' | 'style' | 'visibility';

const PLOT_KINDS: [PlotKind, string][] = [
  ['line', 'Line'],
  ['step', 'Step line'],
  ['histogram', 'Histogram'],
  ['area', 'Area'],
  ['columns', 'Columns'],
  ['circles', 'Circles'],
  ['cross', 'Cross'],
];
const LINE_STYLES: [LineStyle, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
];
const SHAPE_SIZES: ShapeSize[] = ['tiny', 'small', 'normal', 'large', 'huge'];

type Editable = Pick<IndicatorState, 'inputs' | 'styles' | 'visibility'>;

const editable = (i: IndicatorState): Editable => ({
  inputs: i.inputs,
  styles: i.styles,
  visibility: i.visibility,
});

/**
 * Indicator settings in the Inspector, generated from the indicator's schema.
 * Every edit previews live on the chart (transient, not persisted). Closing the
 * panel or Done keeps the edits as one undo step; Revert drops them.
 */
export function IndicatorSettings({ id }: { id: string }) {
  const all = useEffectiveInstances();
  const inst = all.find((i) => i.id === id);
  const saved = useIndicatorPrefs((s) => (inst ? s.defaults[inst.type] : undefined));
  const close = useUiStore((s) => s.closeInspector);
  const [tab, setTab] = useState<TabId>('inputs');
  const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const def = inst ? getIndicator(inst.type) : undefined;

  // Leaving the panel (closed, or another view) keeps the previewed edits.
  useEffect(
    () => () => {
      const type = findIndicator(id)?.type;
      const name = type ? getIndicator(type)?.shortName : undefined;
      commitPreview(id, name ? `Change ${name} settings` : 'Change indicator settings');
    },
    [id],
  );

  // An indicator removed while its settings are open leaves nothing to edit.
  const missing = !inst || !def;
  useEffect(() => {
    if (missing) close();
  }, [missing, close]);
  if (!inst || !def) return null;

  const apply = (patch: Partial<Editable>) => previewIndicator(inst.id, patch);
  const setInput = (key: string, v: InputValueMap[string]) =>
    apply({ inputs: { ...inst.inputs, [key]: v } });
  const setStyle = (outputId: string, patch: OutputStyleOverride) =>
    apply({ styles: { ...inst.styles, [outputId]: { ...inst.styles[outputId], ...patch } } });

  const resetTo = (d: Editable) => {
    try {
      apply({
        inputs: isUserScriptType(def.id)
          ? coerceInputs(def, d.inputs)
          : resolveInputs(def, d.inputs),
        styles: structuredClone(d.styles),
        visibility: d.visibility ? structuredClone(d.visibility) : null,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  let content: ReactNode;
  if (tab === 'inputs') content = <InputsTab def={def} inst={inst} all={all} set={setInput} />;
  else if (tab === 'style')
    content = <StyleTab outputs={resolveOutputs(def, inst.inputs, inst.styles)} set={setStyle} />;
  else
    content = <VisibilityTab vis={inst.visibility} set={(visibility) => apply({ visibility })} />;

  return (
    <div className="insp-settings ind-settings">
      <div className="dlg-tabs" role="tablist" aria-label="Indicator settings sections">
        {(
          [
            ['inputs', 'Inputs'],
            ['style', 'Style'],
            ['visibility', 'Visibility'],
          ] as const
        ).map(([t, tabLabel]) => (
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
      <div className="ind-settings-body insp-settings-body" role="tabpanel">
        {content}
      </div>
      <footer className="insp-footer">
        <button
          ref={setMenuBtn}
          type="button"
          className="io-btn dlg-template"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          Defaults <ChevronDown size={14} />
        </button>
        <DropdownMenu
          anchor={menuBtn}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          placement="bottom-start"
          items={[
            {
              label: 'Reset settings',
              onSelect: () => resetTo(saved ?? { inputs: {}, styles: {}, visibility: null }),
            },
            {
              label: 'Save as default',
              onSelect: () => {
                useIndicatorPrefs
                  .getState()
                  .saveDefaults(inst.type, structuredClone(editable(inst)));
                toast(`Saved as default for ${def.shortName}`, 'success');
              },
            },
            { type: 'separator' },
            {
              label: 'Reset to factory defaults',
              onSelect: () => resetTo({ inputs: {}, styles: {}, visibility: null }),
            },
            {
              label: 'Remove saved default',
              disabled: !saved,
              onSelect: () => useIndicatorPrefs.getState().clearDefaults(inst.type),
            },
          ]}
        />
        <div className="dlg-footer-spacer" />
        <button type="button" className="io-btn" onClick={() => discardPreview(inst.id)}>
          Revert
        </button>
        <button type="button" className="io-btn io-btn-primary" onClick={close}>
          Done
        </button>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ inputs

interface InputRow {
  group: string | undefined;
  keys: string[];
}

/** Rows in schema order; inputs sharing `inline` share a row, `group` starts a section. */
function inputRows(def: AnyIndicatorDefinition): InputRow[] {
  const rows: InputRow[] = [];
  let last: { inline: string | undefined; row: InputRow } | null = null;
  for (const [key, d] of Object.entries(def.inputs)) {
    if (last && d.inline && last.inline === d.inline && last.row.group === d.group) {
      last.row.keys.push(key);
      continue;
    }
    const row: InputRow = { group: d.group, keys: [key] };
    rows.push(row);
    last = { inline: d.inline, row };
  }
  return rows;
}

function InputsTab({
  def,
  inst,
  all,
  set,
}: {
  def: AnyIndicatorDefinition;
  inst: IndicatorState;
  all: IndicatorState[];
  set: (key: string, v: InputValueMap[string]) => void;
}) {
  const rows = inputRows(def);
  if (!rows.length) return <div className="dlg-note">This indicator has no inputs.</div>;
  const sections: { group: string | undefined; rows: InputRow[] }[] = [];
  for (const r of rows) {
    const cur = sections.at(-1);
    if (cur && cur.group === r.group) cur.rows.push(r);
    else sections.push({ group: r.group, rows: [r] });
  }
  const renderRow = (r: InputRow) => {
    const first = def.inputs[r.keys[0]!]!;
    const controls = r.keys.map((key, i) => {
      const d = def.inputs[key]!;
      const label = i > 0 && d.kind !== 'bool' ? <span>{d.label}</span> : null;
      return (
        <span key={key} className="ind-inline" title={d.tooltip}>
          {label}
          <InputControl
            id={`ind-in-${key}`}
            def={d}
            value={inst.inputs[key]}
            inst={inst}
            all={all}
            onChange={(v) => set(key, v)}
          />
        </span>
      );
    });
    return (
      <Row
        key={r.keys.join('|')}
        label={first.kind === 'bool' ? '' : first.label}
        {...(first.kind === 'bool' ? {} : { htmlFor: `ind-in-${r.keys[0]}` })}
      >
        {controls}
      </Row>
    );
  };
  return (
    <>
      {sections.map((s, i) =>
        s.group ? (
          <Section key={`${s.group}-${i}`} title={s.group}>
            {s.rows.map(renderRow)}
          </Section>
        ) : (
          <div key={`nogroup-${i}`} className="dlg-section">
            {s.rows.map(renderRow)}
          </div>
        ),
      )}
    </>
  );
}

function sourceKey(v: SourceValue): string {
  return isOutputRef(v) ? `ref:${v.instanceId}:${v.outputId}` : v;
}

function toLocalInput(sec: number): string {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function InputControl({
  id,
  def,
  value,
  inst,
  all,
  onChange,
}: {
  id: string;
  def: InputDef;
  value: InputValueMap[string] | undefined;
  inst: IndicatorState;
  all: IndicatorState[];
  onChange: (v: InputValueMap[string]) => void;
}) {
  const compareItems = useCompareStore((s) => s.items);
  const overlays = [...new Set(compareItems.map((i) => i.symbol))];
  switch (def.kind) {
    case 'int':
    case 'float':
      return (
        <NumberInput
          id={id}
          value={typeof value === 'number' ? value : def.default}
          min={def.min}
          max={def.max}
          step={def.step ?? (def.kind === 'int' ? 1 : 0.1)}
          label={def.label}
          onChange={onChange}
        />
      );
    case 'bool':
      return <Check checked={value === true} label={def.label} onChange={onChange} />;
    case 'color':
      return (
        <ColorSwatch
          value={typeof value === 'string' ? value : def.default}
          label={def.label}
          onChange={onChange}
        />
      );
    case 'enum':
      return (
        <select
          id={id}
          className="io-input dlg-select"
          value={String(value ?? def.default)}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options.map((o) => (
            <option key={o} value={o}>
              {def.optionLabels?.[o] ?? o}
            </option>
          ))}
        </select>
      );
    case 'source': {
      const cur = (value ?? def.default) as SourceValue;
      // A source on a symbol that is not a compare overlay (free entry) stays listed.
      const free =
        isExternalRef(cur) && !overlays.includes(externalRefSymbol(cur))
          ? [externalRefSymbol(cur)]
          : [];
      const options = sourceOptions(inst, all, [...overlays, ...free]);
      const missing =
        isOutputRef(cur) && !options.some((o) => sourceKey(o.value) === sourceKey(cur));
      const plain = options.filter((o) => !o.group);
      const overlayOptions = options.filter((o) => o.group === 'Overlays');
      return (
        <>
          <select
            id={id}
            className="io-input dlg-select"
            value={sourceKey(cur)}
            onChange={(e) => {
              const o = options.find((x) => sourceKey(x.value) === e.target.value);
              if (o) onChange(o.value);
            }}
          >
            {plain.map((o) => (
              <option key={sourceKey(o.value)} value={sourceKey(o.value)}>
                {o.label}
              </option>
            ))}
            {overlayOptions.length ? (
              <optgroup label="Overlays">
                {overlayOptions.map((o) => (
                  <option key={sourceKey(o.value)} value={sourceKey(o.value)}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {missing ? <option value={sourceKey(cur)}>Removed source</option> : null}
          </select>
          <SymbolField
            value=""
            label={`${def.label} overlay symbol`}
            placeholder="Overlay symbol…"
            clearOnCommit
            onCommit={(symbol) => onChange(overlayOption(symbol, 'close').value)}
          />
        </>
      );
    }
    case 'symbol':
      return (
        <SymbolField
          id={id}
          value={typeof value === 'string' ? value : def.default}
          label={def.label}
          onCommit={onChange}
        />
      );
    case 'timeframe': {
      const cur = typeof value === 'string' ? value : def.default;
      const known = INTERVAL_GROUPS.flatMap((g) => g.intervals);
      return (
        <select
          id={id}
          className="io-input dlg-select"
          value={cur}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Chart</option>
          {def.default === 'auto' || cur === 'auto' ? <option value="auto">Auto</option> : null}
          {INTERVAL_GROUPS.map((g) => (
            <optgroup key={g.unit} label={g.title}>
              {g.intervals.map((iv) => (
                <option key={iv} value={iv}>
                  {intervalLabel(iv)}
                </option>
              ))}
            </optgroup>
          ))}
          {cur && cur !== 'auto' && !known.includes(cur) ? (
            <option value={cur}>{intervalLabel(cur)}</option>
          ) : null}
        </select>
      );
    }
    case 'time':
      return (
        <input
          id={id}
          type="datetime-local"
          className="io-input"
          value={toLocalInput(typeof value === 'number' ? value : 0)}
          onChange={(e) => {
            const t = e.target.value ? Date.parse(e.target.value) : 0;
            if (Number.isFinite(t)) onChange(Math.floor(t / 1000));
          }}
        />
      );
  }
}

/** Number field that commits every valid value and shows the stored value again on blur. */
export function NumberInput({
  id,
  value,
  min,
  max,
  step,
  label,
  onChange,
}: {
  id?: string;
  value: number;
  min?: number | undefined;
  max?: number | undefined;
  step: number;
  label: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  // Follow external changes (reset, clamping) without fighting the user's typing.
  if (value !== shown) {
    setShown(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <input
      id={id}
      type="number"
      className="io-input ind-num"
      aria-label={label}
      value={text}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(v)) onChange(v);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

// ------------------------------------------------------------------- style

const VP_COLOR_LABELS = ['up volume', 'down volume', 'value area up', 'value area down', 'POC'];

function StyleTab({
  outputs,
  set,
}: {
  outputs: ResolvedOutput[];
  set: (outputId: string, patch: OutputStyleOverride) => void;
}) {
  if (!outputs.length) return <div className="dlg-note">Nothing to style.</div>;
  const swatches = (o: { id: string; title: string; colors: string[] }) =>
    o.colors.map((c, i) => (
      <ColorSwatch
        key={i}
        value={c}
        label={`${o.title} colour${o.colors.length > 1 ? ` ${i + 1}` : ''}`}
        onChange={(color) => set(o.id, { colors: o.colors.map((x, j) => (j === i ? color : x)) })}
      />
    ));
  const widthSelect = (o: { id: string; title: string; lineWidth: number }) => (
    <select
      className="io-input dlg-select"
      aria-label={`${o.title} line width`}
      value={o.lineWidth}
      onChange={(e) => set(o.id, { lineWidth: Number(e.target.value) })}
    >
      {[1, 2, 3, 4].map((w) => (
        <option key={w} value={w}>
          {w}px
        </option>
      ))}
    </select>
  );
  const styleSelect = (o: { id: string; title: string; lineStyle: LineStyle }) => (
    <select
      className="io-input dlg-select"
      aria-label={`${o.title} line style`}
      value={o.lineStyle}
      onChange={(e) => set(o.id, { lineStyle: e.target.value as LineStyle })}
    >
      {LINE_STYLES.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  return (
    <div className="dlg-section">
      {outputs.map((o) => {
        const vis = (
          <Check
            checked={o.visible}
            label={o.title}
            onChange={(visible) => set(o.id, { visible })}
          />
        );
        let rest: ReactNode = null;
        switch (o.type) {
          case 'plot':
            rest = (
              <>
                {swatches(o)}
                <select
                  className="io-input dlg-select"
                  aria-label={`${o.title} plot type`}
                  value={o.kind}
                  onChange={(e) => set(o.id, { kind: e.target.value as PlotKind })}
                >
                  {PLOT_KINDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                {widthSelect(o)}
                {styleSelect(o)}
              </>
            );
            break;
          case 'hline':
            rest = (
              <>
                <ColorSwatch
                  value={o.color}
                  label={`${o.title} colour`}
                  onChange={(color) => set(o.id, { color })}
                />
                {widthSelect(o)}
                {styleSelect(o)}
              </>
            );
            break;
          case 'fill':
          case 'bgcolor':
            rest = swatches(o);
            break;
          case 'volumeProfile':
            // Colours in VOLUME_PROFILE_COLOR_KEYS order.
            rest = o.colors.map((c, i) => (
              <ColorSwatch
                key={i}
                value={c}
                label={`${o.title} ${VP_COLOR_LABELS[i] ?? `colour ${i + 1}`}`}
                onChange={(color) =>
                  set(o.id, { colors: o.colors.map((x, j) => (j === i ? color : x)) })
                }
              />
            ));
            break;
          case 'shape':
            rest = (
              <>
                {swatches(o)}
                <select
                  className="io-input dlg-select"
                  aria-label={`${o.title} size`}
                  value={o.size}
                  onChange={(e) => set(o.id, { size: e.target.value as ShapeSize })}
                >
                  {SHAPE_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s[0]!.toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </>
            );
            break;
        }
        return (
          <div key={o.id} className="ind-style-row">
            {vis}
            {rest}
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------- visibility

const isAllVisible = (v: IntervalVisibility) =>
  VISIBILITY_UNITS.every(
    ({ unit, limit }) => v[unit].enabled && v[unit].min === limit[0] && v[unit].max === limit[1],
  );

/** Two-thumb range slider (visibility range); thumbs cannot cross. */
function RangeSlider({
  min,
  max,
  lo,
  hi,
  label,
  disabled,
  onChange,
}: {
  min: number;
  max: number;
  lo: number;
  hi: number;
  label: string;
  disabled: boolean;
  onChange: (lo: number, hi: number) => void;
}) {
  const pct = (v: number) => ((v - min) / Math.max(1, max - min)) * 100;
  return (
    <div className="ind-range" aria-disabled={disabled || undefined}>
      <div className="ind-range-track">
        <div
          className="ind-range-fill"
          style={{ left: `${pct(lo)}%`, width: `${Math.max(0, pct(hi) - pct(lo))}%` }}
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={lo}
        disabled={disabled}
        aria-label={`${label} from slider`}
        onChange={(e) => onChange(Math.min(Number(e.target.value), hi), hi)}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={hi}
        disabled={disabled}
        aria-label={`${label} to slider`}
        onChange={(e) => onChange(lo, Math.max(Number(e.target.value), lo))}
      />
    </div>
  );
}

export function VisibilityTab({
  vis,
  set,
}: {
  vis: IntervalVisibility | null;
  set: (v: IntervalVisibility | null) => void;
}) {
  const cur = vis ?? defaultVisibility();
  const update = (unit: VisibilityUnit, patch: Partial<IntervalVisibility[VisibilityUnit]>) => {
    const next = { ...cur, [unit]: { ...cur[unit], ...patch } };
    set(isAllVisible(next) ? null : next);
  };
  return (
    <div className="dlg-section">
      {VISIBILITY_UNITS.map(({ unit, label, limit }) => {
        const r = cur[unit];
        const clamp = (v: number) => Math.max(limit[0], Math.min(limit[1], Math.round(v)));
        return (
          <div key={unit} className="ind-vis-row">
            <Check
              checked={r.enabled}
              label={label}
              onChange={(enabled) => update(unit, { enabled })}
            />
            <NumberInput
              value={r.min}
              min={limit[0]}
              max={limit[1]}
              step={1}
              label={`${label} from`}
              onChange={(v) => update(unit, { min: Math.min(clamp(v), r.max) })}
            />
            <RangeSlider
              min={limit[0]}
              max={limit[1]}
              lo={r.min}
              hi={r.max}
              label={label}
              disabled={!r.enabled}
              onChange={(min, max) => update(unit, { min, max })}
            />
            <NumberInput
              value={r.max}
              min={limit[0]}
              max={limit[1]}
              step={1}
              label={`${label} to`}
              onChange={(v) => update(unit, { max: Math.max(clamp(v), r.min) })}
            />
          </div>
        );
      })}
    </div>
  );
}
