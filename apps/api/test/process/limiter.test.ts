import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/http/api-error.js';
import { createLimiter } from '../../src/process/limiter.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createLimiter', () => {
  it('runs up to `concurrency` tasks at once and queues the rest', async () => {
    const limiter = createLimiter({ concurrency: 2, maxQueue: 5 });
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      limiter.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.stats()).toEqual({ active: 2, queued: 1 });

    gates[0]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[1]!.resolve();
    gates[2]!.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2]);
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('rejects immediately with SERVER_BUSY and Retry-After when the queue is full', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const queued = limiter.run(() => Promise.resolve());

    const error = await limiter.run(() => Promise.resolve()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'SERVER_BUSY', headers: { 'Retry-After': '2' } });

    gate.resolve();
    await Promise.all([running, queued]);
  });

  it('frees the slot when a task fails', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('frees the slot when a task throws synchronously', async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    await expect(
      limiter.run(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });
});
