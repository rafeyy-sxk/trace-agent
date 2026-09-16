import { estimateCallTokens, type Reservation, type TokenBudget } from './budget';
import { AbortedError, throwIfAborted, type Sleep } from './concurrency';

/**
 * A FIFO gate in front of the token budget.
 *
 * Without it, every waiting agent polls and the winner is whoever the event
 * loop happens to wake first, which starves the agents that have been waiting
 * longest. Grants are strictly in arrival order. That means head-of-line
 * blocking — a large request at the front holds up smaller ones behind it —
 * which is the trade taken deliberately: predictable ordering beats
 * opportunistic throughput when the whole point is a legible ledger.
 */

interface Waiter {
  readonly estimate: number;
  readonly resolve: (reservation: Reservation) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  cleanup: () => void;
  settled: boolean;
}

export class BudgetGate {
  private readonly waiters: Waiter[] = [];
  private pumping = false;
  private totalWaitMs = 0;

  constructor(
    private readonly budget: TokenBudget,
    private readonly sleep: Sleep,
    private readonly now: () => number = Date.now,
  ) {}

  get waiting(): number {
    return this.waiters.length;
  }

  /** Total time all agents spent held at this gate. Reported in the ledger. */
  get waitMs(): number {
    return this.totalWaitMs;
  }

  acquire(estimate: number, signal?: AbortSignal): Promise<Reservation> {
    throwIfAborted(signal);
    const startedAt = this.now();
    return new Promise<Reservation>((resolve, reject) => {
      const waiter: Waiter = {
        estimate,
        resolve: (reservation) => {
          this.totalWaitMs += this.now() - startedAt;
          resolve(reservation);
        },
        reject,
        signal,
        cleanup: () => undefined,
        settled: false,
      };
      const onAbort = () => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new AbortedError());
      };
      waiter.cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiters.length > 0) {
        const head = this.waiters[0] as Waiter;
        if (head.settled) {
          this.waiters.shift();
          continue;
        }
        if (head.signal?.aborted) {
          head.settled = true;
          this.waiters.shift();
          head.cleanup();
          head.reject(new AbortedError());
          continue;
        }

        const wait = this.budget.waitFor(head.estimate);
        if (wait === -1) {
          head.settled = true;
          this.waiters.shift();
          head.cleanup();
          head.reject(
            new RangeError(
              `A single call needs ~${head.estimate} tokens but the per-minute ceiling is ${this.budget.limit}. Lower the per-call token cap or raise the ceiling.`,
            ),
          );
          continue;
        }
        if (wait > 0) {
          try {
            await this.sleep(Math.min(wait, 1_000), head.signal);
          } catch {
            // The head aborted; the abort handler removes it on the next turn.
          }
          continue;
        }

        const reservation = this.budget.tryReserve(head.estimate);
        if (!reservation) {
          // Lost a race with another grant in the same tick; re-evaluate.
          await this.sleep(5);
          continue;
        }
        head.settled = true;
        this.waiters.shift();
        head.cleanup();
        head.resolve(reservation);
      }
    } finally {
      this.pumping = false;
      // A waiter may have arrived while the loop was unwinding.
      if (this.waiters.length > 0) void this.pump();
    }
  }

  /** Reject everyone still waiting. Called on cancellation. */
  drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;
      waiter.cleanup();
      waiter.reject(new AbortedError());
    }
  }
}

export { estimateCallTokens };
