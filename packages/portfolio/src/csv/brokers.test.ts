import { describe, expect, it } from 'vitest';
import { detectBroker, parseBrokerCsv } from './index';
import { hash64 } from './common';
import { computeLedger } from '../ledger';
import type { Tx, TxIn } from '../types';

const toTx = (ins: TxIn[]): Tx[] => ins.map((t, i) => ({ ...t, id: `i${i}` }));

// ---------------------------------------------------------------------------------------------
// Fixtures: small and realistic, but written from memory of public docs (see mapper headers).
// ---------------------------------------------------------------------------------------------

const IBKR = `"ClientAccountID","CurrencyPrimary","AssetClass","Symbol","DateTime","Quantity","TradePrice","IBCommission","Buy/Sell","TradeID"
"U123","USD","STK","AAPL","20240115;093000","10","185.5","-1","BUY","1001"
"U123","USD","STK","AAPL","20240220;101500","-4","190.25","-1.02","SELL","1002"
"U123","USD","OPT","AAPL  240315C00190000","20240221;101500","1","3.2","-0.65","BUY","1003"
"ClientAccountID","CurrencyPrimary","Type","Date/Time","Symbol","Amount","Description","TransactionID"
"U123","USD","Deposits/Withdrawals","20240110;000000","","5000","Wire in","9001"
"U123","USD","Dividends","20240215;000000","AAPL","2.4","AAPL cash dividend","9002"
"U123","USD","Withholding Tax","20240215;000000","AAPL","-0.36","AAPL tax","9003"
"U123","USD","Broker Interest Received","20240301;000000","","1.23","USD interest","9004"
"U123","USD","Other Fees","20240302;000000","","-10","Market data","9005"
"U123","USD","Mystery Type","20240303;000000","","-1","?","9006"
`;

const IBKR_PREFIXED = `"BOF","U123","Trades","Flex","1","20240101","20240301","AccountActivity"
"BOA","U123"
"HEADER","CurrencyPrimary","Symbol","TradeDate","TradeTime","Quantity","TradePrice","IBCommission","TradeID","LevelOfDetail"
"DATA","EUR","SAP","20240301","101500","-3","150.5","-2","7001","EXECUTION"
"DATA","EUR","SAP","20240301","101500","-3","150.5","-2","7001","ORDER"
"EOA","U123"
"EOF","1"
`;

const SCHWAB = `"Transactions  for account XXXX-1234 as of 02/01/2024 10:00:00 ET","","","","","","",""
"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"01/16/2024","Qualified Dividend","AAPL","APPLE INC","","","","$12.00"
"01/16/2024","NRA Tax Adj","AAPL","APPLE INC","","","","-$1.80"
"01/15/2024 as of 01/12/2024","Buy","MSFT","MICROSOFT CORP","5","$400.00","$0.65","-$2,000.65"
"01/10/2024","Sell","AAPL","APPLE INC","10","$185.50","$0.04","$1,854.96"
"01/08/2024","Reinvest Dividend","VTI","VANGUARD TOTAL","","","","$3.00"
"01/08/2024","Reinvest Shares","VTI","VANGUARD TOTAL","0.0125","$240.00","","-$3.00"
"01/05/2024","Stock Split","AAPL","APPLE INC 2 FOR 1","10","","",""
"01/03/2024","Buy","AAPL","APPLE INC","10","$150.00","","-$1,500.00"
"01/02/2024","MoneyLink Transfer","","Tfr","","","","$5,000.00"
"01/02/2024","Bank Interest","","SCHWAB1 INT","","","","$0.50"
"01/02/2024","ADR Mgmt Fee","NVO","NOVO","","","","-$0.10"
"01/02/2024","Spin-off","XYZ","???","","","",""
"Transactions Total","","","","","","","$1,234.00"
`;

