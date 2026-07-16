import { describe, it, expect } from 'vitest';
import { Semaphore, withTimeout, withAbortableTimeout } from '../src/utils/concurrency.js';

describe('Semaphore', () => {
  it('limits concurrency and releases slots', async () => {
    const sem = new Semaphore(1);
    expect(sem.available).toBe(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
    sem.release();
    expect(sem.available).toBe(1);
  });

  it('resolves queued waiters in order on release', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    await sem.acquire();
    const p1 = sem.acquire().then(() => order.push('first'));
    const p2 = sem.acquire().then(() => order.push('second'));
    sem.release();
    await p1;
    sem.release();
    await p2;
    expect(order).toEqual(['first', 'second']);
  });

  it('does not underflow on double-release', async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    sem.release();
    // Double-release must not drive current negative.
    sem.release();
    expect(sem.available).toBe(1);
    // A subsequent acquire must still be capped at max.
    await sem.acquire();
    expect(sem.available).toBe(0);
    sem.release();
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects with a timeout error when the promise is too slow', async () => {
    const slow = new Promise<string>(() => {});
    await expect(withTimeout(slow, 50, 'Too slow')).rejects.toThrow('Too slow');
  });
});

describe('withAbortableTimeout', () => {
  it('passes a non-aborted signal and resolves on success', async () => {
    let captured: AbortSignal | undefined;
    const result = await withAbortableTimeout(
      async (signal) => {
        captured = signal;
        expect(signal.aborted).toBe(false);
        return 'done';
      },
      1000,
    );
    expect(result).toBe('done');
    expect(captured?.aborted).toBe(false);
  });

  it('aborts the signal and rejects with a timeout error on timeout', async () => {
    let captured: AbortSignal | undefined;
    await expect(
      withAbortableTimeout(
        async (signal) => {
          captured = signal;
          return new Promise<string>(() => {});
        },
        50,
        'Too slow',
      ),
    ).rejects.toThrow('Too slow');
    expect(captured?.aborted).toBe(true);
  });
});
