/// <reference lib="webworker" />
import { createReplayer, parseRun, type FlatSpan, type Replayer, type RunLine } from '@alibi/core';
import { metaOf, recordedResults, snapshotOf } from '../lib/snapshots';
import type { RunMeta, Snapshot } from '../lib/viewModel';

export type WorkerIn =
  | { type: 'load'; name: string; url: string; dropAnswers?: boolean }
  | { type: 'seek'; seq: number; atMs: number }
  | { type: 'trace'; seq: number; id: string };

export type WorkerOut =
  | { type: 'loaded'; meta: RunMeta; endMs: number; fetchMs: number; parseMs: number }
  | { type: 'failed'; message: string }
  | { type: 'snapshot'; seq: number; snapshot: Snapshot }
  | { type: 'trace'; seq: number; id: string; spans: FlatSpan[] };

let lines: RunLine[] = [];
let replayer: Replayer | undefined;
let at = 0;
let results: ReturnType<typeof recordedResults>;
let spansByTrace: Map<string, FlatSpan[]> | undefined;

const post = (message: WorkerOut): void => (self as unknown as Worker).postMessage(message);

self.onmessage = async (event: MessageEvent<WorkerIn>) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      const t0 = performance.now();
      const response = await fetch(msg.url);
      if (!response.ok) throw new Error(`the run file did not load (${response.status})`);
      const text = await response.text();
      const t1 = performance.now();
      lines = parseRun(text);
      const t2 = performance.now();
      if (msg.dropAnswers) lines = lines.filter((l) => !(l.kind === 'flagsmith' && l.what === 'switch-off'));
      spansByTrace = undefined;
      replayer = createReplayer(lines);
      results = recordedResults(lines);
      at = 0;
      post({ type: 'loaded', meta: metaOf(replayer.header), endMs: replayer.endsAtMs - replayer.header.startedAtMs, fetchMs: t1 - t0, parseMs: t2 - t1 });
    } else if (msg.type === 'seek' && replayer) {
      const base = replayer.header.startedAtMs;
      let reset = false;
      if (msg.atMs < at) {
        replayer = createReplayer(lines);
        reset = true;
      }
      const events = replayer.step(base + msg.atMs);
      at = msg.atMs;
      post({ type: 'snapshot', seq: msg.seq, snapshot: snapshotOf(replayer, events, reset, msg.atMs, results) });
    } else if (msg.type === 'trace') {
      if (!spansByTrace) {
        spansByTrace = new Map();
        for (const line of lines) {
          if (line.kind !== 'spans') continue;
          for (const span of line.spans) spansByTrace.set(span.traceId, [...(spansByTrace.get(span.traceId) ?? []), { ...span, events: [] }]);
        }
      }
      post({ type: 'trace', seq: msg.seq, id: msg.id, spans: spansByTrace.get(msg.id) ?? [] });
    }
  } catch (error) {
    post({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
};
