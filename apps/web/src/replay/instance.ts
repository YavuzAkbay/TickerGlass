import { getChart } from '../store/chart';
import { useAppStore } from '../store/app';
import { replayFeed } from '../chart/feed';
import { toast } from '../ui/Toast';
import { ReplayController } from './controller';
import { useReplayStore } from './store';

export const replay = new ReplayController({
  feed: replayFeed,
  getChart,
  prepost: () => useAppStore.getState().prepost,
  onError: (message) => toast(message, 'error'),
});

// Expose for debugging and e2e tests.
if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.VITE_E2E === '1')) {
  (window as unknown as { replay?: unknown }).replay = {
    controller: replay,
    store: useReplayStore,
    feed: replayFeed,
  };
}
