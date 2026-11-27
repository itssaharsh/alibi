import { join } from 'node:path';
import {
  Guard,
  TraceAssembler,
  buildRecord,
  describeEvent,
  flattenOtlp,
  judgeTrace,
  makeRates,
  type FlagsmithExperimentSummary,
  type FlatSpan,
  type GuardEvent,
  type GuardSnapshot,
  type GuardState,
  type InvestigationRecord,
  type Rates,
  type RunHeader,
  type RunLine,
  type TimelineEntry,
  type TraceVerdict,
} from '@alibi/core';
import { sleep, type Cancel, type Clock, Tracker } from './clock.js';
import type { ServiceConfig } from './config.js';
import { FlagsmithApi, switchFlagOff, type FlagsmithEvent } from './flagsmith.js';
import { Forwarder, type ForwardCounters } from './forwarder.js';
import type { Logger } from './log.js';
import { Recorder } from './recorder.js';
import { RecordStore, StateFiles, type RecordSummary } from './store.js';
import { slimSpan } from './slim.js';

const TICK_MS = 1000;
const EVENTS_LINE_EVERY_TICKS = 30;
const PERSIST_DELAY_MS = 1000;
/** Flagsmith compares every variant with the one whose key is exactly `control`, so the stable version is sent under that key. */
const CONTROL_VARIANT = 'control';
const END_READ_LEAD_MS = 10000;
const REFRESH_MARGIN_MS = 1000;
const SWITCH_OFF_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const KEEP_VERDICTS = 20000;
const KEEP_RECENT = 200;
const KEEP_FAILED_TRACES = 500;
const KEEP_IDENTITIES = 500;
const KEEP_TIMELINE = 300;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface RunInfo {
  name: string;
  title: string;
  planted: string;
  startedAtMs: number;
  source: string;
  recording: boolean;
}

export interface ReceiverCounters {
  batches: number;
  spans: number;
  malformed: number;
}

export interface SwitchOffView {
  requested: boolean;
  confirmed: boolean;
  detail: string;
}

export interface StatePayload {
  state: GuardState;
  flagsmith: { forwarded: ForwardCounters; /** Set once the rollout is 0%: no more exposures or metrics are sent. */ forwardingStoppedAtMs?: number; /** Feature Health: the flag is marked unhealthy after a switch-off. Absent when Flagsmith has no such webhook. */ featureHealth?: { posts: number; lastPostedAtMs?: number; lastProblem?: string }; switchOff: SwitchOffView; results?: FlagsmithExperimentSummary };
  /** The last 200 verdicts that failed or had the flag on. */
  recent?: TraceVerdict[];
  timeline: TimelineEntry[];
  records: RecordSummary[];
  lastSpanAtMs?: number;
  run: RunInfo;
  receiver: ReceiverCounters;
}

/** What `GET /api/events` carries: every engine event, except that a request that did not fail is only counted in `rates`. */
export type StreamEvent =
  | GuardEvent
  | { type: 'rates'; atMs: number; counted: number; flagOn: Rates; stable: Rates; unflagged: Rates }
  | { type: 'world'; atMs: number; text: string };

export class ArmRefused extends Error {
  constructor() {
    super('A watch is running. Send {"force":true} to reset anyway.');
    this.name = 'ArmRefused';
  }
}

interface Persisted {
  version: 1;
  run: RunInfo;
  guard: GuardSnapshot;
  timeline: TimelineEntry[];
  switchOff: { requested: boolean; detail: string };
  results?: FlagsmithExperimentSummary;
  endReadPending: boolean;
  recordId?: string;
  forwarded: ForwardCounters;
  receiver: ReceiverCounters;
  lastSpanAtMs?: number;
  recordingPath?: string;
  forwardingStoppedAtMs?: number;
  lastRefreshAtMs?: number;
}

function isPersisted(value: unknown): value is Persisted {
  const v = value as Partial<Persisted> | null;
  return typeof v === 'object' && v !== null && v.version === 1 && typeof v.guard?.state?.config?.flag === 'string' && Array.isArray(v.timeline);
}

