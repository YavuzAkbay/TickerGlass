/**
 * Generic CSV: header-mapped columns with case-insensitive alias lists.
 *
 * NOTE: the alias lists below are best-effort and meant to be extended once real user files are
 * seen.
 *
 * Columns (first alias that matches wins):
 *   date    date | datum | datetime | timestamp | tradedate | transactiondate | executiondate (+ optional time)
 *   type    type | kind | action | side | transaction | transactiontype | activity | operation
 *   symbol  symbol | ticker | instrument | code | security | asset
 *   quantity quantity | qty | shares | units | size
 *   price   price | tradeprice | price/share | unitprice
 *   amount  amount | total | value | netamount | proceeds
 *   fee     fee | fees | commission | commissions | charges
 *   currency currency | ccy
 *   id      id | transactionid | tradeid | externalid (unique per row: used as the external id as is)
 *   order   orderid | reference (may repeat across fills: external id = <id>:<hash of the raw row>)
 * Type values map by keyword (buy/purchase, sell/sold, dividend, split, interest, deposit/cash in,
 * withdraw/cash out, fee/commission/tax). A missing currency defaults to USD with a warning.
 * Numeric dates (03/04/2024) and numbers (1,500) can be ambiguous: the format is inferred per file;
 * when that is a guess (no row disambiguates, rows disagree, or only a minority decides) a warning
 * names the assumption and `assumptions` reports it. `opts` overrides the inference. Ids hash the
 * raw cell text so they do not change with the inferred format.
 */
import type { ParseAssumptions, ParseBrokerOptions, TxIn, TxKind } from '../../types';
import { analyzeDecimal, parseDate, parseNumber } from '../parse';
import {
  blankTx,
  ccyOf,
  cell,
  col,
  IdMaker,
  splitTables,
  type BrokerMapper,
  type MapperResult,
  type Table,
} from '../common';

const DATE = [
  'datetime',
  'timestamp',
  'date',
  'datum',
  'tradedate',
  'transactiondate',
  'executiondate',
  'time',
];
const TIME = ['time', 'tradetime'];
const TYPE = [
  'type',
  'kind',
  'action',
  'side',
  'transaction',
  'transactiontype',
  'activity',
  'operation',
];
const SYMBOL = ['symbol', 'ticker', 'instrument', 'code', 'security', 'asset'];
const QTY = ['quantity', 'qty', 'shares', 'units', 'size'];
const PRICE = ['price', 'tradeprice', 'priceshare', 'pricepershare', 'unitprice'];
const AMOUNT = ['amount', 'total', 'value', 'netamount', 'proceeds'];
const FEE = ['fee', 'fees', 'commission', 'commissions', 'charges'];
const CCY = ['currency', 'ccy'];
const ID = ['id', 'transactionid', 'tradeid', 'externalid'];
const ORDER_ID = ['orderid', 'reference'];

const has = (keys: string[], aliases: string[]) => aliases.some((a) => keys.includes(a));

const isHeader = (k: string[]) =>
  has(k, DATE) && (has(k, TYPE) || (has(k, SYMBOL) && has(k, QTY) && has(k, PRICE)));

export function kindOf(typeText: string): TxKind | null {
  const s = typeText.toLowerCase();
  if (s.includes('split')) return 'split';
  if (/dividend|\bdiv\b/.test(s)) return 'dividend';
  if (s.includes('interest')) return 'interest';
  if (/deposit|cash ?in|transfer in|contribution|funds received/.test(s)) return 'cashIn';
  if (/withdraw|cash ?out|transfer out|payout/.test(s)) return 'cashOut';
  if (/buy|purchase|bought|acquire/.test(s)) return 'buy';
  if (/sell|sold|sale|dispos/.test(s)) return 'sell';
  if (/fee|commission|charge|tax/.test(s)) return 'fee';
  return null;
}

function splitRatio(raw: string, dec: '.' | ','): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(?::|\/|-?for-?|\bfor\b)\s*(\d+(?:[.,]\d+)?)$/i.exec(raw.trim());
  if (m) {
    const a = parseNumber(m[1], dec);
    const b = parseNumber(m[2], dec);
    return a !== null && b !== null && b > 0 ? a / b : null;
  }
  return parseNumber(raw, dec);
}

