/**
 * Initial dialog state per entry point (docs/alerts.md §5.3). Pure: the chart
 * comes in as an `AlertContext`.
 */
import { CHANNEL_TOOLS, DEFAULT_NOTIFY, type Alert, type SeriesOperand } from '@investopen/alerts';
import {
  alertToForm,
  cloneForm,
  emptyValue,
  numberText,
  type FormState,
  type TargetForm,
} from './form';
import { isCloneArgs, isEditArgs, type AlertDialogArgs, type CreateArgs } from './open';
import {
  drawingOperand,
  firstOutputId,
  indicatorOperand,
  indicatorsAllowed,
  type AlertContext,
} from './sources';

const CLOSE: SeriesOperand = { kind: 'price', field: 'close' };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Plain defaults: the chart's symbol, interval and extended hours; everything else as the user's last pick would be. */
function base(ctx: AlertContext, symbol: string): FormState {
  return {
    name: '',
    symbol,
    interval: ctx.interval,
    prepost: ctx.prepost,
    left: CLOSE,
    op: 'crossing',
    right: emptyValue(),
    channel: { kind: 'bounds', upper: emptyValue(), lower: emptyValue() },
    amount: '',
    bars: '1',
    trigger: 'once',
    expiresAt: null,
    message: '',
    notify: { ...DEFAULT_NOTIFY },
    status: 'active',
  };
}

const valueTarget = (n: number | undefined, decimals: number): TargetForm => ({
  kind: 'value',
  text: finite(n) ? numberText(n, decimals) : '',
});

/** First chart indicator that lives in `paneId`, with its first plot output. */
function firstIndicatorIn(
  ctx: AlertContext,
  paneId: string,
): { operand: SeriesOperand; instanceId: string; outputId: string } | null {
  for (const inst of ctx.indicators) {
    if (ctx.paneOf(inst.id) !== paneId) continue;
    const outputId = firstOutputId(inst.type);
    const operand = outputId ? indicatorOperand(ctx, inst.id, outputId) : null;
    if (operand && outputId) return { operand, instanceId: inst.id, outputId };
  }
  return null;
}

/**
 * New alert from an entry point:
 * - `{}`: `close` crossing the last price.
 * - `{price}` (+ `paneId`): `close` crossing `price`; on an indicator pane the pane's first indicator output.
 * - `{drawingId}`: line tools `close` crossing the line; channels `close` entering the channel.
 *   On an indicator pane the pane's first indicator output replaces `close`.
 * - `{indicatorId}`: the indicator's first output crossing its last value.
 * - `{symbol}`: that symbol, `close` crossing its last quote (price sources only unless it is the chart symbol).
 */
export function defaultForm(args: CreateArgs, ctx: AlertContext): FormState {
  const symbol = args.symbol?.trim() || ctx.symbol;
  const f = base(ctx, symbol);
  const px = indicatorsAllowed(ctx, symbol) ? 1 : 0;
  const dec = ctx.decimals;

  if (args.drawingId && px) {
    const d = ctx.drawings.find((x) => x.id === args.drawingId);
    if (d) {
      if (d.paneId !== 'main') {
        const ind = firstIndicatorIn(ctx, d.paneId);
        if (ind) f.left = ind.operand;
      }
      if (CHANNEL_TOOLS.includes(d.type)) {
        f.op = 'enteringChannel';
        f.channel = { kind: 'drawing', drawingId: d.id, scale: ctx.scaleOf(d.paneId) };
      } else {
        f.right = { kind: 'source', operand: drawingOperand(ctx, d, 'line') };
      }
      return f;
    }
  }

  if (args.indicatorId && px) {
    const inst = ctx.indicators.find((i) => i.id === args.indicatorId);
    const outputId = inst ? firstOutputId(inst.type) : null;
    const operand = inst && outputId ? indicatorOperand(ctx, inst.id, outputId) : null;
    if (inst && outputId && operand) {
      f.left = operand;
      f.right = valueTarget(ctx.indicatorValue(inst.id, outputId), dec + 2);
      return f;
    }
  }

  if (finite(args.price)) {
    if (args.paneId && args.paneId !== 'main' && px) {
      const ind = firstIndicatorIn(ctx, args.paneId);
      if (ind) f.left = ind.operand;
    }
    f.right = valueTarget(args.price, f.left.kind === 'indicator' ? dec + 2 : dec);
    return f;
  }

  f.right = valueTarget(ctx.lastPrice(symbol), dec);
  return f;
}

/** The dialog state for any open request; null when the alert to edit or clone is gone. */
export function initialForm(
  args: AlertDialogArgs,
  ctx: AlertContext,
  find: (id: string) => Alert | undefined,
): FormState | null {
  if (isEditArgs(args)) {
    const a = find(args.editId);
    return a ? alertToForm(a) : null;
  }
  if (isCloneArgs(args)) {
    const a = find(args.cloneOf);
    return a ? cloneForm(a) : null;
  }
  return defaultForm(args, ctx);
}
