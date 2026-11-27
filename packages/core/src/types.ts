/**
 * Shared data shapes for Alibi. The engine in this package is pure: it takes
 * spans and a clock value and returns verdicts, state and events. It never
 * reads the wall clock or the network, so the same code runs in the guard
 * service and in the browser replay.
 */

export type AttrValue = string | number | boolean;

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/** One span, flattened from OTLP/HTTP JSON. Times are epoch milliseconds. */
export interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  service: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  attrs: Record<string, AttrValue>;
  events: { name: string; timeMs: number; attrs: Record<string, AttrValue> }[];
  /** True when the span's status code is ERROR. */
  error: boolean;
  statusMessage?: string;
}

/** Where a failing request failed. Only `flagged-path` counts toward a switch-off. */
export type FailureClass =
  /** Every origin error is inside the feature's own code path. */
  | 'flagged-path'
  /** An origin error is a dependency that was unavailable (refused, timed out, 5xx). */
  | 'dependency'
  /** An origin error is in the server or in shared code outside the flagged path. */
  | 'server'
  /** Origin errors of more than one class; not counted. */
  | 'mixed';

/** The span where an error started: an error span with no error span beneath it. */
export interface OriginSpan {
  spanId: string;
  name: string;
  kind: SpanKind;
  service: string;
  class: Exclude<FailureClass, 'mixed'>;
  /** True when the span, or an ancestor below the request root, is marked as the flagged path. */
  onFlaggedPath: boolean;
  /** Short machine reason, for example `db.system=postgresql ECONNREFUSED`. */
  detail: string;
  durationMs: number;
}

/** What the shop's own Flagsmith evaluation said, read from the span. */
export interface FlagEvaluation {
  flag: string;
  /** The variation's key, for example `stable` or `v2`. */
  variation: string;
  identity: string;
}

/** One span of a judged request, kept so baseline rows can count requests through a span. */
export interface SpanPoint {
  name: string;
  durationMs: number;
  error: boolean;
}

/** The engine's reading of one finished request. */
export interface TraceVerdict {
  traceId: string;
  route: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Absent when the request never evaluated the guarded flag. */
  evaluation?: FlagEvaluation;
  /** True when the evaluated variation is not the stable one. */
  flagOn: boolean;
  failed: boolean;
  /** Set only when `failed`. */
  failureClass?: FailureClass;
  origins: OriginSpan[];
  /** True when this request counts toward the switch-off. */
  counted: boolean;
  /** One sentence, generated from the origin spans, saying where it failed and why it does or does not count. */
  reason: string;
  /** Every span of the request by name, so the baseline can compare the same span in stable traces. */
  points?: SpanPoint[];
}

export interface RecoveryTolerance {
  /** Trailing window the recovery test looks at. */
  windowMs: number;
  /** Fewest requests in that window for the test to be valid. */
  minRequests: number;
  /** Error rate may exceed the stable baseline by this many percentage points. */
  errorRatePoints: number;
  /** p95 latency may be this many times the stable baseline. */
  p95Factor: number;
}

export interface GuardConfig {
  /** The Flagsmith feature name being guarded. */
  flag: string;
  /** The variation key that is the previous stable version. */
  stableVariation: string;
  /** Switch off when more than this many flag-on requests have failed on the flagged path. */
  threshold: number;
  /** How long to watch after the switch-off. */
  watchMs: number;
  tolerance: RecoveryTolerance;
  /** The comparator: a plain error-rate rule run on the same requests. */
  plainRule: { windowMs: number; minRequests: number; errorRate: number };
  /**
   * The second comparator: the flag-on arm against the stable arm. A run file written before it
   * existed has none, and the defaults apply.
   */
  armRule?: ArmRule;
}

export interface ArmRule {
  /** Trailing window both arms are measured over. */
  windowMs: number;
  /** Fewest completed requests each arm needs for the comparison to count. */
  minRequestsPerArm: number;
  /** The flag-on error rate must exceed the stable one by at least this many percentage points. */
  errorRatePoints: number;
}

/** Said once per span: failures in a dependency that only the flagged path calls. It is not a count. */
export interface Notice {
  atMs: number;
  /** The dependency span's name. */
  span: string;
  failures: number;
  text: string;
}

export type CauseLabel = 'probably the feature' | 'probably not the feature';

export interface Rates {
  requests: number;
  failures: number;
  errorRate: number;
  p95Ms: number;
}

/** One line of the baseline table: the same route and span, flag on against stable. */
export interface BaselineRow {
  route: string;
  /** The failing point's span name. */
  span: string;
  flagOn: { requests: number; failures: number; p95Ms: number };
  stable: { requests: number; failures: number; p95Ms: number };
  /** False when the stable version never runs this span; it is then compared at the route. */
  spanExistsInStable: boolean;
  /** The most common reason at this point. */
  why: string;
}