interface DateOrderAnalysis {
  order: 'mdy' | 'dmy';
  uncertain: boolean;
  /** Human-readable reason, set when uncertain. */
  why: string;
}

/**
 * Tally numeric dates: a first part > 12 proves day-first, a second part > 12 proves month-first,
 * anything else (both <= 12 and different) is ambiguous. Uncertain when nothing is proven, when
 * both orders are proven, or when the proving rows are not the majority of the ambiguous ones.
 */
function analyzeDateOrder(samples: string[]): DateOrderAnalysis {
  let dmy = 0;
  let mdy = 0;
  let ambiguous = 0;
  for (const s of samples) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(s.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) dmy++;
    else if (b > 12) mdy++;
    else if (a !== b) ambiguous++;
  }
  const order = dmy > mdy ? 'dmy' : 'mdy';
  if (dmy + mdy === 0) {
    return ambiguous > 0
      ? { order, uncertain: true, why: 'no date in the file shows which part is the day' }
      : { order, uncertain: false, why: '' };
  }
  if (dmy > 0 && mdy > 0) {
    return { order, uncertain: true, why: 'the file mixes day-first and month-first dates' };
  }
  if (ambiguous > 0 && dmy + mdy <= ambiguous) {
    return {
      order,
      uncertain: true,
      why: `only ${dmy + mdy} of ${dmy + mdy + ambiguous} numeric dates show which part is the day`,
    };
  }
  return { order, uncertain: false, why: '' };
}

