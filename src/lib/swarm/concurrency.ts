/** Abort-aware primitives the scheduler is built from. */

export class AbortedError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

/**
 * A counting semaphore that records the highest concurrency actually reached,
 * so the final ledger reports a measured number rather than the configured one.
 */
export class Semaphore {
  private active = 0;
  private peak = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }> = [];

  constructor(private readonly permits: number) {
    if (permits < 1) throw new RangeError('A semaphore needs at least one permit');
  }

  get inFlight(): number {
    return this.active;
  }

  get maxObserved(): number {
    return this.peak;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.permits) {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      return this.releaseOnce();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push({
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
    });
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) {
        next.cleanup();
        next.resolve();
      }
    };
  }

  /** Reject everyone still waiting. Called on cancellation. */
  drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.cleanup();
      waiter?.reject(new AbortedError());
    }
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * A single-consumer async queue.
 *
 * Many agents produce events concurrently; one HTTP response consumes them.
 * Backpressure is deliberately absent — events are small and dropping one
 * would mean the visible trace is not the real trace.
 */
export class EventQueue<T> {
  private readonly buffer: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as never, done: true });
    }
    this.resolvers = [];
  }

  get size(): number {
    return this.buffer.length;
  }

  async *stream(): AsyncGenerator<T, void, void> {
    for (;;) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
