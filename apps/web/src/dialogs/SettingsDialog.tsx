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
import {
  DARK_THEME,
  LIGHT_THEME,
  defaultChartStyle,
  type Chart,
  type ChartStyle,
  type ChartType,
  type CrosshairMode,
  type DeepPartial,
  type LegendTitleMode,
  type MagnetMode,
  type PriceScaleMode,
} from '@tickerglass/engine';
import { AlertsSettingsTab } from '../alerts/SettingsTab';
import { EventsTab } from '../events/EventsTab';
import { errorMessage } from '../api/client';
import { changeScale } from '../commands/scaleActions';
import {
  CHART_TEMPLATE_SCHEMA_VERSION,
  readChartTemplate,
  templateData,
} from '../persist/chartTemplates';
import { useT, type MessageKey } from '../i18n';
import { chartTemplates, type TemplateRow } from '../persist/templateCache';
import { confirmDialog, promptName } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { useAppStore, type Theme } from '../store/app';
import { DEFAULT_STATUS_LINE, useChartView, type StatusLineSettings } from '../store/chartView';
import { TradingTab } from '../replay/TradingTab';
import { chartTypeDef } from '../topbar/chartTypes';
import { getChart } from '../store/chart';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { Modal } from '../ui/Modal';
import { ChartStyleEditor } from './ChartStyleEditor';
import { Row, Section, Segmented, Setting } from './controls';
import './dialogs.css';

type TabId = 'symbol' | 'status' | 'scales' | 'canvas' | 'trading' | 'alerts' | 'events';

const TABS: {
  id: TabId;
  label: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}[] = [
  { id: 'symbol', label: 'settings.tab.symbol', icon: ChartCandlestick },
  { id: 'status', label: 'settings.tab.status', icon: PanelTop },
  { id: 'scales', label: 'settings.tab.scales', icon: Ruler },
  { id: 'canvas', label: 'settings.tab.canvas', icon: Paintbrush },
  { id: 'trading', label: 'settings.tab.trading', icon: Briefcase },
  { id: 'alerts', label: 'settings.tab.alerts', icon: AlarmClock },
  { id: 'events', label: 'settings.tab.events', icon: CalendarDays },
];

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
  chartStyle: DeepPartial<ChartStyle>;
  showPrevClose: boolean;
  statusLine: StatusLineSettings;
  scale: { mode: PriceScaleMode; invert: boolean; autoScale: boolean } | null;
}

const DEFAULTS: Omit<Draft, 'scale'> & { scale: NonNullable<Draft['scale']> } = {
  theme: 'dark',
  crosshair: 'cross',
  magnet: 'off',
  prepost: false,
  timezone: 'exchange',
  chartStyle: {},
  showPrevClose: false,
  statusLine: DEFAULT_STATUS_LINE,
  scale: { mode: 'linear', invert: false, autoScale: true },
};

/** Effective style of one chart type: theme defaults with the user's overrides on top. */
function effectiveStyle(theme: Theme, overrides: DeepPartial<ChartStyle>, type: ChartType) {
  const base = defaultChartStyle(theme === 'dark' ? DARK_THEME : LIGHT_THEME)[type];
  return { ...base, ...(overrides[type] ?? {}) } as ChartStyle[ChartType];
}

function readScale(chart: Chart | null): Draft['scale'] {
  const ps = chart?.getState().panes.find((p) => p.id === 'main')?.priceScale;
  return ps ? { mode: ps.mode, invert: ps.invert, autoScale: ps.autoScale } : null;
}

function readDraft(): Draft {
  const s = useAppStore.getState();
  const v = useChartView.getState();
  return {
    theme: s.theme,
    crosshair: s.crosshair,
    magnet: s.magnet,
    prepost: v.prepost,
    timezone: v.timezone,
    chartStyle: v.chartStyle,
    showPrevClose: v.showPrevClose,
    statusLine: v.statusLine,
    scale: readScale(getChart()),
  };
}

/** Push a draft to the app store and chart (live preview, without undo entries). */
function applyDraft(d: Draft): void {
  const { scale, theme, crosshair, magnet, ...view } = d;
  useAppStore.getState().set({ theme, crosshair, magnet });
  useChartView.getState().set(view);
  const chart = getChart();
  if (chart && scale && readScale(chart)) {
    chart.setPriceScaleMode('main', scale.mode);
    chart.setInvertScale('main', scale.invert);
    chart.setAutoScale('main', scale.autoScale);
  }
}

