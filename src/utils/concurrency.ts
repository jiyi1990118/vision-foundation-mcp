/**
 * Semaphore — limits concurrent inference requests to prevent OOM and
 * ensure responsive behavior when multiple MCP clients call simultaneously.
 *
 * @see Docs/01-architecture/11-security.md (§4.2 并发控制)
 */

export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    if (this.current > 0) this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get available(): number {
    return this.max - this.current;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

/**
 * Execute a function with a timeout. Rejects if the timeout is exceeded.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Request timed out',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${errorMessage} after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Run an abortable function with a timeout. On timeout the function's
 * AbortController is aborted (so it can cancel in-flight work such as a fetch)
 * and the returned promise rejects with a timeout error.
 */
export function withAbortableTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorMessage = 'Request timed out',
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${errorMessage} after ${timeoutMs}ms`));
    }, timeoutMs);
    fn(controller.signal)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
