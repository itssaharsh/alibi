import { describe, expect, it } from 'vitest';
import { defaultConfig, Guard, recordIdFor } from '../src/guard.js';
import type { GuardEvent } from '../src/types.js';
import { judgeTrace } from '../src/judge.js';
import { checkoutTrace, config, faults, FLAG, makeVerdict, START, STABLE, V2 } from './fixtures.js';

const types = (events: GuardEvent[]) => events.map((e) => e.type);

/** Feeds `n` verdicts one second apart starting at `from` and returns every event. */
function feed(guard: Guard, n: number, from: number, make: (i: number, at: number) => ReturnType<typeof makeVerdict>) {
  const events: GuardEvent[] = [];
  for (let i = 0; i < n; i += 1) {
    const at = from + i * 1000;
    events.push(...guard.ingest(make(i, at), at));
  }
  return events;
}

const counted = (_i: number, at: number) => makeVerdict({ endMs: at, failed: true, failureClass: 'flagged-path' });
const stableOk = (_i: number, at: number) => makeVerdict({ endMs: at, variation: STABLE, durationMs: 80 });

/** A guard that has seen stable traffic, crossed the threshold and is waiting for Flagsmith. */
function crossed(): { guard: Guard; at: number } {
  const guard = new Guard(config());
  feed(guard, 100, START, stableOk);
  feed(guard, 16, START + 100_000, counted);
  return { guard, at: START + 116_000 };
}

describe('defaults', () => {
  it('match the author\'s rule and the stated tolerances', () => {
    expect(defaultConfig('f', 's')).toEqual({
      flag: 'f',
      stableVariation: 's',
      threshold: 15,
      watchMs: 300000,
      tolerance: { windowMs: 60000, minRequests: 20, errorRatePoints: 2, p95Factor: 1.25 },
      plainRule: { windowMs: 30000, minRequests: 20, errorRate: 0.2 },
      armRule: { windowMs: 60000, minRequestsPerArm: 20, errorRatePoints: 10 },
    });
  });
});

describe('counting', () => {
  it('fifteen counted failures do not switch off, the sixteenth does', () => {
    const guard = new Guard(config());
    const first = feed(guard, 15, START, counted);
    expect(types(first)).not.toContain('threshold-crossed');
    expect(guard.state.counted).toBe(15);
    expect(guard.state.phase).toBe('armed');
    expect(guard.switchOffRequested).toBe(false);

    const sixteenth = guard.ingest(counted(0, START + 15_000), START + 15_000);
    expect(types(sixteenth)).toEqual(['verdict', 'threshold-crossed']);
    expect(sixteenth[1]).toMatchObject({ counted: 16, threshold: 15 });
    expect(guard.state.phase).toBe('switching-off');
    expect(guard.switchOffRequested).toBe(true);
  });

  it('dependency failures never move the counter, however many', () => {
    const guard = new Guard(config());
    const events = feed(guard, 500, START, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'dependency' }));
    expect(types(events)).not.toContain('threshold-crossed');
    expect(guard.state.counted).toBe(0);
    expect(guard.state.notCounted).toEqual({ dependency: 500, server: 0, mixed: 0 });
    expect(guard.state.phase).toBe('armed');
  });

  it('failures with the flag off do not count, even on the flagged path', () => {
    const guard = new Guard(config());
    feed(guard, 40, START, (_i, at) => makeVerdict({ endMs: at, variation: STABLE, failed: true, failureClass: 'flagged-path' }));
    expect(guard.state.counted).toBe(0);
    expect(guard.state.notCounted).toEqual({ dependency: 0, server: 0, mixed: 0 });
    expect(guard.state.totals.stable.failures).toBe(40);
  });

  it('requests that never evaluated the flag are ignored by the rule', () => {
    const guard = new Guard(config());
    feed(guard, 30, START, (_i, at) => makeVerdict({ endMs: at, failed: true, noEvaluation: true }));
    expect(guard.state.totals.flagOn.requests + guard.state.totals.stable.requests).toBe(0);
  });

  it('asks for the switch-off once only', () => {
    const { guard, at } = crossed();
    const more = feed(guard, 30, at, counted);
    expect(types(more)).not.toContain('threshold-crossed');
    expect(guard.state.counted).toBe(16);
  });

  it('tallies mixed and server failures separately', () => {
    const guard = new Guard(config());
    feed(guard, 3, START, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'mixed' }));
    feed(guard, 2, START + 5000, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'server' }));
    expect(guard.state.notCounted).toEqual({ dependency: 0, server: 2, mixed: 3 });
  });
});