/** Which requests the stable level was measured over. */
export type StableBaselineWindow = 'before-first-counted-failure' | 'before-switch-off';

export type GuardPhase = 'armed' | 'switching-off' | 'watching' | 'closed';

export interface GuardState {
  config: GuardConfig;
  phase: GuardPhase;
  /** Flag-on requests that failed on the flagged path. */
  counted: number;
  /** Flag-on failures that did not count, by class. */
  notCounted: { dependency: number; server: number; mixed: number };
  totals: { flagOn: Rates; stable: Rates };
  /** Stable-version rates measured before the switch-off; the level recovery is tested against. */
  stableBaseline?: Rates;
  /** Says which requests `stableBaseline` was measured over. */
  stableBaselineWindow?: StableBaselineWindow;
  switchedOffAtMs?: number;
  /** True once Flagsmith confirmed the flag is off. */
  switchOffConfirmed: boolean;
  watchEndsAtMs?: number;
  recoveredAtMs?: number;
  label?: CauseLabel;
  /** When the plain error-rate rule would have switched the flag off, if it would have. */
  plainRuleTrippedAtMs?: number;
  /** When the arm comparison would have switched the flag off, if it would have. */
  armRuleTrippedAtMs?: number;
  notices?: Notice[];
  lastSpanAtMs?: number;
}

export type GuardEvent =
  | { type: 'verdict'; atMs: number; verdict: TraceVerdict; counted: number }
  | { type: 'plain-rule-tripped'; atMs: number; errorRate: number; requests: number }
  | {
      type: 'arm-rule-tripped';
      atMs: number;
      flagOnErrorRate: number;
      flagOnRequests: number;
      stableErrorRate: number;
      stableRequests: number;
    }
  | { type: 'notice'; atMs: number; notice: Notice }
  | { type: 'threshold-crossed'; atMs: number; counted: number; threshold: number }
  | { type: 'switched-off'; atMs: number; confirmed: boolean; detail: string }
  | { type: 'watch-started'; atMs: number; endsAtMs: number; stableBaseline: Rates; stableBaselineWindow?: StableBaselineWindow }
  | { type: 'recovered'; atMs: number; after: Rates }
  | { type: 'labelled'; atMs: number; label: CauseLabel; after: Rates; recordId: string };

/** What a person opens after a switch-off. It never states a cause as proven. */
export interface InvestigationRecord {
  id: string;
  flag: string;
  label: CauseLabel;
  /** Always present: who decides. */
  nextStep: 'A person investigates. Alibi does not declare the cause.';
  openedAtMs: number;
  switchedOffAtMs: number;
  threshold: number;
  counted: number;
  notCounted: { dependency: number; server: number; mixed: number };
  stableBaseline: Rates;
  stableBaselineWindow?: StableBaselineWindow;
  plainRuleTrippedAtMs?: number;
  armRuleTrippedAtMs?: number;
  notices?: Notice[];
  afterSwitchOff: Rates;
  recoveredAtMs?: number;
  baseline: BaselineRow[];
  /** The failing requests with the flag on, counted ones first. */
  traces: TraceVerdict[];
  /** Flagsmith's own experiment numbers for the guarded flag, when they were read. */
  flagsmith?: FlagsmithExperimentSummary;
  timeline: { atMs: number; text: string }[];
}

export interface FlagsmithExperimentSummary {
  experimentId: number;
  readAtMs: number;
  variations: {
    variation: string;
    exposures: number;
    metrics: { name: string; value: number; lift?: number; chanceToWin?: number; interval?: [number, number] }[];
  }[];
}

/** A recorded run: line one is the header, every other line is one batch of spans or one outside fact. */
export interface RunHeader {
  kind: 'alibi-run';
  version: 1;
  name: string;
  title: string;
  /** What was planted, in a sentence. */
  planted: string;
  config: GuardConfig;
  startedAtMs: number;
  /** Where the spans came from, for example `self-hosted Flagsmith 2.295.2, recorded 28 Nov 2026`. */
  source: string;
}

export type RunLine =
  | RunHeader
  | { kind: 'spans'; atMs: number; spans: FlatSpan[] }
  /** Something Flagsmith returned during the recorded run, replayed as it was. */
  | { kind: 'flagsmith'; atMs: number; what: 'switch-off' | 'evaluation-check' | 'results' | 'events'; ok: boolean; detail: string; data?: unknown }
  /** Something the run script did to the world, for example stopping the database. */
  | { kind: 'world'; atMs: number; text: string };