interface Bucket {
  durations: number[];
  failures: number;
}

const emptyBucket = (): Bucket => ({ durations: [], failures: 0 });

function describeDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export interface ServiceDeps {
  config: ServiceConfig;
  clock: Clock;
  log: Logger;
  redact: (text: string) => string;
  tracker?: Tracker;
}

/** The guard: spans in, decisions out. It reads the time only through the clock it is given. */
export class AlibiService {
  readonly tracker: Tracker;
  private readonly config: ServiceConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly api: FlagsmithApi;
  private readonly forwarder: Forwarder;
  private readonly records: RecordStore;
  private readonly files: StateFiles;

  private guard: Guard;
  private assembler: TraceAssembler;
  private verdicts: TraceVerdict[] = [];
  private unsavedVerdicts: TraceVerdict[] = [];
  private timeline: TimelineEntry[] = [];
  private recent: TraceVerdict[] = [];
  private failedTraces = new Map<string, FlatSpan[]>();
  private identities = new Map<string, boolean>();
  private window = { flagOn: emptyBucket(), stable: emptyBucket(), unflagged: emptyBucket() };
  private switchOff = { requested: false, detail: '' };
  private results: FlagsmithExperimentSummary | undefined;
  private reading = false;
  private lastRefreshAtMs: number | undefined;
  private forwardingStoppedAtMs: number | undefined;
  private health = { posts: 0 } as { posts: number; lastPostedAtMs?: number; lastProblem?: string };
  private endReadPending = false;
  private lastRecord: InvestigationRecord | undefined;
  private receiver: ReceiverCounters = { batches: 0, spans: 0, malformed: 0 };
  private lastSpanAtMs: number | undefined;
  private run: RunInfo;
  private recorder: Recorder | undefined;
  private recordingPath: string | undefined;
  private listeners = new Set<(event: StreamEvent) => void>();
  private switching = false;
  private generation = 0;
  private ticks = 0;
  private lastDrainMs = 0;
  private cancelTick: Cancel | undefined;
  private cancelPersist: Cancel | undefined;
  private cancelResults: Cancel | undefined;
  private flagsmithVersion: Promise<string | undefined> | undefined;

  constructor(deps: ServiceDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.log = deps.log;
    this.tracker = deps.tracker ?? new Tracker();
    this.api = new FlagsmithApi(
      deps.config.flagsmith,
      { flag: deps.config.guard.flag, stable: deps.config.guard.stableVariation },
      deps.redact,
      this.tracker,
    );
    this.forwarder = new Forwarder((events) => this.api.postEvents(events), deps.clock, deps.log);
    this.records = new RecordStore(deps.config.dataDir, this.tracker, deps.log);
    this.files = new StateFiles(deps.config.dataDir, this.tracker, deps.log);
    this.guard = new Guard(deps.config.guard);
    this.assembler = new TraceAssembler();
    this.run = { ...deps.config.run, startedAtMs: deps.clock.now(), source: '', recording: false };
  }

  /** Restores what a previous run left in the data directory, then starts the clock tick and the recording. */
  async start(): Promise<void> {
    await this.records.load();
    const saved = await this.files.readState();
    const restored = isPersisted(saved) && saved.guard.state.config.flag === this.config.guard.flag ? saved : undefined;
    if (restored) {
      this.guard = Guard.restore(restored.guard);
      this.run = { ...restored.run, recording: false };
      this.timeline = restored.timeline;
      this.switchOff = restored.switchOff;
      this.results = restored.results;
      this.endReadPending = restored.endReadPending;
      this.receiver = restored.receiver;
      this.lastSpanAtMs = restored.lastSpanAtMs;
      this.forwardingStoppedAtMs = restored.forwardingStoppedAtMs;
      this.lastRefreshAtMs = restored.lastRefreshAtMs;
      this.forwarder.restoreTotals(restored.forwarded);
      this.verdicts = await this.files.readVerdicts(KEEP_VERDICTS);
      for (const verdict of this.verdicts) this.remember(verdict);
      if (restored.recordId) this.lastRecord = await this.records.read(restored.recordId);
      this.log.info(`restored the guard in phase ${this.guard.phase} with ${this.verdicts.length} requests`);
    } else {
      this.run = { ...this.run, startedAtMs: this.clock.now() };
    }
    const path = this.config.recordPath ?? restored?.recordingPath;
    if (path) this.startRecording(path, restored !== undefined);
    this.cancelTick = this.clock.every(TICK_MS, () => this.tick());
    this.ensureSwitchOff();
    if (this.endReadPending) this.scheduleEndRead();
    this.schedulePersist();
  }

