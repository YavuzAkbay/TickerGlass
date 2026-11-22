/**
 * DEGIRO: Transactions.csv and Account.csv (English-language export).
 *
 * NOTE: the column sets below are best-effort, written from public knowledge of the exports. They
 * must be verified against real exports before being relied on.
 *
 * Transactions: Date (dd-mm-yyyy), Time, Product, ISIN, Reference exchange, Venue, Quantity
 *   (signed), Price, <price currency, unnamed>, Local value, <currency, unnamed>, Value EUR,
 *   Exchange rate (foreign units per account unit), Transaction and/or third party fees EUR,
 *   Total EUR, Order ID.
 * Account:      Date, Time, Value date, Product, ISIN, Description, FX, Change, <currency,
 *   unnamed>, Balance, <currency, unnamed>, Order Id. Only dividends, dividend tax, deposits,
 *   withdrawals and interest are imported; trades and trading fees come from Transactions.csv.
 *
 * DEGIRO identifies products by name and ISIN, not ticker: the ISIN is used as the symbol and a
 * warning asks the user to remap it. Number style (1.234,56 vs 1,234.56) is inferred per file; an
 * uncertain guess is reported as a warning plus `assumptions.decimal`, and `opts.decimal` overrides it.
 * Order Id identifies an order, not a fill, so ids are `degiro:<orderId>:<hash(raw date, time,
 * quantity, price)>`: partial fills of one order stay distinct and ids do not depend on row order.
 * Dividend tax lines are their own `fee` rows (symbol set), not folded into the dividend.
 */
import type { ParseAssumptions, ParseBrokerOptions, TxIn } from '../../types';
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
  withholdingTx,
} from '../common';

const isTxHeader = (k: string[]) =>
  k.includes('isin') &&
  k.includes('product') &&
  k.includes('quantity') &&
  k.includes('price') &&
  (k.includes('referenceexchange') || k.includes('venue'));

const isAccountHeader = (k: string[]) =>
  k.includes('isin') &&
  k.includes('valuedate') &&
  k.includes('description') &&
  k.includes('change');

const isHeader = (k: string[]) => isTxHeader(k) || isAccountHeader(k);

const ISIN_WARNING =
  'DEGIRO: products are identified by ISIN, so ISINs are used as symbols. Remap them to tickers (e.g. by editing the transactions) before relying on prices.';

function sampleColumn(t: Table, idx: number): string[] {
  return idx < 0 ? [] : t.rows.map((r) => (r[idx] ?? '').trim()).filter((s) => s !== '');
}

/** The decimal mark: the override if given, else the inferred one with a warning when unsure. */
function decimalFor(
  samples: string[],
  opts: ParseBrokerOptions | undefined,
  assumptions: ParseAssumptions,
  warnings: string[],
  where: string,
): '.' | ',' {
  if (opts?.decimal) return opts.decimal;
  const a = analyzeDecimal(samples);
  if (a.uncertain) {
    assumptions.decimal = a.decimal;
    warnings.push(
      `${where}: the number format is ambiguous; assumed "${a.decimal}" as the decimal mark. Override it if quantities or prices look wrong.`,
    );
  }
  return a.decimal;
}

function parseTransactions(
  t: Table,
  ids: IdMaker,
  out: TxIn[],
  warnings: string[],
  opts: ParseBrokerOptions | undefined,
  assumptions: ParseAssumptions,
): void {
  const cDate = col(t, 'date');
  const cTime = col(t, 'time');
  const cIsin = col(t, 'isin');
  const cProduct = col(t, 'product');
  const cQty = col(t, 'quantity');
  const cPx = col(t, 'price');
  const cRate = col(t, 'exchangerate');
  const cOrder = col(t, 'orderid');
  const cFee = t.keys.findIndex((k) => k.startsWith('transactionand'));
  const accountCcy = cFee >= 0 ? ccyOf((t.keys[cFee] ?? '').slice(-3)) : null;
  const cPxCcy = cPx >= 0 && ['', 'currency'].includes(t.keys[cPx + 1] ?? 'x') ? cPx + 1 : -1;

  const dec = decimalFor(
    [
      ...sampleColumn(t, cQty),
      ...sampleColumn(t, cPx),
      ...sampleColumn(t, cFee),
      ...sampleColumn(t, cRate),
    ],
    opts,
    assumptions,
    warnings,
    'DEGIRO transactions',
  );
  let usedIsin = false;
  t.rows.forEach((row, i) => {
    const where = `DEGIRO transactions row ${i + 1}`;
    const isin = cell(row, cIsin).toUpperCase();
    const time = parseDate(cell(row, cDate), { order: 'dmy', time: cell(row, cTime) });
    const qty = parseNumber(cell(row, cQty), dec);
    const price = parseNumber(cell(row, cPx), dec);
    if (!isin || !time || qty === null || qty === 0 || price === null) {
      warnings.push(`${where}: skipped (missing ISIN, date, quantity or price).`);
      return;
    }
    let ccy = ccyOf(cell(row, cPxCcy));
    if (!ccy) {
      ccy = accountCcy ?? 'EUR';
      warnings.push(`${where}: price currency not found, assumed ${ccy}.`);
    }
    let fee = Math.abs(parseNumber(cell(row, cFee), dec) ?? 0);
    if (fee > 0 && accountCcy && accountCcy !== ccy) {
      const rate = parseNumber(cell(row, cRate), dec);
      if (rate !== null && rate > 0) {
        fee *= rate;
      } else {
        warnings.push(
          `${where}: fee is in ${accountCcy} but the trade is in ${ccy} with no exchange rate; fee set to 0.`,
        );
        fee = 0;
      }
    }
    const q = Math.abs(qty);
    const kind = qty > 0 ? 'buy' : 'sell';
    usedIsin = true;
    out.push(
      blankTx(kind, time, ccy, {
        symbol: isin,
        quantity: q,
        price,
        fee,
        externalId: ids.order(cell(row, cOrder), [
          cell(row, cDate),
          cell(row, cTime),
          cell(row, cQty),
          cell(row, cPx),
        ]),
        note: cell(row, cProduct) || null,
      }),
    );
  });
  if (usedIsin) warnings.push(ISIN_WARNING);
}

