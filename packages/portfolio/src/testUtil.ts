import type { Tx, TxKind } from './types';

let n = 0;

/** Test helper: a transaction with sensible defaults. */
export function mk(kind: TxKind, time: string, o: Partial<Tx> = {}): Tx {
  return {
    id: `t${++n}`,
    kind,
    time,
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    fee: 0,
    currency: 'USD',
    ...o,
  };
}

export const buy = (
  time: string,
  symbol: string,
  quantity: number,
  price: number,
  fee = 0,
  o: Partial<Tx> = {},
) => mk('buy', time, { symbol, quantity, price, fee, ...o });
export const sell = (
  time: string,
  symbol: string,
  quantity: number,
  price: number,
  fee = 0,
  o: Partial<Tx> = {},
) => mk('sell', time, { symbol, quantity, price, fee, ...o });