  async stop(): Promise<void> {
    this.cancelTick?.();
    this.cancelPersist?.();
    this.cancelResults?.();
    this.cancelTick = this.cancelPersist = this.cancelResults = undefined;
    this.generation += 1;
    await this.forwarder.close();
    this.persistNow();
    await this.files.done();
    await this.recorder?.close();
  }

  /** Waits until no Flagsmith call or file write is under way. */
  idle(): Promise<void> {
    return this.tracker.idle();
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- spans in ----

  /** Takes one OTLP/HTTP JSON body. Throws `OtlpError` when it is not a trace export. Returns the number of spans. */
  receiveOtlp(body: unknown): number {
    const spans = flattenOtlp(body);
    this.receive(spans);
    return spans.length;
  }

  noteMalformed(): void {
    this.receiver.malformed += 1;
  }

  receive(spans: readonly FlatSpan[]): void {
    this.receiver.batches += 1;
    if (spans.length === 0) return;
    const now = this.clock.now();
    this.receiver.spans += spans.length;
    this.lastSpanAtMs = now;
    this.recorder?.write({ kind: 'spans', atMs: now, spans: spans.map(slimSpan) });
    this.assembler.add(spans, now);
    this.drain(now);
    this.schedulePersist();
  }

  /** Judges every trace that has finished and lets the rule see the clock. The same steps the replay takes. */
  private drain(now: number): void {
    this.lastDrainMs = Math.max(this.lastDrainMs, now);
    for (const trace of this.assembler.poll(now).ready) {
      const verdict = judgeTrace(trace.spans, this.config.guard);
      if (!verdict) continue;
      this.onVerdict(verdict, trace.spans);
      this.emit(this.guard.ingest(verdict, now));
    }
    this.emit(this.guard.tick(now));
    this.ensureSwitchOff();
  }

  /**
   * The time to put on a line about something outside the spans: now, but never at or before the last moment
   * the rule looked. A replay applies a line at its time before the clock tick of that moment, so this keeps
   * the line after the thing that caused it.
   */
  private stamp(): number {
    return Math.max(this.clock.now(), this.lastDrainMs + 1);
  }

  /** Records a line about something outside the spans and gives the rule that moment, exactly as the replay applies it. */
  private note(line: Exclude<RunLine, RunHeader | { kind: 'spans' }>): void {
    this.recorder?.write(line);
    this.drain(line.atMs);
  }

  private onVerdict(verdict: TraceVerdict, spans: readonly FlatSpan[]): void {
    this.verdicts.push(verdict);
    this.unsavedVerdicts.push(verdict);
    if (this.verdicts.length > KEEP_VERDICTS * 2) {
      this.verdicts = this.verdicts.slice(-KEEP_VERDICTS);
      this.files.replaceVerdicts(this.verdicts);
      this.unsavedVerdicts = [];
    }
    this.remember(verdict);
    if (verdict.failed) {
      this.failedTraces.set(verdict.traceId, [...spans]);
      if (this.failedTraces.size > KEEP_FAILED_TRACES) {
        const oldest = this.failedTraces.keys().next().value;
        if (oldest !== undefined) this.failedTraces.delete(oldest);
      }
    }
    const group = verdict.evaluation ? (verdict.flagOn ? this.window.flagOn : this.window.stable) : this.window.unflagged;
    group.durations.push(verdict.durationMs);
    if (verdict.failed) group.failures += 1;
    if (verdict.evaluation && this.forwardingStoppedAtMs === undefined) this.forwarder.add(this.eventsFor(verdict, verdict.evaluation.identity));
  }

  private remember(verdict: TraceVerdict): void {
    if (verdict.failed || verdict.flagOn) {
      this.recent.push(verdict);
      if (this.recent.length > KEEP_RECENT) this.recent.shift();
    }
    const identity = verdict.evaluation?.identity;
    if (identity) {
      this.identities.delete(identity);
      this.identities.set(identity, verdict.flagOn);
      if (this.identities.size > KEEP_IDENTITIES) {
        const oldest = this.identities.keys().next().value;
        if (oldest !== undefined) this.identities.delete(oldest);
      }
    }
  }

  /** Exposure and metric events for one request, from the span's own times. */
  private eventsFor(verdict: TraceVerdict, identifier: string): FlagsmithEvent[] {
    if (identifier === '' || !verdict.evaluation) return [];
    const names = this.config.events;
    const timestamp = Math.round(verdict.endMs);
    const out: FlagsmithEvent[] = [
      {
        event: names.exposure,
        identifier,
        feature_name: verdict.evaluation.flag,
        value: verdict.evaluation.variation === this.config.guard.stableVariation ? CONTROL_VARIANT : verdict.evaluation.variation,
        timestamp,
      },
    ];
    if (!verdict.failed) out.push({ event: names.completed, identifier, timestamp, value: 1 });
    if (verdict.failed && verdict.failureClass === 'flagged-path') out.push({ event: names.failure, identifier, timestamp, value: 1 });
    out.push({ event: names.latency, identifier, timestamp, value: verdict.durationMs });
    return out;
  }

  // ---- the rule's events ----

  private emit(events: readonly GuardEvent[]): void {
    for (const event of events) {
      const entry = describeEvent(event, this.config.guard);
      if (entry && !entry.failure) this.addTimeline(entry);
      if (event.type === 'threshold-crossed') this.switchOff = { requested: true, detail: 'switch-off not confirmed yet' };
      if (event.type === 'switched-off') {
        this.switchOff.detail = event.confirmed ? event.detail : `switch-off not confirmed: ${event.detail}`;
      }
      if (event.type === 'labelled') this.onLabelled();
      if (event.type !== 'verdict' || event.verdict.failed) this.broadcast(event);
    }
    if (events.length > 0) this.schedulePersist();
  }

  private addTimeline(entry: TimelineEntry): void {
    this.timeline.push(entry);
  }

  private onLabelled(): void {
    const record = buildRecord(this.guard.state, this.verdicts, this.timeline, this.results);
    this.lastRecord = record;
    this.records.save(record);
    this.log.info(`record ${record.id} written: ${record.label}`);
    this.markUnhealthy(this.switchOff.detail, record.label);
  }

  /**
   * Tells Flagsmith's Feature Health that the flag is unhealthy, in the engine's own words: the count, the most
   * common reason, the switch-off, and after the watch the label. It stays "unhealthy" either way, because a person
   * has not looked yet; Alibi never posts "healthy". A failure is shown in the state and never stops anything.
   */
  private markUnhealthy(switchOffDetail: string, label: string | undefined): void {
    if (this.config.flagsmith.featureHealthPath === undefined) return;
    const state = this.guard.state;
    const reasons = new Map<string, number>();
    for (const v of this.verdicts) if (v.counted) reasons.set(v.reason, (reasons.get(v.reason) ?? 0) + 1);
    const common = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const textBlocks = [
      { title: 'Alibi switched this flag off', text: switchOffDetail },
      { title: 'Failures counted', text: `${state.counted} requests with the flag on failed inside the flagged path. The switch-off needs more than ${state.config.threshold}.` },
      ...(common ? [{ title: 'Most common reason', text: common }] : []),
      ...(label ? [{ title: 'After the five-minute watch', text: `${label} (not proven). A person investigates.` }] : []),
    ];
    const generation = this.generation;
    void this.api
      .postFeatureHealth({ textBlocks })
      .then(() => {
        if (generation !== this.generation) return;
        this.health = { posts: this.health.posts + 1, lastPostedAtMs: this.clock.now() };
        this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'feature-health', ok: true, detail: label ? `marked unhealthy, with the label: ${label}` : 'marked unhealthy after the switch-off', data: { textBlocks } });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.health = { ...this.health, lastProblem: reasonOf(error) };
        this.log.warn(`Feature Health was not updated: ${reasonOf(error)}`);
        this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'feature-health', ok: false, detail: reasonOf(error) });
      });
  }

  private broadcast(event: StreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private tick(): void {
    const now = this.clock.now();
    this.ticks += 1;
    this.drain(now);
    const rates = (bucket: Bucket): Rates => makeRates(bucket.durations, bucket.failures);
    this.broadcast({
      type: 'rates',
      atMs: now,
      counted: this.guard.state.counted,
      flagOn: rates(this.window.flagOn),
      stable: rates(this.window.stable),
      unflagged: rates(this.window.unflagged),
    });
    this.window = { flagOn: emptyBucket(), stable: emptyBucket(), unflagged: emptyBucket() };
    if (this.ticks % EVENTS_LINE_EVERY_TICKS === 0) {
      const { sent, accepted, rejected, failed } = this.forwarder.totals;
      this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'events', ok: failed === 0, detail: `${accepted} of ${sent} events accepted, ${rejected} rejected, ${failed} failed${this.forwardingStoppedAtMs === undefined ? '' : '; sending stopped at the switch-off'}`, data: { sent, accepted, rejected, failed, ...(this.forwardingStoppedAtMs === undefined ? {} : { forwardingStoppedAtMs: this.forwardingStoppedAtMs }) } });
    }
  }

  // ---- the switch-off ----

  /** Starts the switch-off once for the crossing the rule is waiting on. Further calls while it runs do nothing. */
  private ensureSwitchOff(): void {
    if (!this.guard.switchOffRequested || this.switching) return;
    this.switching = true;
    const generation = this.generation;
    void this.runSwitchOff(generation)
      .catch((error: unknown) => this.log.warn(`the switch-off stopped: ${reasonOf(error)}`))
      .finally(() => {
        if (generation === this.generation) this.switching = false;
      });
  }

  private pickIdentities(): string[] {
    const wanted = this.config.flagsmith.checkIdentities;
    const newestFirst = [...this.identities.entries()].reverse();
    const chosen = [
      ...newestFirst.filter(([, flagOn]) => flagOn),
      ...newestFirst.filter(([, flagOn]) => !flagOn),
    ]
      .slice(0, wanted)
      .map(([id]) => id);
    for (let n = 1; chosen.length < wanted; n += 1) chosen.push(`alibi-check-${n}`);
    return chosen;
  }

  private async runSwitchOff(generation: number): Promise<void> {
    const { flag, stableVariation } = this.config.guard;
    let patched = false;
    let done = '';
    let badChecks = 0;
    for (let attempt = 0; generation === this.generation && this.guard.switchOffRequested; attempt += 1) {
      let reason: string;
      try {
        if (!patched) {
          done = await switchFlagOff(this.api);
          patched = true;
          this.log.info(`switch-off requested for ${flag}: ${done}`);
        }
        const check = await this.api.checkIdentities(this.pickIdentities());
        if (generation !== this.generation) return;
        const now = this.stamp();
        const summary = `${check.stable} of ${check.checked} identities checked get ${stableVariation}`;
        const passed = check.stable === check.checked;
        this.addTimeline({ atMs: now, text: `Flagsmith check ${passed ? 'passed' : 'failed'}: ${summary}` });
        this.note({ kind: 'flagsmith', atMs: now, what: 'evaluation-check', ok: passed, detail: summary, data: { checked: check.checked, stable: check.stable, notStable: check.notStable } });
        if (passed) {
          const detail = `${flag} ${done} in Flagsmith; ${summary}`;
          this.note({ kind: 'flagsmith', atMs: now, what: 'switch-off', ok: true, detail });
          // With the rollout at 0% nobody is in the experiment any more: an SDK's getExperimentFlag would report
          // "not in the experiment" and track nothing. Flagsmith sets aside identities seen in more than one variant,
          // so exposures and metrics after this point would shrink the new version's arm. Events queued before this
          // moment are still sent; requests keep feeding the rule, the watch and the recording.
          this.forwardingStoppedAtMs = now;
          this.emit(this.guard.confirmSwitchOff(now, true, detail));
          this.markUnhealthy(detail, undefined);
          this.endReadPending = true;
          this.scheduleEndRead();
          return;
        }
        reason = `${check.checked - check.stable} of ${check.checked} identities checked still get the new version`;
        badChecks += 1;
        if (badChecks >= 3) {
          patched = false;
          badChecks = 0;
        }
      } catch (error) {
        reason = reasonOf(error);
      }
      if (generation !== this.generation) return;
      const now = this.stamp();
      this.log.warn(`switch-off of ${flag} is not confirmed: ${reason}`);
      this.note({ kind: 'flagsmith', atMs: now, what: 'switch-off', ok: false, detail: reason });
      this.emit(this.guard.confirmSwitchOff(now, false, reason));
      await sleep(this.clock, SWITCH_OFF_BACKOFF_MS[Math.min(attempt, SWITCH_OFF_BACKOFF_MS.length - 1)] as number);
    }
  }

  // ---- Flagsmith's own numbers ----

  /**
   * Flagsmith allows one refresh of the results per 300 seconds, and the watch lasts as long, so the guard reads
   * once: shortly before the watch ends, so the numbers are in the record when the label is written. A refusal or
   * a failure is retried once, after the time Flagsmith names or 30 seconds, and the record is then updated.
   */
  private scheduleEndRead(): void {
    const endsAt = this.guard.state.watchEndsAtMs ?? this.clock.now();
    const delay = this.guard.phase === 'closed' ? 0 : Math.max(0, endsAt - END_READ_LEAD_MS - this.clock.now());
    this.cancelResults = this.clock.after(delay, () => void this.readResults(1, true));
  }

  /** One try at refreshing and reading the results: the summary, or why there is none and when to try again. */
  private async attemptResults(refresh: boolean): Promise<{ summary: FlagsmithExperimentSummary } | { problem: string; retryAfterMs: number; refreshAgain: boolean }> {
    try {
      if (refresh) {
        const outcome = await this.api.refreshResults();
        if (outcome.limited) {
          return { problem: 'Flagsmith limits how often results can be refreshed', retryAfterMs: outcome.retryAfterMs + REFRESH_MARGIN_MS, refreshAgain: true };
        }
        this.lastRefreshAtMs = this.clock.now();
      }
      let read = await this.api.readResults(this.clock.now());
      for (let wait = 0; !read.fresh && wait < 15; wait += 1) {
        await sleep(this.clock, 1000);
        read = await this.api.readResults(this.clock.now());
      }
      // refreshed, but Flagsmith has not finished: the next try reads again without asking for another refresh
      if (read.summary.variations.length === 0) return { problem: 'Flagsmith has no results for the experiment yet', retryAfterMs: 30000, refreshAgain: false };
      return { summary: read.summary };
    } catch (error) {
      return { problem: reasonOf(error), retryAfterMs: 30000, refreshAgain: true };
    }
  }

  private resultsDetail(when: string): string {
    const stopped = this.forwardingStoppedAtMs;
    return stopped === undefined ? when : `${when}; events were sent to Flagsmith only until the switch-off at ${new Date(stopped).toISOString().slice(11, 19)} UTC, so these numbers describe the experiment as it stood then`;
  }

  private async readResults(retriesLeft: number, refresh: boolean): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    const generation = this.generation;
    const outcome = await this.attemptResults(refresh);
    if (generation !== this.generation) return;
    this.reading = false;
    if ('summary' in outcome) {
      this.results = outcome.summary;
      this.endReadPending = false;
      this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'results', ok: true, detail: this.resultsDetail('read at the end of the watch'), data: outcome.summary });
      if (this.lastRecord) {
        this.lastRecord = { ...this.lastRecord, flagsmith: outcome.summary };
        this.records.save(this.lastRecord);
      }
    } else {
      this.log.warn(`Flagsmith results were not read: ${outcome.problem}`);
      this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'results', ok: false, detail: outcome.problem });
      if (retriesLeft > 0) this.cancelResults = this.clock.after(outcome.retryAfterMs, () => void this.readResults(retriesLeft - 1, outcome.refreshAgain));
      else this.endReadPending = false;
    }
    this.schedulePersist();
  }

  /**
   * Called by the load script at the end of a scenario. A run that never switched the flag off has no record, so
   * its Flagsmith numbers are read here, once (waiting, up to the 300 second limit, if a refresh just happened).
   * Either way the recording is then closed.
   */
  async finish(): Promise<{ resultsRead: boolean }> {
    const generation = this.generation;
    let resultsRead = false;
    await this.forwarder.flush();
    if (this.guard.phase === 'armed') {
      for (let attempt = 0; attempt < 2 && !resultsRead && generation === this.generation; attempt += 1) {
        const wait = this.lastRefreshAtMs === undefined ? 0 : this.lastRefreshAtMs + 300000 + REFRESH_MARGIN_MS - this.clock.now();
        if (wait > 0) await sleep(this.clock, wait);
        const outcome = await this.attemptResults(true);
        if ('summary' in outcome) {
          this.results = outcome.summary;
          resultsRead = true;
          this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'results', ok: true, detail: 'read at the end of the run', data: outcome.summary });
        } else {
          this.log.warn(`Flagsmith results were not read: ${outcome.problem}`);
          this.note({ kind: 'flagsmith', atMs: this.stamp(), what: 'results', ok: false, detail: outcome.problem });
          if (outcome.retryAfterMs > 300000 + REFRESH_MARGIN_MS) break;
          await sleep(this.clock, outcome.retryAfterMs);
        }
      }
    }
    const recorder = this.recorder;
    this.recorder = undefined;
    this.run = { ...this.run, recording: false };
    await recorder?.close();
    this.schedulePersist();
    return { resultsRead };
  }

  // ---- state, records, world ----

  state(options: { recent: boolean } = { recent: true }): StatePayload {
    const state = this.guard.state;
    const payload: StatePayload = {
      state,
      flagsmith: {
        forwarded: this.forwarder.totals,
        ...(this.forwardingStoppedAtMs === undefined ? {} : { forwardingStoppedAtMs: this.forwardingStoppedAtMs }),
        ...(this.config.flagsmith.featureHealthPath === undefined ? {} : { featureHealth: this.health }),
        switchOff: { requested: this.switchOff.requested, confirmed: state.switchOffConfirmed, detail: this.switchOff.detail },
        ...(this.results ? { results: this.results } : {}),
      },
      timeline: this.timeline.slice(-KEEP_TIMELINE),
      records: this.records.list(),
      run: this.run,
      receiver: this.receiver,
    };
    if (options.recent) payload.recent = [...this.recent];
    if (this.lastSpanAtMs !== undefined) payload.lastSpanAtMs = this.lastSpanAtMs;
    return payload;
  }

  get phase(): string {
    return this.guard.phase;
  }

  listRecords(): RecordSummary[] {
    return this.records.list();
  }

  readRecordJson(id: string): Promise<string | undefined> {
    return this.records.readJson(id);
  }

  readRecordMarkdown(id: string): Promise<string | undefined> {
    return this.records.readMarkdown(id);
  }

  trace(traceId: string): FlatSpan[] | undefined {
    return this.failedTraces.get(traceId);
  }

  addWorld(text: string): void {
    const now = this.clock.now();
    this.addTimeline({ atMs: now, text });
    this.note({ kind: 'world', atMs: now, text });
    this.broadcast({ type: 'world', atMs: now, text });
    this.schedulePersist();
  }

  /** Resets the rule to armed for the next run. With a recording directory it also starts a new run file. */
  async arm(options: { name?: string; title?: string; planted?: string; force?: boolean }): Promise<RunInfo> {
    if ((this.guard.phase === 'watching' || this.guard.phase === 'switching-off') && options.force !== true) throw new ArmRefused();
    this.generation += 1;
    this.switching = false;
    this.cancelResults?.();
    this.cancelResults = undefined;
    this.cancelTick?.();
    await this.recorder?.close();
    this.recorder = undefined;
    this.recordingPath = undefined;
    this.guard = new Guard(this.config.guard);
    this.assembler = new TraceAssembler();
    this.verdicts = [];
    this.unsavedVerdicts = [];
    this.timeline = [];
    this.recent = [];
    this.failedTraces = new Map();
    this.identities = new Map();
    this.window = { flagOn: emptyBucket(), stable: emptyBucket(), unflagged: emptyBucket() };
    this.switchOff = { requested: false, detail: '' };
    this.results = undefined;
    this.endReadPending = false;
    this.reading = false;
    this.forwardingStoppedAtMs = undefined;
    this.health = { posts: 0 };
    this.lastRecord = undefined;
    this.ticks = 0;
    this.lastDrainMs = 0;
    this.files.clearVerdicts();
    const name = options.name ?? this.config.run.name;
    this.run = { name, title: options.title ?? name, planted: options.planted ?? this.config.run.planted, startedAtMs: this.clock.now(), source: '', recording: false };
    if (this.config.recordDir) {
      this.startRecording(join(this.config.recordDir, `${name.replace(/[^A-Za-z0-9_-]/g, '-')}.jsonl`), false);
    } else if (this.config.recordPath) {
      this.log.info('a new run was armed; ALIBI_RECORD names one file, so it is not recorded (set ALIBI_RECORD_DIR for one file per run)');
    }
    this.cancelTick = this.clock.every(TICK_MS, () => this.tick());
    this.schedulePersist();
    return this.run;
  }

  // ---- recording and saving ----

  private startRecording(path: string, resume: boolean): void {
    this.flagsmithVersion ??= this.api.version();
    const { startedAtMs, name, title, planted } = this.run;
    const config = JSON.parse(JSON.stringify(this.guard.state.config)) as RunHeader['config'];
    const header = (this.flagsmithVersion as Promise<string | undefined>).then((version): RunHeader => {
      const source = `${version ? `self-hosted Flagsmith ${version}` : 'self-hosted Flagsmith (version not reachable)'}, recorded ${describeDate(this.clock.now())}`;
      this.run = { ...this.run, source };
      return { kind: 'alibi-run', version: 1, name, title, planted, config, startedAtMs, source };
    });
    this.recorder = new Recorder(path, header, this.tracker, this.log, resume);
    this.recordingPath = path;
    this.run = { ...this.run, recording: true };
  }

  private schedulePersist(): void {
    if (this.cancelPersist) return;
    this.cancelPersist = this.clock.after(PERSIST_DELAY_MS, () => {
      this.cancelPersist = undefined;
      this.persistNow();
    });
  }

  private persistNow(): void {
    this.files.appendVerdicts(this.unsavedVerdicts);
    this.unsavedVerdicts = [];
    const saved: Persisted = {
      version: 1,
      run: this.run,
      guard: this.guard.snapshot(),
      timeline: this.timeline,
      switchOff: this.switchOff,
      endReadPending: this.endReadPending,
      forwarded: this.forwarder.totals,
      receiver: this.receiver,
    };
    if (this.results) saved.results = this.results;
    if (this.lastRecord) saved.recordId = this.lastRecord.id;
    if (this.lastSpanAtMs !== undefined) saved.lastSpanAtMs = this.lastSpanAtMs;
    if (this.recordingPath) saved.recordingPath = this.recordingPath;
    if (this.forwardingStoppedAtMs !== undefined) saved.forwardingStoppedAtMs = this.forwardingStoppedAtMs;
    if (this.lastRefreshAtMs !== undefined) saved.lastRefreshAtMs = this.lastRefreshAtMs;
    this.files.writeState(saved);
  }
}
