/**
 * A virtual clock for scheduler tests.
 *
 * The swarm holds agents for real seconds against a 60-second rolling window.
 * Waiting that out in a test suite is not an option, and shrinking the window
 * to milliseconds would test a different system. So time is simulated: `now`
 * and `sleep` share one timeline that only advances when nothing is runnable.
 * The budget arithmetic under test is therefore exact and deterministic.
 */

export class AbortedInTest extends Error {
  constructor() {
    super('Aborted');
    this.name = 'AbortError';
  }
}

interface VirtualTimer {
  readonly id: number;
  readonly at: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  cleanup: () => void;
}

export class VirtualClock {
  private current: number;
  private sequence = 0;
  private timers: VirtualTimer[] = [];

  constructor(startAt = 1_700_000_000_000) {
    this.current = startAt;
  }

  readonly now = (): number => this.current;

  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedInTest());
        return;
      }
      const id = (this.sequence += 1);
      const timer: VirtualTimer = {
        id,
        at: this.current + Math.max(0, ms),
        resolve,
        reject,
        cleanup: () => undefined,
      };
      const onAbort = () => {
        this.timers = this.timers.filter((candidate) => candidate.id !== id);
        reject(new AbortedInTest());
      };
      timer.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.timers.push(timer);
    });

  /** Jump the clock forward with no awaiting. For arithmetic-only assertions. */
  tick(ms: number): void {
    this.current += Math.max(0, ms);
    const due = this.timers.filter((timer) => timer.at <= this.current);
    this.timers = this.timers.filter((timer) => timer.at > this.current);
    for (const timer of due) {
      timer.cleanup();
      timer.resolve();
    }
  }

  get pending(): number {
    return this.timers.length;
  }

  get elapsedMs(): number {
    return this.current;
  }

  /** Jump to the next deadline and fire everything due. */
  advance(): boolean {
    if (this.timers.length === 0) return false;
    const next = Math.min(...this.timers.map((timer) => timer.at));
    this.current = Math.max(this.current, next);
    const due = this.timers.filter((timer) => timer.at <= this.current);
    this.timers = this.timers.filter((timer) => timer.at > this.current);
    for (const timer of due) {
      timer.cleanup();
      timer.resolve();
    }
    return due.length > 0;
  }
}

/** Let every queued microtask and macrotask run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Drive a promise to completion on a virtual clock: drain what is runnable,
 * then advance time, and repeat. Bounded so a genuine deadlock fails loudly
 * instead of hanging the suite.
 */
export async function driveClock<T>(
  clock: VirtualClock,
  work: Promise<T>,
  maxTicks = 200_000,
): Promise<T> {
  let settled = false;
  const tracked = work.then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  tracked.catch(() => undefined);

  let idleTurns = 0;
  for (let tick = 0; tick < maxTicks && !settled; tick += 1) {
    await flush();
    if (settled) break;
    if (clock.advance()) {
      idleTurns = 0;
      continue;
    }
    idleTurns += 1;
    // Nothing scheduled: give real microtask chains a few turns to settle.
    if (idleTurns > 8) break;
  }
  return tracked;
}
