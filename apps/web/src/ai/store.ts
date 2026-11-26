/**
 * Ask AI state: synced preferences (setting `ai.prefs`), the server status, and one in-memory
 * conversation per chart (never saved).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { getAiStatus, type AiStatus } from './api';

// ------------------------------------------------------------ preferences

export interface AiPrefs {
  /** Chosen model; '' = the server default. */
  model: string;
  /** Attach a picture of the chart when the model can read images. */
  includeImage: boolean;
}

export const DEFAULT_AI_PREFS: AiPrefs = { model: '', includeImage: true };

export function parseAiPrefs(v: unknown): Partial<AiPrefs> {
  const out: Partial<AiPrefs> = {};
  if (!isObj(v)) return out;
  if (typeof v.model === 'string' && v.model.length <= 200) out.model = v.model;
  if (typeof v.includeImage === 'boolean') out.includeImage = v.includeImage;
  return out;
}

interface PrefsState extends AiPrefs {
  set: (patch: Partial<AiPrefs>) => void;
}

const pickPrefs = (s: AiPrefs): AiPrefs => ({ model: s.model, includeImage: s.includeImage });

export const useAiPrefs = create<PrefsState>()(
  persist<PrefsState, [], [], AiPrefs>(
    (set) => ({
      ...DEFAULT_AI_PREFS,
      set: (patch) => set(parseAiPrefs({ ...patch })),
    }),
    {
      name: 'tickerglass-ai-prefs',
      version: 1,
      partialize: pickPrefs,
      merge: (persisted, current) => ({ ...current, ...parseAiPrefs(persisted) }),
    },
  ),
);

export const readAiPrefs = (): AiPrefs => pickPrefs(useAiPrefs.getState());

// ------------------------------------------------------------ server status

interface StatusState {
  status: AiStatus | null;
  loading: boolean;
  /** The status request itself failed (API down, signed out). */
  error: string | null;
  refresh: () => Promise<void>;
}

let statusRequest: Promise<void> | null = null;

export const useAiStatus = create<StatusState>()((set) => ({
  status: null,
  loading: false,
  error: null,
  refresh: () => {
    statusRequest ??= (async () => {
      set({ loading: true });
      try {
        set({ status: await getAiStatus(), error: null });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        set({ loading: false });
        statusRequest = null;
      }
    })();
    return statusRequest;
  },
}));

/** True once the server reported the feature on. */
export const selectAiEnabled = (s: StatusState): boolean => s.status?.enabled === true;

// ------------------------------------------------------------ conversations

export interface AiContextInfo {
  /** Short label: "Visible range · 12 Mar – 4 Apr · 18 bars". */
  label: string;
  /** The brief as sent. */
  text: string;
  tokens: number;
  trimmed: readonly string[];
  /** Images attached with it. */
  images: number;
}

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  /** What the user typed / the answer so far. */
  text: string;
  /** Exactly what goes to the model for this message (user: brief + question). */
  content: string;
  images?: string[];
  context?: AiContextInfo;
  thinking?: string;
  /** Assistant only. */
  status?: 'streaming' | 'done' | 'stopped' | 'error';
  error?: string;
  model?: string;
  stats?: { evalTokens: number | null; durationMs: number | null };
}

export interface Conversation {
  messages: UiMessage[];
  /** Key of the context last sent (symbol, interval, range); a change sends a new brief. */
  contextKey: string | null;
}

interface ChatState {
  byChart: Record<string, Conversation>;
  update: (chartId: string, fn: (c: Conversation) => Conversation) => void;
  clear: (chartId: string) => void;
}

export const EMPTY_CONVERSATION: Conversation = { messages: [], contextKey: null };

export const useAiChat = create<ChatState>()((set) => ({
  byChart: {},
  update: (chartId, fn) =>
    set((s) => ({
      byChart: { ...s.byChart, [chartId]: fn(s.byChart[chartId] ?? EMPTY_CONVERSATION) },
    })),
  clear: (chartId) =>
    set((s) => {
      const { [chartId]: _gone, ...rest } = s.byChart;
      return { byChart: rest };
    }),
}));
