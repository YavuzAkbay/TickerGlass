/**
 * Charles Schwab: Transactions export (Account > History > Export).
 *
 * NOTE: the column sets below are best-effort, written from public knowledge of the export. They
 * must be verified against real exports before being relied on.
 *
 * Columns: Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount.
 * - Values carry "$" signs; negatives may be "-$1.00". A title line precedes the header and a
 *   "Transactions Total" line may follow the data.
 * - Dates are "MM/DD/YYYY" or "MM/DD/YYYY as of MM/DD/YYYY"; the "as of" date (the effective
 *   trade date) wins when present. Times are not exported (rows get 12:00 UTC).
 * - The file is newest-first; rows are re-ordered oldest-first before splits are resolved.
 * - "Stock Split" rows give the shares added, not the ratio. The ratio is read from the
 *   Description when it states one ("10 FOR 1", "10:1", "1-for-10"); otherwise NO split row is
 *   emitted and a warning asks the user to add the split manually (a ratio derived from this
 *   file's own holdings is wrong whenever the export starts after the position was opened).
 * - Ids are hashes of the raw cells (the export has no row id).
 * - All amounts are USD.
 */
import type { TxIn } from '../../types';
import { parseDate, parseNumber } from '../parse';
import {
  blankTx,
  cell,
  col,
  IdMaker,
  splitTables,
  type BrokerMapper,
  type MapperResult,
  withholdingTx,
} from '../common';

const isHeader = (k: string[]) =>
  k.includes('date') &&
  k.includes('action') &&
  k.includes('symbol') &&
  k.includes('amount') &&
  (k.includes('feescomm') || k.includes('feescommissions'));

