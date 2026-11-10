/**
 * Share payloads: a watchlist or a saved screen as a small versioned document
 * that moves between people and instances without a server-side link.
 *
 * - Wire document: `{v:1, type:'watchlist', name, items}` or `{v:1, type:'screen', name, spec}`.
 * - Link: `<origin><base>#tg-import=<payload>`. The payload sits in the URL fragment,
 *   which browsers never send to a server (no access logs, no proxy). `<payload>` is
 *   `z.<base64url(deflate-raw(json))>`, or `r.<base64url(json)>` where the browser has no
 *   CompressionStream.
 * - Everything that comes in (link or file) is untrusted: it is validated strictly and
 *   rebuilt field by field, so unknown fields (including `__proto__`) never survive and
 *   nothing is evaluated.
 */
import {
  FORMULA_FIELD_PREFIX,
  FORMULA_MAX_LENGTH,
  FORMULA_OPS,
  MAX_FORMULA_FIELDS,
  MAX_FORMULA_RULES,
  formulaSyntaxOk,
} from '../screener/rules/formula';
import { MAX_GROUPS } from '../screener/rules/rules';
import { MAX_SYMBOLS, RULE_OPS } from '../screener/server/spec';
import type {
  FormulaRule,
  Group,
  Rule,
  RuleOp,
  RuleValue,
  ScreenSpec,
  Universe,
} from '../screener/server/types';
import { SCREENER_CLASSES } from '../screener/universe/types';
import { MAX_SECTION_TITLE, MAX_WATCHLIST_ITEMS, SYMBOL_RE } from '../watchlist/model';
import type { WatchlistItem } from '../watchlist/types';

export const SHARE_VERSION = 1;
export const SHARE_HASH_PREFIX = '#tg-import=';
/** Longest link payload (encoded characters): beyond it the link is refused and a file is offered. */
export const MAX_LINK_PAYLOAD = 16 * 1024;
/** Longest document (bytes of JSON), also after inflating: a decompression bomb is cut off here. */
export const MAX_DOCUMENT_BYTES = 256 * 1024;
export const MAX_NAME = 200;

/** A symbol, or a section header. */
export type ShareItem = string | { section: string };

export interface WatchlistShare {
  v: 1;
  type: 'watchlist';
  name: string;
  items: ShareItem[];
}

export interface ScreenShare {
  v: 1;
  type: 'screen';
  name: string;
  spec: ScreenSpec;
}

export type SharePayload = WatchlistShare | ScreenShare;

export type ShareErrorCode =
  | 'too_large'
  | 'bad_encoding'
  | 'bad_json'
  | 'unsupported_version'
  | 'unsupported_type'
  | 'invalid';

/** Why a payload was refused. `detail` is for diagnostics, not for display. */
export class ShareError extends Error {
  constructor(
    readonly code: ShareErrorCode,
    readonly detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ShareError';
  }
}

const invalid = (detail: string): never => {
  throw new ShareError('invalid', detail);
};

// ------------------------------------------------------------ building

/** Stored list items as share items (section ids and collapsed state stay local). */
export function toShareItems(items: readonly WatchlistItem[]): ShareItem[] {
  return items.map((i) => (i.type === 'section' ? { section: i.title } : i.symbol));
}

/** Share items as list items (fresh section ids). */
export function fromShareItems(items: readonly ShareItem[]): WatchlistItem[] {
  return items.map((i): WatchlistItem =>
    typeof i === 'string'
      ? { type: 'symbol', symbol: i }
      : { type: 'section', id: crypto.randomUUID(), title: i.section, collapsed: false },
  );
}

export const symbolCount = (items: readonly ShareItem[]): number =>
  items.reduce((n, i) => n + (typeof i === 'string' ? 1 : 0), 0);

// ------------------------------------------------------------ validation

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Own property only: never an inherited one (`constructor`, `toString`, ...). */
const own = (o: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(o, key) ? o[key] : undefined;

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const LIST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_RULES = 50;
const MAX_COLUMNS = 100;
const MAX_STRINGS = 200;

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') return invalid(`${what} is not a string`);
  // Control characters become spaces; bidi overrides/isolates and LRM/RLM marks (they can make a
  // name or title read as something else) are dropped.
  const s = v
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  if (!s) return invalid(`${what} is empty`);
  if (s.length > max) return invalid(`${what} is longer than ${max}`);
  return s;
}