const DEGIRO_TX = `Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,Transaction and/or third party fees EUR,Total EUR,Order ID
15-01-2024,09:30,APPLE INC,US0378331005,NDQ,XNAS,10,"185,50",USD,"-1855,00",USD,"-1709,70","1,0850","-0,50","-1710,20",abc-123
20-02-2024,15:45,ASML HOLDING,NL0010273215,EAM,XAMS,-2,"850,00",EUR,"1700,00",EUR,"1700,00",,"-1,00","1699,00",def-456
`;

const DEGIRO_ACCOUNT = `Date,Time,Value date,Product,ISIN,Description,FX,Change,,Balance,,Order Id
16-02-2024,07:00,15-02-2024,APPLE INC,US0378331005,Dividend,,"0,96",USD,"0,96",USD,
16-02-2024,07:00,15-02-2024,APPLE INC,US0378331005,Dividend Tax,,"-0,14",USD,"0,82",USD,
10-01-2024,12:00,10-01-2024,,,iDEAL Deposit,,"2000,00",EUR,"2000,00",EUR,
09-01-2024,12:00,09-01-2024,,,Reservation iDEAL / Sofort Deposit,,"-2000,00",EUR,"0,00",EUR,
15-01-2024,09:30,15-01-2024,APPLE INC,US0378331005,"Buy 10 @ 185,5 USD",,"-1855,00",USD,"0,00",USD,abc-123
`;

const T212 = `Action,Time,ISIN,Ticker,Name,Notes,ID,No. of shares,Price / share,Currency (Price / share),Exchange rate,Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),Currency conversion fee,Currency (Currency conversion fee)
Deposit,2024-01-10 08:00:00,,,,Bank Transfer,dep1,,,,,,,1000.00,EUR,,,,
Market buy,2024-01-15 09:30:12,US0378331005,AAPL,Apple,,EOF123,2,185.50,USD,1.0850,,,-341.97,EUR,,,0.51,EUR
Currency conversion,2024-01-16 10:00:00,,,,,CC1,,,,,,,-100.00,EUR,,,,
Market buy,2024-01-17 08:05:00,GB00B03MLX29,RDSA,Shell,,EOF125,10,2500,GBX,1.17,,,-295.00,EUR,,,,
Dividend (Ordinary),2024-02-15 10:00:00,US0378331005,AAPL,Apple,,DIV1,2,0.24,USD,1.0800,,,0.41,EUR,0.07,EUR,,
Limit sell,2024-02-20 15:00:00,US0378331005,AAPL,Apple,,EOF124,1,190.00,USD,1.0800,0.5,EUR,175.90,EUR,,,0.26,EUR
Interest on cash,2024-03-01 00:00:00,,,,,INT1,,,,,,,0.55,EUR,,,,
Withdrawal,2024-03-02 00:00:00,,,,,WD1,,,,,,,-50.00,EUR,,,,
Cashback,2024-03-03 00:00:00,,,,,CB1,,,,,,,1.00,EUR,,,,
`;

const GENERIC = `Date,Type,Symbol,Quantity,Price,Fee,Amount,Currency,ID
2024-01-02,Deposit,,,,,5000,USD,d1
2024-01-03,Buy,aapl,10,150.00,1.00,,USD,
2024-01-10,Dividend,AAPL,,,0.5,12,USD,
2024-02-01,Split,AAPL,2:1,,,,USD,
2024-03-01,Sell,AAPL,5,170,1,,USD,
2024-03-02,Interest,,,,,1.50,USD,
2024-03-03,Withdrawal,,,,,100,USD,
2024-03-04,Mystery,,,,,1,USD,
`;

const GENERIC_EU = `Datum;Action;Ticker;Qty;Price;Commission;Total;Ccy
15.03.2024;Buy;MSFT;2;"1.234,50";"0,99";;EUR
16.03.2024;Sell;MSFT;1;"1.300,00";"0,99";;EUR
`;