const sameScale = (a: Draft['scale'], b: Draft['scale']) =>
  !!a && !!b && a.mode === b.mode && a.invert === b.invert && a.autoScale === b.autoScale;

/** Chart settings: tabs on the left, live preview, Ok applies, Cancel reverts. */
export default function SettingsDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const t = useT();
  const [initial] = useState(readDraft);
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState<TabId>('symbol');
  const chartType = useChartView((st) => st.chartType);
  const [templateBtn, setTemplateBtn] = useState<HTMLButtonElement | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow<Record<string, unknown>>[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const settled = useRef(false);

  const loadTemplates = () =>
    chartTemplates
      .list()
      .then(({ items: list }) => {
        setTemplates([...list].sort((a, b) => a.name.localeCompare(b.name)));
        setTemplatesError(null);
      })
      .catch((err) => setTemplatesError(errorMessage(err)));

  const saveTemplate = async () => {
    const name = await promptName({ title: 'Save chart template' });
    if (!name) return;
    if (
      templates?.some((t) => t.name === name) &&
      !(await confirmDialog({
        title: 'Replace template',
        message: `A chart template named "${name}" exists. Replace it?`,
        okLabel: 'Replace',
      }))
    )
      return;
    try {
      const { offline } = await chartTemplates.save(
        name,
        templateData(draft) as unknown as Record<string, unknown>,
        CHART_TEMPLATE_SCHEMA_VERSION,
      );
      if (offline)
        toast(`Chart template "${name}" saved (server unreachable: it will sync later)`, 'info');
      else toast(`Chart template "${name}" saved`, 'success');
    } catch (err) {
      toast(`Template could not be saved: ${errorMessage(err)}`, 'error', 6000);
    }
  };

  const removeTemplate = async (t: TemplateRow<Record<string, unknown>>) => {
    const yes = await confirmDialog({
      title: 'Delete template',
      message: `Delete the chart template "${t.name}"?`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await chartTemplates.remove(t);
    } catch (err) {
      toast(`Template could not be deleted: ${errorMessage(err)}`, 'error', 6000);
    }
  };

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
  const updateStyle = (patch: Record<string, string | number | boolean>) => {
    const cur = draft.chartStyle[chartType] ?? {};
    update({
      chartStyle: {
        ...draft.chartStyle,
        [chartType]: { ...cur, ...patch },
      } as DeepPartial<ChartStyle>,
    });
  };
  const resetStyle = () => {
    const { [chartType]: _dropped, ...rest } = draft.chartStyle;
    update({ chartStyle: rest });
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
        onClick={() => {
          if (!templateOpen) void loadTemplates();
          setTemplateOpen((o) => !o);
        }}
      >
        Template <ChevronDown size={14} />
      </button>
      <DropdownMenu
        anchor={templateBtn}
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        placement="bottom-start"
        items={templateItems()}
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

  function templateItems(): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Apply defaults',
        onSelect: () => update({ ...DEFAULTS, scale: draft.scale ? DEFAULTS.scale : null }),
      },
      { type: 'separator' },
      { label: 'Save as…', onSelect: () => void saveTemplate() },
    ];
    if (templatesError)
      items.push({
        type: 'custom',
        render: () => <div className="dlg-menu-note">Templates unavailable: {templatesError}</div>,
      });
    else if (templates?.length) {
      items.push({ type: 'separator' }, { type: 'header', label: 'Templates' });
      for (const t of templates)
        items.push({ label: t.name, onSelect: () => update(readChartTemplate(draft, t.data)) });
      items.push({
        label: 'Remove template',
        submenu: templates.map((t) => ({ label: t.name, onSelect: () => void removeTemplate(t) })),
      });
    }
    return items;
  }

  const typeDef = chartTypeDef(chartType);
  const TypeIcon = typeDef?.icon;
  let content: ReactNode;
  if (tab === 'symbol') {
    content = (
      <>
        <div className="dlg-style-head">
          <span className="dlg-style-type">
            {TypeIcon ? <TypeIcon size={18} /> : null}
            {typeDef?.label ?? chartType}
          </span>
          <button
            type="button"
            className="dlg-link"
            disabled={!draft.chartStyle[chartType]}
            onClick={resetStyle}
          >
            Reset to defaults
          </button>
        </div>
        <ChartStyleEditor
          key={chartType}
          type={chartType}
          style={effectiveStyle(draft.theme, draft.chartStyle, chartType)}
          onChange={updateStyle}
        />
        <Section title="Session">
          <Setting
            checked={draft.prepost}
            label="Extended trading hours"
            hint="Show pre-market and post-market bars"
            onChange={(prepost) => update({ prepost })}
          />
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
      </>
    );
  } else if (tab === 'status') {
    const sl = draft.statusLine;
    const updateStatus = (patch: Partial<StatusLineSettings>) =>
      update({ statusLine: { ...sl, ...patch } });
    content = (
      <>
        <Section title="Symbol">
          <Row label="Title" htmlFor="set-sl-title">
            <select
              id="set-sl-title"
              className="io-input dlg-select"
              value={sl.title}
              onChange={(e) => updateStatus({ title: e.target.value as LegendTitleMode })}
            >
              <option value="ticker">Ticker</option>
              <option value="description">Description</option>
              <option value="both">Ticker and description</option>
            </select>
          </Row>
          <Setting
            checked={sl.exchange}
            label="Exchange name"
            hint="Show it next to the symbol"
            onChange={(exchange) => updateStatus({ exchange })}
          />
        </Section>
        <Section title="Values">
          <Setting
            checked={sl.ohlc}
            label="Open, high, low and close"
            onChange={(ohlc) => updateStatus({ ohlc })}
          />
          <Setting
            checked={sl.barChange}
            label="Change from the previous close"
            onChange={(barChange) => updateStatus({ barChange })}
          />
          <Setting
            checked={sl.volume}
            label="Volume"
            onChange={(volume) => updateStatus({ volume })}
          />
        </Section>
        <Section title="Indicators and overlays">
          <Setting
            checked={sl.indicatorTitles}
            label="Titles"
            onChange={(indicatorTitles) => updateStatus({ indicatorTitles })}
          />
          <Setting
            checked={sl.indicatorInputs}
            label="Inputs"
            onChange={(indicatorInputs) => updateStatus({ indicatorInputs })}
          />
          <Setting
            checked={sl.indicatorValues}
            label="Values"
            onChange={(indicatorValues) => updateStatus({ indicatorValues })}
          />
        </Section>
        <Section title="Appearance">
          <Setting
            checked={sl.background}
            label="Background behind the status line"
            onChange={(background) => updateStatus({ background })}
          />
        </Section>
      </>
    );
  } else if (tab === 'scales') {
    const s = draft.scale;
    content = (
      <>
        <Section title="Price scale">
          {s ? (
            <>
              <Row label="Scale mode" stacked>
                <Segmented
                  fill
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
              <Setting
                checked={s.invert}
                label="Invert scale"
                hint="Higher prices at the bottom"
                onChange={(invert) => updateScale({ invert })}
              />
              <Setting
                checked={s.autoScale}
                label="Auto scale"
                hint="Fit the price range to the visible bars"
                onChange={(autoScale) => updateScale({ autoScale })}
              />
            </>
          ) : (
            <div className="dlg-note">
              The chart is still loading; scale options are unavailable.
            </div>
          )}
        </Section>
        <Section title="Lines">
          <Setting
            checked={draft.showPrevClose}
            label="Previous day close"
            hint="Draw a price line at yesterday's close"
            onChange={(showPrevClose) => update({ showPrevClose })}
          />
        </Section>
      </>
    );
  } else if (tab === 'canvas') {
    content = (
      <>
        <Section title="Appearance">
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
        </Section>
        <Section title="Cursor and snapping">
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
      </>
    );
  } else if (tab === 'alerts') {
    content = <AlertsSettingsTab />;
  } else if (tab === 'events') {
    content = <EventsTab />;
  } else {
    content = <TradingTab />;
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
          {TABS.map((def) => {
            const Icon = def.icon;
            return (
              <button
                key={def.id}
                type="button"
                role="tab"
                aria-selected={tab === def.id}
                className={`dlg-side-item${tab === def.id ? ' active' : ''}`}
                onClick={() => setTab(def.id)}
              >
                <Icon size={18} strokeWidth={1.6} />
                <span>{t(def.label)}</span>
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
