/** Navigator section "Ask AI": chat with a local model about the active chart. */
import {
  ArrowUp,
  BarChart3,
  CircleAlert,
  RefreshCw,
  ScanSearch,
  Square,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getActiveSession, useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { clearRangeSelect, startRangeSelect } from './attach';
import { ask, resolveModel, stopAsking, undoAiChanges } from './chat';
import { Markdown } from './Markdown';
import { EMPTY_CONVERSATION, useAiChat, useAiPrefs, useAiStatus, type UiMessage } from './store';
import './ai.css';

const SUGGESTIONS = [
  'Summarize what the chart shows.',
  'Find bullish and bearish RSI divergences and draw them.',
  'Where are the key support and resistance levels?',
  'What happened in this range, and how unusual was it?',
  'What do the indicators on the chart say right now?',
];

/** "12 Mar – 4 Apr · 18 bars" for a selected range on the active chart. */
function rangeLabel(r: { from: number; to: number }): string {
  const chart = getActiveSession()?.chart;
  const tz = chart?.timezone;
  const fmt = (t: number) =>
    new Date(t * 1000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(tz && tz !== 'local' ? { timeZone: tz } : {}),
    });
  let bars = 0;
  if (chart) {
    const time = chart.store.time;
    for (let i = 0; i < chart.store.length; i++) if (time[i]! >= r.from && time[i]! <= r.to) bars++;
  }
  return `${fmt(r.from)} – ${fmt(r.to)} · ${bars} bars`;
}

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

function Message({ m, chartId }: { m: UiMessage; chartId: string | null }) {
  if (m.role === 'tool') {
    return (
      <div className={`ai-action${m.ok === false ? ' ai-action-failed' : ''}`}>
        {m.ok === false ? <CircleAlert size={12} /> : <Wand2 size={12} />}
        <span>{m.text}</span>
      </div>
    );
  }
  // A round that only asked for tools: its actions show as chips, nothing else to say.
  if (m.role === 'assistant' && m.toolCalls?.length && !m.text && m.status === 'done') return null;
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
      {m.changes && chartId && (
        <button
          type="button"
          className="ai-link ai-undo"
          disabled={m.changesUndone}
          onClick={() => undoAiChanges(chartId, m.id)}
        >
          <Undo2 size={12} />
          {m.changesUndone ? 'AI changes removed' : 'Undo AI changes'}
        </button>
      )}
    </div>
  );
}

export function AiPanel() {
  const { status, loading, error: statusError, refresh } = useAiStatus();
  const chartId = useChartStore((s) => s.activeId);
  const conv = useAiChat((s) => (chartId ? s.byChart[chartId] : undefined)) ?? EMPTY_CONVERSATION;
  const clear = useAiChat((s) => s.clear);
  const selection = useAiChat((s) => (chartId ? s.selection[chartId] : undefined));
  const focusTick = useAiChat((s) => s.focusTick);
  const wanted = useAiPrefs((s) => s.model);
  const setPrefs = useAiPrefs((s) => s.set);
  const includeImage = useAiPrefs((s) => s.includeImage);
  const allowActions = useAiPrefs((s) => s.allowActions);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fresh status (and model list) every time the panel opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A new range selection (or "Ask AI") puts the cursor in the question box.
  useEffect(() => {
    if (focusTick) inputRef.current?.focus();
  }, [focusTick]);

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
          <h4>Ask AI is not connected</h4>
          <p>
            Ask questions about your charts with a model running on your own{' '}
            <a href="https://ollama.com">Ollama</a>. Connect it once and every user can use it.
          </p>
          <button
            type="button"
            className="io-btn io-btn-primary"
            onClick={() => useUiStore.getState().openDialog('settings', { tab: 'ai' })}
          >
            Connect Ollama…
          </button>
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
    ask(q, {
      status,
      ...(selection ? { focus: { kind: 'selection', ...selection } } : {}),
    }).catch((e: unknown) => {
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
          // Re-read the installed models whenever the list is about to be used.
          onPointerEnter={() => void refresh()}
          onFocus={() => void refresh()}
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
          No chat models installed. On the Ollama machine run <code>ollama pull qwen3.5:9b</code>{' '}
          (7B or larger works best); it shows up here straight away.
        </div>
      )}

      <div className="ai-list" ref={listRef}>
        {conv.messages.length === 0 ? (
          <div className="ai-pad ai-empty">
            <p className="ai-faint">
              Ask about the visible part of the chart, or use <em>Select range</em> to drag across
              the bars you mean. The bars, indicator values and drawings are sent along with your
              question.
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
          conv.messages.map((m) => <Message key={m.id} m={m} chartId={chartId} />)
        )}
      </div>

      <div className="ai-composer">
        {sendError && <div className="ai-meta ai-error">{sendError}</div>}
        <div className="ai-scope">
          {selection ? (
            <span className="ai-chip" title="Questions are about the selected bars">
              <ScanSearch size={12} />
              <span className="ai-chip-text">{rangeLabel(selection)}</span>
              <button
                type="button"
                className="ai-chip-x"
                aria-label="Clear selection"
                onClick={() => chartId && clearRangeSelect(chartId)}
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <span className="ai-faint ai-scope-label">
              <BarChart3 size={12} /> Visible range
            </span>
          )}
          <button
            type="button"
            className="ai-link ai-select-btn"
            disabled={!chartId}
            onClick={() => startRangeSelect()}
            data-tip="Drag across the chart to pick bars (Alt+Q)"
          >
            {selection ? 'Reselect' : 'Select range'}
          </button>
        </div>
        {model?.vision && (
          <label className="ai-image-toggle ai-faint">
            <input
              type="checkbox"
              checked={includeImage}
              onChange={(e) => setPrefs({ includeImage: e.target.checked })}
            />
            Send a picture of the chart too
          </label>
        )}
        {model?.tools ? (
          <label className="ai-image-toggle ai-faint">
            <input
              type="checkbox"
              checked={allowActions}
              onChange={(e) => setPrefs({ allowActions: e.target.checked })}
            />
            Let AI add indicators and draw on the chart
          </label>
        ) : (
          model && (
            <div className="ai-faint ai-tools-hint">
              {model.name} can only talk about the chart; pick a model with tool support (e.g.
              qwen3.5:9b, gemma4:12b, qwen3.8:27b) to let it draw.
            </div>
          )
        )}
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