describe('the switch-off', () => {
  it('starts the watch against the stable rates seen before it', () => {
    const { guard, at } = crossed();
    const events = guard.confirmSwitchOff(at, true, 'disabled');
    expect(types(events)).toEqual(['switched-off', 'watch-started']);
    expect(events[1]).toMatchObject({
      endsAtMs: at + 300000,
      stableBaseline: { requests: 100, failures: 0, errorRate: 0, p95Ms: 80 },
    });
    expect(guard.state).toMatchObject({ phase: 'watching', switchOffConfirmed: true, switchedOffAtMs: at, watchEndsAtMs: at + 300000 });
  });

  it('an answer that is not a confirmation keeps waiting and can be retried', () => {
    const { guard, at } = crossed();
    const refused = guard.confirmSwitchOff(at, false, 'Flagsmith did not answer');
    expect(refused).toEqual([{ type: 'switched-off', atMs: at, confirmed: false, detail: 'Flagsmith did not answer' }]);
    expect(guard.state.phase).toBe('switching-off');
    expect(guard.state.switchOffConfirmed).toBe(false);
    expect(types(guard.confirmSwitchOff(at + 5000, true, 'ok'))).toEqual(['switched-off', 'watch-started']);
    expect(guard.state.switchedOffAtMs).toBe(at + 5000);
  });

  it('is ignored when no switch-off was requested', () => {
    expect(new Guard(config()).confirmSwitchOff(START, true, 'x')).toEqual([]);
  });
});

