/** Response shapes of the REST API (see api/src/investopen_api/routes/). */

export interface Quote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  currency: string | null;
}

export interface SymbolMeta {
  symbol: string;
  name: string;
  exchange: string | null;
  exchangeName: string | null;
  type: string | null;
  currency: string | null;
  timezone: string | null;
  minTick: number;
  priceHint: number;
}

export interface FundamentalsInfo {
  marketCap?: number | null;
  trailingPE?: number | null;
  forwardPE?: number | null;
  trailingEps?: number | null;
  /** Already a percentage (0.32 means 0.32%). */
  dividendYield?: number | null;
  beta?: number | null;
  fiftyTwoWeekHigh?: number | null;
  fiftyTwoWeekLow?: number | null;
  sector?: string | null;
  industry?: string | null;
  website?: string | null;
  fullTimeEmployees?: number | null;
  longBusinessSummary?: string | null;
  longName?: string | null;
  currency?: string | null;
}

export interface Fundamentals {
  info: FundamentalsInfo;
  financials: unknown;
}

export interface NewsItem {
  id: string;
  title: string;
  publisher: string | null;
  url: string;
  /** Unix seconds. */
  time: number | null;
  thumbnail: string | null;
}

// ------------------------------------------------------------ persistence
// User data (docs/persistence.md; api/src/investopen_api/userdata/schemas.py).
// JSON payloads are opaque to the server; timestamps are ISO 8601 strings.

/** Version of the import/export bundle this client writes. */
export const BUNDLE_VERSION = 1;

export interface LayoutSummary {
  id: string;
  name: string;
  schemaVersion: number;
  /** Starts at 1; bumped by every state save (not by rename). */
  revision: number;
  isLastUsed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Layout<S = Record<string, unknown>> extends LayoutSummary {
  state: S;
}

export interface LayoutDocument<S = Record<string, unknown>> {
  name: string;
  state: S;
  schemaVersion: number;
}

/** Single-layout export file. */
export interface LayoutFile<S = Record<string, unknown>> {
  version: number;
  kind: 'layout';
  exportedAt?: string | null;
  layout: LayoutDocument<S>;
}

/** A stored drawing; `data` is the engine `Drawing` JSON as sent. */
export interface StoredDrawing<D = Record<string, unknown>> {
  id: string;
  /** null = synced across symbols (scope 'all'). */
  symbol: string | null;
  paneId: string;
  z: number;
  data: D;
  schemaVersion: number;
  revision: number;
  updatedAt: string;
}

export interface DrawingUpsert<D = Record<string, unknown>> {
  drawing: D;
  /** Revision the edit is based on; null/omitted = new drawing. */
  baseRevision?: number | null;
}

export interface DrawingDelete {
  id: string;
  /** Omitted = delete whatever is stored. */
  baseRevision?: number | null;
}

export interface DrawingBatch<D = Record<string, unknown>> {
  upserts?: DrawingUpsert<D>[];
  deletes?: DrawingDelete[];
  schemaVersion?: number;
  /** Skip revision checks (last writer wins). */
  force?: boolean;
}

export interface DrawingBatchResult<D = Record<string, unknown>> {
  drawings: StoredDrawing<D>[];
  deleted: string[];
}

export interface DrawingConflict<D = Record<string, unknown>> {
  id: string;
  /** Stored revision; null when deleted on the server. */
  revision: number | null;
  drawing: StoredDrawing<D> | null;
}

export interface IndicatorTemplateIn<I = unknown> {
  name: string;
  instances: I[];
  schemaVersion?: number;
}

export interface IndicatorTemplate<I = unknown> extends Required<IndicatorTemplateIn<I>> {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface DrawingTemplateIn<S = Record<string, unknown>> {
  toolType: string;
  name: string;
  style: S;
  isDefault?: boolean;
  schemaVersion?: number;
}

export interface DrawingTemplate<S = Record<string, unknown>>
  extends Required<DrawingTemplateIn<S>> {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChartTemplateIn<T = Record<string, unknown>> {
  name: string;
  data: T;
  schemaVersion?: number;
}

export interface ChartTemplate<T = Record<string, unknown>> extends Required<ChartTemplateIn<T>> {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type Settings = Record<string, unknown>;

export interface Note {
  id: string;
  /** null = general note. */
  symbol: string | null;
  text: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** All user data (`GET /api/export`, `POST /api/import`). */
export interface Bundle {
  version: number;
  app: 'investopen';
  exportedAt?: string | null;
  layouts: (Layout | (LayoutDocument & { id: string; isLastUsed?: boolean }))[];
  drawings: { data: Record<string, unknown>; schemaVersion?: number }[];
  indicatorTemplates: IndicatorTemplateIn[];
  drawingTemplates: DrawingTemplateIn[];
  chartTemplates: ChartTemplateIn[];
  settings: Settings;
  notes: { id: string; symbol?: string | null; text: string }[];
}

export type ImportMode = 'merge' | 'replace';

export interface ImportCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface ImportSummary {
  mode: ImportMode;
  dryRun: boolean;
  layouts: ImportCounts;
  drawings: ImportCounts;
  indicatorTemplates: ImportCounts;
  drawingTemplates: ImportCounts;
  chartTemplates: ImportCounts;
  settings: ImportCounts;
  notes: ImportCounts;
}