describe('detectBroker', () => {
  it.each([
    ['ibkr', IBKR],
    ['ibkr', IBKR_PREFIXED],
    ['schwab', SCHWAB],
    ['degiro', DEGIRO_TX],
    ['degiro', DEGIRO_ACCOUNT],
    ['trading212', T212],
    ['generic', GENERIC],
    ['generic', GENERIC_EU],
  ] as const)('%s', (id, text) => {
    expect(detectBroker(text)).toBe(id);
  });

  it('handles BOM, CRLF and unrecognised input', () => {
    expect(detectBroker('﻿' + SCHWAB.replace(/\n/g, '\r\n'))).toBe('schwab');
    expect(detectBroker('')).toBeNull();
    expect(detectBroker('foo,bar\n1,2')).toBeNull();
  });

  it('auto reports a warning instead of throwing when nothing matches', () => {
    const r = parseBrokerCsv('foo,bar\n1,2', 'auto');
    expect(r.transactions).toEqual([]);
    expect(r.warnings[0]).toMatch(/Could not detect/);
  });
});

describe('ibkr', () => {
  const r = parseBrokerCsv(IBKR, 'auto');

  it('maps trades and cash transactions', () => {
    expect(r.broker).toBe('ibkr');
    expect(r.transactions.map((t) => t.kind)).toEqual([
      'buy',
      'sell',
      'cashIn',
      'dividend',
      'fee',
      'interest',
      'fee',
    ]);
    expect(r.transactions[0]).toMatchObject({
      kind: 'buy',
      symbol: 'AAPL',
      quantity: 10,
      price: 185.5,
      fee: 1,
      currency: 'USD',
      time: '2024-01-15T09:30:00.000Z',
      externalId: 'ibkr:t:1001',
    });
    expect(r.transactions[1]).toMatchObject({ kind: 'sell', quantity: 4, fee: 1.02 });
  });

  it('keeps withholding tax as its own fee row and warns about skipped rows', () => {
    const div = r.transactions.find((t) => t.kind === 'dividend');
    expect(div).toMatchObject({
      symbol: 'AAPL',
      amount: 2.4,
      fee: 0,
      externalId: 'ibkr:c:9002',
    });
    expect(r.transactions.find((t) => t.note === 'Withholding tax')).toMatchObject({
      kind: 'fee',
      symbol: 'AAPL',
      amount: 0.36,
      externalId: 'ibkr:c:9003',
    });
    expect(r.transactions.find((t) => t.kind === 'cashIn')).toMatchObject({ amount: 5000 });
    expect(r.transactions.find((t) => t.kind === 'fee' && t.symbol === null)).toMatchObject({
      amount: 10,
    });
    expect(r.warnings.some((w) => /non-stock/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Mystery Type/.test(w))).toBe(true);
  });

  it('feeds the ledger', () => {
    const l = computeLedger(toTx(r.transactions), { costMethod: 'fifo' });
    expect(l.issues).toEqual([]);
    expect(l.positions[0]).toMatchObject({ symbol: 'AAPL', quantity: 6 });
    expect(l.cash.USD).toBeCloseTo(5000 - 1856 + (761 - 1.02) + 2.4 - 0.36 + 1.23 - 10, 6);
  });

  it('reads HEADER/DATA records, TradeDate+TradeTime and skips non-execution levels', () => {
    const p = parseBrokerCsv(IBKR_PREFIXED, 'ibkr');
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]).toMatchObject({
      kind: 'sell',
      symbol: 'SAP',
      currency: 'EUR',
      quantity: 3,
      time: '2024-03-01T10:15:00.000Z',
      externalId: 'ibkr:t:7001',
    });
  });

  it('hashes ids deterministically when TradeID is absent', () => {
    const csv =
      'Symbol,Currency,DateTime,Quantity,TradePrice,IBCommission\nAAPL,USD,20240115;093000,1,10,-1\nAAPL,USD,20240115;093000,1,10,-1\n';
    const a = parseBrokerCsv(csv, 'ibkr').transactions.map((t) => t.externalId);
    const b = parseBrokerCsv(csv, 'ibkr').transactions.map((t) => t.externalId);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^ibkr:t:h[0-9a-f]{16}$/);
    expect(a[1]).toBe(`${a[0]}#2`);
  });
});

