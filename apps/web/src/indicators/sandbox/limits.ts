/** Most user-script instances one chart may run (docs/indicators.md §5a). */
export const MAX_SCRIPT_INSTANCES_PER_CHART = 8;

/** Legend error of a user-script instance over the per-chart cap. */
export const SCRIPT_INSTANCE_CAP_MESSAGE = `At most ${MAX_SCRIPT_INSTANCES_PER_CHART} scripts can run on one chart`;
