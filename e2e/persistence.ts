/**
 * In-test mock of the user-data API (docs/persistence.md §2-4), served with
 * page.route by the auto fixture in ./fixtures.ts. It follows the server's
 * rules (revision checks on upserts and deletes, all-or-nothing batches,
 * import merge/replace semantics, 4xx validation), so tests don't pass on
 * behaviour the real API would reject. State lives in the test process and
 * survives page reloads within a test. e2e never reaches a real user-data
 * database: only market-data routes pass through; anything else fails the test.
 */
import type { Page, Route } from '@playwright/test';

type Json = Record<string, unknown>;
type Reply = [number, unknown];

interface Layout extends Json {
  id: string;
  name: string;
  state: Json;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
interface DrawingRow extends Json {
  id: string;
  symbol: string | null;
  revision: number;
  data: Json;
}
interface Template extends Json {
  id: string;
  name: string;
}
interface Fields {
  id: string;
  symbol: string | null;
  paneId: string;
  z: number;
}
interface Note extends Json {
  id: string;
  symbol: string | null;
  text: string;
  revision: number;
}

/** Routes that may reach the real backend (read-only market data). */
const MARKET = /^\/api\/(bars|quotes|health)$|^\/api\/(symbols|events|news|fundamentals)\//;
const USER_DATA =
  /^\/api\/(layouts|drawings|indicator-templates|drawing-templates|chart-templates|settings|notes|export|import)(\/|$)/;
const FIXED_LAYOUT_ROUTES = new Set(['last-used', 'import']);

const detail = (status: number, message: string): Reply => [status, { detail: message }];

export class MockServer {
  layouts = new Map<string, Layout>();
  lastUsed: string | null = null;
  drawings = new Map<string, DrawingRow>();
  settings = new Map<string, unknown>();
  notes = new Map<string, Note>();
  indicatorTemplates = new Map<string, Template>();
  drawingTemplates = new Map<string, Template>();
  chartTemplates = new Map<string, Template>();
  /** Answer every user-data call with 503 (API down). */
  down = false;
  /** Every user-data request, as "METHOD /path". */
  log: string[] = [];
  /** Requests the mock does not implement, or that would leave the sandbox: fail the test. */
  unhandled: string[] = [];
  private seq = 0;
  private clock = Date.UTC(2026, 0, 1);

  private id(prefix: string) {
    return `${prefix}${++this.seq}`;
  }
  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private summary(l: Layout) {
    const { state: _s, ...rest } = l;
    return { ...rest, isLastUsed: l.id === this.lastUsed };
  }
  private full(l: Layout) {
    return { ...l, isLastUsed: l.id === this.lastUsed };
  }
  private newLayout(
    name: unknown,
    state: unknown,
    schemaVersion: unknown,
    id?: string,
  ): Layout | Reply {
    if (typeof name !== 'string' || !name.trim()) return detail(422, 'name required');
    if (!state || typeof state !== 'object' || Array.isArray(state))
      return detail(422, 'state must be an object');
    const t = this.now();
    const l: Layout = {
      id: id ?? this.id('L'),
      name: name.trim(),
      state: state as Json,
      schemaVersion: Number(schemaVersion ?? 1),
      revision: 1,
      createdAt: t,
      updatedAt: t,
    };
    this.layouts.set(l.id, l);
    return l;
  }

  /** Server-side checks of a drawing (store.drawing_fields): returns an error or the row fields. */
  private drawingFields(
    data: unknown,
  ): { id: string; symbol: string | null; paneId: string; z: number } | string {
    if (!data || typeof data !== 'object') return 'drawing must be an object';
    const d = data as Json;
    if (typeof d.id !== 'string' || !d.id) return 'drawing.id required';
    if (d.scope !== 'all' && (typeof d.symbol !== 'string' || !d.symbol.trim()))
      return 'drawing.symbol required unless scope is "all"';
    return {
      id: d.id,
      symbol: d.scope === 'all' ? null : String(d.symbol).trim().toUpperCase(),
      paneId: String(d.paneId ?? 'main'),
      z: Number(d.zIndex ?? 0),
    };
  }

  private putDrawing(
    data: Json,
    f: { id: string; symbol: string | null; paneId: string; z: number },
  ) {
    const prev = this.drawings.get(f.id);
    const row: DrawingRow = {
      ...f,
      data,
      schemaVersion: 1,
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: this.now(),
    };
    this.drawings.set(f.id, row);
    return row;
  }