function parseAccount(
  t: Table,
  ids: IdMaker,
  out: TxIn[],
  warnings: string[],
  opts: ParseBrokerOptions | undefined,
  assumptions: ParseAssumptions,
): void {
  const cDate = col(t, 'date');
  const cTime = col(t, 'time');
  const cProduct = col(t, 'product');
  const cIsin = col(t, 'isin');
  const cDesc = col(t, 'description');
  const cChange = col(t, 'change');
  const cOrder = col(t, 'orderid');
  const dec = decimalFor(sampleColumn(t, cChange), opts, assumptions, warnings, 'DEGIRO account');
  let usedIsin = false;
  let ignored = 0;
  t.rows.forEach((row, i) => {
    const where = `DEGIRO account row ${i + 1}`;
    const desc = cell(row, cDesc);
    const d = desc.toLowerCase();
    if (d === '' && cell(row, cChange) === '') return;
    const time = parseDate(cell(row, cDate), { order: 'dmy', time: cell(row, cTime) });
    const amount = parseNumber(cell(row, cChange), dec);
    const ccy = ccyOf(cell(row, cChange + 1));
    const isin = cell(row, cIsin).toUpperCase();
    if (!time || amount === null || amount === 0 || !ccy) {
      warnings.push(`${where}: skipped (missing date, amount or currency).`);
      return;
    }
    const externalId = ids.order(cell(row, cOrder), [
      cell(row, cDate),
      cell(row, cTime),
      desc,
      cell(row, cIsin),
      cell(row, cChange),
      cell(row, cChange + 1),
    ]);
    const note = cell(row, cProduct) || desc || null;
    if (d.includes('reservation')) {
      ignored++;
    } else if (d.includes('tax') || d.includes('belasting')) {
      if (d.includes('dividend') && isin) {
        usedIsin = true;
        out.push(
          withholdingTx({
            symbol: isin,
            currency: ccy,
            time,
            amount,
            externalId,
            note: 'Withholding tax',
          }),
        );
      } else {
        ignored++;
      }
    } else if (d.startsWith('dividend')) {
      if (!isin || amount < 0) {
        warnings.push(`${where}: dividend without ISIN or with negative amount skipped.`);
        return;
      }
      usedIsin = true;
      out.push(blankTx('dividend', time, ccy, { symbol: isin, amount, externalId, note }));
    } else if (d.includes('deposit')) {
      out.push(blankTx('cashIn', time, ccy, { amount: Math.abs(amount), externalId, note: desc }));
    } else if (d.includes('withdrawal')) {
      out.push(blankTx('cashOut', time, ccy, { amount: Math.abs(amount), externalId, note: desc }));
    } else if (d.includes('interest')) {
      out.push(
        amount > 0
          ? blankTx('interest', time, ccy, { amount, externalId, note: desc })
          : blankTx('fee', time, ccy, { amount: -amount, externalId, note: desc }),
      );
    } else {
      ignored++;
    }
  });
  if (ignored > 0) {
    warnings.push(
      `DEGIRO account: ignored ${ignored} row(s) that are not dividends, deposits, withdrawals or interest (trades and trading fees come from Transactions.csv).`,
    );
  }
  if (usedIsin) warnings.push(ISIN_WARNING);
}

export const degiro: BrokerMapper = {
  detect(rows) {
    return splitTables(rows, isHeader).length > 0;
  },
  parse(rows, opts): MapperResult {
    const warnings: string[] = [];
    const transactions: TxIn[] = [];
    const assumptions: ParseAssumptions = {};
    const ids = new IdMaker('degiro');
    const tables = splitTables(rows, isHeader);
    if (tables.length === 0) warnings.push('DEGIRO: no Transactions or Account header found.');
    for (const t of tables) {
      if (isTxHeader(t.keys)) parseTransactions(t, ids, transactions, warnings, opts, assumptions);
      else parseAccount(t, ids, transactions, warnings, opts, assumptions);
    }
    const result: MapperResult = { transactions, warnings: [...new Set(warnings)] };
    if (Object.keys(assumptions).length > 0) result.assumptions = assumptions;
    return result;
  },
};
