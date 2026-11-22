/**
 * Interactive Brokers: Flex Query CSV (Trades section and Cash Transactions section, optionally
 * both in one file with HEADER/DATA record prefixes).
 *
 * NOTE: the column sets below are best-effort, written from public knowledge of Flex Query
 * output. They must be verified against real exports before being relied on.
 *
 * Trades:        Symbol, CurrencyPrimary|Currency, DateTime|TradeDate(+TradeTime), Quantity (signed),
 *                TradePrice, IBCommission (negative), Buy/Sell, TradeID, AssetClass, LevelOfDetail.
 * Cash:          Type, Amount, CurrencyPrimary|Currency, Date/Time|DateTime|ReportDate|SettleDate,
 *                Symbol, Description, TransactionID.
 */
import type { TxIn } from '../../types';
import { parseDate, parseNumber } from '../parse';
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

/** Drop BOF/BOA/EOA/EOF records and the HEADER/DATA prefix cell used by Flex files with section records. */
function stripRecordPrefix(rows: string[][]): string[][] {
  const prefixed = rows.some((r) => r[0] === 'HEADER' || r[0] === 'DATA');
  if (!prefixed) return rows;
  const out: string[][] = [];
  for (const r of rows) {
    if (r[0] === 'HEADER' || r[0] === 'DATA') out.push(r.slice(1));
  }
  return out;
}

const isTradeHeader = (k: string[]) =>
  k.includes('symbol') && k.includes('tradeprice') && k.includes('quantity');

const isCashHeader = (k: string[]) =>
  k.includes('type') &&
  k.includes('amount') &&
  !k.includes('tradeprice') &&
  (k.includes('currencyprimary') ||
    k.includes('transactionid') ||
    (k.includes('currency') && k.includes('datetime') && k.includes('description'))) &&
  (k.includes('datetime') ||
    k.includes('date') ||
    k.includes('reportdate') ||
    k.includes('settledate'));

const isHeader = (k: string[]) => isTradeHeader(k) || isCashHeader(k);

function parseTrades(t: Table, ids: IdMaker, out: TxIn[], warnings: string[]): void {
  const cSym = col(t, 'symbol');
  const cCcy = col(t, 'currencyprimary', 'currency');
  const cDt = col(t, 'datetime');
  const cDate = col(t, 'tradedate', 'date');
  const cTime = col(t, 'tradetime');
  const cQty = col(t, 'quantity');
  const cPx = col(t, 'tradeprice');
  const cComm = col(t, 'ibcommission');
  const cSide = col(t, 'buysell');
  const cId = col(t, 'tradeid', 'ibexecid', 'transactionid');
  const cClass = col(t, 'assetclass');
  const cLevel = col(t, 'levelofdetail');
  let skippedClass = 0;
  t.rows.forEach((row, i) => {
    const where = `IBKR trades row ${i + 1}`;
    const level = cell(row, cLevel).toUpperCase();
    if (cLevel >= 0 && level !== '' && level !== 'EXECUTION') return;
    const assetClass = cell(row, cClass).toUpperCase();
    if (cClass >= 0 && assetClass !== '' && assetClass !== 'STK') {
      skippedClass++;
      return;
    }
    const symbol = cell(row, cSym).toUpperCase();
    const ccy = ccyOf(cell(row, cCcy));
    const time =
      cDt >= 0
        ? parseDate(cell(row, cDt))
        : parseDate(cell(row, cDate), { time: cell(row, cTime) });
    const qty = parseNumber(cell(row, cQty), '.');
    const price = parseNumber(cell(row, cPx), '.');
    if (!symbol || !ccy || !time || qty === null || qty === 0 || price === null) {
      warnings.push(`${where}: skipped (missing symbol, currency, date, quantity or price).`);
      return;
    }
    const side = cell(row, cSide).toUpperCase();
    const isBuy = side.startsWith('B') ? true : side.startsWith('S') ? false : qty > 0;
    const fee = Math.abs(parseNumber(cell(row, cComm), '.') ?? 0);
    const q = Math.abs(qty);
    out.push(
      blankTx(isBuy ? 'buy' : 'sell', time, ccy, {
        symbol,
        quantity: q,
        price,
        fee,
        // TradeID is unique per execution, so it is used bare.
        externalId: ids.exec(cell(row, cId), [
          cell(row, cSide),
          cell(row, cDt >= 0 ? cDt : cDate),
          cell(row, cTime),
          cell(row, cSym),
          cell(row, cCcy),
          cell(row, cQty),
          cell(row, cPx),
          cell(row, cComm),
        ]),
      }),
    );
  });
  if (skippedClass > 0) {
    warnings.push(
      `IBKR: skipped ${skippedClass} non-stock trade row(s) (options, futures, FX, ...).`,
    );
  }
}

