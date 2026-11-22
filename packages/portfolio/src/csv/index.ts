import type { BrokerId, ParseBrokerOptions, ParsedImport } from '../types';
import type { BrokerMapper } from './common';
import { generic } from './brokers/generic';
import { degiro } from './brokers/degiro';
import { ibkr } from './brokers/ibkr';
import { schwab } from './brokers/schwab';
import { trading212 } from './brokers/trading212';
import { detectDelimiter, parseCsv } from './parse';

export {
  parseCsv,
  parseNumber,
  parseDate,
  detectDelimiter,
  inferDecimalSeparator,
  analyzeDecimal,
} from './parse';
export type { Delimiter, DateOptions, DecimalAnalysis } from './parse';
export { fnv1a, hash64 } from './common';

const MAPPERS: Record<BrokerId, BrokerMapper> = { ibkr, schwab, degiro, trading212, generic };
/** Most specific first; generic is the catch-all. */
const DETECT_ORDER: BrokerId[] = ['ibkr', 'schwab', 'degiro', 'trading212', 'generic'];

function tokenize(csvText: string): string[][] {
  return parseCsv(csvText, detectDelimiter(csvText));
}

/** Inspect the header rows of a CSV and name the broker format, or null when unrecognised. */
export function detectBroker(csvText: string): BrokerId | null {
  const rows = tokenize(csvText);
  for (const id of DETECT_ORDER) if (MAPPERS[id].detect(rows)) return id;
  return null;
}

/** Map a broker CSV to importable transactions. Never throws; problems become warnings. */
export function parseBrokerCsv(
  csvText: string,
  broker: BrokerId | 'auto',
  opts?: ParseBrokerOptions,
): ParsedImport {
  const rows = tokenize(csvText);
  let id: BrokerId;
  if (broker === 'auto') {
    const found = DETECT_ORDER.find((b) => MAPPERS[b].detect(rows));
    if (!found) {
      return {
        broker: 'generic',
        transactions: [],
        warnings: ['Could not detect the broker format: no recognisable header row.'],
      };
    }
    id = found;
  } else {
    id = broker;
  }
  const result = MAPPERS[id].parse(rows, opts);
  const parsed: ParsedImport = {
    broker: id,
    transactions: result.transactions,
    warnings: result.warnings,
  };
  if (result.assumptions && Object.keys(result.assumptions).length > 0) {
    parsed.assumptions = result.assumptions;
  }
  return parsed;
}
