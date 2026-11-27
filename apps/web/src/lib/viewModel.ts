import type { CauseLabel, FlagsmithExperimentSummary, FlatSpan, GuardEvent, GuardState, InvestigationRecord, OriginSpan, TraceVerdict, FailureClass } from '@alibi/core';

/** One failing request that had the flag on. Times are milliseconds from the start of the run. */
export interface Tag {
  id: string;
  atMs: number;
  counted: boolean;
  cls: FailureClass;
  route: string;
  durationMs: number;
  reason: string;
  origins: OriginSpan[];
}

export type MomentKey = 'plain-rule' | 'arm-rule' | 'threshold' | 'switched-off' | 'recovered' | 'label';

export interface Moment {
  key: MomentKey;
  atMs: number;
  text: string;
  /** For `switched-off`: false when Flagsmith did not confirm. */
  confirmed?: boolean;
  /** For `switched-off`: what Flagsmith's answer said, as recorded. */
  detail?: string;
}

export interface TimelineLine {
  atMs: number;
  text: string;
}

/** What the engine (or the live guard) says at one moment. The page draws only this. */
export interface Snapshot {
  /** True when `newTags` and `newMoments` replace everything drawn so far (a scrub backwards, a new run). */
  reset: boolean;
  nowMs: number;
  endMs: number;
  state: GuardState;
  newTags: Tag[];
  newMoments: Moment[];
  timeline: TimelineLine[];
  record?: InvestigationRecord;
  /** Flagsmith's numbers once the run has recorded them, as recorded. */
  flagsmith?: RecordedResults;
}

export interface RecordedResults {
  atMs: number;
  /** What the run said about the reading, for example `read at the end of the watch`. */
  detail: string;
  data: FlagsmithExperimentSummary;
}

export interface RunMeta {
  name: string;
  title: string;
  planted: string;
  source: string;
  startedAtMs: number;
}

export interface Board {
  meta: RunMeta;
  nowMs: number;
  endMs: number;
  state: GuardState;
  tags: Tag[];
  moments: Moment[];
  timeline: TimelineLine[];
  record?: InvestigationRecord;
  flagsmith?: RecordedResults;
  /** Live only: the guard's own words when the flag is not in an experiment, so no experiment numbers exist. */
  flagsmithNote?: string;
  /** Live only: requests seen in the last second. */
  liveRate?: { requests: number; failures: number };
  /** Live only: requests and failures in each of the last seconds, oldest first. */
  liveHistory?: { requests: number; failures: number }[];
}

export function tagOf(verdict: TraceVerdict, baseMs: number): Tag | undefined {
  if (!verdict.failed || !verdict.flagOn || !verdict.failureClass) return undefined;
  return {
    id: verdict.traceId,
    atMs: verdict.endMs - baseMs,
    counted: verdict.counted,
    cls: verdict.failureClass,
    route: verdict.route,
    durationMs: verdict.durationMs,
    reason: verdict.reason,
    origins: verdict.origins,
  };
}

export function momentOf(event: GuardEvent, baseMs: number): Moment | undefined {
  const atMs = event.atMs - baseMs;
  switch (event.type) {
    case 'plain-rule-tripped':
      return { key: 'plain-rule', atMs, text: 'The plain rule trips' };
    case 'arm-rule-tripped':
      return { key: 'arm-rule', atMs, text: 'The arm comparison trips' };
    case 'threshold-crossed':
      return { key: 'threshold', atMs, text: `The counter passes ${event.threshold}` };
    case 'switched-off':
      return { key: 'switched-off', atMs, confirmed: event.confirmed, detail: event.detail, text: event.confirmed ? 'Switched off in Flagsmith' : 'Switch-off not confirmed' };
    case 'recovered':
      return { key: 'recovered', atMs, text: 'Back at the stable level' };
    case 'labelled':
      return { key: 'label', atMs, text: 'The label' };
    default:
      return undefined;
  }
}

/** Tags and moments from engine events. */
export function deltaOf(events: readonly GuardEvent[], baseMs: number): { tags: Tag[]; moments: Moment[] } {
  const tags: Tag[] = [];
  const moments: Moment[] = [];
  for (const event of events) {
    if (event.type === 'verdict') {
      const tag = tagOf(event.verdict, baseMs);
      if (tag) tags.push(tag);
    } else {
      const moment = momentOf(event, baseMs);
      if (moment) moments.push(moment);
    }
  }
  return { tags, moments };
}

