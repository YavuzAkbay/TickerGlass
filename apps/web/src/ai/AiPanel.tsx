/** Navigator section "Ask AI": chat with a local model about the active chart. */
import { ArrowUp, BarChart3, RefreshCw, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useChartStore } from '../store/chart';
import { ask, resolveModel, stopAsking } from './chat';
import { Markdown } from './Markdown';
import { EMPTY_CONVERSATION, useAiChat, useAiPrefs, useAiStatus, type UiMessage } from './store';
import './ai.css';

const SUGGESTIONS = [
  'Summarize what the chart shows.',
  'Where are the key support and resistance levels?',
  'What happened in this range, and how unusual was it?',
  'What do the indicators on the chart say right now?',
];

function fmtSize(params: string | null): string {
  return params ? ` · ${params}` : '';
}

function AnswerMeta({ m }: { m: UiMessage }) {
  if (m.status === 'streaming')
    return <div className="ai-meta ai-typing">{m.text ? 'Writing…' : 'Thinking…'}</div>;
  if (m.status === 'error') return <div className="ai-meta ai-error">{m.error ?? 'Failed'}</div>;
  const parts = [m.model];
  if (m.status === 'stopped') parts.push('stopped');
  if (m.stats?.evalTokens) parts.push(`${m.stats.evalTokens} tokens`);
  if (m.stats?.durationMs) parts.push(`${(m.stats.durationMs / 1000).toFixed(1)} s`);
  return <div className="ai-meta">{parts.filter(Boolean).join(' · ')}</div>;
}

function Message({ m }: { m: UiMessage }) {
  if (m.role === 'user') {
    return (
      <div className="ai-msg ai-user">
        {m.context && (
          <details className="ai-context">
            <summary>
              <BarChart3 size={12} />
              <span>{m.context.label}</span>
              <span className="ai-faint">
                ~{m.context.tokens} tokens
                {m.context.images ? ` · ${m.context.images} image` : ''}
              </span>
            </summary>
            {m.context.trimmed.length > 0 && (
              <div className="ai-faint">Shortened to fit: {m.context.trimmed.join(', ')}</div>
            )}
            <pre>{m.context.text}</pre>
          </details>
        )}
        <div className="ai-bubble">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="ai-msg ai-assistant">
      {m.thinking && (
        <details className="ai-thinking">
          <summary>Reasoning</summary>
          <div>{m.thinking}</div>
        </details>
      )}
      {m.text && <Markdown text={m.text} />}
      <AnswerMeta m={m} />
    </div>
  );
}

export function AiPanel() {
  const { status, loading, error: statusError, refresh } = useAiStatus();
  const chartId = useChartStore((s) => s.activeId);
  const conv = useAiChat((s) => (chartId ? s.byChart[chartId] : undefined)) ?? EMPTY_CONVERSATION;
  const clear = useAiChat((s) => s.clear);
  const wanted = useAiPrefs((s) => s.model);
  const setPrefs = useAiPrefs((s) => s.set);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!status && !loading) void refresh();
  }, [status, loading, refresh]);

  const streaming = conv.messages.some((m) => m.status === 'streaming');
  const lastText = conv.messages.at(-1)?.text ?? '';
  // Follow the answer while it streams, unless the user scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, lastText]);

  if (!status) {
    return (
      <div className="ai-panel">
        <div className="ai-pad ai-faint">
          {statusError ? `Could not load AI status: ${statusError}` : 'Loading…'}
        </div>
      </div>
    );
  }
  if (!status.enabled) {
    return (
      <div className="ai-panel">
        <div className="ai-pad ai-empty">
          <h4>Ask AI is off</h4>
          <p>
            Point the server at a local <a href="https://ollama.com">Ollama</a> with{' '}
            <code>OLLAMA_URL</code> to ask questions about your charts.
          </p>
        </div>
      </div>
    );
  }

  const model = resolveModel(status, wanted);
  const canSend = !!model && !!chartId && !streaming && draft.trim().length > 0;

  const send = (text: string) => {
    const q = text.trim();
    if (!q || !model || streaming) return;
    setSendError(null);
    setDraft('');
    ask(q, { status }).catch((e: unknown) => {
      setSendError(e instanceof Error ? e.message : String(e));
      setDraft(q);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) send(draft);
    }
  };

  return (
    <div className="ai-panel">
      <div className="ai-bar">
        <select
          className="io-input ai-model"
          aria-label="Model"
          value={model?.name ?? ''}
          disabled={!status.models.length}
          onChange={(e) => setPrefs({ model: e.target.value })}
        >
          {!status.models.length && <option value="">No models</option>}
          {status.models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
              {fmtSize(m.parameterSize)}
              {m.vision ? ' · vision' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="Reload models"
          data-tip="Reload models"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          className="io-icon-btn"
          aria-label="New conversation"
          data-tip="New conversation"
          disabled={!chartId || streaming || !conv.messages.length}
          onClick={() => chartId && clear(chartId)}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {!status.reachable && (
        <div className="ai-notice ai-error">
          {status.error ?? 'Ollama is not reachable.'}{' '}
          <button type="button" className="ai-link" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {status.reachable && !status.models.length && (
        <div className="ai-notice">
          No chat models installed. On the Ollama machine run <code>ollama pull qwen2.5:7b</code>{' '}
          (or a vision model such as <code>qwen2.5vl:7b</code>), then reload.
        </div>
      )}

      <div className="ai-list" ref={listRef}>
        {conv.messages.length === 0 ? (
          <div className="ai-pad ai-empty">
            <p className="ai-faint">
              Ask about the visible part of the chart. The bars, indicator values and drawings are
              sent along with your question.
            </p>
            <div className="ai-suggest">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="io-btn"
                  disabled={!model || !chartId}
                  onClick={() => send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          conv.messages.map((m) => <Message key={m.id} m={m} />)
        )}
      </div>

      <div className="ai-composer">
        {sendError && <div className="ai-meta ai-error">{sendError}</div>}
        <div className="ai-scope ai-faint">
          <BarChart3 size={12} /> Visible range
        </div>
        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="io-input ai-input"
            rows={2}
            placeholder="Ask about this chart…"
            aria-label="Question"
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          {streaming ? (
            <button
              type="button"
              className="io-icon-btn ai-send"
              aria-label="Stop"
              data-tip="Stop"
              onClick={() => chartId && stopAsking(chartId)}
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="io-icon-btn ai-send"
              aria-label="Send"
              data-tip="Send"
              disabled={!canSend}
              onClick={() => send(draft)}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
        <div className="ai-disclaimer ai-faint">
          Answers come from a local model and can be wrong. Not financial advice.
        </div>
      </div>
    </div>
  );
}
