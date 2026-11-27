import type { FlatSpan } from '@alibi/core';
import type { RunMeta, Snapshot } from './viewModel';
import type { WorkerIn, WorkerOut } from '../worker/replay.worker';

/** Talks to the worker that holds one run file and the engine playing it. */
export class ReplayClient {
  private worker = new Worker(new URL('../worker/replay.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0;
  private waiting = new Map<number, (value: WorkerOut) => void>();
  private loadWaiter?: { resolve: (v: { meta: RunMeta; endMs: number }) => void; reject: (e: Error) => void };
  /** Timings of the last load, for measuring on a slow machine. */
  /** Called while the run file arrives, with the bytes so far. */
  onProgress?: (loaded: number, total: number) => void;
  static timings: { fetchMs: number; parseMs: number } | undefined;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerOut>) => {
      const msg = event.data;
      if (msg.type === 'progress') this.onProgress?.(msg.loaded, msg.total);
      else if (msg.type === 'loaded') {
        ReplayClient.timings = { fetchMs: msg.fetchMs, parseMs: msg.parseMs };
        (window as unknown as { __alibiTimings?: unknown }).__alibiTimings = ReplayClient.timings;
        this.loadWaiter?.resolve({ meta: msg.meta, endMs: msg.endMs });
      }
      else if (msg.type === 'failed') this.loadWaiter?.reject(new Error(msg.message));
      else this.waiting.get(msg.seq)?.(msg);
    };
  }

  private send(message: WorkerIn): void {
    this.worker.postMessage(message);
  }

  load(name: string, url: string, dropAnswers = false, size?: number): Promise<{ meta: RunMeta; endMs: number }> {
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.send({ type: 'load', name, url, dropAnswers, ...(size ? { size } : {}) });
    });
  }

  seek(atMs: number): Promise<Snapshot> {
    const seq = (this.seq += 1);
    return new Promise((resolve) => {
      this.waiting.set(seq, (msg) => {
        this.waiting.delete(seq);
        if (msg.type === 'snapshot') resolve(msg.snapshot);
      });
      this.send({ type: 'seek', seq, atMs });
    });
  }

  trace(id: string): Promise<FlatSpan[]> {
    const seq = (this.seq += 1);
    return new Promise((resolve) => {
      this.waiting.set(seq, (msg) => {
        this.waiting.delete(seq);
        resolve(msg.type === 'trace' ? msg.spans : []);
      });
      this.send({ type: 'trace', seq, id });
    });
  }

  close(): void {
    this.worker.terminate();
  }
}