function finite(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e18)
    return invalid(`${what} is not a number`);
  return v;
}

function fieldId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !FIELD_ID.test(v)) return invalid(`${what} is not a field id`);
  return v;
}

function parseItems(v: unknown): ShareItem[] {
  if (!Array.isArray(v)) return invalid('items is not an array');
  if (v.length > MAX_WATCHLIST_ITEMS) return invalid(`more than ${MAX_WATCHLIST_ITEMS} items`);
  const out: ShareItem[] = [];
  const seen = new Set<string>();
  for (const it of v as unknown[]) {
    if (typeof it === 'string') {
      if (!SYMBOL_RE.test(it)) return invalid('bad symbol');
      if (seen.has(it)) continue; // first wins, as in a list
      seen.add(it);
      out.push(it);
    } else if (isRecord(it)) {
      out.push({ section: text(own(it, 'section'), 'section title', MAX_SECTION_TITLE) });
    } else return invalid('bad item');
  }
  return out;
}

function parseValue(v: unknown): RuleValue {
  if (typeof v === 'number') return finite(v, 'rule value');
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length > 200) return invalid('rule value is too long');
    return v;
  }
  if (Array.isArray(v)) {
    const a = v as unknown[];
    if (a.length === 2 && a.every((x) => typeof x === 'number'))
      return [finite(a[0], 'range'), finite(a[1], 'range')];
    if (a.length > MAX_STRINGS) return invalid('rule list is too long');
    return a.map((x) => {
      if (typeof x !== 'string' || x.length > 100) return invalid('rule list entry');
      return x;
    });
  }
  if (isRecord(v)) {
    const field = fieldId(own(v, 'field'), 'operand');
    const pct = own(v, 'pct');
    return pct === undefined ? { field } : { field, pct: finite(pct, 'pct') };
  }
  return invalid('rule value');
}

/** A formula text as stored in a rule or a `=` column: bounded, well-formed (syntax only). */
function formulaText(v: unknown, what: string): string {
  if (typeof v !== 'string') return invalid(`${what} is not a string`);
  if ([...v].length > FORMULA_MAX_LENGTH)
    return invalid(`${what} is longer than ${FORMULA_MAX_LENGTH}`);
  if (!formulaSyntaxOk(v)) return invalid(`${what} is not a valid formula`);
  return v;
}

function parseFormulaRule(v: Record<string, unknown>): FormulaRule {
  const op = own(v, 'op');
  if (typeof op !== 'string' || !(FORMULA_OPS as readonly string[]).includes(op))
    return invalid('bad formula operator');
  const formula = formulaText(own(v, 'formula'), 'formula');
  const value = own(v, 'value');
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return invalid('formula range');
    const a = value as unknown[];
    return {
      formula,
      op: op as FormulaRule['op'],
      value: [finite(a[0], 'formula range'), finite(a[1], 'formula range')],
    };
  }
  return { formula, op: op as FormulaRule['op'], value: finite(value, 'formula value') };
}

interface Budget {
  /** Rules still allowed (formula rules count too). */
  left: number;
  formulas: number;
  /** Groups seen, the root included. */
  groups: number;
}

function parseNode(v: unknown, depth: number, budget: Budget): Rule | FormulaRule | Group {
  if (!isRecord(v)) return invalid('rule is not an object');
  const rules = own(v, 'rules');
  if (rules !== undefined) {
    const op = own(v, 'op');
    if ((op !== 'and' && op !== 'or') || depth > 2 || !Array.isArray(rules))
      return invalid('bad group');
    if (++budget.groups > MAX_GROUPS) return invalid(`more than ${MAX_GROUPS} groups`);
    return { op, rules: (rules as unknown[]).map((c) => parseNode(c, depth + 1, budget)) };
  }
  if (Object.hasOwn(v, 'formula')) {
    if (--budget.left < 0) return invalid(`more than ${MAX_RULES} rules`);
    if (++budget.formulas > MAX_FORMULA_RULES)
      return invalid(`more than ${MAX_FORMULA_RULES} formula rules`);
    return parseFormulaRule(v);
  }
  const op = own(v, 'op');
  if (typeof op !== 'string' || !(RULE_OPS as readonly string[]).includes(op))
    return invalid('bad operator');
  if (--budget.left < 0) return invalid(`more than ${MAX_RULES} rules`);
  return {
    field: fieldId(own(v, 'field'), 'rule field'),
    op: op as RuleOp,
    value: parseValue(own(v, 'value')),
  };
}