describe('the watch', () => {
  /** After the switch-off, `n` requests a second apart with the given failure pattern. */
  function afterSwitchOff(failEvery: number, durationMs: number, n = 60) {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    const events: GuardEvent[] = [];
    for (let i = 1; i <= n; i += 1) {
      const t = at + i * 1000;
      const failed = failEvery > 0 && i % failEvery === 0;
      events.push(...guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs, failed, failureClass: 'server' }), t));
    }
    return { guard, at, events };
  }

  it('labels "probably the feature" when rates return inside five minutes', () => {
    const { guard, at, events } = afterSwitchOff(0, 85);
    expect(types(events)).toContain('recovered');
    expect(guard.state.recoveredAtMs).toBeDefined();
    expect(guard.tick(at + 299_999)).toEqual([]);
    const end = guard.tick(at + 300_000);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ type: 'labelled', label: 'probably the feature', recordId: recordIdFor(FLAG, at) });
    expect(guard.state.phase).toBe('closed');
    expect(guard.state.label).toBe('probably the feature');
  });

  it('labels "probably not the feature" when they do not', () => {
    const { guard, at, events } = afterSwitchOff(3, 85);
    expect(types(events)).not.toContain('recovered');
    const end = guard.tick(at + 300_000);
    expect(end[0]).toMatchObject({ type: 'labelled', label: 'probably not the feature' });
    expect(guard.state.recoveredAtMs).toBeUndefined();
  });

  it('slow requests alone prevent recovery', () => {
    const { guard, events } = afterSwitchOff(0, 120);
    expect(types(events)).not.toContain('recovered');
    expect(guard.state.recoveredAtMs).toBeUndefined();
  });

  it('allows two points above the stable error rate and a p95 of 1.25 times', () => {
    // 1 failure in 50 is 2 points over a 0% baseline; p95 100 ms is 1.25 times 80 ms
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    let recovered = false;
    for (let i = 1; i <= 50; i += 1) {
      const t = at + i * 1200;
      const events = guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 100, failed: i === 1, failureClass: 'server' }), t);
      recovered ||= types(events).includes('recovered');
    }
    expect(recovered).toBe(true);
  });

  it('recovery needs the minimum number of requests', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    for (let i = 1; i <= 19; i += 1) {
      const t = at + i * 3000;
      expect(types(guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }), t))).toEqual(['verdict']);
    }
    expect(guard.tick(at + 60_000)).toEqual([]);
    const t = at + 60_000;
    expect(types(guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }), t))).toEqual(['verdict', 'recovered']);
  });

  it('recovery needs the whole window to lie after the switch-off', () => {
    const { guard, at, events } = afterSwitchOff(0, 85, 59);
    expect(types(events)).not.toContain('recovered');
    const t = at + 60_000;
    const events60 = guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }), t);
    expect(types(events60)).toEqual(['verdict', 'recovered']);
    expect(guard.state.recoveredAtMs).toBe(at + 60_000);
  });

  it('twenty quick requests right after the switch-off do not latch a recovery before a slow host shows', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    for (let i = 1; i <= 20; i += 1) {
      const t = at + i * 500;
      guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }), t);
    }
    expect(guard.state.recoveredAtMs).toBeUndefined();
    for (let i = 1; i <= 290; i += 1) {
      const t = at + 10_000 + i * 1000;
      guard.ingest(makeVerdict({ endMs: t, variation: STABLE, durationMs: 400 }), t);
    }
    expect(guard.state.recoveredAtMs).toBeUndefined();
    guard.tick(at + 300_000);
    expect(guard.state.label).toBe('probably not the feature');
  });

  it('the recovery test looks only at the trailing window', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    // a bad stretch, then a quiet stretch; the first good window after it passes
    for (let i = 1; i <= 30; i += 1) {
      const t = at + i * 1000;
      guard.ingest(makeVerdict({ endMs: t, variation: STABLE, failed: true, failureClass: 'server' }), t);
    }
    expect(guard.state.recoveredAtMs).toBeUndefined();
    let recoveredAt: number | undefined;
    for (let i = 31; i <= 200; i += 1) {
      const t = at + i * 1000;
      guard.ingest(makeVerdict({ endMs: t, variation: STABLE }), t);
      recoveredAt ??= guard.state.recoveredAtMs;
    }
    expect(recoveredAt).toBeGreaterThan(at + 60_000);
    expect(recoveredAt).toBe(at + 89_000);
  });

  it('reports recovery once and does not label before the watch ends', () => {
    const { guard, events } = afterSwitchOff(0, 85);
    expect(types(events).filter((t) => t === 'recovered')).toHaveLength(1);
    expect(types(events)).not.toContain('labelled');
  });

  it('labels from the first ingest at or after the end, and then goes quiet', () => {
    const { guard, at } = afterSwitchOff(0, 85);
    const t = at + 310_000;
    const events = guard.ingest(makeVerdict({ endMs: t, variation: STABLE }), t);
    expect(types(events)).toEqual(['verdict', 'labelled']);
    expect(guard.tick(t + 1000)).toEqual([]);
    expect(guard.state.phase).toBe('closed');
  });

  it('ignores requests that ended before the switch-off', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    feed(guard, 30, at - 40_000, (_i, t) => makeVerdict({ endMs: t, variation: STABLE }));
    expect(guard.state.recoveredAtMs).toBeUndefined();
  });
});

