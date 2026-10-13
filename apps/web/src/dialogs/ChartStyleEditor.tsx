import type { ChartStyle, ChartType } from '@investopen/engine';
import { ColorSwatch } from './ColorPicker';

type Value = string | number | boolean;
type StyleValues = Record<string, Value>;

interface NumberSpec {
  key: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
}

/** One settings row: optional checkbox in the label, then colours / select / number / width. */
interface RowSpec {
  label: string;
  check?: string;
  colors?: { key: string; label: string }[];
  select?: { key: string; options: [string, string][] };
  number?: NumberSpec;
  width?: string;
  show?: (s: StyleValues) => boolean;
}

interface SectionSpec {
  title: string;
  rows: RowSpec[];
}

const SOURCES: [string, string][] = [
  ['open', 'Open'],
  ['high', 'High'],
  ['low', 'Low'],
  ['close', 'Close'],
  ['hl2', '(H + L) / 2'],
  ['hlc3', '(H + L + C) / 3'],
  ['ohlc4', '(O + H + L + C) / 4'],
];
const BRICK_SOURCES: [string, string][] = [
  ['close', 'Close'],
  ['hl', 'High/Low'],
];
const BOX_MODES: [string, string][] = [
  ['atr', 'ATR'],
  ['fixed', 'Fixed'],
];

const upDown = (up: string, down: string) => [
  { key: up, label: 'Up colour' },
  { key: down, label: 'Down colour' },
];

const CANDLE_ROWS: RowSpec[] = [
  { label: 'Body', check: 'drawBody', colors: upDown('upColor', 'downColor') },
  { label: 'Borders', check: 'drawBorder', colors: upDown('borderUpColor', 'borderDownColor') },
  { label: 'Wick', check: 'drawWick', colors: upDown('wickUpColor', 'wickDownColor') },
];

const BAR_ROWS: RowSpec[] = [
  { label: 'Colours', colors: upDown('upColor', 'downColor') },
  { label: 'HLC bars', check: 'hlcBars' },
  { label: 'Thin bars', check: 'thinBars' },
  { label: 'Colour bars based on previous close', check: 'colorByPrevClose' },
];

const LINE_SECTIONS: SectionSpec[] = [
  {
    title: 'Line',
    rows: [
      { label: 'Price source', select: { key: 'source', options: SOURCES } },
      { label: 'Line', colors: [{ key: 'color', label: 'Line colour' }], width: 'width' },
    ],
  },
];

const atr = (s: StyleValues, key: string) => s[key] === 'atr';

