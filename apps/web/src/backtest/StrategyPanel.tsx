import { PRICE_FIELDS } from '@tickerglass/alerts';
import {
  COMPARE_OPS,
  MOVE_OPS,
  type CompareOp,
  type IndicatorOperand,
  type MovingOp,
  type Operand,
  type PriceField,
  type Rule,
  type RuleCondition,
  type RuleKey,
  type Strategy,
  type StrategySettings,
  type Trade,
} from '@tickerglass/backtest';
import { Copy, MoreHorizontal, Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useIndicatorStore } from '../indicators/store';
import { fmtPrice, fmtSigned } from '../sidebar/format';
import { getChart, useChartStore } from '../store/chart';
import { useChartView } from '../store/chartView';
import { DropdownMenu } from '../ui/Menu';
import { confirmDialog, promptName } from '../ui/Prompt';
import { BacktestError, findInstance, runOnChart, showRun } from './run';
import { activeStrategy, useBacktestRun, useStrategies, type BacktestRun } from './store';
import './backtest.css';

// ------------------------------------------------------------ operands

interface OperandOption {
  value: string;
  label: string;
  operand: Operand;
  /** Shape outputs: usable as "signal" conditions. */
  shape: boolean;
  /** Drawn on the price pane (a sensible default to compare price with). */
  overlay: boolean;
}

const PRICE_LABELS: Record<PriceField, string> = {
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  hl2: 'HL2',
  hlc3: 'HLC3',
  ohlc4: 'OHLC4',
};

const OP_LABELS: Record<CompareOp | MovingOp, string> = {
  crossingUp: 'crosses above',
  crossingDown: 'crosses below',
  crossing: 'crosses',
  greater: 'is above',
  less: 'is below',
  movingUp: 'rises by',
  movingDown: 'falls by',
  movingUpPercent: 'rises by %',
  movingDownPercent: 'falls by %',
};

const RULES: { key: RuleKey; title: string }[] = [
  { key: 'longEntry', title: 'Long entry' },
  { key: 'longExit', title: 'Long exit' },
  { key: 'shortEntry', title: 'Short entry' },
  { key: 'shortExit', title: 'Short exit' },
];

const operandValue = (op: Operand): string =>
  op.kind === 'price' ? `price:${op.field}` : `ind:${op.instanceId}:${op.outputId}`;

/** Price fields plus every plot / shape output of the active chart's indicators. */
function useOperandOptions(): OperandOption[] {
  const instances = useIndicatorStore((s) => s.instances);
  const chart = useChartStore((s) => s.chart);
  // Study titles follow input changes; re-read when indicators change.
  return useMemo(() => {
    const out: OperandOption[] = PRICE_FIELDS.map((f) => ({
      value: `price:${f}`,
      label: PRICE_LABELS[f],
      operand: { kind: 'price', field: f },
      shape: false,
      overlay: true,
    }));
    if (!chart) return out;
    const paneOf = new Map(chart.getStudies().map((st) => [st.id, st.paneId]));
    for (const inst of instances) {
      const data = chart.getStudyData(inst.id);
      if (!data) continue;
      for (const o of data.spec.outputs) {
        if (o.type !== 'plot' && o.type !== 'shape') continue;
        const title = `${data.spec.title}${o.title ? `: ${o.title}` : ''}`;
        const operand: IndicatorOperand = {
          kind: 'indicator',
          instanceId: inst.id,
          type: inst.type,
          inputs: structuredClone(inst.inputs) as Record<string, unknown>,
          outputId: o.id,
          title,
        };
        out.push({
          value: operandValue(operand),
          label: title,
          operand,
          shape: o.type === 'shape',
          overlay: paneOf.get(inst.id) === 'main' && inst.type !== 'volume',
        });
      }
    }
    return out;
  }, [instances, chart]);
}

