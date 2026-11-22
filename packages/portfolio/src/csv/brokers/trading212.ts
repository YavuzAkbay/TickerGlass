/**
 * Trading 212: History export (CSV).
 *
 * NOTE: the column sets below are best-effort, written from public knowledge of the export. They
 * must be verified against real exports before being relied on.
 *
 * Columns: Action ("Market buy", "Limit sell", "Dividend (Ordinary)", "Deposit", "Withdrawal",
 *   "Interest on cash", ...), Time, ISIN, Ticker, Name, ID, No. of shares, Price / share,
 *   Currency (Price / share), Exchange rate, Total, Currency (Total), Withholding tax,
 *   Currency (Withholding tax), Stamp duty reserve tax, Currency conversion fee, French
 *   transaction tax, Finra fee (each with a "Currency (...)" companion column).
 * - Trades use the instrument currency and Ticker (UK tickers come without ".L"). Prices quoted in
 *   GBX/GBp are converted to GBP.
 * - Fees quoted in a different currency than the trade are converted with the row's "Exchange
 *   rate", assumed to be instrument-currency units per account-currency unit.
 * - Dividends are booked in the account currency (Total) with Total + Withholding tax as gross.
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
} from '../common';

const isHeader = (k: string[]) =>
  k.includes('action') &&
  k.includes('time') &&
  k.includes('ticker') &&
  k.includes('noofshares') &&
  k.includes('priceshare');

const FEE_COLUMNS = [
  'stampdutyreservetax',
  'currencyconversionfee',
  'frenchtransactiontax',
  'finrafee',
  'transactionfee',
  'stampduty',
];

export const trading212: BrokerMapper = {
  detect(rows) {
    return splitTables(rows, isHeader).length > 0;
  },
  parse(rows): MapperResult {
    const warnings: string[] = [];
    const transactions: TxIn[] = [];
    const ids = new IdMaker('t212');
    const tables = splitTables(rows, isHeader);
    if (tables.length === 0) warnings.push('Trading 212: header row not found.');
    let ignored = 0;
    let convertedFees = false;
    let pence = false;

    for (const t of tables) {
      const cAction = col(t, 'action');
      const cTime = col(t, 'time');
      const cTicker = col(t, 'ticker');
      const cId = col(t, 'id');
      const cQty = col(t, 'noofshares');
      const cPx = col(t, 'priceshare');
      const cPxCcy = col(t, 'currencypriceshare');
      const cRate = col(t, 'exchangerate');
      const cTotal = col(t, 'total');
      const cTotalCcy = col(t, 'currencytotal');
      const cWht = col(t, 'withholdingtax');
      const cWhtCcy = col(t, 'currencywithholdingtax');
      const feeCols = FEE_COLUMNS.map((k) => ({
        amt: col(t, k),
        ccy: col(t, `currency${k}`),
      })).filter((f) => f.amt >= 0);

      t.rows.forEach((row, i) => {
        const where = `Trading 212 row ${i + 1}`;
        const action = cell(row, cAction);
        const a = action.toLowerCase();
        if (a === '') return;
        const time = parseDate(cell(row, cTime));
        if (!time) {
          warnings.push(`${where}: skipped (unreadable time "${cell(row, cTime)}").`);
          return;
        }
        const symbol = cell(row, cTicker).toUpperCase();
        const total = parseNumber(cell(row, cTotal), '.');
        const totalCcy = ccyOf(cell(row, cTotalCcy));
        const rate = parseNumber(cell(row, cRate), '.');
        const brokerId = cell(row, cId);
        // The T212 ID is unique per row, so it is used bare; hashing uses the raw cells.
        const rawCells = [
          action,
          cell(row, cTime),
          cell(row, cTicker),
          cell(row, cQty),
          cell(row, cPx),
          cell(row, cPxCcy),
          cell(row, cTotal),
          cell(row, cTotalCcy),
          cell(row, cWht),
        ];
        const externalId = () => ids.exec(brokerId, rawCells);

        if (a.includes('buy') || a.includes('sell')) {
          const isBuy = a.includes('buy');
          let qty = parseNumber(cell(row, cQty), '.');
          let price = parseNumber(cell(row, cPx), '.');
          const rawCcy = cell(row, cPxCcy);
          let ccy = ccyOf(rawCcy);
          if (rawCcy === 'GBX' || rawCcy === 'GBp') {
            ccy = 'GBP';
            if (price !== null) price /= 100;
            pence = true;
          }
          if (!symbol || !ccy || qty === null || qty <= 0 || price === null) {
            warnings.push(
              `${where}: ${action} skipped (missing ticker, shares, price or currency).`,
            );
            return;
          }
          qty = Math.abs(qty);
          let fee = 0;
          for (const f of feeCols) {
            const amt = Math.abs(parseNumber(cell(row, f.amt), '.') ?? 0);
            if (amt === 0) continue;
            const feeCcy = ccyOf(cell(row, f.ccy)) ?? totalCcy;
            if (!feeCcy || feeCcy === ccy) {
              fee += amt;
            } else if (rate !== null && rate > 0) {
              fee += amt * rate;
              convertedFees = true;
            } else {
              warnings.push(
                `${where}: fee in ${feeCcy} could not be converted to ${ccy}; ignored.`,
              );
            }
          }
          transactions.push(
            blankTx(isBuy ? 'buy' : 'sell', time, ccy, {
              symbol,
              quantity: qty,
              price,
              fee,
              externalId: externalId(),
              note: cell(row, col(t, 'name')) || null,
            }),
          );
        } else if (a.startsWith('dividend')) {
          if (!symbol || total === null || !totalCcy) {
            warnings.push(`${where}: dividend skipped (missing ticker, total or currency).`);
            return;
          }
          let wht = Math.abs(parseNumber(cell(row, cWht), '.') ?? 0);
          const whtCcy = ccyOf(cell(row, cWhtCcy));
          if (wht > 0 && whtCcy && whtCcy !== totalCcy) {
            if (rate !== null && rate > 0) {
              wht /= rate;
              convertedFees = true;
            } else {
              warnings.push(
                `${where}: withholding tax in ${whtCcy} could not be converted to ${totalCcy}; ignored.`,
              );
              wht = 0;
            }
          }
          const gross = total + wht;
          if (gross <= 0) {
            warnings.push(`${where}: dividend skipped (non-positive amount).`);
            return;
          }
          transactions.push(
            blankTx('dividend', time, totalCcy, {
              symbol,
              amount: gross,
              fee: wht,
              externalId: externalId(),
              note: action,
            }),
          );
        } else if (a === 'deposit' || a === 'withdrawal' || a === 'card debit') {
          if (total === null || total === 0 || !totalCcy) {
            warnings.push(`${where}: ${action} skipped (missing total or currency).`);
            return;
          }
          const isIn = a === 'deposit';
          transactions.push(
            blankTx(isIn ? 'cashIn' : 'cashOut', time, totalCcy, {
              amount: Math.abs(total),
              externalId: externalId(),
              note: action,
            }),
          );
        } else if (a.startsWith('interest') || a === 'lending interest') {
          if (total === null || total <= 0 || !totalCcy) {
            warnings.push(`${where}: ${action} skipped (missing or non-positive total).`);
            return;
          }
          transactions.push(
            blankTx('interest', time, totalCcy, {
              amount: total,
              externalId: externalId(),
              note: action,
            }),
          );
        } else if (a.startsWith('currency conversion')) {
          ignored++;
        } else {
          warnings.push(`${where}: unsupported action "${action}" skipped.`);
        }
      });
    }
    if (ignored > 0) {
      warnings.push(
        `Trading 212: ignored ${ignored} currency conversion row(s) (cash is tracked per transaction currency, so per-currency cash balances will not reflect conversions).`,
      );
    }
    if (pence) {
      warnings.push(
        'Trading 212: prices quoted in GBX/GBp were converted to GBP. UK tickers likely need a ".L" suffix (e.g. RDSA.L) to get quotes, and Yahoo quotes LSE shares in GBp (pence), so check the valuation.',
      );
    }
    if (convertedFees) {
      warnings.push(
        'Trading 212: fees/taxes in a different currency were converted with the row exchange rate (assumed instrument-currency units per account-currency unit); please verify.',
      );
    }
    return { transactions, warnings };
  },
};
