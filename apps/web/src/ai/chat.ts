/**
 * Sending a question: build the brief for the chart, append the user message and a streaming
 * answer to the chart's conversation, and fill the answer in as events arrive.
 */
import type { BriefFocus, ChartBrief } from '@tickerglass/ai-context';
import type { Chart } from '@tickerglass/engine';
import { errorMessage } from '../api/client';
import { foldHistorySince, historyMark } from '../drawings/actions';
import { findIndicator, removeIndicators } from '../indicators/actions';
import { getActiveSession, runInSession } from '../store/chart';
import { streamChat, type AiChatMessage, type AiModel, type AiStatus } from './api';
import { briefBudget, briefFromChart, visibleFocus } from './context';
import { restoreChanges } from './fullTools';
import { chartImage } from './image';
import {
  removeAiDrawings,
  runTool,
  MAX_TOOL_ROUNDS,
  schemasFor,
  type AiChanges,
  type ToolCall,
  type ToolContext,
} from './tools';
import { useAiChat, useAiPrefs, type AiContextInfo, type UiMessage } from './store';

const controllers = new Map<string, AbortController>();
let seq = 0;
const nextId = (): string => `ai_${Date.now().toString(36)}_${(seq++).toString(36)}`;

function fullWindow(numCtx: number): string {
  return `Ran out of room: the ${Math.round(numCtx / 1024)}K context window is full, so the answer was cut off. Pick a larger context window below the question box (32K or more for reasoning models), ask about a shorter range, or start a new conversation.`;
}

export const OMITTED_CONTEXT = '[Earlier chart context omitted; see the latest CHART CONTEXT.]';

type EnabledStatus = Extract<AiStatus, { enabled: true }>;

/** The model to use: the saved choice when the server still offers it, else its default. */
export function resolveModel(status: EnabledStatus, wanted: string): AiModel | null {
  return (
    status.models.find((m) => m.name === wanted) ??
    status.models.find((m) => m.name === status.defaultModel) ??
    status.models[0] ??
    null
  );
}

export function isAsking(chartId: string): boolean {
  return controllers.has(chartId);
}

export function stopAsking(chartId: string): void {
  controllers.get(chartId)?.abort();
}

function shortDate(t: number, tz: string): string {
  try {
    return new Date(t * 1000).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...(tz === 'local' ? {} : { timeZone: tz }),
    });
  } catch {
    return new Date(t * 1000).toISOString().slice(0, 10);
  }
}

export function focusLabel(chart: Chart, focus: BriefFocus, brief: ChartBrief): string {
  const kind = focus.kind === 'selection' ? 'Selection' : 'Visible range';
  if (!brief.stats) return `${kind} · no bars`;
  const tz = chart.timezone;
  return `${kind} · ${shortDate(brief.stats.from, tz)} – ${shortDate(brief.stats.to, tz)} · ${brief.focusBars} bars`;
}

/** The calls of the assistant message at `at` that have a result right after it, and those results. */
function answeredCalls(
  messages: readonly UiMessage[],
  at: number,
  calls: readonly ToolCall[],
): { calls: ToolCall[]; results: UiMessage[] } {
  const results: UiMessage[] = [];
  for (let j = at + 1; j < messages.length && messages[j]!.role === 'tool'; j++)
    results.push(messages[j]!);
  const free = [...results];
  const kept: ToolCall[] = [];
  const used = new Set<UiMessage>();
  for (const call of calls) {
    const k = free.findIndex((r) => (r.toolName ?? '') === call.name);
    if (k < 0) continue;
    used.add(free.splice(k, 1)[0]!);
    kept.push(call);
  }
  return { calls: kept, results: results.filter((r) => used.has(r)) };
}