export function boardFrom(meta: RunMeta, snapshot: Snapshot): Board {
  return {
    meta,
    nowMs: snapshot.nowMs,
    endMs: snapshot.endMs,
    state: snapshot.state,
    tags: snapshot.newTags,
    moments: snapshot.newMoments,
    timeline: snapshot.timeline,
    ...(snapshot.record ? { record: snapshot.record } : {}),
    ...(snapshot.flagsmith ? { flagsmith: snapshot.flagsmith } : {}),
  };
}

export function applySnapshot(board: Board, snapshot: Snapshot): Board {
  if (snapshot.reset) return boardFrom(board.meta, snapshot);
  return {
    meta: board.meta,
    nowMs: snapshot.nowMs,
    endMs: snapshot.endMs,
    state: snapshot.state,
    tags: snapshot.newTags.length ? [...board.tags, ...snapshot.newTags] : board.tags,
    moments: snapshot.newMoments.length ? [...board.moments, ...snapshot.newMoments] : board.moments,
    timeline: snapshot.timeline,
    ...(snapshot.record ? { record: snapshot.record } : {}),
    ...(snapshot.flagsmith ? { flagsmith: snapshot.flagsmith } : {}),
  };
}

export type Outcome =
  | { kind: 'waiting' }
  | { kind: 'on'; counted: number; failures: number }
  | { kind: 'switching'; counted: number; failures: number; confirmed: false }
  | { kind: 'off'; counted: number; failures: number }
  | { kind: 'labelled'; counted: number; failures: number; label: CauseLabel };

/** What the verdict card says, read from the engine's state. */
export function outcomeOf(board: Board): Outcome {
  const { state } = board;
  const failures = state.totals.flagOn.failures;
  const counted = state.counted;
  if (state.label) return { kind: 'labelled', counted, failures, label: state.label };
  if (state.phase === 'watching') return { kind: 'off', counted, failures };
  if (state.phase === 'switching-off') return { kind: 'switching', counted, failures, confirmed: false };
  if (state.lastSpanAtMs === undefined && failures === 0) return { kind: 'waiting' };
  return { kind: 'on', counted, failures };
}

export interface WaterfallRow {
  span: FlatSpan;
  depth: number;
  origin?: OriginSpan;
  flagged: boolean;
  /** True for spans that are only noise by default: Express middleware and pool connects off the failing path. */
  quiet: boolean;
}

export interface Waterfall {
  rows: WaterfallRow[];
  startMs: number;
  durationMs: number;
}

const isQuiet = (name: string): boolean => name.startsWith('middleware - ') || name === 'pg-pool.connect';

/**
 * Orders a request's spans as a tree for the waterfall. Origin spans come from the engine's verdict.
 * A span is quiet when it is middleware or a pool connect that is neither on the path from the root to a
 * failing span nor on the flagged path.
 */
export function waterfallOf(spans: readonly FlatSpan[], origins: readonly OriginSpan[], flaggedAttribute: string): Waterfall {
  const byParent = new Map<string | undefined, FlatSpan[]>();
  const ids = new Set(spans.map((s) => s.spanId));
  const parentOf = new Map<string, string | undefined>();
  for (const span of spans) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined;
    parentOf.set(span.spanId, parent);
    byParent.set(parent, [...(byParent.get(parent) ?? []), span]);
  }
  const onPath = new Set<string>();
  for (const origin of origins) for (let id: string | undefined = origin.spanId; id; id = parentOf.get(id)) onPath.add(id);
  const originById = new Map(origins.map((o) => [o.spanId, o]));
  const rows: WaterfallRow[] = [];
  const walk = (parent: string | undefined, depth: number, flagged: boolean): void => {
    const kids = (byParent.get(parent) ?? []).sort((a, b) => a.startMs - b.startMs);
    for (const span of kids) {
      const here = flagged || flaggedAttribute in span.attrs;
      const origin = originById.get(span.spanId);
      rows.push({ span, depth, flagged: here, quiet: isQuiet(span.name) && !here && !onPath.has(span.spanId), ...(origin ? { origin } : {}) });
      walk(span.spanId, depth + 1, here);
    }
  };
  walk(undefined, 0, false);
  const startMs = Math.min(...spans.map((s) => s.startMs));
  const endMs = Math.max(...spans.map((s) => s.endMs));
  return { rows, startMs, durationMs: Math.max(1e-6, endMs - startMs) };
}

export const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
