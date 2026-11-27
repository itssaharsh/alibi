import { sleep, type Cancel, type Clock } from './clock.js';
import type { FlagsmithEvent, PostResult } from './flagsmith.js';
import type { Logger } from './log.js';

export interface ForwardCounters {
  /** Events handed to Flagsmith and answered (accepted or rejected). */
  sent: number;
  accepted: number;
  rejected: number;
  /** Events given up on: Flagsmith did not answer after every retry, or the queue was full. */
  failed: number;
  retries: number;
  queued: number;
  lastProblem?: string;
}

export interface ForwarderOptions {
  maxBatch?: number;
  flushMs?: number;
  maxQueue?: number;
  retryDelaysMs?: number[];
}

/**
 * Batches events for Flagsmith. `add` never waits: events queue up while a batch is being retried,
 * and the oldest are dropped (and counted as failed) only when the queue is full.
 */
export class Forwarder {
  private queue: FlagsmithEvent[] = [];
  private sending = false;
  private stopTimer: Cancel | undefined;
  private readonly counters: ForwardCounters = { sent: 0, accepted: 0, rejected: 0, failed: 0, retries: 0, queued: 0 };
  private readonly maxBatch: number;
  private readonly maxQueue: number;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly post: (events: readonly FlagsmithEvent[]) => Promise<PostResult>,
    private readonly clock: Clock,
    private readonly log: Logger,
    options: ForwarderOptions = {},
  ) {
    this.maxBatch = options.maxBatch ?? 200;
    this.maxQueue = options.maxQueue ?? 10000;
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1000, 2000, 4000, 8000];
    this.stopTimer = clock.every(options.flushMs ?? 2000, () => void this.flush());
  }

  get totals(): ForwardCounters {
    return { ...this.counters, queued: this.queue.length };
  }

  restoreTotals(saved: ForwardCounters): void {
    Object.assign(this.counters, saved, { queued: 0 });
  }

  add(events: readonly FlagsmithEvent[]): void {
    if (events.length === 0) return;
    this.queue.push(...events);
    const overflow = this.queue.length - this.maxQueue;
    if (overflow > 0) {
      this.queue.splice(0, overflow);
      this.counters.failed += overflow;
      this.counters.lastProblem = 'the event queue was full, so the oldest events were dropped';
    }
    if (this.queue.length >= this.maxBatch) void this.flush();
  }

  /** Sends what is queued, batch by batch. A second call while one is running does nothing; the running one picks up the rest. */
  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) await this.sendBatch(this.queue.splice(0, this.maxBatch));
    } finally {
      this.sending = false;
    }
  }

  private async sendBatch(batch: FlagsmithEvent[]): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.post(batch);
        this.counters.sent += batch.length;
        this.counters.accepted += result.accepted;
        this.counters.rejected += result.rejected;
        if (result.rejected > 0 && result.firstError) {
          this.counters.lastProblem = `Flagsmith rejected ${result.rejected} events: ${result.firstError}`;
          this.log.warn(this.counters.lastProblem);
        }
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown error';
        const delay = this.retryDelaysMs[attempt];
        if (delay === undefined) {
          this.counters.failed += batch.length;
          this.counters.lastProblem = `gave up on ${batch.length} events: ${reason}`;
          this.log.warn(this.counters.lastProblem);
          return;
        }
        this.counters.retries += 1;
        this.counters.lastProblem = `${reason}; trying again`;
        await sleep(this.clock, delay);
      }
    }
  }

  /** Stops the timer and makes one last attempt to send what is queued. */
  async close(): Promise<void> {
    this.stopTimer?.();
    this.stopTimer = undefined;
    if (this.sending) return;
    this.retryDelaysMs.length = 0;
    await this.flush();
  }
}