/** Messages for the API: only the latest chart context is sent in full. */
export function apiMessages(messages: readonly UiMessage[]): AiChatMessage[] {
  let latestContext = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.context) latestContext = i;
  });
  const out: AiChatMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      // Providers reject `tool_calls` without a result for each, so a round that was stopped,
      // cut off or never run sends only the calls that were answered (results follow the
      // assistant message; each answers the oldest unanswered call of its name, like the server).
      const answered = m.toolCalls?.length ? answeredCalls(messages, i, m.toolCalls) : null;
      if (answered?.calls.length) {
        out.push({ role: 'assistant', content: m.text, tool_calls: answered.calls });
        for (const r of answered.results)
          out.push({ role: 'tool', content: r.content, tool_name: r.toolName ?? '' });
      }
      // Failed or empty answers are left out; the next question follows the last good one.
      else if (m.text) out.push({ role: 'assistant', content: m.text });
      return;
    }
    // Tool results are emitted with the assistant message they answer; any others are orphans.
    if (m.role === 'tool') return;
    const content =
      m.context && i !== latestContext ? `${OMITTED_CONTEXT}\n\n${m.text}` : m.content;
    out.push({
      role: 'user',
      content,
      ...(m.images?.length && i === latestContext ? { images: m.images } : {}),
    });
  });
  return out;
}

export interface AskOptions {
  status: EnabledStatus;
  /** Defaults to the visible range. */
  focus?: BriefFocus;
}

/**
 * Ask about the active chart. Resolves when the answer is complete, stopped or failed (the
 * outcome is on the assistant message); throws only when nothing could be sent.
 */
