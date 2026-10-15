import type { AnyIndicatorDefinition } from '../../registry';

/**
 * Trend and moving-average built-ins (Phase 12, batch B2), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const TREND_MA: readonly AnyIndicatorDefinition[] = [];
