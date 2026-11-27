/**
 * Ask AI about the chart: the server's `/api/ai` routes (docs/design/local-ai.md). The chat
 * answer streams back as NDJSON, one event per line.
 */
import { ApiError, getJson, notifyUnauthorized, requestJson } from '../api/client';

export interface AiModel {
  name: string;
  vision: boolean;
  parameterSize: string | null;
  sizeBytes: number | null;
}

export type AiStatus =
  | { enabled: false }
  | {
      enabled: true;
      provider: string;
      reachable: boolean;
      error: string | null;
      models: AiModel[];
      defaultModel: string | null;
      numCtx: number;
      maxImageBytes: number;
    };

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Base64 PNG/JPEG without a `data:` prefix. */
  images?: string[];
}

export type AiEvent =
  | { t: 'delta'; text: string }
  | { t: 'thinking'; text: string }
  | {
      t: 'done';
      reason: string;
      promptTokens: number | null;
      evalTokens: number | null;
      durationMs: number | null;
    }
  | { t: 'error'; message: string };

export function getAiStatus(signal?: AbortSignal): Promise<AiStatus> {
  return getJson<AiStatus>('/ai/status', signal ? { signal } : undefined);
}

async function errorFrom(res: Response): Promise<ApiError> {
  if (res.status === 401) notifyUnauthorized();
  let detail = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
    else if (Array.isArray(body.detail)) detail = 'The request was rejected as invalid';
  } catch {
    // keep the status text
  }
  return new ApiError(detail, res.status);
}

function parseEvent(line: string): AiEvent | null {
  try {
    const v = JSON.parse(line) as { t?: unknown };
    return v && typeof v === 'object' && typeof v.t === 'string' ? (v as AiEvent) : null;
  } catch {
    return null;
  }
}

/**
 * POST a chat and call `onEvent` for every streamed event. Resolves when the stream ends;
 * rejects with ApiError on an HTTP error (status 0 when the API is unreachable) and with an
 * AbortError when `signal` aborts.
 */
export async function streamChat(
  body: { model: string; messages: AiChatMessage[] },
  onEvent: (e: AiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ApiError('Empty response', res.status);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const event = line ? parseEvent(line) : null;
      if (event) onEvent(event);
    }
  }
  const rest = buffer.trim() ? parseEvent(buffer.trim()) : null;
  if (rest) onEvent(rest);
}

// ------------------------------------------------------------ admin set-up (Settings → AI)

export interface AiConfig {
  /** env: OLLAMA_URL / AI_PROVIDER in the server environment (read-only here). */
  source: 'env' | 'app' | 'off';
  locked: boolean;
  provider: string | null;
  url: string | null;
  /** Models users may pick; empty = all installed. */
  models: string[];
  defaultModel: string | null;
}

export type AiTestResult =
  | { ok: true; url: string; models: AiModel[] }
  | {
      ok: false;
      url: string;
      error: string | null;
      tried?: { url: string; error: string | null }[];
    };

export function getAiConfig(): Promise<AiConfig> {
  return getJson<AiConfig>('/ai/config');
}

export function saveAiConfig(body: {
  url: string | null;
  models: string[];
  defaultModel: string | null;
}): Promise<AiConfig> {
  return requestJson<AiConfig>('PUT', '/ai/config', body);
}

/** Reach Ollama at `url`, or with no url try the usual addresses. */
export function testAi(url?: string): Promise<AiTestResult> {
  return requestJson<AiTestResult>('POST', '/ai/test', url ? { url } : {});
}
