import {
  ChevronsLeft,
  ChevronsRight,
  FastForward,
  Play,
  Rewind,
  Scissors,
  StepForward,
  X,
} from 'lucide-react';
import { commands, type Command } from '../commands/registry';
import { replay } from './instance';
import { useReplayStore } from './store';

const status = () => useReplayStore.getState().status;
/** Replay is on (loaded or loading): the transport commands apply. */
const running = () => ['loading', 'paused', 'playing', 'ended'].includes(status());
/** Playback controls need a loaded replay. */
const loaded = () => ['paused', 'playing', 'ended'].includes(status());

/** Bar replay commands. The first four need no running replay (toggle, select bar). */
export function registerReplayCommands(): () => void {
  const list: Command[] = [
    {
      id: 'replay.toggle',
      title: 'Bar replay',
      category: 'Replay',
      icon: Rewind,
      shortcut: 'Shift+Alt+r',
      run: () => {
        const s = status();
        if (s === 'off') replay.beginPick();
        else if (s === 'picking') replay.cancelPick();
        else replay.exit();
      },
    },
    {
      id: 'replay.selectBar',
      title: 'Replay: select bar',
      category: 'Replay',
      icon: Scissors,
      enabled: () => status() !== 'loading',
      run: () => replay.beginPick(),
    },
    {
      id: 'replay.playPause',
      title: 'Replay: play / pause',
      category: 'Replay',
      icon: Play,
      shortcut: 'Shift+Alt+Space',
      enabled: loaded,
      run: () => replay.togglePlay(),
    },
    {
      id: 'replay.step',
      title: 'Replay: step forward',
      category: 'Replay',
      icon: StepForward,
      shortcut: 'Shift+Alt+ArrowRight',
      enabled: () => status() === 'paused',
      run: () => replay.step(),
    },
    {
      id: 'replay.realtime',
      title: 'Replay: jump to realtime',
      category: 'Replay',
      icon: FastForward,
      enabled: running,
      run: () => replay.realtime(),
    },
    {
      id: 'replay.speedUp',
      title: 'Replay: faster',
      category: 'Replay',
      icon: ChevronsRight,
      enabled: running,
      run: () => replay.speedUp(),
    },
    {
      id: 'replay.speedDown',
      title: 'Replay: slower',
      category: 'Replay',
      icon: ChevronsLeft,
      enabled: running,
      run: () => replay.speedDown(),
    },
    {
      id: 'replay.exit',
      title: 'Replay: exit',
      category: 'Replay',
      icon: X,
      enabled: () => running() || status() === 'picking',
      run: () => (status() === 'picking' ? replay.cancelPick() : replay.exit()),
    },
  ];
  return commands.register(list);
}
