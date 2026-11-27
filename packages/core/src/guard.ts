import type {
  ArmRule,
  CauseLabel,
  GuardConfig,
  GuardEvent,
  GuardPhase,
  GuardState,
  Rates,
  StableBaselineWindow,
  TraceVerdict,
} from './types.js';
import { emptyRates, makeRates } from './stats.js';

/** Floating point slack so a rate exactly on the limit passes. */
const EPSILON = 1e-9;

/** Failures in a flagged-path-only dependency before a notice is raised. */
const NOTICE_AFTER = 5;

export const DEFAULT_ARM_RULE: ArmRule = { windowMs: 60000, minRequestsPerArm: 20, errorRatePoints: 10 };

export function defaultConfig(flag: string, stableVariation: string): GuardConfig {
  return {
    flag,
    stableVariation,
    threshold: 15,
    watchMs: 300000,
    tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 },
    plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 },
    armRule: { ...DEFAULT_ARM_RULE },
  };
}

export function recordIdFor(flag: string, switchedOffAtMs: number): string {
  return `${flag.replace(/[^A-Za-z0-9_-]/g, '-')}-${Math.round(switchedOffAtMs)}`;
}

/** One finished request that evaluated the guarded flag: when it ended, how long it took, whether it failed. */
interface Sample {
  t: number;
  d: number;
  f: boolean;
}

interface GuardMemory {
  /** Flag-on requests inside the plain rule's trailing window. */
  plainWindow: Sample[];
  /** Requests completed after the switch-off. */
  afterSwitchOff: Sample[];
  /** Stable-variation requests seen before the switch-off. */
  stableBefore: Sample[];
  /** When the earliest counted failure ended; the stable level is measured up to here. */
  firstCountedMs?: number;
  /** Both arms inside the arm comparison's trailing window. */
  armFlagOn: Sample[];
  armStable: Sample[];
  /** Names of spans the stable version has run. */
  stableSpans: string[];
  /** Flag-on requests lost to an unavailable dependency on the flagged path, by span name. */
  flaggedDependencyFailures: Record<string, number>;
  flagOnDurations: number[];
  stableDurations: number[];
}

/** Everything needed to carry on later: the public state plus the request samples behind its rates. */
export interface GuardSnapshot {
  state: GuardState;
  memory: GuardMemory;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The rule. It holds state, takes verdicts and a clock value, and returns events.
 * The caller performs the switch-off and reports Flagsmith's answer with `confirmSwitchOff`.
 */
export class Guard {
  private s: GuardState;
  private m: GuardMemory;
  private totalsStale = false;

  constructor(config: GuardConfig) {
    this.s = {
      config: clone(config),
      phase: 'armed',
      counted: 0,
      notCounted: { dependency: 0, server: 0, mixed: 0 },
      totals: { flagOn: emptyRates(), stable: emptyRates() },
      switchOffConfirmed: false,
    };
    this.m = {
      plainWindow: [],
      afterSwitchOff: [],
      stableBefore: [],
      armFlagOn: [],
      armStable: [],
      stableSpans: [],
      flaggedDependencyFailures: {},
      flagOnDurations: [],
      stableDurations: [],
    };
  }

  static restore(snapshot: GuardSnapshot): Guard {
    const guard = new Guard(snapshot.state.config);
    guard.s = clone(snapshot.state);
    guard.m = clone(snapshot.memory);
    return guard;
  }

  snapshot(): GuardSnapshot {
    return { state: clone(this.state), memory: clone(this.m) };
  }

  get state(): GuardState {
    if (this.totalsStale) {
      const { totals } = this.s;
      totals.flagOn = makeRates(this.m.flagOnDurations, totals.flagOn.failures);
      totals.stable = makeRates(this.m.stableDurations, totals.stable.failures);
      this.totalsStale = false;
    }
    return this.s;
  }

  get phase(): GuardPhase {
    return this.s.phase;
  }

  /** True from the moment the threshold is crossed until Flagsmith confirms the switch-off. */
  get switchOffRequested(): boolean {
    return this.s.phase === 'switching-off';
  }