  private snapshot(): MockServer {
    const copy = new MockServer();
    copy.layouts = structuredClone(this.layouts);
    copy.lastUsed = this.lastUsed;
    copy.drawings = structuredClone(this.drawings);
    copy.settings = structuredClone(this.settings);
    copy.notes = structuredClone(this.notes);
    copy.indicatorTemplates = structuredClone(this.indicatorTemplates);
    copy.drawingTemplates = structuredClone(this.drawingTemplates);
    copy.chartTemplates = structuredClone(this.chartTemplates);
    copy.seq = this.seq;
    copy.clock = this.clock;
    return copy;
  }

  private templateMap(head: string): Map<string, Template> | null {
    if (head === 'indicator-templates') return this.indicatorTemplates;
    if (head === 'drawing-templates') return this.drawingTemplates;
    if (head === 'chart-templates') return this.chartTemplates;
    return null;
  }

  /** Handle one request: [status, body]. */
  handle(method: string, path: string, query: URLSearchParams, body: unknown): Reply {
    const b = (body ?? {}) as Json;
    const [head, id, sub] = path.split('/').filter(Boolean);
    const notFound = detail(404, `not found: ${path}`);

    if (head === 'layouts') {
      if (!id && method === 'GET')
        return [
          200,
          [...this.layouts.values()]
            .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
            .map((l) => this.summary(l)),
        ];
      if (!id && method === 'POST') {
        const l = this.newLayout(b.name, b.state, b.schemaVersion);
        return Array.isArray(l) ? l : [201, this.full(l)];
      }
      if (id === 'last-used') {
        if (method === 'GET') {
          const l = this.lastUsed ? this.layouts.get(this.lastUsed) : undefined;
          return [200, l ? this.full(l) : null];
        }
        if (method === 'PUT') {
          if (!this.layouts.has(String(b.id))) return notFound;
          this.lastUsed = String(b.id);
          return [204, undefined];
        }
      }
      if (id === 'import' && method === 'POST') {
        const file = b as { kind?: unknown; layout?: Json };
        if (file.kind !== 'layout' || !file.layout) return detail(422, 'not a layout file');
        const l = this.newLayout(
          query.get('name') ?? file.layout.name,
          file.layout.state,
          file.layout.schemaVersion,
        );
        return Array.isArray(l) ? l : [201, this.full(l)];
      }
      const l = this.layouts.get(id!);
      if (!l) return notFound;
      if (sub === 'duplicate' && method === 'POST') {
        const c = this.newLayout(b.name, structuredClone(l.state), l.schemaVersion);
        return Array.isArray(c) ? c : [201, this.full(c)];
      }
      if (sub === 'export' && method === 'GET')
        return [
          200,
          {
            version: 1,
            kind: 'layout',
            exportedAt: this.now(),
            layout: { name: l.name, state: l.state, schemaVersion: l.schemaVersion },
          },
        ];
      if (sub) return notFound;
      if (method === 'GET') return [200, this.full(l)];
      if (method === 'PUT') {
        if (typeof b.revision !== 'number') return detail(422, 'revision required');
        if (b.revision !== l.revision)
          return [409, { detail: { message: 'layout changed elsewhere', current: this.full(l) } }];
        l.state = b.state as Json;
        if (b.schemaVersion !== undefined) l.schemaVersion = Number(b.schemaVersion);
        l.revision++;
        l.updatedAt = this.now();
        return [200, this.full(l)];
      }
      if (method === 'PATCH') {
        if (typeof b.name !== 'string' || !b.name.trim()) return detail(422, 'name required');
        l.name = b.name.trim();
        return [200, this.summary(l)];
      }
      if (method === 'DELETE') {
        this.layouts.delete(l.id);
        if (this.lastUsed === l.id) this.lastUsed = null;
        return [204, undefined];
      }
    }

    if (head === 'drawings') {
      if (!id && method === 'GET') {
        const sym = query.get('symbol')?.trim().toUpperCase();
        const synced = query.get('synced') !== 'false';
        const rows = [...this.drawings.values()].filter(
          (r) => !sym || r.symbol === sym || (synced && r.symbol === null),
        );
        return [200, { drawings: rows }];
      }
      if (id === 'batch' && method === 'POST') return this.batch(b);
    }

    const templates = this.templateMap(head ?? '');
    if (templates) {
      const keyOf = (t: Json) =>
        head === 'drawing-templates' ? `${t.toolType}\n${t.name}` : String(t.name);
      if (!id && method === 'GET') {
        const tool = query.get('toolType');
        return [200, [...templates.values()].filter((t) => !tool || t.toolType === tool)];
      }
      if (typeof b.name === 'string') b.name = b.name.trim();
      if ((method === 'POST' || method === 'PUT') && !b.name) return detail(422, 'name required');
      if (!id && method === 'POST') {
        const existing = [...templates.values()].find((t) => keyOf(t) === keyOf(b));
        if (head === 'drawing-templates' && b.isDefault)
          for (const t of templates.values()) if (t.toolType === b.toolType) t.isDefault = false;
        const t = this.now();
        const row: Template = {
          schemaVersion: 1,
          ...(head === 'drawing-templates' ? { isDefault: false } : {}),
          ...b,
          id: existing?.id ?? this.id('T'),
          name: String(b.name),
          createdAt: existing?.createdAt ?? t,
          updatedAt: t,
        };
        templates.set(row.id, row);
        return [existing ? 200 : 201, row];
      }
      const row = templates.get(id!);
      if (!row) return notFound;
      if (method === 'GET') return [200, row];
      if (method === 'PUT') {
        const clash = [...templates.values()].find(
          (t) => t.id !== row.id && keyOf(t) === keyOf({ ...row, ...b }),
        );
        if (clash) return detail(409, `a template named "${b.name}" exists`);
        Object.assign(row, b, { updatedAt: this.now() });
        return [200, row];
      }
      if (method === 'DELETE') {
        templates.delete(row.id);
        return [204, undefined];
      }
    }

    if (head === 'settings') {
      const keyOk = (k: string) => /^[A-Za-z0-9_.-]{1,64}$/.test(k);
      if (!id && method === 'GET') return [200, Object.fromEntries(this.settings)];
      if (!id && method === 'PATCH') {
        if (Object.keys(b).some((k) => !keyOk(k))) return detail(422, 'bad setting key');
        for (const [k, v] of Object.entries(b)) {
          if (v === null) this.settings.delete(k);
          else this.settings.set(k, v);
        }
        return [200, Object.fromEntries(this.settings)];
      }
      if (!keyOk(id!)) return detail(422, 'bad setting key');
      if (method === 'GET')
        return this.settings.has(id!) ? [200, this.settings.get(id!)] : notFound;
      if (method === 'PUT') {
        if (b.value === null || b.value === undefined) return detail(422, 'value must not be null');
        this.settings.set(id!, b.value);
        return [204, undefined];
      }
      if (method === 'DELETE') {
        this.settings.delete(id!);
        return [204, undefined];
      }
    }

    if (head === 'notes') {
      if (!id && method === 'GET') {
        const sym = query.get('symbol')?.trim().toUpperCase();
        return [200, [...this.notes.values()].filter((n) => sym === undefined || n.symbol === sym)];
      }
      if (!id && method === 'POST') {
        const t = this.now();
        const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : null;
        const n: Note = {
          id: this.id('N'),
          symbol,
          text: String(b.text ?? ''),
          revision: 1,
          createdAt: t,
          updatedAt: t,
        };
        this.notes.set(n.id, n);
        return [201, n];
      }
      const n = this.notes.get(id!);
      if (!n) return notFound;
      if (method === 'GET') return [200, n];
      if (method === 'PUT') {
        if (b.revision !== undefined && b.revision !== n.revision)
          return [409, { detail: { message: `note ${n.id} changed elsewhere`, current: n } }];
        Object.assign(n, {
          text: String(b.text ?? ''),
          revision: n.revision + 1,
          updatedAt: this.now(),
        });
        if ('symbol' in b)
          n.symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : null;
        return [200, n];
      }
      if (method === 'DELETE') {
        this.notes.delete(n.id);
        return [204, undefined];
      }
    }

    if (head === 'export' && method === 'GET')
      return [
        200,
        {
          version: 1,
          app: 'investopen',
          exportedAt: this.now(),
          layouts: [...this.layouts.values()].map((l) => this.full(l)),
          drawings: [...this.drawings.values()],
          indicatorTemplates: [...this.indicatorTemplates.values()],
          drawingTemplates: [...this.drawingTemplates.values()],
          chartTemplates: [...this.chartTemplates.values()],
          settings: Object.fromEntries(this.settings),
          notes: [...this.notes.values()],
        },
      ];

    if (head === 'import' && method === 'POST') {
      const mode = query.get('mode') ?? 'merge';
      const dryRun = query.get('dryRun') === 'true';
      if (mode !== 'merge' && mode !== 'replace') return detail(422, 'bad mode');
      if (mode === 'replace' && !dryRun && query.get('confirm') !== 'true')
        return detail(400, 'mode=replace deletes data; pass confirm=true');
      if (dryRun) {
        const scratch = this.snapshot();
        const out = scratch.importBundle(b, mode);
        return Array.isArray(out) ? out : [200, { ...out, dryRun: true }];
      }
      const out = this.snapshot().importBundle(b, mode); // validate first: all-or-nothing
      if (Array.isArray(out)) return out;
      return [200, this.importBundle(b, mode)];
    }
    return [-1, undefined];
  }

