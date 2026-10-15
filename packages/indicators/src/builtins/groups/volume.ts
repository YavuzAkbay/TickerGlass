import type { AnyIndicatorDefinition } from '../../registry';

/**
 * Volume built-ins (Phase 12, batch B5), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const VOLUME_GROUP: readonly AnyIndicatorDefinition[] = [];