describe('the plain rule comparator', () => {
  it('trips on an outage while the counter stays at zero, and never switches anything', () => {
    const guard = new Guard(config());
    const events = feed(guard, 40, START, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'dependency' }));
    const tripped = events.find((e) => e.type === 'plain-rule-tripped');
    expect(tripped).toMatchObject({ atMs: START + 19_000, requests: 20, errorRate: 1 });
    expect(guard.state.plainRuleTrippedAtMs).toBe(START + 19_000);
    expect(guard.state.counted).toBe(0);
    expect(guard.state.phase).toBe('armed');
    expect(types(events).filter((t) => t === 'plain-rule-tripped')).toHaveLength(1);
  });

  it('needs the minimum number of requests', () => {
    const guard = new Guard(config());
    feed(guard, 19, START, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'dependency' }));
    expect(guard.state.plainRuleTrippedAtMs).toBeUndefined();
  });

  it('stays quiet at or below the error rate', () => {
    const guard = new Guard(config());
    feed(guard, 100, START, (i, at) => makeVerdict({ endMs: at, failed: i % 6 === 0, failureClass: 'dependency' }));
    expect(guard.state.plainRuleTrippedAtMs).toBeUndefined();
  });

  it('looks only at flag-on requests', () => {
    const guard = new Guard(config());
    feed(guard, 60, START, (_i, at) => makeVerdict({ endMs: at, variation: STABLE, failed: true, failureClass: 'dependency' }));
    expect(guard.state.plainRuleTrippedAtMs).toBeUndefined();
  });

  it('forgets requests older than its window', () => {
    const guard = new Guard(config());
    feed(guard, 19, START, (_i, at) => makeVerdict({ endMs: at, failed: true, failureClass: 'dependency' }));
    guard.tick(START + 120_000);
    guard.ingest(makeVerdict({ endMs: START + 120_000, failed: true }), START + 120_000);
    expect(guard.state.plainRuleTrippedAtMs).toBeUndefined();
  });
});

describe('state', () => {
  it('survives a JSON round trip and carries on the same way', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    feed(guard, 10, at + 1000, (_i, t) => makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }));

    const restored = Guard.restore(JSON.parse(JSON.stringify(guard.snapshot())));
    expect(restored.state).toEqual(guard.state);

    const run = (g: Guard) => {
      const events = feed(g, 60, at + 11_000, (_i, t) => makeVerdict({ endMs: t, variation: STABLE, durationMs: 85 }));
      events.push(...g.tick(at + 300_000));
      return { events, state: g.state };
    };
    expect(run(restored)).toEqual(run(guard));
  });

  it('a new guard has plain zero rates', () => {
    const state = new Guard(config()).state;
    expect(state.totals.flagOn).toEqual({ requests: 0, failures: 0, errorRate: 0, p95Ms: 0 });
    expect(state.phase).toBe('armed');
  });

  it('p95 is the nearest rank', () => {
    const guard = new Guard(config());
    feed(guard, 20, START, (i, at) => makeVerdict({ endMs: at, variation: STABLE, durationMs: i + 1 }));
    expect(guard.state.totals.stable.p95Ms).toBe(19);
  });
});

describe('the arm comparison', () => {
  /** Feeds a flag-on and a stable request each second; the flag-on one fails when `onFails(i)`. */
  function arms(guard: Guard, n: number, from: number, onFails: (i: number) => boolean, stableFails: (i: number) => boolean = () => false) {
    const events: GuardEvent[] = [];
    for (let i = 0; i < n; i += 1) {
      const at = from + i * 1000;
      events.push(...guard.ingest(makeVerdict({ endMs: at, failed: onFails(i), failureClass: 'dependency' }), at));
      events.push(...guard.ingest(makeVerdict({ endMs: at, variation: STABLE, failed: stableFails(i), failureClass: 'dependency' }), at));
    }
    return events;
  }

  it('trips when the flag-on arm fails ten points more than the stable arm, and never switches anything', () => {
    const guard = new Guard(config());
    const events = arms(guard, 40, START, (i) => i % 3 === 0);
    const tripped = events.find((e) => e.type === 'arm-rule-tripped');
    expect(tripped).toMatchObject({ flagOnRequests: 20, stableRequests: 20, stableErrorRate: 0 });
    expect(tripped && 'flagOnErrorRate' in tripped && tripped.flagOnErrorRate).toBeCloseTo(7 / 20);
    expect(types(events).filter((t) => t === 'arm-rule-tripped')).toHaveLength(1);
    expect(guard.state.armRuleTrippedAtMs).toBeDefined();
    expect(guard.state.phase).toBe('armed');
    expect(guard.state.counted).toBe(0);
  });

  it('stays quiet when both arms fail alike, as in an outage that hits everyone equally', () => {
    const guard = new Guard(config());
    arms(guard, 100, START, () => true, () => true);
    expect(guard.state.armRuleTrippedAtMs).toBeUndefined();
  });

  it('needs the minimum requests in both arms', () => {
    const guard = new Guard(config());
    arms(guard, 19, START, () => true);
    expect(guard.state.armRuleTrippedAtMs).toBeUndefined();
  });

  it('forgets requests older than its window', () => {
    const guard = new Guard(config());
    arms(guard, 19, START, () => true);
    guard.tick(START + 200_000);
    arms(guard, 1, START + 200_000, () => true);
    expect(guard.state.armRuleTrippedAtMs).toBeUndefined();
  });

  it('stops once the flag is switched off', () => {
    const { guard, at } = crossed();
    guard.confirmSwitchOff(at, true, 'ok');
    arms(guard, 40, at + 1000, () => true);
    expect(guard.state.armRuleTrippedAtMs).toBeUndefined();
  });

  it('uses the defaults when a run header has no arm rule', () => {
    const { armRule: _omitted, ...older } = config();
    const guard = new Guard(older);
    arms(guard, 40, START, () => true);
    expect(guard.state.armRuleTrippedAtMs).toBeDefined();
  });
});

