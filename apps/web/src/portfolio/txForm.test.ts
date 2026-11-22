import { describe, expect, it } from 'vitest';
import type { Transaction } from '../api/portfolio';
import {
  emptyForm,
  formFromTransaction,
  KIND_RULES,
  parseTyped,
  toLocalInput,
  validateTxForm,
  withKind,
  type TxFormState,
} from './txForm';

const NOW = new Date(2026, 4, 12, 14, 30);

const form = (patch: Partial<TxFormState>): TxFormState => ({
  ...emptyForm('buy', { currency: 'USD', now: NOW }),
  ...patch,
});

describe('parseTyped', () => {
  it('parses plain, signed and exponent numbers', () => {
    expect(parseTyped('12.5')).toBe(12.5);
    expect(parseTyped(' -3 ')).toBe(-3);
    expect(parseTyped('1e3')).toBe(1000);
    expect(parseTyped('.5')).toBe(0.5);
  });
  it('takes a lone comma as the decimal separator', () => {
    expect(parseTyped('12,5')).toBe(12.5);
    expect(parseTyped('1,000.5')).toBe(1000.5);
    expect(parseTyped('1,000,000')).toBe(1_000_000);
  });
  it('returns null for blank and NaN for junk', () => {
    expect(parseTyped('  ')).toBeNull();
    expect(parseTyped('abc')).toBeNaN();
    expect(parseTyped('1,2,3')).toBeNaN();
    expect(parseTyped('Infinity')).toBeNaN();
  });
});

describe('validateTxForm', () => {
  it('builds a buy', () => {
    const r = validateTxForm(
      form({ symbol: ' aapl ', quantity: '10', price: '150.25', fee: '1', note: ' hi ' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx).toMatchObject({
      kind: 'buy',
      symbol: 'AAPL',
      quantity: 10,
      price: 150.25,
      amount: null,
      fee: 1,
      currency: 'USD',
      note: 'hi',
    });
    expect(new Date(r.tx.time).getTime()).toBe(NOW.getTime());
  });

  it('requires symbol, quantity and price on a buy; allows a free (0) price', () => {
    const r = validateTxForm(form({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['price', 'quantity', 'symbol']);
    expect(validateTxForm(form({ symbol: 'X', quantity: '1', price: '0' })).ok).toBe(true);
  });

  it('applies the sign rules', () => {
    const r = validateTxForm(form({ symbol: 'X', quantity: '0', price: '-1', fee: '-2' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.quantity).toBeDefined();
    expect(r.errors.price).toBeDefined();
    expect(r.errors.fee).toBeDefined();
  });

  it('dividend needs symbol + positive amount, nulls the rest, fee is withholding', () => {
    const r = validateTxForm(
      form({ kind: 'dividend', symbol: 'ko', amount: '20', fee: '3', quantity: '5', price: '1' }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx).toMatchObject({ symbol: 'KO', amount: 20, fee: 3, quantity: null, price: null });
  });

  it('split takes the ratio as quantity and no fee', () => {
    const r = validateTxForm(form({ kind: 'split', symbol: 'nvda', quantity: '4', fee: '9' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx).toMatchObject({ quantity: 4, price: null, amount: null, fee: 0 });
  });

  it('fee symbol is optional; interest and cash kinds have no symbol', () => {
    expect(validateTxForm(form({ kind: 'fee', amount: '5' })).ok).toBe(true);
    const fee = validateTxForm(form({ kind: 'fee', amount: '5', symbol: 'abc' }));
    expect(fee.ok && fee.tx.symbol).toBe('ABC');
    const cash = validateTxForm(form({ kind: 'cashIn', amount: '1000', symbol: 'zzz' }));
    expect(cash.ok && cash.tx.symbol).toBeNull();
    expect(validateTxForm(form({ kind: 'interest', amount: '0' })).ok).toBe(false);
  });

  it('checks currency and date', () => {
    const r = validateTxForm(
      form({ symbol: 'X', quantity: '1', price: '1', currency: 'US', time: '' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.currency).toBeDefined();
    expect(r.errors.time).toBeDefined();
    const ok = validateTxForm(form({ symbol: 'X', quantity: '1', price: '1', currency: 'eur' }));
    expect(ok.ok && ok.tx.currency).toBe('EUR');
  });

  it('never sends an external id (an edit keeps the stored one)', () => {
    const r = validateTxForm(form({ symbol: 'X', quantity: '1', price: '1' }));
    expect(r.ok && 'externalId' in r.tx).toBe(false);
  });

  it('withholding cannot exceed the gross amount; no fee on cash kinds', () => {
    const r = validateTxForm(form({ kind: 'dividend', symbol: 'KO', amount: '10', fee: '11' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.fee).toBeDefined();
    const cash = validateTxForm(form({ kind: 'cashOut', amount: '10', fee: '3' }));
    expect(cash.ok && cash.tx.fee).toBe(0);
  });
});

describe('withKind', () => {
  it('clears fields the new kind does not use', () => {
    const f = withKind(form({ symbol: 'X', quantity: '1', price: '2', fee: '1' }), 'cashIn');
    expect(f).toMatchObject({ kind: 'cashIn', symbol: '', quantity: '', price: '', fee: '' });
  });
  it('keeps shared fields when buy becomes sell', () => {
    const f = withKind(form({ symbol: 'X', quantity: '1', price: '2' }), 'sell');
    expect(f).toMatchObject({ kind: 'sell', symbol: 'X', quantity: '1', price: '2' });
  });
});

describe('form <-> transaction', () => {
  it('round-trips a stored row', () => {
    const t: Transaction = {
      id: 'a',
      portfolioId: 'p',
      kind: 'sell',
      time: new Date(2026, 0, 5, 9, 15).toISOString(),
      symbol: 'MSFT',
      quantity: 3,
      price: 410.5,
      amount: null,
      fee: 0,
      currency: 'USD',
      note: null,
      source: 'import:ibkr',
      externalId: 'x1',
      importBatch: 'b1',
      seq: 4,
      revision: 2,
      createdAt: '',
      updatedAt: '',
    };
    const f = formFromTransaction(t);
    expect(f.time).toBe('2026-01-05T09:15');
    expect(f.fee).toBe('');
    const r = validateTxForm(f);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tx).toMatchObject({ kind: 'sell', symbol: 'MSFT', quantity: 3, price: 410.5 });
    expect(r.tx).not.toHaveProperty('externalId');
    expect(r.tx.time).toBe(t.time);
  });
  it('formats local datetime inputs', () => {
    expect(toLocalInput(new Date(2026, 8, 3, 7, 5))).toBe('2026-09-03T07:05');
  });
  it('every kind lists a rule row', () => {
    expect(Object.keys(KIND_RULES)).toHaveLength(8);
  });
});
