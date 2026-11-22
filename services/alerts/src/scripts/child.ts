/**
 * The script child process: runs the `isolated-vm` isolates for the alerts service
 * (`remoteIsolates.ts` is the other end). Built to `dist/scripthost.js` next to
 * `dist/isolate.js`. A script that makes V8 abort this process ends only this process.
 */
import { errText } from '../log';
import type { FromChild, ToChild } from './childProtocol';
import { LocalIsolate, closeHandle, type Ivm } from './isolates';
import { loadIsolateBundle } from './isolateBundle';

const send = (m: FromChild): void => {
  try {
    process.send?.(m);
  } catch {
    // the parent is gone: the disconnect handler ends this process
  }
};

async function main(): Promise<void> {
  const ivm = (await import('isolated-vm')).default as Ivm;
  const bundle = await loadIsolateBundle();
  const isolates = new Map<number, LocalIsolate>();
  let nextIso = 1;

  process.on('disconnect', () => process.exit(0));
  process.on('message', (m: ToChild, handle?: unknown) => {
    closeHandle(handle); // the parent never sends handles: do not hold on to one
    void handle_(m);
  });

  /** Heap in use plus external memory of each isolate; one that does not answer in 300 ms is left out. */
  async function heapSizes(): Promise<{ iso: number; bytes: number }[]> {
    const out: { iso: number; bytes: number }[] = [];
    await Promise.all(
      [...isolates].map(async ([iso, isolate]) => {
        const bytes = await isolate.heapBytes(300);
        if (bytes !== null) out.push({ iso, bytes });
      }),
    );
    return out;
  }

  async function handle_(m: ToChild): Promise<void> {
    switch (m.t) {
      case 'ping':
        send({ t: 'pong', rss: process.memoryUsage().rss, isolates: await heapSizes() });
        return;
      case 'dispose':
        isolates.get(m.iso)?.dispose();
        isolates.delete(m.iso);
        return;
      case 'create':
        try {
          const iso = await LocalIsolate.create(ivm, bundle, m.memoryMb, m.loadMs);
          const id = nextIso++;
          isolates.set(id, iso);
          send({ t: 'created', rid: m.rid, iso: id });
        } catch (err) {
          send({ t: 'err', rid: m.rid, message: errText(err), dead: true });
        }
        return;
      case 'call': {
        const iso = isolates.get(m.iso);
        if (!iso) {
          send({ t: 'err', rid: m.rid, message: 'Isolate is disposed', dead: true });
          return;
        }
        try {
          const r = await iso.callAsync(m.name, m.args, m.timeoutMs);
          send({ t: 'result', rid: m.rid, raw: r.raw, cpuMs: r.cpuMs });
        } catch (err) {
          const dead = iso.died;
          if (iso.isDead) isolates.delete(m.iso);
          send({ t: 'err', rid: m.rid, message: errText(err), dead });
        }
      }
    }
  }

  send({ t: 'ready' });
}

main().catch((err: unknown) => {
  send({ t: 'fatal', message: errText(err) });
  process.exit(1);
});
