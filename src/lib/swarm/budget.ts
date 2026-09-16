/**
 * The rolling token budget.
 *
 * This is the piece that makes a swarm possible on a free tier. Groq's limit
 * is tokens per minute, enforced as a rolling window. Firing 100 agents at it
 * produces 429s and a run that never finishes; the fix is to make the client
 * hold its own agents at a gate that models the same window the provider is
 * enforcing, and let them through only as older spend ages out.
 *
 * Reservations are made with an UPPER BOUND estimate before the call, and
 * reconciled against real usage after it. An underestimate is absorbed into
 * the window and delays the next dispatch rather than being lost.
 */

export interface TokenBudgetOptions {
  readonly limitPerMinute: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  /**
   * Fraction of the limit kept unspent. The provider's window and ours are
   * not phase-aligned, so aiming for exactly 100% reliably produces 429s.
   */
  readonly headroom?: number;
}

export interface Reservation {
  readonly id: number;
  readonly at: number;
  readonly estimate: number;
}

interface Entry {
  readonly id: number;
  readonly at: number;
  tokens: number;
  settled: boolean;
}

export interface SpendSample {
  readonly at: number;
  readonly tokens: number;
}

export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_HEADROOM = 0.1;

export class TokenBudget {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly headroom: number;
  private entries: Entry[] = [];
  private nextId = 1;
  private rawLimit: number;
  private cooldownUntil = 0;
  private peakUsage = 0;

  constructor(options: TokenBudgetOptions) {
    this.rawLimit = Math.max(1, options.limitPerMinute);
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.headroom = options.headroom ?? DEFAULT_HEADROOM;
  }

  /** The effective ceiling, after headroom. */
  get limit(): number {
    return Math.max(1, Math.floor(this.rawLimit * (1 - this.headroom)));
  }

  get declaredLimit(): number {
    return this.rawLimit;
  }

  /**
   * Adopt the ceiling the provider reported in `x-ratelimit-limit-tokens`.
   * Beats any number compiled into the app, which is why it exists.
   */
  calibrate(limitFromProvider: number): boolean {
    if (!Number.isFinite(limitFromProvider) || limitFromProvider < 1) return false;
    if (limitFromProvider === this.rawLimit) return false;
    this.rawLimit = limitFromProvider;
    return true;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    if (this.entries.length > 0 && (this.entries[0] as Entry).at >= cutoff) return;
    this.entries = this.entries.filter((entry) => entry.at >= cutoff);
  }

  spentInWindow(): number {
    this.prune();
    return this.entries.reduce((total, entry) => total + entry.tokens, 0);
  }

  /** Highest spend seen inside any single window during this run. */
  get peak(): number {
    return this.peakUsage;
  }

  cooldownRemaining(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /** Hold every agent until `ms` from now. Used after a real 429. */
  penalise(ms: number): void {
    const until = this.now() + Math.max(0, ms);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  /**
   * Milliseconds to wait before `estimate` tokens would fit.
   * `0` means now. `-1` means it can never fit and the caller must fail fast.
   */
  waitFor(estimate: number): number {
    const cooldown = this.cooldownRemaining();
    if (cooldown > 0) return cooldown;
    if (estimate > this.limit) return -1;
    this.prune();
    const spent = this.entries.reduce((total, entry) => total + entry.tokens, 0);
    if (spent + estimate <= this.limit) return 0;

    const need = spent + estimate - this.limit;
    let freed = 0;
    const nowMs = this.now();
    for (const entry of this.entries) {
      freed += entry.tokens;
      if (freed >= need) return Math.max(1, entry.at + this.windowMs - nowMs);
    }
    return this.windowMs;
  }

  /** Take `estimate` tokens if they fit right now, otherwise return null. */
  tryReserve(estimate: number): Reservation | null {
    if (this.waitFor(estimate) !== 0) return null;
    const reservation: Reservation = { id: this.nextId++, at: this.now(), estimate };
    this.entries.push({ id: reservation.id, at: reservation.at, tokens: estimate, settled: false });
    this.peakUsage = Math.max(this.peakUsage, this.spentInWindow());
    return reservation;
  }

  /** Replace an estimate with what the call actually cost. */
  settle(reservation: Reservation, actualTokens: number): void {
    const entry = this.entries.find((candidate) => candidate.id === reservation.id);
    if (!entry) return;
    entry.tokens = Math.max(0, actualTokens);
    entry.settled = true;
    this.peakUsage = Math.max(this.peakUsage, this.spentInWindow());
  }

  /** The call never reached the provider; give the estimate back. */
  release(reservation: Reservation): void {
    this.entries = this.entries.filter((entry) => entry.id !== reservation.id);
  }

  /** Settled spend, for asserting after the fact that no window was exceeded. */
  history(): SpendSample[] {
    return this.entries.map((entry) => ({ at: entry.at, tokens: entry.tokens }));
  }
}

const CHARS_PER_TOKEN = 3.2;
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * A deliberately pessimistic prompt-token estimate.
 *
 * English averages ~4 chars per token; using 3.2 over-counts, which is the
 * side to be wrong on when the number is used to decide whether to dispatch.
 */
export function estimatePromptTokens(messages: readonly { content: string }[]): number {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil((message.content?.length ?? 0) / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Upper bound for one model call: the prompt we are about to send, plus the
 * tool specs, plus the full completion cap we allow.
 */
export function estimateCallTokens(
  messages: readonly { content: string }[],
  maxCompletionTokens: number,
  toolSpecTokens = 0,
): number {
  return estimatePromptTokens(messages) + toolSpecTokens + maxCompletionTokens;
}
