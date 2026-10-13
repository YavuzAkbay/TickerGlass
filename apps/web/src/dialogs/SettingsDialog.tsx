import {
  AlarmClock,
  Briefcase,
  CalendarDays,
  ChartCandlestick,
  ChevronDown,
  Paintbrush,
  PanelTop,
  Ruler,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { Chart, CrosshairMode, MagnetMode, PriceScaleMode } from '@investopen/engine';
import { changeScale } from '../chart/scaleActions';
import { useAppStore, type Theme } from '../store/app';
import { getChart } from '../store/chart';
import { DropdownMenu } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import './dialogs.css';

type TabId = 'symbol' | 'status' | 'scales' | 'canvas' | 'trading' | 'alerts' | 'events';

const TABS: {
  id: TabId;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { id: 'symbol', label: 'Symbol', icon: ChartCandlestick },
  { id: 'status', label: 'Status line', icon: PanelTop },
  { id: 'scales', label: 'Scales and lines', icon: Ruler },
  { id: 'canvas', label: 'Canvas', icon: Paintbrush },
  { id: 'trading', label: 'Trading', icon: Briefcase },
  { id: 'alerts', label: 'Alerts', icon: AlarmClock },
  { id: 'events', label: 'Events', icon: CalendarDays },
];

const PLANNED: Partial<Record<TabId, string[]>> = {
  status: [
    'Symbol title: description, ticker, exchange',
    'Open market status',
    'OHLC values and bar change',
    'Volume and last-day change values',
    'Indicator titles, inputs and values',
    'Status line background',
  ],
  trading: [
    'Buy/sell buttons and instant orders',
    'Positions, orders and executions on chart',
    'Profit & loss display',
    'Order and position line styles',
  ],
  alerts: [
    'Alert lines and colour',
    'Show only active alerts',
    'Alert volume and sound',
    'Hide toasts automatically',
  ],
  events: [
    'Ideas, dividends, splits and earnings',
    'Economic events and session breaks',
    'Latest news markers',
  ],
};

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Zurich',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

interface Draft {
  theme: Theme;
  crosshair: CrosshairMode;
  magnet: MagnetMode;
  prepost: boolean;
  timezone: string;
  scale: { mode: PriceScaleMode; invert: boolean; autoScale: boolean } | null;
}

const DEFAULTS: Omit<Draft, 'scale'> & { scale: NonNullable<Draft['scale']> } = {
  theme: 'dark',
  crosshair: 'cross',
  magnet: 'off',
  prepost: false,
  timezone: 'exchange',
  scale: { mode: 'linear', invert: false, autoScale: true },
};

function readScale(chart: Chart | null): Draft['scale'] {
  const ps = chart?.getState().panes.find((p) => p.id === 'main')?.priceScale;
  return ps ? { mode: ps.mode, invert: ps.invert, autoScale: ps.autoScale } : null;
}

function readDraft(): Draft {
  const s = useAppStore.getState();
  return {
    theme: s.theme,
    crosshair: s.crosshair,
    magnet: s.magnet,
    prepost: s.prepost,
    timezone: s.timezone,
    scale: readScale(getChart()),
  };
}

/** Push a draft to the app store and chart (live preview, without undo entries). */
function applyDraft(d: Draft): void {
  const { scale, ...app } = d;
  useAppStore.getState().set(app);
  const chart = getChart();
  if (chart && scale && readScale(chart)) {
    chart.setPriceScaleMode('main', scale.mode);
    chart.setInvertScale('main', scale.invert);
    chart.setAutoScale('main', scale.autoScale);
  }
}

const sameScale = (a: Draft['scale'], b: Draft['scale']) =>
  !!a && !!b && a.mode === b.mode && a.invert === b.invert && a.autoScale === b.autoScale;

/** standard chart settings: tabs on the left, live preview, Ok applies, Cancel reverts. */
export default function SettingsDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [initial] = useState(readDraft);
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<TabId>('symbol');
  const [templateBtn, setTemplateBtn] = useState<HTMLButtonElement | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const settled = useRef(false);

  // Leaving without Ok (Escape, overlay, another dialog replacing this one) reverts.
  useEffect(() => {
    settled.current = false;
    return () => {
      if (!settled.current) applyDraft(initial);
    };
  }, [initial]);

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    applyDraft(next);
  };
  const updateScale = (patch: Partial<NonNullable<Draft['scale']>>) => {
    if (draft.scale) update({ scale: { ...draft.scale, ...patch } });
  };

  const ok = () => {
    settled.current = true;
    applyDraft(draft);
    // Record the scale change as one undoable step, starting from the pre-dialog state.
    const chart = getChart();
    if (chart && initial.scale && draft.scale && !sameScale(initial.scale, draft.scale)) {
      applyDraft({ ...draft, scale: initial.scale });
      changeScale(chart, 'main', draft.scale, 'Chart settings');
    }
    onClose();
  };

  const cancel = () => {
    settled.current = true;
    applyDraft(initial);
    onClose();
  };

  const footer = (
    <>
      <button
        ref={setTemplateBtn}
        type="button"
        className="io-btn dlg-template"
        aria-haspopup="menu"
        aria-expanded={templateOpen}
        onClick={() => setTemplateOpen((o) => !o)}
      >
        Template <ChevronDown size={14} />
      </button>
      <DropdownMenu
        anchor={templateBtn}
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        placement="bottom-start"
        items={[
          {
            label: 'Apply defaults',
            onSelect: () => update({ ...DEFAULTS, scale: draft.scale ? DEFAULTS.scale : null }),
          },
          { type: 'separator' },
          { label: 'Save as…', disabled: true },
          {
            type: 'custom',
            render: () => <div className="dlg-menu-note">Templates arrive in Phase 15</div>,
          },
        ]}
      />
      <div className="dlg-footer-spacer" />
      <button type="button" className="io-btn" onClick={cancel}>
        Cancel
      </button>
      <button type="button" className="io-btn io-btn-primary" onClick={ok}>
        Ok
      </button>
    </>
  );

  let content: ReactNode;
  if (tab === 'symbol') {
    content = (
      <>
        <Section title="Session">
          <Row label="Extended trading hours">
            <Check
              checked={draft.prepost}
              label="Show pre-market and post-market"
              onChange={(prepost) => update({ prepost })}
            />
          </Row>
        </Section>
        <Section title="Time">
          <Row label="Timezone" htmlFor="set-tz">
            <select
              id="set-tz"
              className="io-input dlg-select"
              value={draft.timezone}
              onChange={(e) => update({ timezone: e.target.value })}
            >
              <option value="exchange">Exchange</option>
              <option value="local">
                Local ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              </option>
              <option value="UTC">UTC</option>
              <optgroup label="Time zones">
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </option>
                ))}
              </optgroup>
              {!['exchange', 'local', 'UTC', ...TIMEZONES].includes(draft.timezone) ? (
                <option value={draft.timezone}>{draft.timezone}</option>
              ) : null}
            </select>
          </Row>
        </Section>
        <Planned
          items={[
            'Body, border and wick colours',
            'Colour bars based on previous close',
            'Precision',
            'Data modification (adjust for dividends)',
          ]}
        />
      </>
    );
  } else if (tab === 'scales') {
    const s = draft.scale;
    content = (
      <>
        <Section title="Price scale">
          {s ? (
            <>
              <Row label="Scale mode">
                <Segmented
                  value={s.mode}
                  options={[
                    ['linear', 'Regular'],
                    ['percent', 'Percent'],
                    ['indexed', 'Indexed to 100'],
                    ['log', 'Logarithmic'],
                  ]}
                  onChange={(mode) => updateScale({ mode })}
                />
              </Row>
              <Row label="Invert scale">
                <Check
                  checked={s.invert}
                  label="Invert price scale"
                  onChange={(invert) => updateScale({ invert })}
                />
              </Row>
              <Row label="Auto scale">
                <Check
                  checked={s.autoScale}
                  label="Fit data to the visible range"
                  onChange={(autoScale) => updateScale({ autoScale })}
                />
              </Row>
            </>
          ) : (
            <div className="dlg-note">
              The chart is still loading; scale options are unavailable.
            </div>
          )}
        </Section>
        <Planned
          items={[
            'Scale placement and labels',
            'Countdown to bar close',
            'Grid lines and session breaks',
            'Price line and previous-close line',
          ]}
        />
      </>
    );
  } else if (tab === 'canvas') {
    content = (
      <>
        <Section title="Chart basic styles">
          <Row label="Theme">
            <Segmented
              value={draft.theme}
              options={[
                ['dark', 'Dark'],
                ['light', 'Light'],
              ]}
              onChange={(theme) => update({ theme })}
            />
          </Row>
          <Row label="Crosshair" htmlFor="set-crosshair">
            <select
              id="set-crosshair"
              className="io-input dlg-select"
              value={draft.crosshair}
              onChange={(e) => update({ crosshair: e.target.value as CrosshairMode })}
            >
              <option value="cross">Cross</option>
              <option value="dot">Dot</option>
              <option value="arrow">Arrow</option>
            </select>
          </Row>
          <Row label="Magnet" htmlFor="set-magnet">
            <select
              id="set-magnet"
              className="io-input dlg-select"
              value={draft.magnet}
              onChange={(e) => update({ magnet: e.target.value as MagnetMode })}
            >
              <option value="off">Off</option>
              <option value="weak">Weak magnet</option>
              <option value="strong">Strong magnet</option>
            </select>
          </Row>
        </Section>
        <Planned
          items={[
            'Background colour and gradient',
            'Grid lines',
            'Crosshair colour and style',
            'Watermark',
            'Scale text and lines colours',
            'Margins',
          ]}
        />
      </>
    );
  } else {
    content = (
      <Placeholder title={TABS.find((t) => t.id === tab)?.label ?? ''} items={PLANNED[tab] ?? []} />
    );
  }

  return (
    <Modal title="Settings" onClose={cancel} width={760} footer={footer} className="dlg-settings">
      <div className="dlg-settings-body">
        <nav
          className="dlg-side"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`dlg-side-item${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="dlg-settings-content" role="tabpanel">
          {content}
        </div>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dlg-section">
      <h3 className="dlg-section-head">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="dlg-row">
      {htmlFor ? (
        <label className="dlg-row-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="dlg-row-label">{label}</span>
      )}
      <div className="dlg-row-control">{children}</div>
    </div>
  );
}

function Check({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="dlg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="dlg-segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'active' : ''}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Planned({ items }: { items: string[] }) {
  return (
    <div className="dlg-planned">
      <div className="dlg-planned-title">More in Phase 15</div>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

function Placeholder({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="dlg-placeholder">
      <div className="dlg-placeholder-badge">Phase 15</div>
      <h3>{title} settings are coming in Phase 15</h3>
      <p>Planned options:</p>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
