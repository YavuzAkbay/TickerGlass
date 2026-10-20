import type { AnyIndicatorDefinition } from '../../registry';
import { ACCDIST } from '../accdist';
import { CHAIKIN_OSC } from '../chaikin-osc';
import { CMF } from '../cmf';
import { EOM } from '../eom';
import { KLINGER } from '../klinger';
import { NET_VOLUME } from '../net-volume';
import { PVT } from '../pvt';
import { TOD_RELATIVE_VOLUME } from '../tod-relative-volume';
import { VOLUME_OSC } from '../volume-osc';

/**
 * Volume built-ins (Phase 12, batch B5), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const VOLUME_GROUP: readonly AnyIndicatorDefinition[] = [
  ACCDIST,
  CHAIKIN_OSC,
  CMF,
  EOM,
  KLINGER,
  NET_VOLUME,
  PVT,
  TOD_RELATIVE_VOLUME,
  VOLUME_OSC,
];

export {
  ACCDIST,
  CHAIKIN_OSC,
  CMF,
  EOM,
  KLINGER,
  NET_VOLUME,
  PVT,
  TOD_RELATIVE_VOLUME,
  VOLUME_OSC,
};