  ingest(verdict: TraceVerdict, nowMs: number): GuardEvent[] {
    const events: GuardEvent[] = [];
    const s = this.s;
    s.lastSpanAtMs = nowMs;

    if (verdict.evaluation) {
      const sample: Sample = { t: verdict.endMs, d: verdict.durationMs, f: verdict.failed };
      const group = verdict.flagOn ? 'flagOn' : 'stable';
      s.totals[group].failures += verdict.failed ? 1 : 0;
      (verdict.flagOn ? this.m.flagOnDurations : this.m.stableDurations).push(verdict.durationMs);
      this.totalsStale = true;
      if (verdict.flagOn) {
        this.m.plainWindow.push(sample);
        this.m.armFlagOn.push(sample);
      } else {
        this.m.armStable.push(sample);
        for (const point of verdict.points ?? []) {
          if (!this.m.stableSpans.includes(point.name)) this.m.stableSpans.push(point.name);
        }
      }
      if (!verdict.flagOn && (s.phase === 'armed' || s.phase === 'switching-off')) {
        this.m.stableBefore.push(sample);
      }
      if (s.phase === 'watching' && s.switchedOffAtMs !== undefined && verdict.endMs > s.switchedOffAtMs) {
        this.m.afterSwitchOff.push(sample);
      }
      if (s.phase === 'armed' && verdict.flagOn && verdict.failed) {
        if (verdict.counted) {
          s.counted += 1;
          this.m.firstCountedMs = Math.min(this.m.firstCountedMs ?? verdict.endMs, verdict.endMs);
        }
        else if (verdict.failureClass && verdict.failureClass !== 'flagged-path') s.notCounted[verdict.failureClass] += 1;
      }
    }

    events.push({ type: 'verdict', atMs: nowMs, verdict, counted: s.counted });
    this.checkPlainRule(nowMs, events);
    this.checkArmRule(nowMs, events);
    this.checkNotice(verdict, nowMs, events);
    if (s.phase === 'armed' && s.counted > s.config.threshold) {
      s.phase = 'switching-off';
      events.push({ type: 'threshold-crossed', atMs: nowMs, counted: s.counted, threshold: s.config.threshold });
    }
    this.watch(nowMs, events);
    return events;
  }

  tick(nowMs: number): GuardEvent[] {
    const events: GuardEvent[] = [];
    this.checkPlainRule(nowMs, events);
    this.checkArmRule(nowMs, events);
    this.watch(nowMs, events);
    return events;
  }

  /**
   * Flagsmith's answer to the switch-off. A refusal leaves the guard waiting, so the caller can
   * retry and report again; only a confirmation starts the watch.
   */
  confirmSwitchOff(nowMs: number, ok: boolean, detail: string): GuardEvent[] {
    const s = this.s;
    if (s.phase !== 'switching-off') return [];
    if (!ok) return [{ type: 'switched-off', atMs: nowMs, confirmed: false, detail }];
    const { rates: stableBaseline, window } = this.stableLevel();
    s.phase = 'watching';
    s.switchOffConfirmed = true;
    s.switchedOffAtMs = nowMs;
    s.stableBaseline = stableBaseline;
    s.stableBaselineWindow = window;
    s.watchEndsAtMs = nowMs + s.config.watchMs;
    this.m.stableBefore = [];
    return [
      { type: 'switched-off', atMs: nowMs, confirmed: true, detail },
      { type: 'watch-started', atMs: nowMs, endsAtMs: s.watchEndsAtMs, stableBaseline, stableBaselineWindow: window },
    ];
  }

  /**
   * The stable version's level from before the trouble started. On a slow host the stable version
   * is slow too by the time the flag goes off, so measuring up to the switch-off would let a
   * degraded host pass as recovered. Falls back to everything before the switch-off when too few
   * stable requests came before the first counted failure.
   */
  private stableLevel(): { rates: Rates; window: StableBaselineWindow } {
    const all = this.m.stableBefore;
    const cutoff = this.m.firstCountedMs;
    const early = cutoff === undefined ? [] : all.filter((sample) => sample.t < cutoff);
    const useEarly = early.length >= this.s.config.tolerance.minRequests;
    return { rates: ratesOf(useEarly ? early : all), window: useEarly ? 'before-first-counted-failure' : 'before-switch-off' };
  }

  /** What a plain error-rate breaker would have done with the same flag-on requests. It never acts. */
  private checkPlainRule(nowMs: number, events: GuardEvent[]): void {
    const s = this.s;
    if (s.plainRuleTrippedAtMs !== undefined) return;
    const rule = s.config.plainRule;
    this.m.plainWindow = this.m.plainWindow.filter((sample) => sample.t > nowMs - rule.windowMs);
    const requests = this.m.plainWindow.length;
    if (requests < rule.minRequests) return;
    const errorRate = this.m.plainWindow.filter((sample) => sample.f).length / requests;
    if (errorRate <= rule.errorRate) return;
    s.plainRuleTrippedAtMs = nowMs;
    this.m.plainWindow = [];
    events.push({ type: 'plain-rule-tripped', atMs: nowMs, errorRate, requests });
  }

