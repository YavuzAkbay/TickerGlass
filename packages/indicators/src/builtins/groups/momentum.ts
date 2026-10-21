import type { AnyIndicatorDefinition } from '../../registry';
import { ACCELERATOR_OSC } from '../accelerator-osc';
import { AWESOME_OSC } from '../awesome-osc';
import { COPPOCK } from '../coppock';
import { DPO } from '../dpo';
import { FISHER } from '../fisher';
import { KST } from '../kst';
import { MOMENTUM_INDICATOR } from '../momentum';
import { PRICE_OSCILLATOR } from '../price-oscillator';
import { ROC } from '../roc';
import { SMI_ERGODIC } from '../smi-ergodic';
import { SMI_ERGODIC_OSC } from '../smi-ergodic-osc';
import { TRIX } from '../trix';
import { TSI } from '../tsi';
import { ULTIMATE_OSC } from '../ultimate-osc';

/**
 * Momentum oscillators (Phase 12, batch B3), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const MOMENTUM: readonly AnyIndicatorDefinition[] = [
  MOMENTUM_INDICATOR,
  ROC,
  TRIX,
  TSI,
  ULTIMATE_OSC,
  AWESOME_OSC,
  ACCELERATOR_OSC,
  COPPOCK,
  KST,
  DPO,
  PRICE_OSCILLATOR,
  SMI_ERGODIC,
  SMI_ERGODIC_OSC,
  FISHER,
];

export {
  ACCELERATOR_OSC,
  AWESOME_OSC,
  COPPOCK,
  DPO,
  FISHER,
  KST,
  MOMENTUM_INDICATOR,
  PRICE_OSCILLATOR,
  ROC,
  SMI_ERGODIC,
  SMI_ERGODIC_OSC,
  TRIX,
  TSI,
  ULTIMATE_OSC,
};