function parseCash(t: Table, ids: IdMaker, out: TxIn[], warnings: string[]): void {
  const cType = col(t, 'type');
  const cAmt = col(t, 'amount');
  const cCcy = col(t, 'currencyprimary', 'currency');
  const cTime = col(t, 'datetime', 'date', 'reportdate', 'settledate');
  const cSym = col(t, 'symbol');
  const cDesc = col(t, 'description');
  const cId = col(t, 'transactionid');
  t.rows.forEach((row, i) => {
    const where = `IBKR cash row ${i + 1}`;
    const type = cell(row, cType).toLowerCase();
    const amount = parseNumber(cell(row, cAmt), '.');
    const ccy = ccyOf(cell(row, cCcy));
    const time = parseDate(cell(row, cTime));
    const symbol = cell(row, cSym).toUpperCase();
    if (type === '' && amount === null) return;
    if (amount === null || !ccy || !time || amount === 0) {
      warnings.push(`${where}: skipped (missing amount, currency or date).`);
      return;
    }
    const externalId = ids.exec(cell(row, cId), [
      cell(row, cType),
      cell(row, cTime),
      cell(row, cSym),
      cell(row, cCcy),
      cell(row, cAmt),
      cell(row, cDesc),
    ]);
    const note = cell(row, cDesc) || null;
    switch (type) {
      case 'dividends':
      case 'payment in lieu of dividends':
        if (!symbol || amount < 0) {
          warnings.push(`${where}: ${type} without symbol or with negative amount skipped.`);
          return;
        }
        out.push(blankTx('dividend', time, ccy, { symbol, amount, externalId, note }));
        return;
      case 'withholding tax':
        if (!symbol) {
          warnings.push(`${where}: withholding tax without symbol skipped.`);
          return;
        }
        // Its own row (a fee tagged with the symbol), never merged into the dividend.
        out.push(
          withholdingTx({
            symbol,
            currency: ccy,
            time,
            amount,
            externalId,
            note: 'Withholding tax',
          }),
        );
        return;
      case 'deposits/withdrawals':
        out.push(
          blankTx(amount > 0 ? 'cashIn' : 'cashOut', time, ccy, {
            amount: Math.abs(amount),
            externalId,
            note,
          }),
        );
        return;
      case 'broker interest received':
      case 'bond interest received':
        if (amount < 0) {
          warnings.push(`${where}: negative interest received skipped.`);
          return;
        }
        out.push(blankTx('interest', time, ccy, { amount, externalId, note }));
        return;
      case 'broker interest paid':
      case 'bond interest paid':
      case 'other fees':
      case 'commission adjustments':
        if (amount > 0) {
          warnings.push(`${where}: ${type} credit skipped.`);
          return;
        }
        out.push(blankTx('fee', time, ccy, { amount: -amount, externalId, note }));
        return;
      default:
        warnings.push(`${where}: unsupported cash transaction type "${cell(row, cType)}" skipped.`);
    }
  });
}

export const ibkr: BrokerMapper = {
  detect(rows) {
    return splitTables(stripRecordPrefix(rows), isHeader).length > 0;
  },
  parse(rows): MapperResult {
    const warnings: string[] = [];
    const transactions: TxIn[] = [];
    const tradeIds = new IdMaker('ibkr:t');
    const cashIds = new IdMaker('ibkr:c');
    const tables = splitTables(stripRecordPrefix(rows), isHeader);
    if (tables.length === 0) warnings.push('IBKR: no Trades or Cash Transactions header found.');
    for (const t of tables) {
      if (isTradeHeader(t.keys)) parseTrades(t, tradeIds, transactions, warnings);
      else parseCash(t, cashIds, transactions, warnings);
    }
    return { transactions, warnings };
  },
};
