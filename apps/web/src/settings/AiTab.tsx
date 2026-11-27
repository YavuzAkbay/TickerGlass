/**
 * Settings → AI (admins): connect the server to an Ollama, see its models live, and choose which
 * ones users may pick. Saved on the server; the environment (`OLLAMA_URL`) wins when set.
 */
import { CheckCircle2, CircleAlert, Radar, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import {
  AI_TIERS,
  TIER_LABEL,
  getAiConfig,
  saveAiConfig,
  testAi,
  type AiConfig,
  type AiModel,
  type AiTestResult,
  type AiTier,
} from '../ai/api';
import { useAiStatus } from '../ai/store';
import { Row, Section } from '../dialogs/controls';
import { toast } from '../ui/Toast';
import { formatBytes } from './serverFormat';
import './aiTab.css';

type Probe =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; url: string; models: AiModel[] }
  | { state: 'error'; message: string };

function probeFrom(r: AiTestResult): Probe {
  if (r.ok) return { state: 'ok', url: r.url, models: r.models };
  const tried = r.tried && r.tried.length > 1 ? r.tried.map((t) => t.url).join(', ') : r.url;
  return { state: 'error', message: `${r.error ?? 'Not reachable'} (${tried})` };
}

export function AiTab() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [allModels, setAllModels] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [numCtx, setNumCtx] = useState(16384);
  const [tiers, setTiers] = useState<Record<string, AiTier>>({});
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const testSeq = useRef(0);

  const runTest = async (target?: string) => {
    const seq = ++testSeq.current;
    setProbe({ state: 'testing' });
    try {
      const r = await testAi(target);
      if (seq !== testSeq.current) return;
      setProbe(probeFrom(r));
      if (r.ok && !target) setUrl(r.url); // Detect fills the address it found.
    } catch (e) {
      if (seq === testSeq.current) setProbe({ state: 'error', message: errorMessage(e) });
    }
  };

  const adopt = (c: AiConfig) => {
    setConfig(c);
    setUrl(c.url ?? '');
    setAllModels(c.models.length === 0);
    setPicked(c.models);
    setDefaultModel(c.defaultModel ?? '');
    setNumCtx(c.numCtx);
    setTiers(c.tiers ?? {});
  };

  useEffect(() => {
    getAiConfig()
      .then((c) => {
        adopt(c);
        // Show what is installed right away; with nothing set up yet, look for Ollama.
        if (!c.locked) void runTest(c.url ?? undefined);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  if (loadError) return <p className="dlg-note">{loadError}</p>;
  if (!config) return <p className="dlg-note">…</p>;

  if (config.locked) {
    return (
      <Section title="Ask AI">
        <p className="dlg-note">
          Set by the server environment: <code>{config.url ?? config.provider}</code>
          {config.models.length ? ` · models: ${config.models.join(', ')}` : ''}. Change{' '}
          <code>OLLAMA_URL</code> there, or remove it to manage Ask AI here.
        </p>
      </Section>
    );
  }

  const models = probe.state === 'ok' ? probe.models : [];
  const allowed = allModels ? models.map((m) => m.name) : picked;
  const togglePick = (name: string) =>
    setPicked((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));
  const trimmedUrl = url.trim();
  const dirty =
    trimmedUrl !== (config.url ?? '') ||
    (allModels ? 0 : picked.length) !== config.models.length ||
    (!allModels && picked.some((m) => !config.models.includes(m))) ||
    defaultModel !== (config.defaultModel ?? '') ||
    numCtx !== config.numCtx ||
    JSON.stringify(tiers) !== JSON.stringify(config.tiers ?? {});

  const save = async (off = false) => {
    setSaving(true);
    try {
      const next = await saveAiConfig(
        off
          ? { url: null, models: [], defaultModel: null, numCtx: null }
          : {
              url: trimmedUrl || null,
              models: allModels ? [] : picked,
              defaultModel: defaultModel && allowed.includes(defaultModel) ? defaultModel : null,
              numCtx,
              tiers,
            },
      );
      adopt(next);
      if (off) setProbe({ state: 'idle' });
      await useAiStatus.getState().refresh();
      toast(next.source === 'app' ? 'Ask AI connected' : 'Ask AI turned off', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Section title="Ollama connection">
        <p className="dlg-note">
          Ask AI sends chart questions to an <a href="https://ollama.com">Ollama</a> server you run,
          on this machine or another one on your network. Nothing goes to the cloud.
        </p>
        <Row label="Address" htmlFor="ai-url">
          <div className="ai-set-url">
            <input
              id="ai-url"
              className="io-input"
              placeholder="http://localhost:11434"
              value={url}
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() =>
                trimmedUrl &&
                trimmedUrl !== (probe.state === 'ok' ? probe.url : '') &&
                void runTest(trimmedUrl)
              }
              onKeyDown={(e) => e.key === 'Enter' && trimmedUrl && void runTest(trimmedUrl)}
            />
            <button
              type="button"
              className="io-btn"
              disabled={probe.state === 'testing'}
              onClick={() => void runTest()}
              data-tip="Look for Ollama on this machine, the Docker host and an 'ollama' container"
            >
              <Radar size={14} /> Detect
            </button>
            <button
              type="button"
              className="io-btn"
              disabled={!trimmedUrl || probe.state === 'testing'}
              onClick={() => void runTest(trimmedUrl)}
            >
              Test
            </button>
          </div>
        </Row>
        <div className={`ai-set-status ai-set-${probe.state}`} role="status">
          {probe.state === 'testing' && 'Connecting…'}
          {probe.state === 'ok' && (
            <>
              <CheckCircle2 size={14} /> Connected to {probe.url} · {probe.models.length} chat model
              {probe.models.length === 1 ? '' : 's'}
            </>
          )}
          {probe.state === 'error' && (
            <>
              <CircleAlert size={14} /> {probe.message}
            </>
          )}
          {probe.state === 'idle' && (config.source === 'off' ? 'Not connected' : '')}
        </div>
        <div className="ai-set-actions">
          {config.source === 'app' && (
            <button
              type="button"
              className="io-btn"
              disabled={saving}
              onClick={() => void save(true)}
            >
              Turn off
            </button>
          )}
          <button
            type="button"
            className="io-btn io-btn-primary"
            disabled={saving || !trimmedUrl || !dirty || (!allModels && picked.length === 0)}
            onClick={() => void save()}
          >
            {config.source === 'app' ? 'Save' : 'Connect'}
          </button>
        </div>
        {probe.state === 'error' && (
          <p className="dlg-note">
            Is Ollama running? From Docker use <code>http://host.docker.internal:11434</code>; on
            Linux also start Ollama with <code>OLLAMA_HOST=0.0.0.0</code>.
          </p>
        )}
      </Section>

      {probe.state === 'ok' && (
        <Section title="Models">
          {models.length === 0 ? (
            <p className="dlg-note">
              No chat models installed. On the Ollama machine run{' '}
              <code>ollama pull qwen3.5:9b</code> (or <code>qwen3.8:27b</code> with 24 GB or more;
              both read chart pictures and can draw), then reload. Use 7B or larger: smaller models
              misread numbers.
            </p>
          ) : (
            <>
              <label className="dlg-check">
                <input
                  type="checkbox"
                  checked={allModels}
                  onChange={(e) => {
                    setAllModels(e.target.checked);
                    if (!e.target.checked && picked.length === 0)
                      setPicked(models.map((m) => m.name));
                  }}
                />
                <span>Users can pick any installed model</span>
              </label>
              <ul className="ai-set-models">
                {models.map((m) => (
                  <li key={m.name}>
                    <label className={`dlg-check${allModels ? ' ai-set-dim' : ''}`}>
                      <input
                        type="checkbox"
                        disabled={allModels}
                        checked={allModels || picked.includes(m.name)}
                        onChange={() => togglePick(m.name)}
                      />
                      <span className="ai-set-name">{m.name}</span>
                    </label>
                    <span className="ai-set-meta">
                      {[m.parameterSize, m.sizeBytes ? formatBytes(m.sizeBytes) : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {m.vision && <span className="ai-set-tag">reads images</span>}
                    {m.tools && <span className="ai-set-tag">chart tools</span>}
                    {m.tools && (
                      <select
                        className="io-input ai-set-tier"
                        aria-label={`Tools tier of ${m.name}`}
                        title="Basic: strict script, core chart tools (small models). Standard: freer answers, every indicator, Fibonacci and more drawings. Full: every tool, other symbols, news, chart changes (large and cloud models)."
                        value={tiers[m.name] ?? ''}
                        onChange={(e) => {
                          const v = e.target.value as AiTier | '';
                          setTiers(({ [m.name]: _, ...rest }) =>
                            v ? { ...rest, [m.name]: v } : rest,
                          );
                        }}
                      >
                        <option value="">Auto ({TIER_LABEL[m.tier]})</option>
                        {AI_TIERS.map((t) => (
                          <option key={t} value={t}>
                            {TIER_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
              <Row label="Default model" htmlFor="ai-default">
                <select
                  id="ai-default"
                  className="io-input"
                  value={allowed.includes(defaultModel) ? defaultModel : ''}
                  onChange={(e) => setDefaultModel(e.target.value)}
                >
                  <option value="">First in the list</option>
                  {allowed.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Context window" htmlFor="ai-ctx">
                <select
                  id="ai-ctx"
                  className="io-input"
                  value={numCtx}
                  onChange={(e) => setNumCtx(Number(e.target.value))}
                >
                  {[4096, 8192, 16384, 32768, 65536].map((n) => (
                    <option key={n} value={n}>
                      {n / 1024}K tokens
                      {n === 16384 ? ' (default)' : n === 32768 ? ' (reasoning models)' : ''}
                    </option>
                  ))}
                </select>
              </Row>
              <p className="dlg-note">
                Room for the chart data, the conversation, the model&apos;s reasoning and its
                answer. Larger needs more memory on the Ollama machine; reasoning models (Qwen3,
                DeepSeek-R1) work best with 16K or more.
              </p>
            </>
          )}
          <p className="dlg-note">
            <button type="button" className="ai-link" onClick={() => void runTest(probe.url)}>
              <RefreshCw size={12} /> Reload
            </button>{' '}
            Models you <code>ollama pull</code> show up here and in the Ask AI panel straight away.
          </p>
        </Section>
      )}
    </>
  );
}
