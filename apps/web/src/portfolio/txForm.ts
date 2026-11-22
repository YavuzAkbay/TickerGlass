/** Transaction form: per-kind field rules (mirrors the API table) and validation. Pure. */
import type { TxIn, TxKind } from '@tickerglass/portfolio';
import type { Transaction } from '../api/portfolio';

export const TX_KINDS: readonly TxKind[] = [
  'buy',
  'sell',
  'dividend',
  'split',
  'fee',
  'interest',
  'cashIn',
  'cashOut',
];

export const KIND_LABEL: Record<TxKind, string> = {
  buy: 'Buy',
  sell: 'Sell',
  dividend: 'Dividend',
  split: 'Split',
  fee: 'Fee',
  interest: 'Interest',
  cashIn: 'Deposit',
  cashOut: 'Withdrawal',
};

export type FieldRule = 'req' | 'opt' | 'none';

export interface KindRules {
  symbol: FieldRule;
  quantity: FieldRule;
  price: FieldRule;
  amount: FieldRule;
  /** The fee input is shown (commission, or withholding tax on dividends / interest). */
  fee: boolean;
  quantityLabel: string;
  amountLabel: string;
  feeLabel: string;
}

const NONE = { symbol: 'none', quantity: 'none', price: 'none', amount: 'none' } as const;

export const KIND_RULES: Record<TxKind, KindRules> = {
  buy: {
    ...NONE,
    symbol: 'req',
    quantity: 'req',
    price: 'req',
    fee: true,
    quantityLabel: 'Shares',
    amountLabel: 'Amount',
    feeLabel: 'Commission',
  },
  sell: {
    ...NONE,
    symbol: 'req',
    quantity: 'req',
    price: 'req',
    fee: true,
    quantityLabel: 'Shares',
    amountLabel: 'Amount',
    feeLabel: 'Commission',
  },
  dividend: {
    ...NONE,
    symbol: 'req',
    amount: 'req',
    fee: true,
    quantityLabel: 'Shares',
    amountLabel: 'Gross amount',
    feeLabel: 'Withholding tax',
  },
  split: {
    ...NONE,
    symbol: 'req',
    quantity: 'req',
    fee: false,
    quantityLabel: 'Ratio (new per old)',
    amountLabel: 'Amount',
    feeLabel: 'Fee',
  },
  fee: {
    ...NONE,
    symbol: 'opt',
    amount: 'req',
    fee: false,
    quantityLabel: 'Shares',
    amountLabel: 'Amount',
    feeLabel: 'Fee',
  },
  interest: {
    ...NONE,
    amount: 'req',
    fee: true,
    quantityLabel: 'Shares',
    amountLabel: 'Gross amount',
    feeLabel: 'Withholding tax',
  },
  cashIn: {
    ...NONE,
    amount: 'req',
    fee: false,
    quantityLabel: 'Shares',
    amountLabel: 'Amount',
    feeLabel: 'Fee',
  },
  cashOut: {
    ...NONE,
    amount: 'req',
    fee: false,
    quantityLabel: 'Shares',
    amountLabel: 'Amount',
    feeLabel: 'Fee',
  },
};

export const MAX_SYMBOL = 32;
export const MAX_NOTE = 2000;

/** Every input as the user typed it. `time` is a `datetime-local` value (browser time zone). */
export interface TxFormState {
  kind: TxKind;
  time: string;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fee: string;
  currency: string;
  note: string;
}

export type TxFormField = keyof TxFormState;
export type TxFormErrors = Partial<Record<TxFormField, string>>;

const pad = (n: number) => String(n).padStart(2, '0');