describe('schwab', () => {
  const r = parseBrokerCsv(SCHWAB, 'schwab');
  const kinds = r.transactions.map((t) => t.kind);

  it('sorts oldest-first and maps actions', () => {
    // Newest-first file is restored to chronological order (same-day rows end up reversed).
    expect(kinds).toEqual([
      'fee',
      'interest',
      'cashIn',
      'buy',
      'split',
      'buy',
      'dividend',
      'sell',
      'buy',
      'fee',
      'dividend',
    ]);
  });

  it('uses the as-of date, strips $ signs and reads the split ratio from the description', () => {
    const msft = r.transactions.find((t) => t.symbol === 'MSFT');
    expect(msft).toMatchObject({
      quantity: 5,
      price: 400,
      fee: 0.65,
      time: '2024-01-12T12:00:00.000Z',
      currency: 'USD',
    });
    expect(r.transactions.find((t) => t.kind === 'split')).toMatchObject({
      symbol: 'AAPL',
      quantity: 2,
    });
    expect(r.transactions.find((t) => t.kind === 'cashIn')).toMatchObject({ amount: 5000 });
  });

  it('books NRA tax as its own fee row and reports unsupported rows', () => {
    const div = r.transactions.find((t) => t.kind === 'dividend' && t.symbol === 'AAPL');
    expect(div).toMatchObject({ amount: 12, fee: 0 });
    expect(r.transactions.find((t) => t.note === 'Withholding tax')).toMatchObject({
      kind: 'fee',
      symbol: 'AAPL',
      amount: 1.8,
    });
    expect(r.warnings.some((w) => /Spin-off/.test(w))).toBe(true);
    expect(r.transactions.every((t) => t.externalId && t.externalId.startsWith('schwab:h'))).toBe(
      true,
    );
  });

  it('feeds the ledger without issues', () => {
    const l = computeLedger(toTx(r.transactions), { costMethod: 'fifo' });
    expect(l.issues).toEqual([]);
    const aapl = l.positions.find((p) => p.symbol === 'AAPL');
    expect(aapl?.quantity).toBe(10); // 10 -> split x2 = 20 -> sold 10
  });
});

describe('degiro', () => {
  it('maps Transactions.csv with comma decimals and converts the fee to the trade currency', () => {
    const r = parseBrokerCsv(DEGIRO_TX, 'auto');
    expect(r.broker).toBe('degiro');
    expect(r.transactions[0]).toMatchObject({
      kind: 'buy',
      symbol: 'US0378331005',
      quantity: 10,
      price: 185.5,
      currency: 'USD',
      time: '2024-01-15T09:30:00.000Z',
      externalId: expect.stringMatching(/^degiro:abc-123:[0-9a-f]{16}$/),
    });
    expect(r.transactions[0]?.fee).toBeCloseTo(0.5 * 1.085, 9);
    expect(r.transactions[1]).toMatchObject({ kind: 'sell', quantity: 2, currency: 'EUR', fee: 1 });
    expect(r.warnings.filter((w) => /ISIN/.test(w))).toHaveLength(1);
  });

  it('maps Account.csv dividends, tax, deposits and ignores the rest', () => {
    const r = parseBrokerCsv(DEGIRO_ACCOUNT, 'auto');
    expect(r.broker).toBe('degiro');
    expect(r.transactions.map((t) => t.kind)).toEqual(['dividend', 'fee', 'cashIn']);
    expect(r.transactions[0]).toMatchObject({
      symbol: 'US0378331005',
      amount: 0.96,
      fee: 0,
      currency: 'USD',
    });
    expect(r.transactions[1]).toMatchObject({
      symbol: 'US0378331005',
      amount: 0.14,
      currency: 'USD',
      note: 'Withholding tax',
    });
    expect(r.transactions[2]).toMatchObject({ amount: 2000, currency: 'EUR' });
    expect(r.warnings.some((w) => /ignored 2 row/.test(w))).toBe(true);
  });

  it('copes with semicolon files', () => {
    const semi = DEGIRO_TX.split('\n')
      .map((l) =>
        l.includes('"') ? l.replace(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ';') : l.replace(/,/g, ';'),
      )
      .join('\n');
    const r = parseBrokerCsv(semi, 'auto');
    expect(r.broker).toBe('degiro');
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]?.price).toBe(185.5);
  });
});

