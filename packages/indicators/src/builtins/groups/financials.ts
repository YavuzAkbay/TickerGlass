import type { AnyIndicatorDefinition } from '../../registry';
import { BOOK_VALUE } from '../financials/book-value';
import { CURRENT_RATIO } from '../financials/current-ratio';
import { DEBT_CASH } from '../financials/debt-cash';
import { DEBT_EQUITY } from '../financials/debt-equity';
import { EPS } from '../financials/eps';
import { FREE_CASH_FLOW } from '../financials/free-cash-flow';
import { GROSS_MARGIN } from '../financials/gross-margin';
import { NET_INCOME } from '../financials/net-income';
import { NET_INCOME_GROWTH } from '../financials/net-income-growth';
import { NET_MARGIN } from '../financials/net-margin';
import { OPERATING_CASH_FLOW } from '../financials/operating-cash-flow';
import { OPERATING_MARGIN } from '../financials/operating-margin';
import { PRICE_BOOK } from '../financials/pb';
import { PRICE_EARNINGS } from '../financials/pe';
import { PRICE_SALES } from '../financials/ps';
import { REVENUE } from '../financials/revenue';
import { REVENUE_GROWTH } from '../financials/revenue-growth';
import { ROE } from '../financials/roe';

/**
 * Financial statement built-ins (revenue, EPS, margins, growth, cash flows,
 * balance-sheet ratios, valuation): per-period values of the chart symbol's
 * quarterly/annual statements (see `IndicatorDefinition.usesFundamentals`), in
 * Indicators-dialog order. One file per indicator in `src/builtins/financials/`.
 */
export const FINANCIALS: readonly AnyIndicatorDefinition[] = [
  REVENUE,
  NET_INCOME,
  EPS,
  GROSS_MARGIN,
  OPERATING_MARGIN,
  NET_MARGIN,
  REVENUE_GROWTH,
  NET_INCOME_GROWTH,
  OPERATING_CASH_FLOW,
  FREE_CASH_FLOW,
  DEBT_CASH,
  DEBT_EQUITY,
  CURRENT_RATIO,
  ROE,
  BOOK_VALUE,
  PRICE_EARNINGS,
  PRICE_SALES,
  PRICE_BOOK,
];

export {
  BOOK_VALUE,
  CURRENT_RATIO,
  DEBT_CASH,
  DEBT_EQUITY,
  EPS,
  FREE_CASH_FLOW,
  GROSS_MARGIN,
  NET_INCOME,
  NET_INCOME_GROWTH,
  NET_MARGIN,
  OPERATING_CASH_FLOW,
  OPERATING_MARGIN,
  PRICE_BOOK,
  PRICE_EARNINGS,
  PRICE_SALES,
  REVENUE,
  REVENUE_GROWTH,
  ROE,
};