  /**
   * What the flag-on arm against the stable arm would have done. It stops once the flag is off,
   * because there is no flag-on arm after that. It never acts.
   */
  private checkArmRule(nowMs: number, events: GuardEvent[]): void {
    const s = this.s;
    if (s.armRuleTrippedAtMs !== undefined) return;
    if (s.phase !== 'armed' && s.phase !== 'switching-off') return;
    const rule = s.config.armRule ?? DEFAULT_ARM_RULE;
    const inWindow = (sample: Sample) => sample.t > nowMs - rule.windowMs;
    this.m.armFlagOn = this.m.armFlagOn.filter(inWindow);
    this.m.armStable = this.m.armStable.filter(inWindow);
    const on = this.m.armFlagOn;
    const stable = this.m.armStable;
    if (on.length < rule.minRequestsPerArm || stable.length < rule.minRequestsPerArm) return;
    const flagOnErrorRate = on.filter((sample) => sample.f).length / on.length;
    const stableErrorRate = stable.filter((sample) => sample.f).length / stable.length;
    if (flagOnErrorRate - stableErrorRate < rule.errorRatePoints / 100 - EPSILON) return;
    s.armRuleTrippedAtMs = nowMs;
    this.m.armFlagOn = [];
    this.m.armStable = [];
    events.push({
      type: 'arm-rule-tripped',
      atMs: nowMs,
      flagOnErrorRate,
      flagOnRequests: on.length,
      stableErrorRate,
      stableRequests: stable.length,
    });
  }

  /**
   * Failures in a dependency that only the flagged path calls never count, but a person should
   * hear about them once per span.
   */
  private checkNotice(verdict: TraceVerdict, nowMs: number, events: GuardEvent[]): void {
    if (!verdict.evaluation || !verdict.flagOn || !verdict.failed || verdict.failureClass !== 'dependency') return;
    const s = this.s;
    const names = new Set(verdict.origins.filter((o) => o.class === 'dependency' && o.onFlaggedPath).map((o) => o.name));
    for (const span of names) {
      const failures = (this.m.flaggedDependencyFailures[span] ?? 0) + 1;
      this.m.flaggedDependencyFailures[span] = failures;
      const known = (s.notices ?? []).some((notice) => notice.span === span);
      if (failures < NOTICE_AFTER || known || this.m.stableSpans.includes(span)) continue;
      const notice = {
        atMs: nowMs,
        span,
        failures,
        text: `${failures} requests with the flag on failed in ${span}, a dependency that only the flagged path calls and that was unavailable. By the rule these do not count toward the switch-off. The stable version never makes this call, so a person should look.`,
      };
      s.notices = [...(s.notices ?? []), notice];
      events.push({ type: 'notice', atMs: nowMs, notice });
    }
  }

  private watch(nowMs: number, events: GuardEvent[]): void {
    const s = this.s;
    if (s.phase !== 'watching' || s.watchEndsAtMs === undefined || !s.stableBaseline) return;
    if (nowMs >= s.watchEndsAtMs) {
      this.close(nowMs, s.watchEndsAtMs, events);
      return;
    }
    if (s.recoveredAtMs !== undefined) return;
    const tolerance = s.config.tolerance;
    // The whole window must lie after the switch-off, or the first quick requests could latch a pass
    // before a slow host shows in them.
    if (s.switchedOffAtMs === undefined || nowMs - s.switchedOffAtMs < tolerance.windowMs) return;
    const window = this.m.afterSwitchOff.filter((sample) => sample.t > nowMs - tolerance.windowMs);
    if (window.length < tolerance.minRequests) return;
    const rates = ratesOf(window);
    const baseline = s.stableBaseline;
    const errorOk = rates.errorRate <= baseline.errorRate + tolerance.errorRatePoints / 100 + EPSILON;
    const latencyOk = rates.p95Ms <= baseline.p95Ms * tolerance.p95Factor + EPSILON;
    if (!errorOk || !latencyOk) return;
    s.recoveredAtMs = nowMs;
    events.push({ type: 'recovered', atMs: nowMs, after: rates });
  }

  private close(nowMs: number, watchEndsAtMs: number, events: GuardEvent[]): void {
    const s = this.s;
    const label: CauseLabel = s.recoveredAtMs === undefined ? 'probably not the feature' : 'probably the feature';
    const after = ratesOf(this.m.afterSwitchOff.filter((sample) => sample.t <= watchEndsAtMs));
    s.label = label;
    s.phase = 'closed';
    this.m.afterSwitchOff = [];
    this.m.plainWindow = [];
    events.push({
      type: 'labelled',
      atMs: nowMs,
      label,
      after,
      recordId: recordIdFor(s.config.flag, s.switchedOffAtMs ?? nowMs),
    });
  }
}

function ratesOf(samples: readonly Sample[]): Rates {
  return makeRates(
    samples.map((sample) => sample.d),
    samples.filter((sample) => sample.f).length,
  );
}