const SPECS: Record<ChartType, SectionSpec[]> = {
  candles: [{ title: 'Candles', rows: CANDLE_ROWS }],
  hollowCandles: [{ title: 'Hollow candles', rows: CANDLE_ROWS }],
  volumeCandles: [{ title: 'Volume candles', rows: CANDLE_ROWS }],
  heikinAshi: [{ title: 'Heikin Ashi', rows: CANDLE_ROWS }],
  bars: [{ title: 'Bars', rows: BAR_ROWS }],
  line: LINE_SECTIONS,
  lineMarkers: LINE_SECTIONS,
  stepLine: LINE_SECTIONS,
  area: [
    {
      title: 'Area',
      rows: [
        { label: 'Price source', select: { key: 'source', options: SOURCES } },
        { label: 'Line', colors: [{ key: 'color', label: 'Line colour' }], width: 'width' },
        {
          label: 'Fill',
          colors: [
            { key: 'topFill', label: 'Top fill colour' },
            { key: 'bottomFill', label: 'Bottom fill colour' },
          ],
        },
      ],
    },
  ],
  baseline: [
    {
      title: 'Baseline',
      rows: [
        { label: 'Price source', select: { key: 'source', options: SOURCES } },
        {
          label: 'Base level',
          number: { key: 'baseLevelPercent', min: 0, max: 100, step: 1, suffix: '%' },
        },
        { label: 'Line width', width: 'width' },
      ],
    },
    {
      title: 'Top area',
      rows: [
        { label: 'Line', colors: [{ key: 'topLineColor', label: 'Top line colour' }] },
        {
          label: 'Fill',
          colors: [
            { key: 'topFill1', label: 'Top fill colour 1' },
            { key: 'topFill2', label: 'Top fill colour 2' },
          ],
        },
      ],
    },
    {
      title: 'Bottom area',
      rows: [
        { label: 'Line', colors: [{ key: 'bottomLineColor', label: 'Bottom line colour' }] },
        {
          label: 'Fill',
          colors: [
            { key: 'bottomFill1', label: 'Bottom fill colour 1' },
            { key: 'bottomFill2', label: 'Bottom fill colour 2' },
          ],
        },
      ],
    },
  ],
  hlcArea: [
    {
      title: 'HLC area',
      rows: [
        { label: 'High line', colors: [{ key: 'highColor', label: 'High line colour' }] },
        { label: 'Low line', colors: [{ key: 'lowColor', label: 'Low line colour' }] },
        {
          label: 'Close line',
          colors: [{ key: 'closeColor', label: 'Close line colour' }],
          width: 'width',
        },
        {
          label: 'Fill',
          colors: [
            { key: 'highFill', label: 'High fill colour' },
            { key: 'lowFill', label: 'Low fill colour' },
          ],
        },
      ],
    },
  ],
  columns: [
    {
      title: 'Columns',
      rows: [
        { label: 'Price source', select: { key: 'source', options: SOURCES } },
        { label: 'Colours', colors: upDown('upColor', 'downColor') },
        { label: 'Colour bars based on previous close', check: 'colorByPrevClose' },
      ],
    },
  ],
  highLow: [
    {
      title: 'High-low',
      rows: [
        { label: 'Body', colors: [{ key: 'color', label: 'Body colour' }] },
        { label: 'Borders', colors: [{ key: 'borderColor', label: 'Border colour' }] },
        {
          label: 'Labels',
          check: 'showLabels',
          colors: [{ key: 'labelColor', label: 'Label colour' }],
        },
      ],
    },
  ],
  renko: [
    {
      title: 'Box size',
      rows: [
        { label: 'Box size assignment method', select: { key: 'boxSizeMode', options: BOX_MODES } },
        {
          label: 'ATR length',
          number: { key: 'atrLength', min: 1, max: 500, step: 1 },
          show: (s) => atr(s, 'boxSizeMode'),
        },
        {
          label: 'Box size',
          number: { key: 'boxSize', min: 0.000001, max: 1e9, step: 0.01 },
          show: (s) => !atr(s, 'boxSizeMode'),
        },
        { label: 'Source', select: { key: 'source', options: BRICK_SOURCES } },
        { label: 'Wicks', check: 'wicks' },
      ],
    },
    { title: 'Bricks', rows: CANDLE_ROWS },
  ],
  lineBreak: [
    {
      title: 'Line break',
      rows: [{ label: 'Number of lines', number: { key: 'lines', min: 1, max: 50, step: 1 } }],
    },
    { title: 'Colours', rows: CANDLE_ROWS },
  ],
  kagi: [
    {
      title: 'Reversal',
      rows: [
        {
          label: 'Reversal method',
          select: {
            key: 'reversalMode',
            options: [
              ['atr', 'ATR'],
              ['fixed', 'Fixed'],
              ['percent', 'Percentage'],
            ],
          },
        },
        {
          label: 'ATR length',
          number: { key: 'atrLength', min: 1, max: 500, step: 1 },
          show: (s) => atr(s, 'reversalMode'),
        },
        {
          label: 'Reversal amount',
          number: { key: 'reversal', min: 0.000001, max: 1e9, step: 0.01 },
          show: (s) => s.reversalMode === 'fixed',
        },
        {
          label: 'Reversal amount',
          number: { key: 'reversal', min: 0.01, max: 100, step: 0.1, suffix: '%' },
          show: (s) => s.reversalMode === 'percent',
        },
        { label: 'Source', select: { key: 'source', options: BRICK_SOURCES } },
      ],
    },
    {
      title: 'Lines',
      rows: [
        {
          label: 'Yang line',
          colors: [{ key: 'yangColor', label: 'Yang line colour' }],
          width: 'yangWidth',
        },
        {
          label: 'Yin line',
          colors: [{ key: 'yinColor', label: 'Yin line colour' }],
          width: 'yinWidth',
        },
      ],
    },
  ],
  pointFigure: [
    {
      title: 'Box size',
      rows: [
        { label: 'Box size assignment method', select: { key: 'boxSizeMode', options: BOX_MODES } },
        {
          label: 'ATR length',
          number: { key: 'atrLength', min: 1, max: 500, step: 1 },
          show: (s) => atr(s, 'boxSizeMode'),
        },
        {
          label: 'Box size',
          number: { key: 'boxSize', min: 0.000001, max: 1e9, step: 0.01 },
          show: (s) => !atr(s, 'boxSizeMode'),
        },
        {
          label: 'Reversal amount',
          number: { key: 'reversal', min: 1, max: 20, step: 1, suffix: 'boxes' },
        },
        { label: 'Source', select: { key: 'source', options: BRICK_SOURCES } },
      ],
    },
    { title: 'Colours', rows: [{ label: 'X / O', colors: upDown('upColor', 'downColor') }] },
  ],
  range: [
    {
      title: 'Range',
      rows: [
        { label: 'Range assignment method', select: { key: 'rangeMode', options: BOX_MODES } },
        {
          label: 'ATR length',
          number: { key: 'atrLength', min: 1, max: 500, step: 1 },
          show: (s) => atr(s, 'rangeMode'),
        },
        {
          label: 'Range',
          number: { key: 'range', min: 0.000001, max: 1e9, step: 0.01 },
          show: (s) => !atr(s, 'rangeMode'),
        },
      ],
    },
    { title: 'Bars', rows: BAR_ROWS },
  ],
};