  /** POST /drawings/batch (routes/drawings.py): all-or-nothing with revision checks. */
  private batch(b: Json): Reply {
    const ups = (b.upserts ?? []) as { drawing: Json; baseRevision?: number | null }[];
    const dels = (b.deletes ?? []) as { id: string; baseRevision?: number | null }[];
    const fields: Fields[] = [];
    for (const u of ups) {
      const f = this.drawingFields(u.drawing);
      if (typeof f === 'string') return detail(422, f);
      fields.push(f);
    }
    const ids = [...fields.map((f) => f.id), ...dels.map((d) => d.id)];
    if (new Set(ids).size !== ids.length)
      return detail(422, 'a drawing id appears more than once in the batch');
    if (!b.force) {
      const conflicts: unknown[] = [];
      ups.forEach((u, i) => {
        const row = this.drawings.get(fields[i]!.id);
        const base = u.baseRevision ?? null;
        const ok = row ? row.revision === base : base === null;
        if (!ok)
          conflicts.push({
            id: fields[i]!.id,
            revision: row?.revision ?? null,
            drawing: row ?? null,
          });
      });
      for (const d of dels) {
        const row = this.drawings.get(d.id);
        const base = d.baseRevision ?? null;
        if (!(base === null || !row || row.revision === base))
          conflicts.push({ id: d.id, revision: row!.revision, drawing: row });
      }
      if (conflicts.length)
        return [409, { detail: { message: 'drawings changed elsewhere', conflicts } }];
    }
    const out = ups.map((u, i) => this.putDrawing(u.drawing, fields[i]!));
    const deleted = dels.filter((d) => this.drawings.delete(d.id)).map((d) => d.id);
    return [200, { drawings: out, deleted }];
  }

