import type { AnyIndicatorDefinition } from '../../registry';
import { AROON } from '../aroon';
import { BB_PERCENT_B } from '../bb-percent-b';
import { BB_WIDTH } from '../bb-width';
import { BOP } from '../bop';
import { CHAIKIN_VOLATILITY } from '../chaikin-volatility';
import { CHOP } from '../chop';
import { CMO } from '../cmo';
import { CONNORS_RSI } from '../connors-rsi';
import { EFI } from '../efi';
import { HV } from '../hv';
import { MASS_INDEX } from '../mass-index';
import { RVI } from '../rvi';
import { RVOL_INDEX } from '../rvol-index';
import { STDEV } from '../stdev';
import { ULCER } from '../ulcer';
import { VORTEX } from '../vortex';

/**
 * Volatility built-ins and the second momentum set (Phase 12, batch B4), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const VOLATILITY: readonly AnyIndicatorDefinition[] = [
  // momentum
  CONNORS_RSI,
  CMO,
  AROON,
  VORTEX,
  CHOP,
  RVI,
  EFI,
  BOP,
  // volatility
  HV,
  CHAIKIN_VOLATILITY,
  ULCER,
  BB_PERCENT_B,
  BB_WIDTH,
  STDEV,
  MASS_INDEX,
  RVOL_INDEX,
];

export {
  AROON,
  BB_PERCENT_B,
  BB_WIDTH,
  BOP,
  CHAIKIN_VOLATILITY,
  CHOP,
  CMO,
  CONNORS_RSI,
  EFI,
  HV,
  MASS_INDEX,
  RVI,
  RVOL_INDEX,
  STDEV,
  ULCER,
  VORTEX,
};
