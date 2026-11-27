import type { GuardEvent, Replayer, RunHeader } from '@alibi/core';
import { deltaOf, type RunMeta, type Snapshot } from './viewModel';

export function metaOf(header: RunHeader): RunMeta {
  return { name: header.name, title: header.title, planted: header.planted, source: header.source, startedAtMs: header.startedAtMs };
}

/** The engine's state at `nowMs` from the run's start, with the events produced since the last snapshot. */
export function snapshotOf(replayer: Replayer, events: readonly GuardEvent[], reset: boolean, nowMs: number): Snapshot {
  const result = replayer.result();
  const base = replayer.header.startedAtMs;
  const { tags, moments } = deltaOf(events, base);
  return {
    reset,
    nowMs,
    endMs: replayer.endsAtMs - base,
    state: result.state,
    newTags: tags,
    newMoments: moments,
    timeline: result.timeline.filter((entry) => !entry.failure).map((entry) => ({ atMs: entry.atMs - base, text: entry.text })),
    // The page lists failing requests from the tags it draws, so the record's own copy of every trace is left out here.
    ...(result.record ? { record: { ...result.record, traces: [] } } : {}),
  };
}