/** `datetime-local` value (local time, minute precision) of a date. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function emptyForm(
  kind: TxKind,
  opts: { currency: string; now?: Date; symbol?: string; price?: number | null },
): TxFormState {
  return {
    kind,
    time: toLocalInput(opts.now ?? new Date()),
    symbol: opts.symbol ?? '',
    quantity: '',
    price: opts.price != null && Number.isFinite(opts.price) ? String(opts.price) : '',
    amount: '',
    fee: '',
    currency: opts.currency,
    note: '',
  };
}

const str = (n: number | null): string => (n === null ? '' : String(n));

export function formFromTransaction(t: Transaction): TxFormState {
  const d = new Date(t.time);
  return {
    kind: t.kind,
    time: Number.isNaN(d.getTime()) ? '' : toLocalInput(d),
    symbol: t.symbol ?? '',
    quantity: str(t.quantity),
    price: str(t.price),
    amount: str(t.amount),
    fee: t.fee > 0 ? String(t.fee) : '',
    currency: t.currency,
    note: t.note ?? '',
  };
}

/** Changing the kind keeps what still applies and clears what no longer does. */
export function withKind(form: TxFormState, kind: TxKind): TxFormState {
  const r = KIND_RULES[kind];
  return {
    ...form,
    kind,
    symbol: r.symbol === 'none' ? '' : form.symbol,
    quantity: r.quantity === 'none' ? '' : form.quantity,
    price: r.price === 'none' ? '' : form.price,
    amount: r.amount === 'none' ? '' : form.amount,
    fee: r.fee ? form.fee : '',
  };
}

/**
 * Parse a typed number. With a dot, commas are thousands separators (`1,000.5`); without one, a
 * single comma is the decimal separator (`12,5`) unless it groups thousands (`1,000,000`).
 */
export function parseTyped(s: string): number | null {
  let v = s.trim().replace(/\s/g, '');
  if (!v) return null;
  if (v.includes('.')) v = v.replace(/,/g, '');
  else if (/^[+-]?\d{1,3}(,\d{3}){2,}$/.test(v)) v = v.replace(/,/g, '');
  else if ((v.match(/,/g)?.length ?? 0) === 1) v = v.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v)) return Number.NaN;
  return Number(v);
}

export type TxFormResult = { ok: true; tx: TxIn } | { ok: false; errors: TxFormErrors };

/**
 * Validate per kind and build the API body. Server rules: qty > 0, price >= 0, amount > 0,
 * fee >= 0 (only on buy / sell / dividend / interest; withholding <= gross). `externalId` is never
 * sent: a PUT without it keeps the stored one.
 */
export function validateTxForm(form: TxFormState): TxFormResult {
  const errors: TxFormErrors = {};
  const rules = KIND_RULES[form.kind];

  const d = form.time ? new Date(form.time) : null;
  if (!d || Number.isNaN(d.getTime())) errors.time = 'Pick a date and time';

  const symbol = form.symbol.trim().toUpperCase();
  if (rules.symbol === 'req' && !symbol) errors.symbol = 'Required';
  else if (symbol.length > MAX_SYMBOL) errors.symbol = `At most ${MAX_SYMBOL} characters`;

  const currency = form.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = '3-letter code, e.g. USD';

  const num = (
    field: 'quantity' | 'price' | 'amount',
    rule: FieldRule,
    ok: (n: number) => boolean,
    msg: string,
  ): number | null => {
    if (rule === 'none') return null;
    const n = parseTyped(form[field]);
    if (n === null) {
      if (rule === 'req') errors[field] = 'Required';
      return null;
    }
    if (!Number.isFinite(n) || !ok(n)) {
      errors[field] = msg;
      return null;
    }
    return n;
  };
  const quantity = num('quantity', rules.quantity, (n) => n > 0, 'Must be greater than 0');
  const price = num('price', rules.price, (n) => n >= 0, 'Must be 0 or more');
  const amount = num('amount', rules.amount, (n) => n > 0, 'Must be greater than 0');

  let fee = 0;
  if (rules.fee) {
    const f = parseTyped(form.fee);
    if (f !== null) {
      if (!Number.isFinite(f) || f < 0) errors.fee = 'Must be 0 or more';
      else fee = f;
    }
  }

  // Withholding tax comes out of the gross amount (the API rejects more).
  if (
    (form.kind === 'dividend' || form.kind === 'interest') &&
    amount !== null &&
    !errors.fee &&
    fee > amount
  )
    errors.fee = 'Cannot exceed the gross amount';

  if (form.note.length > MAX_NOTE) errors.note = `At most ${MAX_NOTE} characters`;

  if (Object.keys(errors).length > 0 || !d) return { ok: false, errors };
  const note = form.note.trim();
  return {
    ok: true,
    tx: {
      kind: form.kind,
      time: d.toISOString(),
      symbol: rules.symbol === 'none' || !symbol ? null : symbol,
      quantity,
      price,
      amount,
      fee,
      currency,
      note: note || null,
    },
  };
}