interface Props {
  type: ChartType;
  /** Effective style for `type` (defaults merged with overrides). */
  style: ChartStyle[ChartType];
  onChange: (patch: StyleValues) => void;
}

/** Spec-driven, standard style rows for the active chart type. */
export function ChartStyleEditor({ type, style, onChange }: Props) {
  const s = style as unknown as StyleValues;
  return (
    <>
      {SPECS[type].map((section) => (
        <section key={section.title} className="dlg-section">
          <h3 className="dlg-section-head">{section.title}</h3>
          {section.rows
            .filter((r) => !r.show || r.show(s))
            .map((r, i) => (
              <StyleRow key={`${r.label}-${i}`} row={r} values={s} onChange={onChange} />
            ))}
        </section>
      ))}
    </>
  );
}

function StyleRow({
  row,
  values,
  onChange,
}: {
  row: RowSpec;
  values: StyleValues;
  onChange: (p: StyleValues) => void;
}) {
  const { check, select, number, width } = row;
  const checked = check ? values[check] === true : true;
  const id = `style-${select?.key ?? number?.key ?? check ?? row.label}`.replace(/\W/g, '-');
  return (
    <div className="dlg-row">
      {check ? (
        <label className="dlg-check dlg-row-label">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange({ [check]: e.target.checked })}
          />
          <span>{row.label}</span>
        </label>
      ) : (
        <label className="dlg-row-label" htmlFor={select || number ? id : undefined}>
          {row.label}
        </label>
      )}
      <div className="dlg-row-control">
        {row.colors?.map((c) => (
          <ColorSwatch
            key={c.key}
            label={c.label}
            value={String(values[c.key] ?? '')}
            disabled={!checked}
            onChange={(v) => onChange({ [c.key]: v })}
          />
        ))}
        {width ? (
          <WidthSelect
            value={Number(values[width] ?? 1)}
            onChange={(w) => onChange({ [width]: w })}
          />
        ) : null}
        {select ? (
          <select
            id={id}
            className="io-input dlg-select"
            value={String(values[select.key] ?? '')}
            onChange={(e) => onChange({ [select.key]: e.target.value })}
          >
            {select.options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : null}
        {number ? (
          <NumberInput
            id={id}
            spec={number}
            value={Number(values[number.key] ?? 0)}
            onChange={onChange}
          />
        ) : null}
      </div>
    </div>
  );
}

function NumberInput({
  id,
  spec,
  value,
  onChange,
}: {
  id: string;
  spec: NumberSpec;
  value: number;
  onChange: (p: StyleValues) => void;
}) {
  return (
    <span className="dlg-number">
      <input
        id={id}
        className="io-input"
        type="number"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        defaultValue={value}
        key={value}
        onBlur={(e) => commitNumber(e.target, spec, value, onChange)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitNumber(e.currentTarget, spec, value, onChange);
        }}
      />
      {spec.suffix ? <span className="dlg-number-suffix">{spec.suffix}</span> : null}
    </span>
  );
}

/** Clamp and apply; invalid input snaps back to the previous value. */
function commitNumber(
  el: HTMLInputElement,
  spec: NumberSpec,
  prev: number,
  onChange: (p: StyleValues) => void,
) {
  const n = Number(el.value);
  if (el.value.trim() === '' || !Number.isFinite(n)) {
    el.value = String(prev);
    return;
  }
  let v = Math.max(spec.min, Math.min(spec.max, n));
  if (Number.isInteger(spec.step)) v = Math.round(v);
  el.value = String(v);
  if (v !== prev) onChange({ [spec.key]: v });
}

function WidthSelect({ value, onChange }: { value: number; onChange: (w: number) => void }) {
  return (
    <div className="dlg-widths" role="radiogroup" aria-label="Line width">
      {[1, 2, 3, 4].map((w) => (
        <button
          key={w}
          type="button"
          role="radio"
          aria-checked={value === w}
          aria-label={`${w}px`}
          className={value === w ? 'active' : ''}
          onClick={() => onChange(w)}
        >
          <span style={{ height: w }} />
        </button>
      ))}
    </div>
  );
}