function parseTable(
  t: Table,
  ids: IdMaker,
  out: TxIn[],
  warnings: string[],
  opts: ParseBrokerOptions | undefined,
  assumptions: ParseAssumptions,
): void {
  const cDate = col(t, ...DATE);
  // A separate time column only makes sense next to a distinct date column.
  const cTime = t.keys[cDate] === 'time' ? -1 : col(t, ...TIME);
  const cType = col(t, ...TYPE);
  const cSym = col(t, ...SYMBOL);
  const cQty = col(t, ...QTY);
  const cPx = col(t, ...PRICE);
  const cAmt = col(t, ...AMOUNT);
  const cFee = col(t, ...FEE);
  const cCcy = col(t, ...CCY);
  const cId = col(t, ...ID);
  const cOrder = col(t, ...ORDER_ID);
  const col_ = (i: number) => t.rows.map((r) => cell(r, i)).filter((s) => s !== '');
  let dec: '.' | ',';
  if (opts?.decimal) {
    dec = opts.decimal;
  } else {
    const a = analyzeDecimal([...col_(cQty), ...col_(cPx), ...col_(cAmt), ...col_(cFee)]);
    dec = a.decimal;
    if (a.uncertain) {
      assumptions.decimal = dec;
      warnings.push(
        `Generic: the number format is ambiguous; assumed "${dec}" as the decimal mark (e.g. "1,500" read as ${dec === '.' ? '1500' : '1.5'}). Override it if quantities or prices look wrong.`,
      );
    }
  }
  let order: 'mdy' | 'dmy';
  if (opts?.dateOrder) {
    order = opts.dateOrder;
  } else {
    const a = analyzeDateOrder(col_(cDate));
    order = a.order;
    if (a.uncertain) {
      assumptions.dateOrder = order;
      warnings.push(
        `Generic: numeric dates are ambiguous (${a.why}); assumed ${order === 'dmy' ? 'day/month/year' : 'month/day/year'}. Override it if dates look wrong.`,
      );
    }
  }
  let defaultedCcy = false;

  t.rows.forEach((row, i) => {
    const where = `Generic row ${i + 1}`;
    const typeText = cell(row, cType);
    const hasQty = cQty >= 0 && cell(row, cQty) !== '';
    if (typeText === '' && !hasQty && cell(row, cAmt) === '') return;
    const time = parseDate(cell(row, cDate), {
      order,
      time: cell(row, cTime),
    });
    if (!time) {
      warnings.push(`${where}: skipped (unreadable date "${cell(row, cDate)}").`);
      return;
    }
    const qty = cQty >= 0 ? parseNumber(cell(row, cQty), dec) : null;
    const price = parseNumber(cell(row, cPx), dec);
    const amount = parseNumber(cell(row, cAmt), dec);
    const fee = Math.abs(parseNumber(cell(row, cFee), dec) ?? 0);
    const symbol = cell(row, cSym).toUpperCase() || null;
    let kind: TxKind | null = typeText !== '' ? kindOf(typeText) : null;
    if (typeText === '' && symbol && qty !== null && qty !== 0) kind = qty > 0 ? 'buy' : 'sell';
    if (!kind) {
      warnings.push(`${where}: unrecognised type "${typeText}" skipped.`);
      return;
    }
    let ccy = ccyOf(cell(row, cCcy));
    if (!ccy) {
      ccy = 'USD';
      defaultedCcy = true;
    }
    // Raw cell text, so the id does not depend on the inferred date order / decimal mark.
    const raw = [cDate, cTime, cType, cSym, cQty, cPx, cAmt, cFee, cCcy].map((c) => cell(row, c));
    const rowId = cell(row, cId);
    const orderId = cell(row, cOrder);
    const externalId = rowId !== '' ? ids.exec(rowId, raw) : ids.order(orderId, raw);
    const note = typeText || null;

    switch (kind) {
      case 'buy':
      case 'sell': {
        const q = qty === null ? null : Math.abs(qty);
        let px = price;
        if (px === null && amount !== null && q) px = Math.abs(amount) / q;
        if (!symbol || !q || px === null) {
          warnings.push(`${where}: ${kind} skipped (needs symbol, quantity and price or amount).`);
          return;
        }
        out.push(
          blankTx(kind, time, ccy, { symbol, quantity: q, price: px, fee, externalId, note }),
        );
        return;
      }
      case 'dividend': {
        let a = amount === null ? null : Math.abs(amount);
        if (a === null && qty !== null && price !== null) a = Math.abs(qty * price);
        if (!symbol || a === null || a === 0) {
          warnings.push(`${where}: dividend skipped (needs symbol and amount).`);
          return;
        }
        out.push(blankTx('dividend', time, ccy, { symbol, amount: a, fee, externalId, note }));
        return;
      }
      case 'split': {
        const ratio = splitRatio(cell(row, cQty), dec);
        if (!symbol || ratio === null || ratio <= 0) {
          warnings.push(`${where}: split skipped (needs symbol and a ratio such as 4 or 1:10).`);
          return;
        }
        out.push(blankTx('split', time, ccy, { symbol, quantity: ratio, externalId, note }));
        return;
      }
      default: {
        // fee, interest, cashIn, cashOut
        const a = amount !== null ? Math.abs(amount) : kind === 'fee' && fee > 0 ? fee : null;
        if (a === null || a === 0) {
          warnings.push(`${where}: ${kind} skipped (needs an amount).`);
          return;
        }
        out.push(
          blankTx(kind, time, ccy, {
            symbol: kind === 'fee' ? symbol : null,
            amount: a,
            externalId,
            note,
          }),
        );
      }
    }
  });
  if (defaultedCcy) warnings.push('Generic: no currency column or value; defaulted to USD.');
}

export const generic: BrokerMapper = {
  detect(rows) {
    return splitTables(rows, isHeader).length > 0;
  },
  parse(rows, opts): MapperResult {
    const warnings: string[] = [];
    const transactions: TxIn[] = [];
    const tables = splitTables(rows, isHeader);
    const first = tables[0];
    if (!first) {
      return {
        transactions,
        warnings: [
          'Generic: no header with a date and a type (or symbol/quantity/price) column found.',
        ],
      };
    }
    const assumptions: ParseAssumptions = {};
    parseTable(first, new IdMaker('csv'), transactions, warnings, opts, assumptions);
    const result: MapperResult = { transactions, warnings };
    if (Object.keys(assumptions).length > 0) result.assumptions = assumptions;
    return result;
  },
};
