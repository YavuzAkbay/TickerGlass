import type { AnyIndicatorDefinition } from '../../registry';

/**
 * Momentum oscillators (Phase 12, batch B3), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const MOMENTUM: readonly AnyIndicatorDefinition[] = [];
