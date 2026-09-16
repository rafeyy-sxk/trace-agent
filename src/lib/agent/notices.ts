/**
 * A side channel for things that happen *inside* a model call.
 *
 * The agent loop only regains control between calls, so a client-side 429
 * backoff — which can stall a run for two minutes — produces no event at all.
 * For an app whose entire claim is that nothing is hidden, a silent two-minute
 * pause is a defect. The loop drains this queue at every step boundary.
 */

export interface PendingNotice {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly message: string;
}

export class NoticeSink {
  private queue: PendingNotice[] = [];

  push(notice: PendingNotice): void {
    this.queue.push(notice);
  }

  drain(): PendingNotice[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get size(): number {
    return this.queue.length;
  }
}
