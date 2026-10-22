/** Opens the alert dialog (docs/alerts.md §5.2, slice E "Exposes"). */
import { useUiStore } from '../../store/ui';

/** Arguments of `alert.create` for a new alert. */
export interface CreateArgs {
  price?: number;
  paneId?: string;
  symbol?: string;
  drawingId?: string;
  indicatorId?: string;
  /** Condition to start with, e.g. "crossingUp" for "alert above 200" in the palette. */
  op?: CreateOp;
}

export const CREATE_OPS = ['crossing', 'crossingUp', 'crossingDown', 'greater', 'less'] as const;
export type CreateOp = (typeof CREATE_OPS)[number];

/** What opens the dialog: a new alert from an entry point, a copy, or an edit. */
export type AlertDialogArgs = CreateArgs | { cloneOf: string } | { editId: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const isCloneArgs = (a: unknown): a is { cloneOf: string } =>
  isObj(a) && typeof a['cloneOf'] === 'string';
export const isEditArgs = (a: unknown): a is { editId: string } =>
  isObj(a) && typeof a['editId'] === 'string';

/** Keep only well-typed fields of untrusted command arguments. */
export function sanitizeCreateArgs(arg: unknown): CreateArgs {
  if (!isObj(arg)) return {};
  const out: CreateArgs = {};
  if (typeof arg['price'] === 'number' && Number.isFinite(arg['price'])) out.price = arg['price'];
  const op = arg['op'];
  if (typeof op === 'string' && (CREATE_OPS as readonly string[]).includes(op))
    out.op = op as CreateOp;
  for (const k of ['paneId', 'symbol', 'drawingId', 'indicatorId'] as const) {
    const v = arg[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

export function openAlertDialog(args: AlertDialogArgs = {}): void {
  useUiStore.getState().openDialog('alert', args);
}
