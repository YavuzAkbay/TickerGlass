/**
 * Settings → AI → Cloud and other connections (admins): OpenAI-compatible endpoints (OpenAI,
 * OpenRouter, Z.ai, DeepSeek, OpenCode Zen, LM Studio...). The admin picks the models users may
 * use and what each can do; keys stay on the server and are only shown as their last digits.
 */
import { CheckCircle2, CircleAlert, Cloud, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../api/client';
import {
  AI_TIERS,
  TIER_LABEL,
  deleteConnection,
  saveAiConfig,
  saveConnection,
  testConnection,
  type AiConfig,
  type AiConnection,
  type AiConnectionModel,
  type AiPreset,
  type AiTier,
} from '../ai/api';
import { useAiStatus } from '../ai/store';
import { Row, Section } from '../dialogs/controls';
import { toast } from '../ui/Toast';

interface Draft {
  /** null: a new connection. */
  id: string | null;
  preset: string;
  name: string;
  baseUrl: string;
  /** '' keeps the stored key of an existing connection. */
  apiKey: string;
  context: number;
  models: AiConnectionModel[];
  tiers: Record<string, AiTier>;
  acknowledged: boolean;
}

type Listing =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; models: string[]; cloud: boolean }
  | { state: 'error'; message: string };

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'ai';

function uniqueId(base: string, taken: string[]): string {
  let id = slug(base);
  for (let n = 2; taken.includes(id); n++) id = `${slug(base)}-${n}`;
  return id;
}

const isLocal = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(host) ||
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
      /\.(local|lan|internal)$/.test(host)
    );
  } catch {
    return false;
  }
};

const MODELS_SHOWN = 200;