function OperandSelect({
  value,
  options,
  onChange,
  label,
  shapesOnly = false,
  allowValue = false,
}: {
  value: Operand | { kind: 'value'; value: number };
  options: OperandOption[];
  onChange: (op: Operand | { kind: 'value'; value: number }) => void;
  label: string;
  shapesOnly?: boolean;
  allowValue?: boolean;
}) {
  const list = options.filter((o) => (shapesOnly ? o.shape : true));
  const current = value.kind === 'value' ? 'value' : operandValue(value);
  // A saved operand that is not on this chart stays selectable (and is flagged).
  const known = current === 'value' || list.some((o) => o.value === current);
  return (
    <select
      className="io-input bt-select"
      aria-label={label}
      value={current}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'value') onChange({ kind: 'value', value: 0 });
        else {
          const o = list.find((x) => x.value === v);
          if (o) onChange(o.operand);
        }
      }}
    >
      {allowValue ? <option value="value">Value</option> : null}
      {!known && value.kind === 'indicator' ? (
        <option value={current}>{`${value.title} (not on chart)`}</option>
      ) : null}
      {list.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Number input that commits on blur / Enter and keeps the text while typing. */
function NumField({
  value,
  onChange,
  label,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  // Follow outside changes (another strategy selected, a sync) during render.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || text.trim() === '') return setText(String(value));
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (c !== value) onChange(c);
    setText(String(c));
  };
  return (
    <input
      className="io-input bt-num"
      type="number"
      inputMode="decimal"
      aria-label={label}
      value={text}
      min={min}
      max={max}
      step={step ?? 'any'}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

// ---------------------------------------------------------- conditions

function defaultCondition(options: OperandOption[]): RuleCondition {
  const firstInd = options.find((o) => o.operand.kind === 'indicator' && !o.shape && o.overlay);
  return {
    kind: 'compare',
    left: { kind: 'price', field: 'close' },
    op: 'crossingUp',
    right: firstInd ? firstInd.operand : { kind: 'value', value: 0 },
  };
}

function ConditionRow({
  cond,
  options,
  onChange,
  onRemove,
}: {
  cond: RuleCondition;
  options: OperandOption[];
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
}) {
  const shapes = options.filter((o) => o.shape);
  const opValue = cond.kind === 'signal' ? 'signal' : cond.op;
  const changeOp = (v: string) => {
    if (v === 'signal') {
      const first = shapes[0]?.operand as IndicatorOperand | undefined;
      const left = cond.left.kind === 'indicator' ? cond.left : first;
      if (left) onChange({ kind: 'signal', left });
      return;
    }
    const left = cond.left;
    if ((MOVE_OPS as readonly string[]).includes(v))
      onChange({
        kind: 'moving',
        left,
        op: v as MovingOp,
        amount: cond.kind === 'moving' ? cond.amount : 1,
        bars: cond.kind === 'moving' ? cond.bars : 1,
      });
    else
      onChange({
        kind: 'compare',
        left,
        op: v as CompareOp,
        right: cond.kind === 'compare' ? cond.right : { kind: 'value', value: 0 },
      });
  };
  return (
    <li className="bt-cond">
      <div className="bt-cond-line">
        <OperandSelect
          label="Left value"
          value={cond.left}
          options={options}
          shapesOnly={cond.kind === 'signal'}
          onChange={(op) => op.kind !== 'value' && onChange({ ...cond, left: op } as RuleCondition)}
        />
        <button
          type="button"
          className="io-icon-btn bt-cond-remove"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <X size={14} />
        </button>
      </div>
      <div className="bt-cond-line">
        <select
          className="io-input bt-select bt-op"
          aria-label="Condition"
          value={opValue}
          onChange={(e) => changeOp(e.target.value)}
        >
          {COMPARE_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
          {MOVE_OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
          <option value="signal" disabled={!shapes.length && cond.kind !== 'signal'}>
            fires (marker)
          </option>
        </select>
        {cond.kind === 'compare' ? (
          <>
            <OperandSelect
              label="Right value"
              value={cond.right}
              options={options}
              allowValue
              onChange={(right) => onChange({ ...cond, right })}
            />
            {cond.right.kind === 'value' ? (
              <NumField
                label="Constant"
                value={cond.right.value}
                onChange={(value) => onChange({ ...cond, right: { kind: 'value', value } })}
              />
            ) : null}
          </>
        ) : null}
        {cond.kind === 'moving' ? (
          <>
            <NumField
              label="Amount"
              value={cond.amount}
              min={0}
              onChange={(amount) => onChange({ ...cond, amount })}
            />
            <span className="bt-muted">in</span>
            <NumField
              label="Bars"
              value={cond.bars}
              min={1}
              max={5000}
              step={1}
              onChange={(bars) => onChange({ ...cond, bars: Math.floor(bars) })}
            />
            <span className="bt-muted">bars</span>
          </>
        ) : null}
      </div>
    </li>
  );
}

function RuleEditor({
  title,
  rule,
  options,
  onChange,
}: {
  title: string;
  rule: Rule;
  options: OperandOption[];
  onChange: (r: Rule) => void;
}) {
  const set = (i: number, c: RuleCondition) =>
    onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <section className="bt-rule" aria-label={title}>
      <header className="bt-rule-head">
        <h3 className="rs-section-title">{title}</h3>
        {rule.conditions.length > 1 ? (
          <div className="wl-seg bt-match" role="group" aria-label={`${title}: combine`}>
            {(['all', 'any'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={rule.match === m}
                onClick={() => onChange({ ...rule, match: m })}
              >
                {m === 'all' ? 'All' : 'Any'}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {rule.conditions.length ? (
        <ul className="bt-conds">
          {rule.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              cond={c}
              options={options}
              onChange={(nc) => set(i, nc)}
              onRemove={() =>
                onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })
              }
            />
          ))}
        </ul>
      ) : (
        <p className="bt-muted bt-empty-rule">No conditions: never fires.</p>
      )}
      <button
        type="button"
        className="io-btn bt-add"
        disabled={rule.conditions.length >= 16}
        onClick={() =>
          onChange({ ...rule, conditions: [...rule.conditions, defaultCondition(options)] })
        }
      >
        <Plus size={14} /> Add condition
      </button>
    </section>
  );
}

// ------------------------------------------------------------ settings

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  /** Two controls: stack them under the label. */
  wide?: boolean;
}) {
  return (
    <label className={`bt-field${wide ? ' bt-field-wide' : ''}`}>
      <span className="bt-field-label">{label}</span>
      <span className="bt-field-control">{children}</span>
    </label>
  );
}

function SettingsEditor({
  settings,
  onChange,
}: {
  settings: StrategySettings;
  onChange: (s: StrategySettings) => void;
}) {
  const set = (patch: Partial<StrategySettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="bt-settings">
      <Field label="Initial capital">
        <NumField
          label="Initial capital"
          value={settings.initialCapital}
          min={1}
          onChange={(initialCapital) => set({ initialCapital })}
        />
      </Field>
      <Field label="Order size" wide>
        <NumField
          label="Order size"
          value={settings.sizing.value}
          min={0}
          onChange={(value) => set({ sizing: { ...settings.sizing, value } })}
        />
        <select
          className="io-input bt-select"
          aria-label="Order size unit"
          value={settings.sizing.mode}
          onChange={(e) =>
            set({
              sizing: {
                ...settings.sizing,
                mode: e.target.value as StrategySettings['sizing']['mode'],
              },
            })
          }
        >
          <option value="percentEquity">% of equity</option>
          <option value="fixedQty">units</option>
          <option value="fixedCash">cash</option>
        </select>
      </Field>
      <Field label="Fractional units">
        <input
          type="checkbox"
          checked={settings.fractional}
          onChange={(e) => set({ fractional: e.target.checked })}
        />
      </Field>
      <Field label="Commission" wide>
        <NumField
          label="Commission"
          value={settings.commission.value}
          min={0}
          onChange={(value) => set({ commission: { ...settings.commission, value } })}
        />
        <select
          className="io-input bt-select"
          aria-label="Commission unit"
          value={settings.commission.mode}
          onChange={(e) =>
            set({
              commission: {
                ...settings.commission,
                mode: e.target.value as StrategySettings['commission']['mode'],
              },
            })
          }
        >
          <option value="percent">% of value</option>
          <option value="perOrder">per order</option>
          <option value="perShare">per unit</option>
        </select>
      </Field>
      <Field label="Slippage %">
        <NumField
          label="Slippage %"
          value={settings.slippagePct}
          min={0}
          max={50}
          onChange={(slippagePct) => set({ slippagePct })}
        />
      </Field>
      <Field label="Fill at">
        <select
          className="io-input bt-select"
          aria-label="Fill at"
          value={settings.fillAt}
          onChange={(e) => set({ fillAt: e.target.value as StrategySettings['fillAt'] })}
        >
          <option value="nextOpen">Next bar open</option>
          <option value="close">Signal bar close</option>
        </select>
      </Field>
      <Field label="Stop loss %">
        <NumField
          label="Stop loss %"
          value={settings.stopLossPct}
          min={0}
          max={99}
          onChange={(stopLossPct) => set({ stopLossPct })}
        />
      </Field>
      <Field label="Take profit %">
        <NumField
          label="Take profit %"
          value={settings.takeProfitPct}
          min={0}
          onChange={(takeProfitPct) => set({ takeProfitPct })}
        />
      </Field>
      <p className="bt-muted bt-note">
        0 turns stop loss / take profit off. Signals are decided on a bar's close; a stop and a
        target hit in the same bar count as the stop.
      </p>
    </div>
  );
}

// -------------------------------------------------------------- report

const pct = (v: number) => (Number.isFinite(v) ? `${fmtSigned(v, 2)}%` : '—');
const num = (v: number, d = 2) =>
  Number.isFinite(v) ? fmtPrice(v, d) : v === Infinity ? '∞' : '—';
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bt-stat">
      <span className="bt-stat-label">{label}</span>
      <span className={`bt-stat-value rs-num ${tone}`}>{value}</span>
    </div>
  );
}

/** Equity line over the initial-capital baseline, drawdown underneath. */
function EquityChart({ run }: { run: BacktestRun }) {
  const { equity, drawdown } = run.result;
  const base = run.result.stats.initialCapital;
  const W = 300;
  const H = 90;
  const DD = 28;
  const n = equity.length;
  const step = Math.max(1, Math.floor(n / W));
  const pts: [number, number][] = [];
  const dd: [number, number][] = [];
  let lo = base;
  let hi = base;
  let ddMin = 0;
  for (let i = 0; i < n; i += step) {
    const e = equity[i]!;
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
    ddMin = Math.min(ddMin, drawdown[i]!);
  }
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H - ((v - lo) / span) * H;
  for (let i = 0; i < n; i += step) {
    pts.push([x(i), y(equity[i]!)]);
    dd.push([x(i), H + 4 + (ddMin < 0 ? (drawdown[i]! / ddMin) * DD : 0)]);
  }
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const area = `0,${H + 4} ${dd.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')} ${W},${H + 4}`;
  const up = equity[n - 1]! >= base;
  return (
    <svg
      className="bt-equity"
      viewBox={`0 0 ${W} ${H + DD + 6}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Equity curve and drawdown"
    >
      <line x1="0" x2={W} y1={y(base)} y2={y(base)} className="bt-equity-base" />
      <polygon points={area} className="bt-equity-dd" />
      <polyline points={line} className={`bt-equity-line ${up ? 'up' : 'down'}`} />
    </svg>
  );
}

function TradeRows({ trades, run }: { trades: Trade[]; run: BacktestRun }) {
  const intraday = !/[DWM]$/.test(run.interval);
  const f = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        timeZone: run.timezone,
        year: '2-digit',
        month: 'short',
        day: 'numeric',
        ...(intraday ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
      }),
    [run.timezone, intraday],
  );
  const date = (t: number) => f.format(new Date(t * 1000));
  const focus = (t: Trade) => {
    const chart = getChart();
    if (chart && chart.getSymbol() === run.symbol)
      chart.setVisibleLogicalRange(t.entryIndex - 20, t.exitIndex + 20);
  };
  const shown = trades.slice(-300).reverse();
  return (
    <ul className="bt-trades" aria-label="Trades">
      {shown.map((t) => (
        <li key={t.n}>
          <button type="button" className="bt-trade" onClick={() => focus(t)} title="Show on chart">
            <span className="bt-trade-main">
              <span className="bt-trade-head">
                <span className="bt-muted">#{t.n}</span>{' '}
                <span className={t.side === 'long' ? 'up' : 'down'}>
                  {t.side === 'long' ? 'Long' : 'Short'}
                </span>{' '}
                <span className="bt-muted">· {t.exitReason}</span>
              </span>
              <span className="bt-muted rs-num">
                {date(t.entryTime)} → {t.exitReason === 'open' ? 'now' : date(t.exitTime)}
              </span>
              <span className="bt-muted rs-num">
                {fmtPrice(t.entryPrice, run.decimals)} → {fmtPrice(t.exitPrice, run.decimals)}
              </span>
            </span>
            <span className={`bt-trade-pnl rs-num ${cls(t.pnl)}`}>
              <span>{fmtSigned(t.pnl, 2)}</span>
              <span className="bt-muted">{pct(t.pnlPct)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Report({ run, stale }: { run: BacktestRun; stale: boolean }) {
  const s = run.result.stats;
  const trades = run.result.openTrade
    ? [...run.result.trades, run.result.openTrade]
    : run.result.trades;
  return (
    <div className="bt-report">
      <p className="bt-muted bt-ran">
        {run.symbol} · {run.interval} · {run.result.equity.length} bars
        {stale ? ' · chart changed, run again' : ''}
      </p>
      {run.missing.length ? (
        <p className="rs-error bt-missing" role="status">
          Not on this chart (never true): {run.missing.map((m) => m.title).join(', ')}
        </p>
      ) : null}
      <div className="bt-headline">
        <Stat
          label="Net profit"
          value={`${fmtSigned(s.netProfit, 2)} (${pct(s.netProfitPct)})`}
          tone={cls(s.netProfit)}
        />
        <Stat label="Buy & hold" value={pct(s.buyHoldPct)} tone={cls(s.buyHoldPct)} />
        <Stat label="Max drawdown" value={`${num(s.maxDrawdown)} (${num(s.maxDrawdownPct)}%)`} />
        <Stat label="Profit factor" value={num(s.profitFactor)} />
      </div>
      {run.result.equity.length > 1 ? <EquityChart run={run} /> : null}
      <div className="bt-stats">
        <Stat label="Trades" value={`${s.totalTrades} (${s.longTrades} L / ${s.shortTrades} S)`} />
        <Stat label="Win rate" value={Number.isFinite(s.winRate) ? `${num(s.winRate, 1)}%` : '—'} />
        <Stat label="Avg trade" value={fmtSigned(s.avgTrade, 2)} tone={cls(s.avgTrade)} />
        <Stat label="Avg win / loss" value={`${num(s.avgWin)} / ${num(s.avgLoss)}`} />
        <Stat label="Payoff ratio" value={num(s.payoffRatio)} />
        <Stat label="Largest win / loss" value={`${num(s.largestWin)} / ${num(s.largestLoss)}`} />
        <Stat label="Open P&L" value={fmtSigned(s.openPnl, 2)} tone={cls(s.openPnl)} />
        <Stat label="CAGR" value={pct(s.cagrPct)} tone={cls(s.cagrPct)} />
        <Stat label="Sharpe / Sortino" value={`${num(s.sharpe)} / ${num(s.sortino)}`} />
        <Stat label="Exposure" value={`${num(s.exposurePct, 1)}%`} />
        <Stat label="Avg bars in trade" value={num(s.avgBarsInTrade, 1)} />
        <Stat
          label="Max wins / losses in a row"
          value={`${s.maxConsecutiveWins} / ${s.maxConsecutiveLosses}`}
        />
        <Stat label="Commission" value={num(s.commissionPaid)} />
        <Stat label="Final equity" value={num(s.finalEquity)} />
      </div>
      {trades.length ? (
        <TradeRows trades={trades} run={run} />
      ) : (
        <p className="bt-muted bt-pad">No trades.</p>
      )}
    </div>
  );
}

// --------------------------------------------------------------- panel

type Tab = 'rules' | 'settings' | 'report';

export function StrategyPanel() {
  const strategies = useStrategies((s) => s.strategies);
  const strategy = useStrategies(activeStrategy);
  const store = useStrategies.getState();
  const options = useOperandOptions();
  const run = useBacktestRun((s) => s.run);
  const error = useBacktestRun((s) => s.error);
  const symbol = useChartView((s) => s.symbol);
  const interval = useChartView((s) => s.interval);
  const [tab, setTab] = useState<Tab>('rules');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);

  const shownRun = run && strategy && run.strategyId === strategy.id ? run : null;
  const stale = !!shownRun && (shownRun.symbol !== symbol || shownRun.interval !== interval);

  // Markers belong to the shown run; switching strategy clears them.
  useEffect(() => {
    if (!shownRun) showRun(getChart(), null);
  }, [shownRun]);

  const doRun = () => {
    if (!strategy) return;
    const chart = getChart();
    if (!chart) return useBacktestRun.getState().set({ error: 'No chart.', run: null });
    try {
      const hint = useChartStore.getState().symbolInfo?.priceHint;
      const next = runOnChart(strategy, {
        chart,
        instances: useIndicatorStore.getState().instances,
        decimals: typeof hint === 'number' && Number.isInteger(hint) && hint >= 0 ? hint : 2,
      });
      useBacktestRun.getState().set({ run: next, error: null });
      showRun(chart, next);
      setTab('report');
    } catch (e) {
      useBacktestRun.getState().set({
        run: null,
        error: e instanceof BacktestError ? e.message : `Backtest failed: ${String(e)}`,
      });
      showRun(chart, null);
    }
  };

  const rename = async (s: Strategy) => {
    const name = await promptName({ title: 'Rename strategy', initial: s.name, okLabel: 'Rename' });
    if (name) store.update(s.id, { name: name.slice(0, 200) });
  };

  if (!strategy)
    return (
      <div className="rs-empty">
        <p className="rs-empty-title">Strategy tester</p>
        <p className="rs-empty-text">
          Build entry and exit rules from prices and the indicators on your chart, then test them on
          the chart's history.
        </p>
        <button
          type="button"
          className="io-btn io-btn-primary rs-empty-btn"
          onClick={() => store.create()}
        >
          <Plus size={14} /> New strategy
        </button>
      </div>
    );

  const missingNow = new Set(
    RULES.flatMap(({ key }) =>
      strategy[key].conditions.flatMap((c) => {
        const ops = [c.left, ...(c.kind === 'compare' ? [c.right] : [])];
        return ops.filter((o): o is IndicatorOperand => o.kind === 'indicator');
      }),
    )
      .filter((o) => !findInstance(o, useIndicatorStore.getState().instances))
      .map((o) => o.title),
  );

  return (
    <div className="bt-panel">
      <div className="bt-bar">
        <select
          className="io-input bt-select bt-pick"
          aria-label="Strategy"
          value={strategy.id}
          onChange={(e) => store.setActive(e.target.value)}
        >
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="New strategy"
          data-tip="New strategy"
          onClick={() => store.create()}
        >
          <Plus size={16} />
        </button>
        <button
          ref={setMenuAnchor}
          type="button"
          className="io-icon-btn"
          aria-label="Strategy actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tip="More"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <MoreHorizontal size={16} />
        </button>
        <DropdownMenu
          anchor={menuAnchor}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          placement="bottom-end"
          items={[
            { label: 'Rename…', icon: Pencil, onSelect: () => void rename(strategy) },
            { label: 'Duplicate', icon: Copy, onSelect: () => store.duplicate(strategy.id) },
            { type: 'separator' },
            {
              label: 'Delete…',
              icon: Trash2,
              danger: true,
              onSelect: () =>
                void confirmDialog({
                  title: 'Delete strategy',
                  message: `Delete "${strategy.name}"?`,
                  okLabel: 'Delete',
                  danger: true,
                }).then((ok) => ok && store.remove(strategy.id)),
            },
          ]}
        />
      </div>
      <div className="bt-bar">
        <div className="wl-seg bt-tabs" role="tablist" aria-label="Strategy view">
          {(['rules', 'settings', 'report'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {t === 'rules' ? 'Rules' : t === 'settings' ? 'Settings' : 'Report'}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="io-btn io-btn-primary bt-run"
          onClick={doRun}
          data-testid="bt-run"
        >
          <Play size={14} /> Run
        </button>
      </div>
      {error ? (
        <p className="rs-error bt-missing" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bt-body">
        {tab === 'rules' ? (
          <>
            {missingNow.size ? (
              <p className="rs-error bt-missing" role="status">
                Add these indicators to the chart: {[...missingNow].join(', ')}
              </p>
            ) : null}
            {RULES.map(({ key, title }) => (
              <RuleEditor
                key={key}
                title={title}
                rule={strategy[key]}
                options={options}
                onChange={(rule) => store.update(strategy.id, { [key]: rule })}
              />
            ))}
          </>
        ) : null}
        {tab === 'settings' ? (
          <SettingsEditor
            settings={strategy.settings}
            onChange={(settings) => store.update(strategy.id, { settings })}
          />
        ) : null}
        {tab === 'report' ? (
          shownRun ? (
            <Report run={shownRun} stale={stale} />
          ) : (
            <p className="bt-muted bt-pad">Press Run to test this strategy on the chart.</p>
          )
        ) : null}
      </div>
    </div>
  );
}