export async function ask(question: string, opts: AskOptions): Promise<void> {
  const session = getActiveSession();
  if (!session) throw new Error('No chart');
  const { id: chartId, chart } = session;
  if (controllers.has(chartId)) throw new Error('An answer is already being written');
  const model = resolveModel(opts.status, useAiPrefs.getState().model);
  if (!model) throw new Error('No model is available');
  const focus = opts.focus ?? visibleFocus(chart);
  if (!focus) throw new Error('The chart has no bars yet');
  // Read-only tools (fundamentals, levels, swings...) always; chart changes only when allowed.
  const tier = model.tier ?? 'basic';
  const useTools = model.tools;
  const tools = schemasFor(tier, useAiPrefs.getState().allowActions);
  const userCtx = useAiPrefs.getState().numCtx;
  // Cloud providers own their context window; Ollama's is the user's or the server's.
  const numCtx = model.contextTokens ?? (userCtx || opts.status.numCtx);
  const brief = briefFromChart(chart, focus, briefBudget(numCtx, useTools, tools.length));
  if (!brief) throw new Error('The chart has no bars yet');

  const last = chart.store.length ? chart.store.time[chart.store.length - 1] : 0;
  const key = [chart.getSymbol(), chart.getInterval(), focus.kind, focus.from, focus.to, last].join(
    '|',
  );
  const conv = useAiChat.getState().byChart[chartId];
  const newContext = key !== conv?.contextKey;
  // Claim the chart before the (async) picture so a second click cannot send twice.
  const controller = new AbortController();
  controllers.set(chartId, controller);
  let images: string[] = [];
  if (newContext && model.vision && useAiPrefs.getState().includeImage) {
    try {
      const img = await chartImage(chart, focus, opts.status.maxImageBytes);
      if (img) images = [img];
    } catch {
      // No picture: the text brief still goes.
    }
  }
  const context: AiContextInfo | undefined = newContext
    ? {
        label: focusLabel(chart, focus, brief),
        text: brief.text,
        tokens: brief.approxTokens,
        trimmed: brief.trimmed,
        images: images.length,
      }
    : undefined;
  const userMsg: UiMessage = {
    id: nextId(),
    role: 'user',
    text: question,
    content: newContext ? `${brief.text}\n\nQuestion: ${question}` : question,
    ...(images.length ? { images } : {}),
    ...(context ? { context } : {}),
  };
  const { update } = useAiChat.getState();
  update(chartId, (c) => ({
    messages: [...c.messages, userMsg],
    contextKey: newContext ? key : c.contextKey,
  }));
  const append = (m: UiMessage): void =>
    update(chartId, (c) => ({ ...c, messages: [...c.messages, m] }));
  let answerId = '';
  const patch = (fn: (m: UiMessage) => Partial<UiMessage>): void =>
    update(chartId, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === answerId ? { ...m, ...fn(m) } : m)),
    }));

  const changes: AiChanges = { indicators: [], drawings: [] };
  const ctx: ToolContext = { chartId, chart, focus, changes, tier };
  const mark = runInSession(chartId, historyMark);
  let rounds = 0;
  try {
    for (;;) {
      answerId = nextId();
      append({
        id: answerId,
        role: 'assistant',
        text: '',
        content: '',
        status: 'streaming',
        model: model.name,
      });
      const history = useAiChat
        .getState()
        .byChart[chartId]!.messages.filter((m) => m.id !== answerId);
      let calls: ToolCall[] = [];
      await streamChat(
        {
          model: model.name,
          messages: apiMessages(history),
          ...(useTools ? { tools } : {}),
          ...(userCtx && !model.contextTokens ? { numCtx: userCtx } : {}),
        },
        (e) => {
          switch (e.t) {
            case 'delta':
              patch((m) => ({ text: m.text + e.text }));
              break;
            case 'thinking':
              patch((m) => ({ thinking: (m.thinking ?? '') + e.text }));
              break;
            case 'tool_calls':
              calls = e.calls;
              patch(() => ({ toolCalls: e.calls }));
              break;
            case 'done':
              patch(() => ({
                stats: { evalTokens: e.evalTokens, durationMs: e.durationMs },
                // Ollama stops with `length` when the context window is full: the answer
                // was cut off, not finished.
                ...(e.reason === 'length'
                  ? { status: 'error' as const, error: fullWindow(numCtx) }
                  : { status: 'done' as const }),
              }));
              break;
            case 'error':
              patch(() => ({ status: 'error', error: e.message }));
              break;
          }
        },
        controller.signal,
      );
      // A stream that ended without `done` or `error` was cut off.
      patch((m) =>
        m.status === 'streaming' ? { status: 'error', error: 'The answer was cut off' } : {},
      );
      const current = useAiChat
        .getState()
        .byChart[chartId]?.messages.find((m) => m.id === answerId);
      if (!calls.length && current?.status === 'done' && !current.text.trim())
        patch(() => ({
          status: 'error',
          error: 'The model finished without an answer. Ask again, or try a larger model.',
        }));
      if (!calls.length || current?.status !== 'done') break;
      if (++rounds > MAX_TOOL_ROUNDS[tier]) {
        patch(() => ({ text: '_Stopped after too many chart actions._' }));
        break;
      }
      for (const call of calls) {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const offered = tools.some((t) => t.function.name === call.name);
        const r = offered
          ? await runTool(ctx, call)
          : {
              content: JSON.stringify({
                error: `${call.name} is not available: the user has not allowed chart changes`,
              }),
              summary: `Skipped ${call.name} (chart changes off)`,
              ok: false,
            };
        append({
          id: nextId(),
          role: 'tool',
          text: r.summary,
          content: r.content,
          toolName: call.name,
          ok: r.ok,
        });
      }
    }
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    patch(() => (aborted ? { status: 'stopped' } : { status: 'error', error: errorMessage(e) }));
    // The server never saw a question it refused: let the next one resend the context.
    if (!aborted && newContext && rounds === 0)
      update(chartId, (c) => ({ ...c, contextKey: conv?.contextKey ?? null }));
  } finally {
    controllers.delete(chartId);
    if (changes.indicators.length || changes.drawings.length || changes.restore) {
      runInSession(chartId, () => foldHistorySince(mark, `AI: ${question.slice(0, 40)}`));
      patch(() => ({ changes }));
    }
  }
}

/** Remove what the AI added while answering (the button under the answer); one undo step. */
export function undoAiChanges(chartId: string, messageId: string): void {
  const msg = useAiChat.getState().byChart[chartId]?.messages.find((m) => m.id === messageId);
  const changes = msg?.changes;
  if (!changes || msg.changesUndone) return;
  runInSession(chartId, () => {
    const mark = historyMark();
    const live = changes.indicators.filter((id) => findIndicator(id));
    if (live.length) removeIndicators(live);
    removeAiDrawings(chartId, changes.drawings);
    if (changes.restore) restoreChanges(changes.restore);
    foldHistorySince(mark, 'Undo AI changes');
  });
  useAiChat.getState().update(chartId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? { ...m, changesUndone: true } : m)),
  }));
}