export function AiConnections({
  config,
  onChange,
}: {
  config: AiConfig;
  onChange: (c: AiConfig) => void;
}) {
  const presets: Record<string, AiPreset> = config.presets ?? {};
  const connections = config.connections ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [listing, setListing] = useState<Listing>({ state: 'idle' });
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);

  const open = (c: AiConnection | null, preset = 'openai') => {
    const p = presets[preset];
    const id = c?.id ?? null;
    setDraft(
      c
        ? {
            id,
            preset: c.preset,
            name: c.name,
            baseUrl: c.baseUrl,
            apiKey: '',
            context: c.context,
            models: c.models,
            tiers: Object.fromEntries(
              c.models
                .map((m) => [m.name, config.tiers[`${c.id}/${m.name}`]] as const)
                .filter(([, t]) => t),
            ) as Record<string, AiTier>,
            acknowledged: c.cloud,
          }
        : {
            id: null,
            preset,
            name: p?.name ?? 'Connection',
            baseUrl: p?.baseUrl ?? '',
            apiKey: '',
            context: 128_000,
            models: [],
            tiers: {},
            acknowledged: false,
          },
    );
    setListing({ state: 'idle' });
    setFilter('');
  };

  const loadModels = async (d: Draft) => {
    setListing({ state: 'loading' });
    try {
      const r = await testConnection({
        baseUrl: d.baseUrl.trim(),
        ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : d.id ? { id: d.id } : {}),
      });
      setListing(
        r.ok
          ? { state: 'ok', models: r.models, cloud: r.cloud }
          : { state: 'error', message: r.error },
      );
    } catch (e) {
      setListing({ state: 'error', message: errorMessage(e) });
    }
  };

  const remove = async (c: AiConnection) => {
    if (!window.confirm(`Remove the ${c.name} connection and its key?`)) return;
    try {
      onChange(await deleteConnection(c.id));
      await useAiStatus.getState().refresh();
      toast(`${c.name} removed`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const save = async (d: Draft) => {
    const id =
      d.id ??
      uniqueId(
        d.name,
        connections.map((c) => c.id),
      );
    setSaving(true);
    try {
      let next = await saveConnection(id, {
        name: d.name.trim(),
        preset: d.preset,
        baseUrl: d.baseUrl.trim(),
        ...(d.apiKey.trim() || !d.id ? { apiKey: d.apiKey.trim() } : {}),
        models: d.models,
        context: d.context,
        maxTokens: null,
        acknowledged: d.acknowledged,
      });
      // Tier overrides live with the other per-model tiers.
      const prefix = `${id}/`;
      const tiers: Record<string, AiTier> = Object.fromEntries(
        Object.entries(next.tiers ?? {}).filter(([k]) => !k.startsWith(prefix)),
      );
      for (const [m, t] of Object.entries(d.tiers)) tiers[`${prefix}${m}`] = t;
      if (JSON.stringify(tiers) !== JSON.stringify(next.tiers ?? {}))
        next = await saveAiConfig({
          url: next.url,
          models: next.models,
          defaultModel: next.defaultModel,
          numCtx: next.numCtx,
          tiers,
        });
      onChange(next);
      setDraft(null);
      await useAiStatus.getState().refresh();
      toast(`${d.name.trim()} saved`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const shown = useMemo(() => {
    if (listing.state !== 'ok') return [];
    const q = filter.trim().toLowerCase();
    const picked = new Set(draft?.models.map((m) => m.name));
    const all = listing.models.filter((m) => !q || m.toLowerCase().includes(q));
    // Picked models first so they stay visible in long lists (OpenRouter has hundreds).
    return [...all.filter((m) => picked.has(m)), ...all.filter((m) => !picked.has(m))].slice(
      0,
      MODELS_SHOWN,
    );
  }, [listing, filter, draft?.models]);

  if (config.locked) return null;

  const d = draft;
  const cloud = d ? !isLocal(d.baseUrl.trim()) : false;
  const setD = (patch: Partial<Draft>) => setDraft((x) => (x ? { ...x, ...patch } : x));
  const pick = (name: string) => {
    if (!d) return;
    const has = d.models.some((m) => m.name === name);
    setD({
      models: has
        ? d.models.filter((m) => m.name !== name)
        : [...d.models, { name, vision: false, tools: true, context: null }],
    });
  };
  const setModel = (name: string, patch: Partial<AiConnectionModel>) =>
    d && setD({ models: d.models.map((m) => (m.name === name ? { ...m, ...patch } : m)) });

  return (
    <Section title="Cloud and other connections">
      <p className="dlg-note">
        Connect any OpenAI-compatible API: OpenAI, OpenRouter, Z.ai (GLM), DeepSeek, OpenCode Zen,
        Groq, Mistral, or a local LM Studio. These need an <strong>API key</strong> and are billed
        by the provider per use; a ChatGPT or Claude chat subscription cannot be used here. Cloud
        models get every chart tool (Full tier) and see the questions and chart data users send.
      </p>
      {connections.length > 0 && (
        <ul className="ai-set-conns">
          {connections.map((c) => (
            <li key={c.id}>
              {c.cloud && <Cloud size={13} aria-label="cloud" />}
              <span className="ai-set-name">{c.name}</span>
              <span className="ai-set-meta">
                {c.models.length} model{c.models.length === 1 ? '' : 's'}
                {c.keyHint ? ` · key ${c.keyHint}` : ' · no key'}
              </span>
              <button type="button" className="io-btn" onClick={() => open(c)}>
                Edit
              </button>
              <button
                type="button"
                className="io-icon-btn"
                aria-label={`Remove ${c.name}`}
                onClick={() => void remove(c)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!d && (
        <div className="ai-set-actions">
          <button type="button" className="io-btn" onClick={() => open(null)}>
            <Plus size={14} /> Add connection
          </button>
        </div>
      )}
      {d && (
        <div className="ai-set-conn-form">
          {d.id === null && (
            <Row label="Provider" htmlFor="ai-conn-preset">
              <select
                id="ai-conn-preset"
                className="io-input"
                value={d.preset}
                onChange={(e) => {
                  const p = presets[e.target.value];
                  setD({
                    preset: e.target.value,
                    name: p?.name ?? d.name,
                    baseUrl: p?.baseUrl ?? '',
                  });
                  setListing({ state: 'idle' });
                }}
              >
                {Object.entries(presets).map(([k, p]) => (
                  <option key={k} value={k}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          <Row label="Name" htmlFor="ai-conn-name">
            <input
              id="ai-conn-name"
              className="io-input"
              value={d.name}
              onChange={(e) => setD({ name: e.target.value })}
            />
          </Row>
          <Row label="Base URL" htmlFor="ai-conn-url">
            <input
              id="ai-conn-url"
              className="io-input"
              placeholder="https://…/v1"
              spellCheck={false}
              value={d.baseUrl}
              onChange={(e) => setD({ baseUrl: e.target.value })}
            />
          </Row>
          <Row label="API key" htmlFor="ai-conn-key">
            <input
              id="ai-conn-key"
              className="io-input"
              type="password"
              autoComplete="off"
              placeholder={
                d.id
                  ? (connections.find((c) => c.id === d.id)?.keyHint ?? 'none') +
                    ' (leave empty to keep)'
                  : 'sk-…'
              }
              value={d.apiKey}
              onChange={(e) => setD({ apiKey: e.target.value })}
            />
          </Row>
          <Row label="Context window" htmlFor="ai-conn-ctx">
            <select
              id="ai-conn-ctx"
              className="io-input"
              value={d.context}
              onChange={(e) => setD({ context: Number(e.target.value) })}
            >
              {[32_000, 64_000, 128_000, 200_000, 400_000, 1_000_000].map((n) => (
                <option key={n} value={n}>
                  {n >= 1_000_000 ? '1M' : `${n / 1000}K`} tokens
                </option>
              ))}
            </select>
          </Row>
          <div className="ai-set-actions">
            <button
              type="button"
              className="io-btn"
              disabled={!d.baseUrl.trim() || listing.state === 'loading'}
              onClick={() => void loadModels(d)}
            >
              Load models
            </button>
          </div>
          <div
            className={`ai-set-status ai-set-${listing.state === 'loading' ? 'testing' : listing.state}`}
            role="status"
          >
            {listing.state === 'loading' && 'Connecting…'}
            {listing.state === 'ok' && (
              <>
                <CheckCircle2 size={14} /> {listing.models.length} models available
              </>
            )}
            {listing.state === 'error' && (
              <>
                <CircleAlert size={14} /> {listing.message}
              </>
            )}
          </div>
          {listing.state === 'ok' && listing.models.length > 10 && (
            <input
              className="io-input"
              placeholder="Filter models"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {(listing.state === 'ok' ? shown : d.models.map((m) => m.name)).length > 0 && (
            <ul className="ai-set-models">
              {(listing.state === 'ok' ? shown : d.models.map((m) => m.name)).map((name) => {
                const m = d.models.find((x) => x.name === name);
                return (
                  <li key={name}>
                    <label className="dlg-check">
                      <input type="checkbox" checked={!!m} onChange={() => pick(name)} />
                      <span className="ai-set-name">{name}</span>
                    </label>
                    {m && (
                      <>
                        <label className="dlg-check ai-set-cap">
                          <input
                            type="checkbox"
                            checked={m.vision}
                            onChange={(e) => setModel(name, { vision: e.target.checked })}
                          />
                          <span>images</span>
                        </label>
                        <label className="dlg-check ai-set-cap">
                          <input
                            type="checkbox"
                            checked={m.tools}
                            onChange={(e) => setModel(name, { tools: e.target.checked })}
                          />
                          <span>tools</span>
                        </label>
                        {m.tools && (
                          <select
                            className="io-input ai-set-tier"
                            aria-label={`Tools tier of ${name}`}
                            value={d.tiers[name] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value as AiTier | '';
                              const { [name]: _, ...rest } = d.tiers;
                              setD({ tiers: v ? { ...rest, [name]: v } : rest });
                            }}
                          >
                            <option value="">Auto ({cloud ? 'Full' : 'Standard'})</option>
                            {AI_TIERS.map((t) => (
                              <option key={t} value={t}>
                                {TIER_LABEL[t]}
                              </option>
                            ))}
                          </select>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {cloud && (
            <label className="dlg-check">
              <input
                type="checkbox"
                checked={d.acknowledged}
                onChange={(e) => setD({ acknowledged: e.target.checked })}
              />
              <span>
                I understand that users&apos; questions, chart data and chart pictures are sent to{' '}
                {(() => {
                  try {
                    return new URL(d.baseUrl).hostname;
                  } catch {
                    return 'this provider';
                  }
                })()}{' '}
                and billed to this key.
              </span>
            </label>
          )}
          <div className="ai-set-actions">
            <button type="button" className="io-btn" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="io-btn io-btn-primary"
              disabled={
                saving ||
                !d.name.trim() ||
                !d.baseUrl.trim() ||
                d.models.length === 0 ||
                (cloud && !d.acknowledged)
              }
              onClick={() => void save(d)}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