function schwabDate(raw: string): string | null {
  const m = /(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+as of\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i.exec(raw);
  if (!m) return null;
  return parseDate(m[2] ?? m[1], { order: 'mdy' });
}

interface Draft {
  index: number;
  time: string;
  ms: number;
  action: string;
  actionRaw: string;
  dateRaw: string;
  symbol: string;
  qty: number | null;
  price: number | null;
  fee: number;
  amount: number | null;
  desc: string;
  /** Raw trimmed cells used for the id hash. */
  raw: string[];
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const RE_RATIO = new RegExp(`${NUM}\\s*(?:-?\\s*for\\s*-?|:)\\s*${NUM}`, 'i');

/** New shares per old share from a description such as "10 FOR 1", "10:1" or "1-for-10"; else null. */
export function splitRatioFromDescription(desc: string): number | null {
  const m = RE_RATIO.exec(desc);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 ? a / b : null;
}

export const schwab: BrokerMapper = {
  detect(rows) {
    return splitTables(rows, isHeader).length > 0;
  },
  parse(rows): MapperResult {
    const warnings: string[] = [];
    const tables = splitTables(rows, isHeader);
    const first = tables[0];
    if (!first) return { transactions: [], warnings: ['Schwab: header row not found.'] };
    const t = first;
    const cDate = col(t, 'date');
    const cAction = col(t, 'action');
    const cSym = col(t, 'symbol');
    const cDesc = col(t, 'description');
    const cQty = col(t, 'quantity');
    const cPx = col(t, 'price');
    const cFee = col(t, 'feescomm', 'feescommissions');
    const cAmt = col(t, 'amount');

    const drafts: Draft[] = [];
    t.rows.forEach((row, i) => {
      const dateRaw = cell(row, cDate);
      const actionRaw = cell(row, cAction);
      if (dateRaw === '' && actionRaw === '') return;
      if (/total/i.test(dateRaw)) return;
      const time = schwabDate(dateRaw);
      if (!time || actionRaw === '') {
        warnings.push(`Schwab row ${i + 1}: skipped (unreadable date "${dateRaw}" or no action).`);
        return;
      }
      drafts.push({
        index: i,
        time,
        ms: Date.parse(time),
        action: actionRaw.toLowerCase(),
        actionRaw,
        dateRaw,
        symbol: cell(row, cSym).toUpperCase(),
        qty: parseNumber(cell(row, cQty), '.'),
        price: parseNumber(cell(row, cPx), '.'),
        fee: Math.abs(parseNumber(cell(row, cFee), '.') ?? 0),
        amount: parseNumber(cell(row, cAmt), '.'),
        desc: cell(row, cDesc),
        raw: [
          dateRaw,
          actionRaw,
          cell(row, cSym),
          cell(row, cQty),
          cell(row, cPx),
          cell(row, cFee),
          cell(row, cAmt),
        ],
      });
    });

    // Newest-first export: restore chronological order, keeping same-day file order reversed back.
    const firstD = drafts[0];
    const lastD = drafts[drafts.length - 1];
    if (firstD && lastD && firstD.ms > lastD.ms) drafts.reverse();
    drafts.sort((a, b) => a.ms - b.ms);

    const ids = new IdMaker('schwab');
    const transactions: TxIn[] = [];
    const CCY = 'USD';

    for (const d of drafts) {
      const where = `Schwab ${d.dateRaw} ${d.actionRaw} ${d.symbol}`.trim();
      const externalId = ids.exec(null, d.raw);
      const note = d.desc || null;
      const a = d.action;

      if (a === 'buy' || a === 'sell' || a === 'reinvest shares') {
        const isBuy = a !== 'sell';
        let price = d.price;
        const qty = d.qty === null ? null : Math.abs(d.qty);
        if (!d.symbol || qty === null || qty === 0) {
          warnings.push(`${where}: skipped (missing symbol or quantity).`);
          continue;
        }
        if (price === null && d.amount !== null) {
          const gross = isBuy ? Math.abs(d.amount) - d.fee : Math.abs(d.amount) + d.fee;
          price = gross / qty;
        }
        if (price === null) {
          warnings.push(`${where}: skipped (missing price).`);
          continue;
        }
        transactions.push(
          blankTx(isBuy ? 'buy' : 'sell', d.time, CCY, {
            symbol: d.symbol,
            quantity: qty,
            price,
            fee: d.fee,
            externalId,
            note,
          }),
        );
      } else if (a.includes('div') && !a.includes('adj')) {
        if (!d.symbol || d.amount === null || d.amount <= 0) {
          warnings.push(`${where}: dividend skipped (missing symbol or non-positive amount).`);
          continue;
        }
        transactions.push(
          blankTx('dividend', d.time, CCY, {
            symbol: d.symbol,
            amount: d.amount,
            externalId,
            note,
          }),
        );
      } else if (a === 'nra tax adj' || a === 'nra withholding' || a === 'foreign tax paid') {
        if (!d.symbol || d.amount === null || d.amount === 0) {
          warnings.push(`${where}: tax line skipped (missing symbol or amount).`);
          continue;
        }
        transactions.push(
          withholdingTx({
            symbol: d.symbol,
            currency: CCY,
            time: d.time,
            amount: d.amount,
            externalId,
            note: 'Withholding tax',
          }),
        );
      } else if (a === 'stock split') {
        const ratio = splitRatioFromDescription(d.desc);
        if (!d.symbol || ratio === null) {
          warnings.push(
            `${where}: stock split has no ratio in its description (${d.qty ?? '?'} shares added); no split row was created. Add the split manually (${d.symbol || 'symbol'}, ${d.time.slice(0, 10)}).`,
          );
          continue;
        }
        transactions.push(
          blankTx('split', d.time, CCY, { symbol: d.symbol, quantity: ratio, externalId, note }),
        );
      } else if (
        a.startsWith('moneylink') ||
        a.startsWith('wire') ||
        a === 'journal' ||
        a === 'funds received' ||
        a.startsWith('electronic funds')
      ) {
        if (d.amount === null || d.amount === 0) {
          warnings.push(`${where}: transfer skipped (no amount).`);
          continue;
        }
        transactions.push(
          blankTx(d.amount > 0 ? 'cashIn' : 'cashOut', d.time, CCY, {
            amount: Math.abs(d.amount),
            externalId,
            note,
          }),
        );
      } else if (a === 'bank interest' || a === 'credit interest') {
        if (d.amount === null || d.amount <= 0) {
          warnings.push(`${where}: interest skipped (non-positive amount).`);
          continue;
        }
        transactions.push(blankTx('interest', d.time, CCY, { amount: d.amount, externalId, note }));
      } else if (a === 'margin interest' || a.includes('fee')) {
        if (d.amount === null || d.amount >= 0) {
          warnings.push(`${where}: fee skipped (expected a negative amount).`);
          continue;
        }
        transactions.push(
          blankTx('fee', d.time, CCY, {
            symbol: d.symbol || null,
            amount: -d.amount,
            externalId,
            note,
          }),
        );
      } else {
        warnings.push(`${where}: unsupported action "${d.actionRaw}" skipped.`);
      }
    }
    return { transactions, warnings };
  },
};