describe('the notice for a dependency only the feature calls', () => {
  const refusedFromFlaggedPath = (n: number, at = START + n * 1000) => {
    const v = judgeTrace(checkoutTrace({ n, startMs: at, variation: V2, faults: [faults.dbRefused('price-query')] }), config());
    if (!v) throw new Error('no verdict');
    return v;
  };
  const SENTENCE =
    '5 requests with the flag on failed in pg.query:SELECT price, a dependency that only the flagged path calls and that was unavailable. By the rule these do not count toward the switch-off. The stable version never makes this call, so a person should look.';

  it('fires once at five failures, says so in words, and does not count', () => {
    const guard = new Guard(config());
    const events: GuardEvent[] = [];
    for (let n = 1; n <= 12; n += 1) {
      const v = refusedFromFlaggedPath(n);
      events.push(...guard.ingest(v, v.endMs));
    }
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notice: { span: 'pg.query:SELECT price', failures: 5, text: SENTENCE } });
    expect(guard.state.notices).toHaveLength(1);
    expect(guard.state.counted).toBe(0);
    expect(guard.state.phase).toBe('armed');
  });

  it('does not fire before five', () => {
    const guard = new Guard(config());
    for (let n = 1; n <= 4; n += 1) guard.ingest(refusedFromFlaggedPath(n), START + n * 1000);
    expect(guard.state.notices).toBeUndefined();
  });

  it('does not fire when the stable version also runs that span', () => {
    const guard = new Guard(config());
    const stable = { ...makeVerdict({ endMs: START, variation: STABLE }), points: [{ name: 'pg.query:SELECT price', durationMs: 5, error: false }] };
    guard.ingest(stable, START);
    for (let n = 1; n <= 10; n += 1) guard.ingest(refusedFromFlaggedPath(n), START + n * 1000);
    expect(guard.state.notices).toBeUndefined();
  });

  it('does not fire for dependency failures outside the flagged path', () => {
    const guard = new Guard(config());
    for (let n = 1; n <= 10; n += 1) {
      const v = judgeTrace(checkoutTrace({ n, startMs: START + n * 1000, variation: V2, faults: [faults.dbRefused('shop-query')] }), config());
      if (v) guard.ingest(v, v.endMs);
    }
    expect(guard.state.notices).toBeUndefined();
  });

  it('survives a JSON round trip', () => {
    const guard = new Guard(config());
    for (let n = 1; n <= 5; n += 1) guard.ingest(refusedFromFlaggedPath(n), START + n * 1000);
    const restored = Guard.restore(JSON.parse(JSON.stringify(guard.snapshot())));
    expect(restored.state.notices).toEqual(guard.state.notices);
    for (let n = 6; n <= 9; n += 1) expect(types(restored.ingest(refusedFromFlaggedPath(n), START + n * 1000))).toEqual(['verdict']);
  });
});