describe('trading212', () => {
  const r = parseBrokerCsv(T212, 'auto');

  it('maps trades with a converted fee and ids', () => {
    expect(r.broker).toBe('trading212');
    expect(r.transactions.map((t) => t.kind)).toEqual([
      'cashIn',
      'buy',
      'buy',
      'dividend',
      'sell',
      'interest',
      'cashOut',
    ]);
    const buy1 = r.transactions[1];
    expect(buy1).toMatchObject({
      symbol: 'AAPL',
      quantity: 2,
      price: 185.5,
      currency: 'USD',
      externalId: 't212:EOF123',
    });
    expect(buy1?.fee).toBeCloseTo(0.51 * 1.085, 9);
  });

  it('converts GBX prices to GBP', () => {
    expect(r.transactions[2]).toMatchObject({
      symbol: 'RDSA',
      currency: 'GBP',
      price: 25,
      quantity: 10,
    });
  });

  it('books dividends gross in the account currency', () => {
    expect(r.transactions[3]).toMatchObject({ symbol: 'AAPL', currency: 'EUR' });
    expect(r.transactions[3]?.amount).toBeCloseTo(0.48, 9);
    expect(r.transactions[3]?.fee).toBeCloseTo(0.07, 9);
  });

  it('warns about conversions and unsupported actions', () => {
    expect(r.warnings.some((w) => /currency conversion/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Cashback/.test(w))).toBe(true);
  });
});