  /** store.import_bundle: merge by id/name/key (matches overwritten, revision bumped) or replace present sections. */
  private importBundle(b: Json, mode: string): Json | Reply {
    if (b.app !== 'investopen') return detail(422, 'app must be "investopen"');
    if (typeof b.version !== 'number' || b.version < 1 || b.version > 1)
      return detail(422, 'unsupported bundle version');
    const zero = () => ({ created: 0, updated: 0, deleted: 0 });
    const summary: Json & Record<string, { created: number; updated: number; deleted: number }> = {
      mode,
      dryRun: false,
      layouts: zero(),
      drawings: zero(),
      indicatorTemplates: zero(),
      drawingTemplates: zero(),
      chartTemplates: zero(),
      settings: zero(),
      notes: zero(),
    } as never;
    const drawings = (b.drawings ?? []) as { data: Json }[];
    const fields: Fields[] = [];
    for (const d of drawings) {
      const f = this.drawingFields(d.data);
      if (typeof f === 'string') return detail(422, f);
      fields.push(f);
    }
    if (mode === 'replace') {
      const sections: [string, Map<string, unknown>][] = [
        ['layouts', this.layouts],
        ['drawings', this.drawings],
        ['indicatorTemplates', this.indicatorTemplates],
        ['drawingTemplates', this.drawingTemplates],
        ['chartTemplates', this.chartTemplates],
        ['settings', this.settings],
        ['notes', this.notes],
      ];
      for (const [k, map] of sections) {
        if (b[k] === undefined) continue; // absent sections are kept
        summary[k]!.deleted = map.size;
        map.clear();
        if (k === 'layouts') this.lastUsed = null;
      }
    }
    let lastUsed: string | null = null;
    for (const x of (b.layouts ?? []) as Layout[]) {
      const lid = FIXED_LAYOUT_ROUTES.has(x.id) ? this.id('L') : x.id;
      const cur = this.layouts.get(lid);
      if (cur) {
        Object.assign(cur, {
          name: x.name,
          state: x.state,
          schemaVersion: x.schemaVersion ?? 1,
          revision: cur.revision + 1,
          updatedAt: this.now(),
        });
        summary.layouts!.updated++;
      } else {
        const l = this.newLayout(x.name, x.state, x.schemaVersion, lid);
        if (Array.isArray(l)) return l;
        summary.layouts!.created++;
      }
      if (x.isLastUsed) lastUsed = lid;
    }
    if (lastUsed && (mode === 'replace' || !this.lastUsed)) this.lastUsed = lastUsed;
    drawings.forEach((d, i) => {
      const existed = this.drawings.has(fields[i]!.id);
      this.putDrawing(d.data, fields[i]!);
      summary.drawings![existed ? 'updated' : 'created']++;
    });
    const templates: [string, Map<string, Template>, (t: Json) => string][] = [
      ['indicatorTemplates', this.indicatorTemplates, (t) => String(t.name)],
      ['drawingTemplates', this.drawingTemplates, (t) => `${t.toolType}\n${t.name}`],
      ['chartTemplates', this.chartTemplates, (t) => String(t.name)],
    ];
    for (const [k, map, keyOf] of templates)
      for (const t of (b[k] ?? []) as Json[]) {
        const existing = [...map.values()].find((x) => keyOf(x) === keyOf(t));
        const row: Template = {
          schemaVersion: 1,
          ...t,
          id: existing?.id ?? this.id('T'),
          name: String(t.name),
          updatedAt: this.now(),
        };
        map.set(row.id, row);
        summary[k]![existing ? 'updated' : 'created']++;
      }
    for (const [k, v] of Object.entries((b.settings ?? {}) as Json)) {
      if (v === null) return detail(422, `setting ${k}: value must not be null`);
      summary.settings![this.settings.has(k) ? 'updated' : 'created']++;
      this.settings.set(k, v);
    }
    for (const n of (b.notes ?? []) as Note[]) {
      const cur = this.notes.get(n.id);
      if (cur) {
        Object.assign(cur, {
          symbol: n.symbol ?? null,
          text: n.text,
          revision: cur.revision + 1,
          updatedAt: this.now(),
        });
        summary.notes!.updated++;
      } else {
        const t = this.now();
        this.notes.set(n.id, {
          id: n.id,
          symbol: n.symbol ?? null,
          text: n.text,
          revision: 1,
          createdAt: t,
          updatedAt: t,
        });
        summary.notes!.created++;
      }
    }
    return summary;
  }
}

/**
 * Route `/api/**` of `page`: user data to `server`, market data through,
 * anything else recorded in `server.unhandled` (the fixture fails the test).
 */
export async function mockPersistence(page: Page, server = new MockServer()): Promise<MockServer> {
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Only the backend (not e.g. Vite's /src/api/*.ts modules); market data passes through.
    if (!url.pathname.startsWith('/api/') || MARKET.test(url.pathname)) return route.fallback();
    const call = `${req.method()} ${url.pathname}${url.search}`;
    if (!USER_DATA.test(url.pathname)) {
      server.unhandled.push(call);
      return route.fulfill({ status: 501, json: { detail: `e2e: unexpected API call ${call}` } });
    }
    const path = url.pathname.slice('/api'.length);
    server.log.push(`${req.method()} ${path}`);
    if (server.down) return route.fulfill({ status: 503, json: { detail: 'down' } });
    let body: unknown;
    try {
      body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    } catch {
      return route.fulfill({ status: 422, json: { detail: 'invalid JSON' } });
    }
    const [status, out] = server.handle(req.method(), path, url.searchParams, body);
    if (status === -1) {
      server.unhandled.push(call);
      return route.fulfill({ status: 501, json: { detail: `e2e mock: unhandled ${call}` } });
    }
    if (status === 204 || out === undefined) return route.fulfill({ status });
    return route.fulfill({ status, json: out });
  });
  return server;
}
