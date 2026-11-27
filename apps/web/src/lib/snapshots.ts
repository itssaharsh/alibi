import type { FlagsmithExperimentSummary, GuardEvent, Replayer, RunHeader, RunLine } from '@alibi/core';
import { deltaOf, type RecordedResults, type RunMeta, type Snapshot } from './viewModel';

export function metaOf(header: RunHeader): RunMeta {
  return { name: header.name, title: header.title, planted: header.planted, source: header.source, startedAtMs: header.startedAtMs };
}

/**
 * The last experiment results the run recorded, as recorded. The run's `results` line can land a moment after the
 * label, so the engine's record may not hold it yet; the page shows it from the first moment it was recorded.
 */
export function recordedResults(lines: readonly RunLine[]): RecordedResults | undefined {
  let found: RecordedResults | undefined;
  for (const line of lines) {
    if (line.kind === 'flagsmith' && line.what === 'results' && line.ok) {
      const d = line.data as Partial<FlagsmithExperimentSummary> | null;
      if (d && typeof d.experimentId === 'number' && Array.isArray(d.variations) && (!found || line.atMs >= found.atMs)) found = { atMs: line.atMs, detail: line.detail, data: d as FlagsmithExperimentSummary };
    }
  }
  return found;
}

/** The engine's state at `nowMs` from the run's start, with the events produced since the last snapshot. */
export function snapshotOf(
  replayer: Replayer,
  events: readonly GuardEvent[],
  reset: boolean,
  nowMs: number,
  results?: RecordedResults,
): Snapshot {
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
    ...(results && results.atMs <= base + nowMs ? { flagsmith: results } : {}),
    ...(result.record
      ? {
          record: {
            ...result.record,
            traces: [],
            ...(!result.record.flagsmith && results && results.atMs <= base + nowMs ? { flagsmith: results.data } : {}),
          },
        }
      : {}),
  };
}
