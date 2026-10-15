import type { AnyIndicatorDefinition } from '../../registry';

/**
 * Built-ins on external symbols, e.g. Correlation (Phase 12, batch B7), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const EXTERNAL: readonly AnyIndicatorDefinition[] = [];
