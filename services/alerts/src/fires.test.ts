import { describe, expect, it } from 'vitest';
import type { FireIn } from '@tickerglass/alerts';
import { ApiError } from './api';
import type { FireJob } from './alert-runner';
import { FireQueue } from './fires';
import { silentLogger } from './log';
import { FakeClock } from './test-utils';

const job = (revision: number, id = `f${revision}`): FireJob => ({
  alertId: 'a1',
  revision,
  body: { fireId: id, revision } as unknown as FireIn,
});

describe('FireQueue', () => {
  it('a stale revision 409 keeps a fresher queued job', async () => {
    const sent: string[] = [];
    let rejectFirst!: () => void;
    const api = {
      fire: (_id: string, body: FireIn) => {
        sent.push(body.fireId);
        if (body.fireId === 'f1')
          return new Promise<never>((_, rej) => {
            rejectFirst = () => rej(new ApiError('stale', 409));
          });
        return Promise.resolve({} as never);
      },
    };
    const q = new FireQueue({
      api,
      clock: new FakeClock(0),
      log: silentLogger,
      onConflict: () => {},
    });
    q.enqueue(job(1));
    q.drop('a1'); // alert edited -> revision 2
    q.enqueue(job(2));
    rejectFirst();
    await q.whenIdle();
    await new Promise((r) => setImmediate(r));
    await q.whenIdle();
    expect(sent).toEqual(['f1', 'f2']);
    expect(q.pending).toBe(0);
  });

  it('a 409 drops older queued jobs of the same alert', async () => {
    const sent: string[] = [];
    const api = {
      fire: (_id: string, body: FireIn) => {
        sent.push(body.fireId);
        return Promise.reject(new ApiError('stale', 409));
      },
    };
    const q = new FireQueue({
      api,
      clock: new FakeClock(0),
      log: silentLogger,
      onConflict: () => {},
    });
    q.enqueue(job(1, 'x'));
    q.enqueue(job(1, 'y'));
    await q.whenIdle();
    expect(sent).toEqual(['x']);
    expect(q.pending).toBe(0);
  });

  it('stop keeps unsent jobs queued', async () => {
    const clock = new FakeClock(0);
    const q = new FireQueue({
      api: { fire: () => Promise.reject(new Error('down')) },
      clock,
      log: silentLogger,
      onConflict: () => {},
    });
    q.enqueue(job(1));
    await new Promise((r) => setImmediate(r));
    q.stop();
    await q.whenIdle();
    expect(q.pendingFor('a1').map((j) => j.body.fireId)).toEqual(['f1']);
  });
});