function parseUniverse(v: unknown): Universe {
  if (!isRecord(v)) return invalid('universe');
  const kind = own(v, 'kind');
  if (kind === 'class') {
    const cls = own(v, 'cls');
    if (typeof cls !== 'string' || !(SCREENER_CLASSES as readonly string[]).includes(cls))
      return invalid('universe class');
    return { kind: 'class', cls: cls as (typeof SCREENER_CLASSES)[number] };
  }
  if (kind === 'list') {
    const id = own(v, 'id');
    if (typeof id !== 'string' || !LIST_ID.test(id)) return invalid('universe list id');
    return { kind: 'list', id };
  }
  if (kind === 'symbols') {
    const symbols = own(v, 'symbols');
    if (!Array.isArray(symbols) || symbols.length > MAX_SYMBOLS) return invalid('universe symbols');
    const out: string[] = [];
    for (const s of symbols as unknown[]) {
      if (typeof s !== 'string' || !SYMBOL_RE.test(s)) return invalid('universe symbol');
      if (!out.includes(s)) out.push(s);
    }
    return { kind: 'symbols', symbols: out };
  }
  // `watchlist` universes name a local list id: not portable (the sender resolves them to symbols).
  return invalid('universe kind');
}

function parseSpec(v: unknown): ScreenSpec {
  if (!isRecord(v)) return invalid('spec');
  if (own(v, 'schemaVersion') !== 1) return invalid('spec schemaVersion');
  const filterRaw = own(v, 'filter');
  let filter: Group | null = null;
  if (filterRaw !== null && filterRaw !== undefined) {
    const node = parseNode(filterRaw, 1, { left: MAX_RULES, formulas: 0, groups: 0 });
    if (!('rules' in node)) return invalid('filter is not a group');
    filter = node;
  }
  const sortRaw = own(v, 'sort');
  if (!isRecord(sortRaw)) return invalid('sort');
  const dir = own(sortRaw, 'dir');
  if (dir !== 'asc' && dir !== 'desc') return invalid('sort direction');
  const spec: ScreenSpec = {
    schemaVersion: 1,
    universe: parseUniverse(own(v, 'universe')),
    filter,
    sort: { field: fieldId(own(sortRaw, 'field'), 'sort field'), dir },
  };
  const columns = own(v, 'columns');
  if (columns !== undefined) {
    if (!Array.isArray(columns) || columns.length > MAX_COLUMNS) return invalid('columns');
    let formulas = 0;
    spec.columns = (columns as unknown[]).map((c) => {
      if (typeof c === 'string' && c.startsWith(FORMULA_FIELD_PREFIX)) {
        if (++formulas > MAX_FORMULA_FIELDS)
          return invalid(`more than ${MAX_FORMULA_FIELDS} formula columns`);
        return (
          FORMULA_FIELD_PREFIX + formulaText(c.slice(FORMULA_FIELD_PREFIX.length), 'column formula')
        );
      }
      return fieldId(c, 'column');
    });
  }
  return spec;
}

/**
 * Validate an untrusted document and return a clean copy (known fields only).
 * Throws `ShareError` (`unsupported_version`, `unsupported_type`, `invalid`).
 */
export function parseSharePayload(raw: unknown): SharePayload {
  if (!isRecord(raw)) return invalid('not an object');
  const version = own(raw, 'v');
  if (version !== SHARE_VERSION)
    throw new ShareError(
      'unsupported_version',
      String(typeof version === 'number' ? version : '?'),
    );
  const type = own(raw, 'type');
  const name = text(own(raw, 'name'), 'name', MAX_NAME);
  if (type === 'watchlist') return { v: 1, type, name, items: parseItems(own(raw, 'items')) };
  if (type === 'screen') return { v: 1, type, name, spec: parseSpec(own(raw, 'spec')) };
  throw new ShareError('unsupported_type');
}

