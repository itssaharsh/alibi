import type { FlatSpan } from './types.js';

export interface AssemblerOptions {
  /** A trace is complete when its root has arrived and nothing new came for this long. */
  settleMs?: number;
  /** A trace still open this long after its first span is released or dropped. */
  expireMs?: number;
}

export interface BufferedTrace {
  traceId: string;
  spans: FlatSpan[];
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface PollResult {
  /** Traces with a root server span that stopped growing, or that hit the expiry with a root. */
  ready: BufferedTrace[];
  /** Traces that never received a root server span before the expiry. */
  expired: BufferedTrace[];
}

interface Entry extends BufferedTrace {
  hasRoot: boolean;
  seen: Set<string>;
}

/**
 * Buffers spans by trace. Spans of one request arrive in separate batches and in any order,
 * so a request is judged only after its root span is in and the trace has been quiet for a while.
 */
export class TraceAssembler {
  readonly settleMs: number;
  readonly expireMs: number;
  private readonly open = new Map<string, Entry>();
  private readonly released = new Map<string, number>();
  private late = 0;

  constructor(options: AssemblerOptions = {}) {
    this.settleMs = options.settleMs ?? 2000;
    this.expireMs = options.expireMs ?? 30000;
  }

  /** Traces still waiting for a root or for quiet. */
  get pending(): number {
    return this.open.size;
  }

  /** Spans dropped because their trace had already been released. */
  get droppedLate(): number {
    return this.late;
  }

  add(spans: readonly FlatSpan[], nowMs: number): void {
    for (const span of spans) {
      if (this.released.has(span.traceId)) {
        this.late += 1;
        continue;
      }
      let entry = this.open.get(span.traceId);
      if (!entry) {
        entry = { traceId: span.traceId, spans: [], firstSeenMs: nowMs, lastSeenMs: nowMs, hasRoot: false, seen: new Set() };
        this.open.set(span.traceId, entry);
      }
      if (entry.seen.has(span.spanId)) continue;
      entry.seen.add(span.spanId);
      entry.spans.push(span);
      entry.lastSeenMs = nowMs;
      if (span.kind === 'server' && span.parentSpanId === undefined) entry.hasRoot = true;
    }
  }

  poll(nowMs: number): PollResult {
    const ready: BufferedTrace[] = [];
    const expired: BufferedTrace[] = [];
    for (const [traceId, entry] of this.open) {
      const settled = entry.hasRoot && nowMs - entry.lastSeenMs >= this.settleMs;
      const stale = nowMs - entry.firstSeenMs >= this.expireMs;
      if (!settled && !stale) continue;
      this.open.delete(traceId);
      this.released.set(traceId, nowMs);
      const trace: BufferedTrace = {
        traceId,
        spans: entry.spans,
        firstSeenMs: entry.firstSeenMs,
        lastSeenMs: entry.lastSeenMs,
      };
      (settled || entry.hasRoot ? ready : expired).push(trace);
    }
    for (const [traceId, at] of this.released) {
      if (nowMs - at >= this.expireMs) this.released.delete(traceId);
    }
    const order = (a: BufferedTrace, b: BufferedTrace) =>
      a.lastSeenMs - b.lastSeenMs || (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0);
    return { ready: ready.sort(order), expired: expired.sort(order) };
  }
}
