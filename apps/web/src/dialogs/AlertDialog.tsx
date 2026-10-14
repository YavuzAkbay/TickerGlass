import {
  CHANNEL_OPS,
  CROSS_OPS,
  MOVING_OPS,
  OP_LABELS,
  isChannelOp,
  isCrossOp,
  isMovingOp,
  renderMessage,
  type Alert,
  type AlertNotify,
  type ConditionOp,
  type DrawingInfo,
  type DrawingLineOperand,
  type SeriesOperand,
  type TriggerMode,
  type ValidationError,
} from '@investopen/alerts';
import { Minus, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import * as alertsApi from '../api/alerts';
import { errorMessage } from '../api/client';
import { currentAlertContext } from '../alerts/dialog/context';
import { initialForm } from '../alerts/dialog/defaults';
import {
  emptyValue,
  formToAlert,
  numberText,
  type ChannelForm,
  type FormState,
  type TargetForm,
} from '../alerts/dialog/form';
import { isEditArgs, type AlertDialogArgs } from '../alerts/dialog/open';
import {
  channelDrawings,
  drawingName,
  drawingsAllowed,
  indicatorsAllowed,
  isBrickType,
  leftOptions,
  operandKey,
  previewSample,
  targetOptions,
  usesHeikinAshi,
  type AlertContext,
  type SourceOption,
} from '../alerts/dialog/sources';
import { browserPermission, requestBrowserPermission } from '../alerts/notify';
import { readAlertPrefs } from '../alerts/prefs';
import { playSound } from '../alerts/sound';
import { useAlerts } from '../alerts/store';
import { createAlert, updateAlert } from '../alerts/sync';
import { getPersistence } from '../persist/bootstrap';
import { normalizeSymbol } from '../store/app';
import { INTERVAL_GROUPS, intervalLabel } from '../topbar/intervals';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';
import { Check, Row, Section, Segmented } from './controls';
import '../alerts/dialog/alertDialog.css';
import './dialogs.css';

type TabId = 'settings' | 'notifications' | 'message';

const TRIGGERS: [TriggerMode, string, string][] = [
  ['once', 'Only once', 'Fires one time, then the alert stops.'],
  ['oncePerBar', 'Once per bar', 'Fires at most once for each bar while it is forming.'],
  ['oncePerBarClose', 'Once per bar close', 'Fires when a bar closes and the condition holds.'],
  ['everyTime', 'Every time', 'Fires on every update where the condition is met.'],
];

const PRESETS: [string, number][] = [
  ['+1 day', 1],
  ['+1 week', 7],
  ['+1 month', 30],
];

const PLACEHOLDERS = [
  'ticker',
  'exchange',
  'currency',
  'interval',
  'open',
  'high',
  'low',
  'close',
  'price',
  'volume',
  'value',
  'target',
  'upper',
  'lower',
  'change',
  'time',
  'timenow',
  'name',
  'condition',
];

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO instant -> `datetime-local` value (local time, minutes). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value -> ISO instant (null for empty or invalid). */
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function groupedOptions<T>(options: SourceOption<T>[]): ReactNode {
  const groups = [...new Set(options.map((o) => o.group))];
  return groups.map((g) => (
    <optgroup key={g} label={g}>
      {options
        .filter((o) => o.group === g)
        .map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
    </optgroup>
  ));
}

/** A number with minus/plus nudges. */
function NumberField({
  value,
  onChange,
  step,
  label,
  suffix,
  nudges = true,
}: {
  value: string;
  onChange: (v: string) => void;
  step: number;
  label: string;
  suffix?: string | undefined;
  nudges?: boolean;
}) {
  const nudge = (dir: 1 | -1) => {
    const n = Number(value);
    onChange(numberText((Number.isFinite(n) ? n : 0) + dir * step));
  };
  return (
    <span className="dlg-number alert-number">
      {nudges ? (
        <button
          type="button"
          className="io-icon-btn"
          aria-label={`Decrease ${label}`}
          onClick={() => nudge(-1)}
        >
          <Minus size={14} />
        </button>
      ) : null}
      <input
        className="io-input"
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {nudges ? (
        <button
          type="button"
          className="io-icon-btn"
          aria-label={`Increase ${label}`}
          onClick={() => nudge(1)}
        >
          <Plus size={14} />
        </button>
      ) : null}
      {suffix ? <span className="dlg-number-suffix">{suffix}</span> : null}
    </span>
  );
}

/** One operand of a condition: a typed value or a source. */
function TargetEditor({
  value,
  onChange,
  sources,
  step,
  label,
}: {
  value: TargetForm;
  onChange: (t: TargetForm) => void;
  sources: SourceOption<SeriesOperand | DrawingLineOperand>[];
  step: number;
  label: string;
}) {
  const key = value.kind === 'source' ? operandKey(value.operand) : '';
  return (
    <span className="alert-target">
      <Segmented
        value={value.kind}
        options={[
          ['value', 'Value'],
          ['source', 'Source'],
        ]}
        onChange={(kind) => {
          if (kind === value.kind) return;
          const first = sources[0];
          onChange(
            kind === 'value'
              ? emptyValue()
              : first
                ? { kind: 'source', operand: first.operand }
                : value,
          );
        }}
      />
      {value.kind === 'value' ? (
        <NumberField
          value={value.text}
          onChange={(text) => onChange({ kind: 'value', text })}
          step={step}
          label={label}
        />
      ) : (
        <select
          className="io-input dlg-select"
          aria-label={label}
          value={key}
          onChange={(e) => {
            const o = sources.find((s) => s.key === e.target.value);
            if (o) onChange({ kind: 'source', operand: o.operand });
          }}
        >
          {groupedOptions(sources)}
        </select>
      )}
    </span>
  );
}

function usesIndicator(f: FormState): boolean {
  const t = (x: TargetForm) => x.kind === 'source' && x.operand.kind === 'indicator';
  return (
    f.left.kind === 'indicator' ||
    (isCrossOp(f.op) && t(f.right)) ||
    (isChannelOp(f.op) && f.channel.kind === 'bounds' && (t(f.channel.upper) || t(f.channel.lower)))
  );
}

function usesDrawing(f: FormState): boolean {
  const t = (x: TargetForm) => x.kind === 'source' && x.operand.kind === 'drawing';
  return (
    (isCrossOp(f.op) && t(f.right)) ||
    (isChannelOp(f.op) &&
      (f.channel.kind === 'drawing' ||
        (f.channel.kind === 'bounds' && (t(f.channel.upper) || t(f.channel.lower)))))
  );
}

const keepTarget = (t: TargetForm, valid: Set<string>): TargetForm =>
  t.kind === 'source' && !valid.has(operandKey(t.operand)) ? emptyValue() : t;

/** Create or edit an alert (docs/alerts.md §5.2). */
export default function AlertDialog({ onClose, arg }: { onClose: () => void; arg?: unknown }) {
  const args = (arg ?? {}) as AlertDialogArgs;
  const ctx = useMemo(() => currentAlertContext(), []);
  // Snapshot of the alert as it was when the dialog opened: its revision is what a save is
  // based on, so a server bump while the dialog is open still ends in the 409 path (§1.7).
  const [edit] = useState<Alert | undefined>(() =>
    isEditArgs(args) ? useAlerts.getState().alerts[args.editId] : undefined,
  );
  const [form, setForm] = useState<FormState | null>(() =>
    initialForm(args, ctx, (id) => useAlerts.getState().alerts[id]),
  );
  const [tab, setTab] = useState<TabId>('settings');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const channels = useAlerts((s) => s.channels);
  const newId = useRef(crypto.randomUUID());
  /** The symbol is fixed when an entry point supplied it, and for edits and clones. */
  const symbolFixed = useMemo(() => {
    const a = args as Record<string, unknown>;
    return 'cloneOf' in a || 'editId' in a || !!(a['symbol'] || a['drawingId'] || a['indicatorId']);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!form) {
    return (
      <Modal title="Alert" onClose={onClose} width={420}>
        <div className="dlg-empty">This alert no longer exists.</div>
      </Modal>
    );
  }

  const set = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const drawingInfo = (id: string): DrawingInfo | null => {
    const d = ctx.drawings.find((x) => x.id === id);
    return d
      ? {
          type: d.type,
          points: new Array<unknown>(d.pointCount).fill(null),
          scope: d.scope,
          symbol: d.symbol,
        }
      : null;
  };
  const names = { drawing: (id: string) => drawingName(ctx, id), precision: ctx.decimals };
  const result = formToAlert(form, { drawing: drawingInfo, names });
  const errors: ValidationError[] = result.ok ? [] : result.errors;
  const symbol = form.symbol.trim();

  const setLeft = (left: SeriesOperand) =>
    setForm((f) => {
      if (!f) return f;
      const valid = new Set([
        ...targetOptions(ctx, f.symbol.trim(), left).map((o) => o.key),
        'value',
      ]);
      const chanOk = channelDrawings(ctx, f.symbol.trim(), left).map((c) => c.drawing.id);
      const channel: ChannelForm =
        f.channel.kind === 'drawing'
          ? chanOk.includes(f.channel.drawingId)
            ? f.channel
            : { kind: 'bounds', upper: emptyValue(), lower: emptyValue() }
          : {
              kind: 'bounds',
              upper: keepTarget(f.channel.upper, valid),
              lower: keepTarget(f.channel.lower, valid),
            };
      return { ...f, left, right: keepTarget(f.right, valid), channel };
    });

  const setSymbol = (text: string) =>
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, symbol: text };
      // Indicators and drawings belong to the chart's symbol.
      if (!indicatorsAllowed(ctx, normalizeSymbol(text)) && f.left.kind !== 'price')
        next.left = { kind: 'price', field: 'close' };
      return next;
    });

  const save = async () => {
    setAttempted(true);
    if (busy) return;
    setBusy(true);
    try {
      if (usesDrawing(form) || ctx.drawings.length) await getPersistence()?.drawings.flush();
      const res = formToAlert(form, { drawing: drawingInfo, names });
      if (!res.ok) {
        setTab('settings');
        return;
      }
      const body = { ...res.alert, id: form.id ?? edit?.id ?? newId.current };
      if (edit && !useAlerts.getState().alerts[edit.id]) {
        toast(
          'This alert was deleted while you were editing it. Nothing was saved.',
          'error',
          6000,
        );
        return;
      }
      if (edit) {
        const { id: _id, ...patch } = body;
        const saved = await updateAlert(edit.id, patch, edit.revision);
        if (saved) toast('Alert saved', 'success');
      } else {
        await createAlert(body);
        toast('Alert created', 'success');
      }
      onClose();
    } catch (err) {
      toast(`Alert not saved: ${errorMessage(err)}`, 'error', 6000);
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <>
      <div className="dlg-footer-spacer" />
      <button type="button" className="io-btn" onClick={onClose}>
        Cancel
      </button>
      <button
        type="button"
        className="io-btn io-btn-primary"
        disabled={busy}
        onClick={() => void save()}
      >
        {edit ? 'Save' : 'Create'}
      </button>
    </>
  );

  const shown = attempted ? errors : [];
  const title = edit ? 'Edit alert' : 'Create alert';

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={560}
      footer={footer}
      className="dlg-settings alert-dlg"
    >
      <div className="dlg-tabs" role="tablist" aria-label="Alert sections">
        {(
          [
            ['settings', 'Settings'],
            ['notifications', 'Notifications'],
            ['message', 'Message'],
          ] as const
        ).map(([t, label]) => (
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
      <div className="alert-dlg-body" role="tabpanel">
        {tab === 'settings' ? (
          <SettingsTab
            form={form}
            set={set}
            setLeft={setLeft}
            setSymbol={setSymbol}
            ctx={ctx}
            symbolFixed={symbolFixed}
            symbol={normalizeSymbol(symbol)}
          />
        ) : tab === 'notifications' ? (
          <NotificationsTab form={form} set={set} channels={channels} />
        ) : (
          <MessageTab form={form} set={set} ctx={ctx} result={result} />
        )}
        {shown.length ? (
          <ul className="alert-errors dlg-error" role="alert">
            {shown.map((e, i) => (
              <li key={i}>
                {e.path ? <code>{e.path.replace(/^spec\./, '')}</code> : null} {e.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings

function SettingsTab({
  form,
  set,
  setLeft,
  setSymbol,
  ctx,
  symbolFixed,
  symbol,
}: {
  form: FormState;
  set: (p: Partial<FormState>) => void;
  setLeft: (l: SeriesOperand) => void;
  setSymbol: (s: string) => void;
  ctx: AlertContext;
  symbolFixed: boolean;
  symbol: string;
}) {
  const left = leftOptions(ctx, symbol, form.left);
  const targets = targetOptions(
    ctx,
    symbol,
    form.left,
    form.right.kind === 'source' ? form.right.operand : undefined,
  );
  const channels = channelDrawings(ctx, symbol, form.left);
  const step = 10 ** -ctx.decimals;
  const intervals = INTERVAL_GROUPS.flatMap((g) => g.intervals);
  if (!intervals.includes(form.interval)) intervals.unshift(form.interval);
  const op = form.op;
  const percent = op === 'movingUpPercent' || op === 'movingDownPercent';
  const chan = form.channel;
  const hasDrawingChannel = channels.length > 0 || chan.kind === 'drawing';
  const drawingsOff = !drawingsAllowed(ctx);
  const sourcesOnly = !indicatorsAllowed(ctx, symbol);

  return (
    <>
      <Section title="Symbol">
        <Row label="Symbol" htmlFor="alert-symbol">
          <input
            id="alert-symbol"
            className="io-input"
            value={form.symbol}
            readOnly={symbolFixed}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSymbol(e.target.value)}
            onBlur={() => set({ symbol: normalizeSymbol(form.symbol) })}
          />
        </Row>
        <Row label="Interval" htmlFor="alert-interval">
          <select
            id="alert-interval"
            className="io-input dlg-select"
            value={form.interval}
            onChange={(e) => set({ interval: e.target.value })}
          >
            {intervals.map((iv) => (
              <option key={iv} value={iv}>
                {intervalLabel(iv)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Extended hours">
          <Check
            checked={form.prepost}
            label="Include pre- and post-market"
            onChange={(prepost) => set({ prepost })}
          />
        </Row>
        {usesHeikinAshi(ctx) ? (
          <p className="dlg-note">Heikin Ashi chart: alert values use regular candles.</p>
        ) : null}
      </Section>

      <Section title="Condition">
        <Row label="Value" htmlFor="alert-left">
          <select
            id="alert-left"
            className="io-input dlg-select"
            value={operandKey(form.left)}
            onChange={(e) => {
              const o = left.find((x) => x.key === e.target.value);
              if (o) setLeft(o.operand);
            }}
          >
            {groupedOptions(left)}
          </select>
        </Row>
        <Row label="Condition" htmlFor="alert-op">
          <select
            id="alert-op"
            className="io-input dlg-select"
            value={op}
            onChange={(e) => set({ op: e.target.value as ConditionOp })}
          >
            <optgroup label="Compare">
              {CROSS_OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Channel">
              {CHANNEL_OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Move">
              {MOVING_OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_LABELS[o]}
                </option>
              ))}
            </optgroup>
          </select>
        </Row>
        {isCrossOp(op) ? (
          <Row label="Target">
            <TargetEditor
              value={form.right}
              onChange={(right) => set({ right })}
              sources={targets}
              step={step}
              label="Target"
            />
          </Row>
        ) : null}
        {isChannelOp(op) ? (
          <>
            <Row label="Channel">
              <Segmented
                value={chan.kind}
                options={[
                  ['bounds', 'Bounds'],
                  ['drawing', 'Drawing'],
                ]}
                onChange={(kind) => {
                  if (kind === chan.kind) return;
                  const first = channels[0];
                  set({
                    channel:
                      kind === 'bounds'
                        ? { kind: 'bounds', upper: emptyValue(), lower: emptyValue() }
                        : first
                          ? { kind: 'drawing', drawingId: first.drawing.id, scale: first.scale }
                          : chan,
                  });
                }}
              />
              {!hasDrawingChannel ? (
                <span className="dlg-number-suffix">
                  {drawingsOff
                    ? 'Drawings are not available on this chart type'
                    : 'No channel drawing on this pane'}
                </span>
              ) : null}
            </Row>
            {chan.kind === 'bounds' ? (
              <>
                <Row label="Upper">
                  <TargetEditor
                    value={chan.upper}
                    onChange={(upper) => set({ channel: { ...chan, upper } })}
                    sources={targets}
                    step={step}
                    label="Upper"
                  />
                </Row>
                <Row label="Lower">
                  <TargetEditor
                    value={chan.lower}
                    onChange={(lower) => set({ channel: { ...chan, lower } })}
                    sources={targets}
                    step={step}
                    label="Lower"
                  />
                </Row>
              </>
            ) : (
              <Row label="Drawing" htmlFor="alert-channel">
                <select
                  id="alert-channel"
                  className="io-input dlg-select"
                  value={chan.drawingId}
                  onChange={(e) => {
                    const c = channels.find((x) => x.drawing.id === e.target.value);
                    if (c)
                      set({
                        channel: { kind: 'drawing', drawingId: c.drawing.id, scale: c.scale },
                      });
                  }}
                >
                  {!channels.some((c) => c.drawing.id === chan.drawingId) ? (
                    <option value={chan.drawingId}>{drawingName(ctx, chan.drawingId)}</option>
                  ) : null}
                  {channels.map((c) => (
                    <option key={c.drawing.id} value={c.drawing.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Row>
            )}
          </>
        ) : null}
        {isMovingOp(op) ? (
          <>
            <Row label="Amount">
              <NumberField
                value={form.amount}
                onChange={(amount) => set({ amount })}
                step={percent ? 0.5 : step}
                label="Amount"
                suffix={percent ? '%' : undefined}
              />
            </Row>
            <Row label="In bars">
              <NumberField
                value={form.bars}
                onChange={(bars) => set({ bars })}
                step={1}
                label="Bars"
              />
            </Row>
          </>
        ) : null}
        {sourcesOnly ? (
          <p className="dlg-note">
            Only price sources are available for a symbol other than the chart&apos;s.
          </p>
        ) : null}
        {usesIndicator(form) ? (
          <p className="dlg-note">
            Uses the current settings of the indicator; later changes on the chart do not affect
            this alert.
          </p>
        ) : null}
        {usesDrawing(form) ? (
          <p className="dlg-note">
            The alert follows the drawing when you move it. The price-scale mode (linear or log) is
            fixed when the alert is created.
          </p>
        ) : null}
        {drawingsOff && isBrickType(ctx.chartType) ? (
          <p className="dlg-note">Drawing sources are not available on this chart type.</p>
        ) : null}
      </Section>

      <Section title="Trigger">
        <div className="alert-triggers" role="radiogroup" aria-label="Trigger">
          {TRIGGERS.map(([mode, label, hint]) => (
            <label key={mode} className="alert-trigger">
              <input
                type="radio"
                name="alert-trigger"
                checked={form.trigger === mode}
                onChange={() => set({ trigger: mode })}
              />
              <span>
                <b>{label}</b>
                <span className="dlg-number-suffix"> {hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Expiration">
        <Row label="Expires">
          <Segmented
            value={form.expiresAt ? 'date' : 'none'}
            options={[
              ['none', 'Never'],
              ['date', 'On date'],
            ]}
            onChange={(v) =>
              set({ expiresAt: v === 'none' ? null : (form.expiresAt ?? plusDays(1)) })
            }
          />
        </Row>
        {form.expiresAt ? (
          <Row label="Date and time" htmlFor="alert-expires">
            <input
              id="alert-expires"
              type="datetime-local"
              className="io-input"
              value={toLocalInput(form.expiresAt)}
              onChange={(e) => set({ expiresAt: fromLocalInput(e.target.value) })}
            />
            {PRESETS.map(([label, days]) => (
              <button
                key={label}
                type="button"
                className="io-btn"
                onClick={() => set({ expiresAt: plusDays(days) })}
              >
                {label}
              </button>
            ))}
          </Row>
        ) : null}
      </Section>
    </>
  );
}

function plusDays(days: number): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ------------------------------------------------------------ notifications

function NotificationsTab({
  form,
  set,
  channels,
}: {
  form: FormState;
  set: (p: Partial<FormState>) => void;
  channels: alertsApi.AlertChannels | null;
}) {
  const n = form.notify;
  const [testing, setTesting] = useState<string | null>(null);
  const setN = (patch: Partial<AlertNotify>) => set({ notify: { ...n, ...patch } });

  const toggleBrowser = async (on: boolean) => {
    if (!on) return setN({ browser: false });
    const perm = browserPermission() === 'granted' ? 'granted' : await requestBrowserPermission();
    if (perm !== 'granted') {
      toast('Browser notifications are not allowed for this site', 'error');
      return;
    }
    setN({ browser: true });
  };

  const test = async (channel: 'webhook' | 'telegram' | 'email') => {
    setTesting(channel);
    try {
      await alertsApi.testAlertChannel(
        channel,
        channel === 'webhook' ? n.webhookUrl?.trim() || undefined : undefined,
      );
      toast(`Test sent to ${channel}`, 'success');
    } catch (err) {
      toast(`Test failed: ${errorMessage(err)}`, 'error');
    } finally {
      setTesting(null);
    }
  };

  const testLink = (channel: 'webhook' | 'telegram' | 'email') => (
    <button
      type="button"
      className="io-btn"
      disabled={testing !== null}
      onClick={() => void test(channel)}
    >
      Send test
    </button>
  );
  const hint = (ok: boolean | undefined, text: string) =>
    ok === false ? <span className="dlg-number-suffix">{text}</span> : null;

  return (
    <>
      <Section title="In the app">
        <Check
          checked={n.toast}
          label="Show a toast"
          onChange={(toastOn) => setN({ toast: toastOn })}
        />
        <div className="dlg-row">
          <Check checked={n.sound} label="Play a sound" onChange={(sound) => setN({ sound })} />
          <button
            type="button"
            className="io-btn"
            onClick={() => {
              const p = readAlertPrefs();
              playSound(p.sound, p.volume);
            }}
          >
            Preview
          </button>
        </div>
        <Check
          checked={n.browser}
          label="Browser notification when the tab is hidden"
          onChange={(on) => void toggleBrowser(on)}
        />
      </Section>
      <Section title="Delivery">
        <div className="dlg-row">
          <Check checked={n.webhook} label="Webhook" onChange={(webhook) => setN({ webhook })} />
          {testLink('webhook')}
        </div>
        {n.webhook ? (
          <>
            <Row label="URL" htmlFor="alert-webhook-url">
              <input
                id="alert-webhook-url"
                className="io-input"
                value={n.webhookUrl ?? ''}
                placeholder={channels?.webhook.url ?? 'https://…'}
                spellCheck={false}
                onChange={(e) => setN({ webhookUrl: e.target.value })}
              />
            </Row>
            <Check
              checked={n.webhookRaw}
              label="Send the message text as the body"
              onChange={(webhookRaw) => setN({ webhookRaw })}
            />
            {hint(
              channels ? channels.webhook.configured || !!n.webhookUrl?.trim() : undefined,
              'No default URL (set ALERTS_WEBHOOK_URL), enter one above.',
            )}
          </>
        ) : null}
        <div className="dlg-row">
          <Check
            checked={n.telegram}
            label="Telegram"
            onChange={(telegram) => setN({ telegram })}
          />
          {testLink('telegram')}
          {hint(channels?.telegram.configured, 'Not configured (set TELEGRAM_BOT_TOKEN…)')}
        </div>
        <div className="dlg-row">
          <Check checked={n.email} label="Email" onChange={(email) => setN({ email })} />
          {testLink('email')}
          {hint(channels?.email.configured, 'Not configured (set the ALERTS_SMTP_… variables)')}
        </div>
      </Section>
    </>
  );
}

// ----------------------------------------------------------------- message

function MessageTab({
  form,
  set,
  ctx,
  result,
}: {
  form: FormState;
  set: (p: Partial<FormState>) => void;
  ctx: AlertContext;
  result: ReturnType<typeof formToAlert>;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [openedAt] = useState(() => Date.now());
  const insert = (name: string) => {
    const el = area.current;
    const text = `{{${name}}}`;
    const start = el?.selectionStart ?? form.message.length;
    const end = el?.selectionEnd ?? start;
    set({ message: form.message.slice(0, start) + text + form.message.slice(end) });
  };
  let preview = '';
  if (result.ok) {
    const s = previewSample(result.alert, ctx);
    preview = renderMessage(form.message, {
      alert: result.alert,
      symbol: { priceHint: ctx.decimals },
      barTime: s.barTime,
      values: s.values,
      firedAt: openedAt,
      names: { drawing: (id) => drawingName(ctx, id), precision: ctx.decimals },
    });
  }
  return (
    <>
      <Section title="Name">
        <Row label="Alert name" htmlFor="alert-name">
          <input
            id="alert-name"
            className="io-input"
            value={form.name}
            placeholder={result.ok ? result.alert.name : 'Generated from the condition'}
            maxLength={200}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Row>
      </Section>
      <Section title="Message">
        <textarea
          ref={area}
          className="io-input alert-message"
          aria-label="Message template"
          rows={4}
          value={form.message}
          placeholder="{{ticker}} {{condition}}"
          maxLength={2000}
          onChange={(e) => set({ message: e.target.value })}
        />
        <div className="dlg-row">
          <span className="dlg-row-label">Placeholder</span>
          <div className="dlg-row-control">
            <select
              className="io-input dlg-select"
              aria-label="Insert placeholder"
              value=""
              onChange={(e) => e.target.value && insert(e.target.value)}
            >
              <option value="">Insert…</option>
              {PLACEHOLDERS.map((p) => (
                <option key={p} value={p}>
                  {`{{${p}}}`}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="dlg-section-head">Preview</div>
        <div className="alert-preview" data-testid="alert-preview">
          {preview || (
            <span className="dlg-number-suffix">Complete the condition to see a preview.</span>
          )}
        </div>
      </Section>
    </>
  );
}