/** Parse the text of a downloaded JSON file. */
export function parseShareJson(source: string): SharePayload {
  if (source.length > MAX_DOCUMENT_BYTES) throw new ShareError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ShareError('bad_json');
  }
  return parseSharePayload(raw);
}

/** The JSON file of a payload (pretty-printed). */
export const shareFileText = (payload: SharePayload): string => JSON.stringify(payload, null, 2);

// ------------------------------------------------------------ bytes

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!BASE64URL.test(s) || s.length % 4 === 1) throw new ShareError('bad_encoding', 'base64url');
  let bin: string;
  try {
    bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new ShareError('bad_encoding', 'base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Run `data` through a (de)compression stream, giving up past `limit` output bytes. */
async function pipe(
  data: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  written.catch(() => undefined); // a failure here also surfaces on the read side
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ShareError('too_large', 'inflated size');
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    writer.abort().catch(() => undefined);
    throw e instanceof ShareError ? e : new ShareError('bad_encoding', 'deflate');
  }
  await written.catch(() => undefined);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// ------------------------------------------------------------ encode / decode

export interface EncodedShare {
  /** `z.<...>` (deflated) or `r.<...>` (no compression available). */
  encoded: string;
  compressed: boolean;
}

/** JSON -> deflate-raw (when the browser can) -> base64url, with a one-letter format flag. */
export async function encodePayload(payload: SharePayload): Promise<EncodedShare> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (canCompress()) {
    try {
      const packed = await pipe(json, new CompressionStream('deflate-raw'), MAX_DOCUMENT_BYTES);
      return { encoded: `z.${toBase64Url(packed)}`, compressed: true };
    } catch {
      // Fall through to the plain form.
    }
  }
  return { encoded: `r.${toBase64Url(json)}`, compressed: false };
}

/** Decode and validate an encoded payload (the part after `#tg-import=`). Throws `ShareError`. */
export async function decodePayload(encoded: string): Promise<SharePayload> {
  if (encoded.length > MAX_LINK_PAYLOAD) throw new ShareError('too_large', 'link');
  const flag = encoded.slice(0, 2);
  if (flag !== 'z.' && flag !== 'r.') throw new ShareError('bad_encoding', 'format');
  const bytes = fromBase64Url(encoded.slice(2));
  let json: Uint8Array;
  if (flag === 'z.') {
    if (!canCompress()) throw new ShareError('bad_encoding', 'this browser cannot inflate links');
    json = await pipe(
      bytes as Uint8Array<ArrayBuffer>,
      new DecompressionStream('deflate-raw'),
      MAX_DOCUMENT_BYTES,
    );
  } else {
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new ShareError('too_large');
    json = bytes;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw new ShareError('bad_json');
  }
  return parseSharePayload(raw);
}

// ------------------------------------------------------------ links

/** `<origin><base>` of this app, for building links. */
export const shareBaseUrl = (): string =>
  typeof location === 'undefined' ? '' : `${location.origin}${import.meta.env.BASE_URL}`;

export interface ShareLink {
  link: string;
  /** Length of the encoded payload. */
  length: number;
  /** Over `MAX_LINK_PAYLOAD`: the link would not open reliably; offer a file instead. */
  tooLarge: boolean;
  compressed: boolean;
}

export async function buildShareLink(
  payload: SharePayload,
  base: string = shareBaseUrl(),
): Promise<ShareLink> {
  const { encoded, compressed } = await encodePayload(payload);
  return {
    link: `${base}${SHARE_HASH_PREFIX}${encoded}`,
    length: encoded.length,
    tooLarge: encoded.length > MAX_LINK_PAYLOAD,
    compressed,
  };
}

/** The payload of a location hash (`#tg-import=...`), or null if it is not a share link. */
export function payloadFromHash(hash: string): string | null {
  return hash.startsWith(SHARE_HASH_PREFIX) ? hash.slice(SHARE_HASH_PREFIX.length) : null;
}

/** The payload of a pasted link or hash. */
export function payloadFromLink(link: string): string | null {
  const i = link.indexOf(SHARE_HASH_PREFIX);
  return i < 0 ? null : link.slice(i + SHARE_HASH_PREFIX.length).trim();
}