describe('generic', () => {
  it('maps type keywords, splits "2:1" and defaults', () => {
    const r = parseBrokerCsv(GENERIC, 'auto');
    expect(r.broker).toBe('generic');
    expect(r.transactions.map((t) => t.kind)).toEqual([
      'cashIn',
      'buy',
      'dividend',
      'split',
      'sell',
      'interest',
      'cashOut',
    ]);
    expect(r.transactions[0]).toMatchObject({
      amount: 5000,
      externalId: 'csv:d1',
      currency: 'USD',
    });
    expect(r.transactions[1]).toMatchObject({ symbol: 'AAPL', quantity: 10, price: 150, fee: 1 });
    expect(r.transactions[2]).toMatchObject({ amount: 12, fee: 0.5 });
    expect(r.transactions[3]).toMatchObject({ quantity: 2 });
    expect(r.warnings.some((w) => /Mystery/.test(w))).toBe(true);
  });

  it('reads European dates and numbers via aliases', () => {
    const r = parseBrokerCsv(GENERIC_EU, 'generic');
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({
      kind: 'buy',
      symbol: 'MSFT',
      quantity: 2,
      price: 1234.5,
      fee: 0.99,
      currency: 'EUR',
      time: '2024-03-15T12:00:00.000Z',
    });
  });

  it('defaults the currency with a warning and never throws on junk', () => {
    const r = parseBrokerCsv(
      'Date,Type,Amount\n2024-01-01,Deposit,10\nnot-a-date,Deposit,5\n',
      'generic',
    );
    expect(r.transactions).toHaveLength(1);
    expect(r.warnings.some((w) => /USD/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /unreadable date/.test(w))).toBe(true);
    expect(parseBrokerCsv('', 'generic').transactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Review regressions
// ---------------------------------------------------------------------------------------------

describe('hash64', () => {
  it('is 16 hex chars, deterministic and differs for different input', () => {
    expect(hash64('a')).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64('a')).toBe(hash64('a'));
    expect(hash64('a')).not.toBe(hash64('b'));
    expect(hash64('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('degiro order ids', () => {
  const H =
    'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,Transaction and/or third party fees EUR,Total EUR,Order ID\n';
  const f1 =
    '05-03-2024,10:00,ACME,US0000000001,NSY,XNYS,5,9.00,USD,-45.00,USD,-41,1.08,-1.00,-42,ord-1\n';
  const f2 =
    '06-03-2024,10:00,ACME,US0000000001,NSY,XNYS,5,10.00,USD,-50.00,USD,-46,1.08,-1.00,-47,ord-1\n';
  const ids = (csv: string) =>
    Object.fromEntries(
      parseBrokerCsv(csv, 'auto').transactions.map((t) => [t.time.slice(0, 10), t.externalId]),
    );

  it('two fills of one order get distinct ids that match across files, whatever the row order', () => {
    const a = ids(H + f1); // A only
    const b = ids(H + f2 + f1); // B then A
    const c = ids(H + f1 + f2); // A then B
    expect(a['2024-03-05']).toBeDefined();
    expect(b['2024-03-06']).not.toBe(b['2024-03-05']);
    expect(b['2024-03-05']).toBe(a['2024-03-05']);
    expect(c).toEqual(b);
  });

  it('identical fills in one file stay distinct (#n) and stable', () => {
    const r = parseBrokerCsv(H + f1 + f1, 'auto').transactions.map((t) => t.externalId);
    expect(r[1]).toBe(`${r[0]}#2`);
  });
});

describe('generic: raw-cell ids and format assumptions', () => {
  const head = 'Date,Type,Symbol,Quantity,Price,Currency\n';

  it('does not change a row id when another row flips the inferred date order', () => {
    const a = head + '03/04/2024,Buy,AAPL,10,100,USD\n';
    const b = a + '25/04/2024,Buy,MSFT,1,100,USD\n';
    const ra = parseBrokerCsv(a, 'auto');
    const rb = parseBrokerCsv(b, 'auto');
    expect(rb.transactions[0]?.externalId).toBe(ra.transactions[0]?.externalId);
  });

  it('warns and reports the assumption when no date disambiguates, and honours the override', () => {
    const csv = head + '03/04/2024,Buy,AAPL,10,100,USD\n';
    const r = parseBrokerCsv(csv, 'auto');
    expect(r.transactions[0]?.time).toBe('2024-03-04T12:00:00.000Z');
    expect(r.assumptions).toEqual({ dateOrder: 'mdy' });
    expect(r.warnings.some((w) => /assumed month\/day\/year/.test(w))).toBe(true);
    const o = parseBrokerCsv(csv, 'auto', { dateOrder: 'dmy' });
    expect(o.transactions[0]?.time).toBe('2024-04-03T12:00:00.000Z');
    expect(o.assumptions).toBeUndefined();
    expect(o.warnings.filter((w) => /ambiguous/.test(w))).toEqual([]);
  });

  it('warns when a minority of rows decides the date order', () => {
    const csv =
      head +
      '03/04/2024,Buy,AAPL,10,100,USD\n05/04/2024,Buy,AAPL,10,100,USD\n06/04/2024,Buy,AAPL,10,100,USD\n25/04/2024,Buy,MSFT,1,100,USD\n';
    const r = parseBrokerCsv(csv, 'auto');
    expect(r.assumptions).toEqual({ dateOrder: 'dmy' });
    expect(r.warnings.some((w) => /only 1 of 4/.test(w))).toBe(true);
  });

  it('stays quiet when most rows prove the order', () => {
    const csv =
      head +
      '25/04/2024,Buy,AAPL,10,100,USD\n26/04/2024,Buy,AAPL,10,100,USD\n03/04/2024,Buy,AAPL,1,100,USD\n';
    const r = parseBrokerCsv(csv, 'auto');
    expect(r.assumptions).toBeUndefined();
    expect(r.transactions[2]?.time).toBe('2024-04-03T12:00:00.000Z');
  });

  it('flags an ambiguous "1,500" and lets the caller pick the decimal mark', () => {
    const csv = head + '2024-01-02,Buy,AAPL,"1,500",100,USD\n';
    const r = parseBrokerCsv(csv, 'auto');
    expect(r.transactions[0]?.quantity).toBe(1500);
    expect(r.assumptions).toEqual({ decimal: '.' });
    const o = parseBrokerCsv(csv, 'auto', { decimal: ',' });
    expect(o.transactions[0]?.quantity).toBe(1.5);
    expect(o.assumptions).toBeUndefined();
    // Ids come from raw text: same id whichever way the number is read.
    expect(o.transactions[0]?.externalId).toBe(r.transactions[0]?.externalId);
  });

  it('does not flag a clear number format', () => {
    const r = parseBrokerCsv(
      head + '2024-01-02,Buy,AAPL,"1,500",100.25,USD\n2024-01-03,Buy,AAPL,3,99.5,USD\n',
      'auto',
    );
    expect(r.assumptions).toBeUndefined();
    expect(r.transactions[0]?.quantity).toBe(1500);
  });

  it('uses a bare id for id/transactionid columns but hashes order-level ids', () => {
    const a = parseBrokerCsv(
      'Date,Type,Symbol,Quantity,Price,Currency,Order ID\n2024-01-02,Buy,A,1,10,USD,o1\n2024-01-03,Buy,A,2,11,USD,o1\n',
      'generic',
    ).transactions.map((t) => t.externalId);
    expect(a[0]).toMatch(/^csv:o1:[0-9a-f]{16}$/);
    expect(a[1]).toMatch(/^csv:o1:[0-9a-f]{16}$/);
    expect(a[0]).not.toBe(a[1]);
  });

  it('applies the same decimal override to DEGIRO', () => {
    const csv = [
      'Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,Transaction and/or third party fees EUR,Total EUR,Order ID',
      '05-03-2024,10:00,ACME,US0000000001,NSY,XNYS,1,"1,500",EUR,0,EUR,0,,0,0,o1',
    ].join('\n');
    const r = parseBrokerCsv(csv, 'degiro');
    expect(r.assumptions).toEqual({ decimal: '.' });
    expect(r.transactions[0]?.price).toBe(1500);
    expect(parseBrokerCsv(csv, 'degiro', { decimal: ',' }).transactions[0]?.price).toBe(1.5);
  });
});

describe('schwab splits', () => {
  const head = '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\n';
  const split = (desc: string) =>
    parseBrokerCsv(
      head +
        `"06/10/2024","Stock Split","NVDA","${desc}","990","","",""\n"05/01/2024","Buy","NVDA","NVIDIA","10","$800","","-$8000"\n`,
      'schwab',
    );

  it.each([
    ['NVIDIA 10 FOR 1 FORWARD SPLIT', 10],
    ['NVIDIA 10:1', 10],
    ['NVIDIA 1-for-10 REVERSE', 0.1],
    ['NVIDIA 3 for 2', 1.5],
  ])('reads the ratio from "%s"', (desc, ratio) => {
    const r = split(desc);
    expect(r.transactions.find((t) => t.kind === 'split')?.quantity).toBeCloseTo(ratio, 9);
  });

  it('emits no split row without a stated ratio and says to add it manually', () => {
    const r = split('NVIDIA');
    expect(r.transactions.map((t) => t.kind)).toEqual(['buy']);
    const w = r.warnings.find((x) => /NVDA/.test(x) && /2024-06-10/.test(x));
    expect(w).toMatch(/add the split manually/i);
  });
});

describe('trading212 GBX', () => {
  it('warns about the .L suffix and Yahoo pence quoting', () => {
    const r = parseBrokerCsv(T212, 'auto');
    expect(r.warnings.some((w) => /\.L/.test(w) && /GBp/.test(w))).toBe(true);
    const none = parseBrokerCsv(T212.replace(/GBX/g, 'GBP'), 'auto');
    expect(none.warnings.some((w) => /\.L/.test(w))).toBe(false);
  });
});
