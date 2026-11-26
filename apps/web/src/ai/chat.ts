/**
 * Sending a question: build the brief for the chart, append the user message and a streaming
 * answer to the chart's conversation, and fill the answer in as events arrive.
 */
import type { BriefFocus, ChartBrief } from '@tickerglass/ai-context';
import type { Chart } from '@tickerglass/engine';
import { errorMessage } from '../api/client';
import { getActiveSession } from '../store/chart';
import { streamChat, type AiChatMessage, type AiModel, type AiStatus } from './api';
import { briefBudget, briefFromChart, visibleFocus } from './context';
import { useAiChat, useAiPrefs, type AiContextInfo, type UiMessage } from './store';

const controllers = new Map<string, AbortController>();
let seq = 0;
const nextId = (): string => `ai_${Date.now().toString(36)}_${(seq++).toString(36)}`;

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

/** Messages for the API: only the latest chart context is sent in full. */
export function apiMessages(messages: readonly UiMessage[]): AiChatMessage[] {
  let latestContext = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.context) latestContext = i;
  });
  const out: AiChatMessage[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      // Failed or empty answers are left out; the next question follows the last good one.
      if (m.text) out.push({ role: 'assistant', content: m.text });
      return;
    }
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
  /** Base64 image(s) of the chart to attach with a new context. */
  images?: string[];
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
  const brief = briefFromChart(chart, focus, briefBudget(opts.status.numCtx));
  if (!brief) throw new Error('The chart has no bars yet');

  const last = chart.store.length ? chart.store.time[chart.store.length - 1] : 0;
  const key = [chart.getSymbol(), chart.getInterval(), focus.kind, focus.from, focus.to, last].join(
    '|',
  );
  const conv = useAiChat.getState().byChart[chartId];
  const newContext = key !== conv?.contextKey;
  const images = newContext && model.vision ? (opts.images ?? []) : [];
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
  const answerId = nextId();
  const answer: UiMessage = {
    id: answerId,
    role: 'assistant',
    text: '',
    content: '',
    status: 'streaming',
    model: model.name,
  };
  const { update } = useAiChat.getState();
  update(chartId, (c) => ({
    messages: [...c.messages, userMsg, answer],
    contextKey: newContext ? key : c.contextKey,
  }));
  const patch = (fn: (m: UiMessage) => Partial<UiMessage>): void =>
    update(chartId, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === answerId ? { ...m, ...fn(m) } : m)),
    }));

  const history = useAiChat.getState().byChart[chartId]!.messages.filter((m) => m.id !== answerId);
  const controller = new AbortController();
  controllers.set(chartId, controller);
  try {
    await streamChat(
      { model: model.name, messages: apiMessages(history) },
      (e) => {
        switch (e.t) {
          case 'delta':
            patch((m) => ({ text: m.text + e.text }));
            break;
          case 'thinking':
            patch((m) => ({ thinking: (m.thinking ?? '') + e.text }));
            break;
          case 'done':
            patch(() => ({
              status: 'done',
              stats: { evalTokens: e.evalTokens, durationMs: e.durationMs },
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
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    patch(() => (aborted ? { status: 'stopped' } : { status: 'error', error: errorMessage(e) }));
    // The server never saw a question it refused: let the next one resend the context.
    if (!aborted && newContext)
      update(chartId, (c) => ({ ...c, contextKey: conv?.contextKey ?? null }));
  } finally {
    controllers.delete(chartId);
  }
}
