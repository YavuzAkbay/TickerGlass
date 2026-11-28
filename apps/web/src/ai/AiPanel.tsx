/** Navigator section "Ask AI": chat with a local model about the active chart. */
import {
  Activity,
  AlignLeft,
  ArrowUp,
  ArrowUpRight,
  BarChart3,
  CircleAlert,
  Gauge,
  Image as ImageIcon,
  Info,
  RefreshCw,
  ScanSearch,
  SeparatorHorizontal,
  Sparkles,
  Square,
  SquarePen,
  Undo2,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { getActiveSession, useChartStore } from '../store/chart';
import { useUiStore } from '../store/ui';
import { TIER_LABEL } from './api';
import { clearRangeSelect, startRangeSelect } from './attach';
import { ask, resolveModel, stopAsking, undoAiChanges } from './chat';
import { Markdown } from './Markdown';
import {
  CONTEXT_WINDOWS,
  EMPTY_CONVERSATION,
  useAiChat,
  useAiPrefs,
  useAiStatus,
  type UiMessage,
} from './store';
import './ai.css';

const SUGGESTIONS: { text: string; icon: LucideIcon }[] = [
  { text: 'Summarize what the chart shows.', icon: AlignLeft },
  { text: 'Mark the key support and resistance levels.', icon: SeparatorHorizontal },
  { text: 'Find the latest RSI divergence and draw it.', icon: Activity },
  { text: 'What happened in this range, and how unusual was it?', icon: ScanSearch },
  { text: 'What do the indicators on the chart say right now?', icon: Gauge },
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
    return (
      <div className="ai-meta ai-typing">
        <span className="ai-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {m.text ? 'Writing…' : 'Thinking…'}
      </div>
    );
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
  const userCtx = useAiPrefs((s) => s.numCtx);
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

  // Grow the question box with its text, up to a limit.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // Busy for the whole run: tool rounds and the picture wait have no streaming message.
  const asking = useAiChat((s) => (chartId ? !!s.asking[chartId] : false));
  const streaming = asking || conv.messages.some((m) => m.status === 'streaming');
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
        <div className="ai-model-wrap">
          <Sparkles size={13} className="ai-model-icon" aria-hidden="true" />
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
                {m.tools ? ` · ${TIER_LABEL[m.tier] ?? m.tier}` : ''}
                {m.cloud ? ' · cloud' : ''}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="io-icon-btn ai-bar-btn"
          aria-label="Reload models"
          data-tip="Reload models"
          data-tip-side="bottom"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={loading ? 'ai-spin' : undefined} />
        </button>
        <button
          type="button"
          className="io-icon-btn ai-bar-btn"
          aria-label="New conversation"
          data-tip="New conversation"
          data-tip-side="bottom"
          disabled={!chartId || streaming || !conv.messages.length}
          onClick={() => chartId && clear(chartId)}
        >
          <SquarePen size={14} />
        </button>
      </div>

      {!status.reachable && (
        <div className="ai-notice ai-error">
          <CircleAlert size={14} />
          <span>
            {status.error ?? 'Ollama is not reachable.'}{' '}
            <button type="button" className="ai-link" onClick={() => void refresh()}>
              Retry
            </button>
          </span>
        </div>
      )}
      {status.reachable && !status.models.length && (
        <div className="ai-notice">
          <Info size={14} />
          <span>
            No chat models installed. On the Ollama machine run <code>ollama pull qwen3.5:9b</code>{' '}
            (7B or larger works best); it shows up here straight away.
          </span>
        </div>
      )}

      <div className="ai-list" ref={listRef}>
        {conv.messages.length === 0 ? (
          <div className="ai-welcome">
            <div className="ai-hero">
              <div className="ai-hero-mark" aria-hidden="true">
                <Sparkles size={20} />
              </div>
              <h3>Ask about this chart</h3>
              <p>
                Questions cover the visible bars, or{' '}
                <button
                  type="button"
                  className="ai-link"
                  disabled={!chartId}
                  onClick={() => startRangeSelect()}
                >
                  select a range
                </button>{' '}
                to focus on the ones you mean. Bars, indicator values and drawings go along with
                each question.
              </p>
            </div>
            <div className="ai-suggest-label">Try asking</div>
            <div className="ai-suggest">
              {SUGGESTIONS.map(({ text, icon: Icon }) => (
                <button
                  key={text}
                  type="button"
                  className="ai-suggestion"
                  disabled={!model || !chartId}
                  onClick={() => send(text)}
                >
                  <span className="ai-suggestion-icon">
                    <Icon size={14} />
                  </span>
                  <span className="ai-suggestion-text">{text}</span>
                  <ArrowUpRight size={14} className="ai-suggestion-go" />
                </button>
              ))}
            </div>
            <p className="ai-legal">
              <Info size={12} />
              <span>
                Answers are generated by a language model for information and education only. They
                are not financial advice, investment recommendations or consultation, and can be
                wrong.
              </span>
            </p>
          </div>
        ) : (
          conv.messages.map((m) => <Message key={m.id} m={m} chartId={chartId} />)
        )}
      </div>

      <div className="ai-composer">
        {sendError && (
          <div className="ai-send-error">
            <CircleAlert size={12} />
            <span>{sendError}</span>
          </div>
        )}
        {model && !model.tools && (
          <div className="ai-tools-hint">
            {model.name} can only talk about the chart; pick a model with tool support (e.g.
            qwen3.5:9b, gemma4:12b, qwen3.8:27b) to let it draw.
          </div>
        )}
        <div className={`ai-box${streaming ? ' ai-box-busy' : ''}`}>
          <div className="ai-scope">
            {selection ? (
              <span className="ai-chip ai-chip-on" title="Questions are about the selected bars">
                <ScanSearch size={12} />
                <span className="ai-chip-text">{rangeLabel(selection)}</span>
                <button
                  type="button"
                  className="ai-chip-x"
                  aria-label="Clear selection"
                  onClick={() => chartId && clearRangeSelect(chartId)}
                >
                  <X size={11} />
                </button>
              </span>
            ) : (
              <span className="ai-chip">
                <BarChart3 size={12} />
                <span className="ai-chip-text">Visible range</span>
              </span>
            )}
            <button
              type="button"
              className="ai-link ai-select-btn"
              disabled={!chartId}
              onClick={() => startRangeSelect()}
              data-tip="Drag across the chart to pick bars (Alt+Q)"
              data-tip-side="top"
            >
              {selection ? 'Reselect' : 'Select range'}
            </button>
          </div>
          <textarea
            ref={inputRef}
            className="ai-input"
            rows={1}
            placeholder="Ask about this chart…"
            aria-label="Question"
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="ai-tools">
            {model?.tools && (
              <button
                type="button"
                className={`ai-toggle${allowActions ? ' on' : ''}`}
                aria-pressed={allowActions}
                data-tip={allowActions ? 'AI can add indicators and draw' : 'AI only answers'}
                data-tip-side="top"
                onClick={() => setPrefs({ allowActions: !allowActions })}
              >
                <Wand2 size={13} />
                Draw
              </button>
            )}
            {model?.vision && (
              <button
                type="button"
                className={`ai-toggle${includeImage ? ' on' : ''}`}
                aria-pressed={includeImage}
                data-tip="Send a picture of the chart too"
                data-tip-side="top"
                onClick={() => setPrefs({ includeImage: !includeImage })}
              >
                <ImageIcon size={13} />
                Image
              </button>
            )}
            <label className="ai-ctx" data-tip="Context window" data-tip-side="top">
              <span className="ai-sr">Context window</span>
              <select
                value={userCtx}
                onChange={(e) => setPrefs({ numCtx: Number(e.target.value) })}
              >
                <option value={0}>Auto · {Math.round(status.numCtx / 1024)}K</option>
                {CONTEXT_WINDOWS.map((n) => (
                  <option key={n} value={n}>
                    {n / 1024}K ctx
                  </option>
                ))}
              </select>
            </label>
            <span className="ai-tools-spacer" />
            {streaming ? (
              <button
                type="button"
                className="ai-send ai-stop"
                aria-label="Stop"
                data-tip="Stop"
                data-tip-side="top"
                onClick={() => chartId && stopAsking(chartId)}
              >
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="ai-send"
                aria-label="Send"
                data-tip="Send (Enter)"
                data-tip-side="top"
                disabled={!canSend}
                onClick={() => send(draft)}
              >
                <ArrowUp size={15} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
        <div className="ai-disclaimer">
          AI-generated, can be wrong. For information only: not financial advice or a recommendation
          to buy or sell.
        </div>
      </div>
    </div>
  );
}
