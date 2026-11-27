import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatReport, formatRelative } from '../src/format.js';
import { readRun } from '../src/node.js';
import { recordToMarkdown } from '../src/record.js';
import { createReplayer, replayRun, type ReplayResult } from '../src/replay.js';

const runs = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runs');

const FORBIDDEN = ['caused by', 'root cause', 'proved', 'proven that', 'the cause was'];

/** Replays a recorded run one-shot, and again stepped, and checks the two end in the same state. */
function replayBoth(name: string): ReplayResult {
  const lines = readRun(join(runs, `${name}.jsonl`));
  const whole = replayRun(lines);
  const replayer = createReplayer(lines);
  for (let t = replayer.header.startedAtMs; t < replayer.endsAtMs; t += 7000) replayer.step(t);
  replayer.step(replayer.endsAtMs);
  const stepped = replayer.result();
  expect(JSON.stringify(stepped.state)).toBe(JSON.stringify(whole.state));
  expect(stepped.verdicts).toHaveLength(whole.verdicts.length);
  expect(JSON.stringify(stepped.events)).toBe(JSON.stringify(whole.events));
  return whole;
}

/** Every user-facing string the run produces: reasons, timeline, report and the record. */
function userFacingText(r: ReplayResult): string {
  return [
    ...r.verdicts.map((v) => v.reason),
    ...r.timeline.map((e) => e.text),
    formatReport(r),
    r.record ? recordToMarkdown(r.record) : '',
  ].join('\n');
}

function expectNoNotices(r: ReplayResult): void {
  expect(r.state.notices).toBeUndefined();
  expect(r.events.filter((e) => e.type === 'notice')).toEqual([]);
}

function expectNoCauseWording(r: ReplayResult): void {
  const text = userFacingText(r).toLowerCase();
  for (const phrase of FORBIDDEN) expect(text).not.toContain(phrase);
  if (r.state.label) expect(text).toContain(`${r.state.label} (not proven)`);
  else expect(text).not.toMatch(/probably (not )?the feature/);
}

function sentenceCounts(r: ReplayResult, pick: (v: ReplayResult['verdicts'][number]) => boolean): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of r.verdicts.filter(pick)) counts[v.reason] = (counts[v.reason] ?? 0) + 1;
  return counts;
}

/** When each of the three acted, relative to the start of the run. */
function actedAt(r: ReplayResult): { plain?: string; arm?: string; count?: string } {
  const at = (type: string) => {
    const e = r.events.find((event) => event.type === type);
    return e ? formatRelative(e.atMs - r.header.startedAtMs) : undefined;
  };
  return { plain: at('plain-rule-tripped'), arm: at('arm-rule-tripped'), count: at('threshold-crossed') };
}

function armTrip(r: ReplayResult) {
  const e = r.events.find((event) => event.type === 'arm-rule-tripped');
  if (e?.type !== 'arm-rule-tripped') throw new Error('the arm comparison did not trip');
  return e;
}

describe.skipIf(!existsSync(runs))('the recorded runs, against their answer keys', () => {
  it('outage: the database is down, every failure is a dependency, the flag stays on', () => {
    const r = replayBoth('outage');
    const failing = r.verdicts.filter((v) => v.failed);
    expect(failing).toHaveLength(179);
    expect(failing.filter((v) => v.flagOn)).toHaveLength(97);
    for (const v of failing) {
      expect(v.failureClass).toBe('dependency');
      expect(v.counted).toBe(false);
      expect(v.origins.map((o) => o.name)).toEqual(['pg.connect']);
    }
    expect(sentenceCounts(r, (v) => v.failed)).toEqual({
      'Failed in pg.connect, a dependency call (db.system.name=postgresql): Connection terminated unexpectedly. The dependency was unavailable, so this does not count.': 179,
    });
    expect(r.state.counted).toBe(0);
    expect(r.state.notCounted).toEqual({ dependency: 97, server: 0, mixed: 0 });
    expect(r.events.filter((e) => e.type === 'switched-off' || e.type === 'threshold-crossed')).toEqual([]);
    expect(r.state.phase).toBe('armed');
    expect(r.state.switchedOffAtMs).toBeUndefined();
    expect(r.state.label).toBeUndefined();
    expect(r.record).toBeUndefined();
    expect(r.state.plainRuleTrippedAtMs).toBeDefined();
    // Honest result: both arms failed in the outage, but the flag-on arm by a little more over the window.
    expect(actedAt(r)).toEqual({ plain: '+01:16', arm: '+01:22', count: undefined });
    const arm = armTrip(r);
    expect([arm.flagOnRequests, arm.stableRequests]).toEqual([46, 66]);
    expect(arm.flagOnErrorRate).toBeCloseTo(18 / 46);
    expect(arm.stableErrorRate).toBeCloseTo(19 / 66);
    expectNoNotices(r);
    expect(formatReport(r)).toContain('Arm comparison (flag on against stable): would have switched the flag off at +01:22, flag on 39.1% against stable 28.8% over the last 60 seconds.');
    expectNoCauseWording(r);
  });

  it('coupon-bug: the feature breaks, the flag goes off at the sixteenth, the run recovers', () => {
    const r = replayBoth('coupon-bug');
    const flagOnFailures = r.verdicts.filter((v) => v.failed && v.flagOn);
    expect(r.state.counted).toBe(16);
    expect(flagOnFailures.length).toBeGreaterThanOrEqual(16);
    for (const v of flagOnFailures) {
      expect(v.failureClass).toBe('flagged-path');
      expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.apply_coupon']);
    }
    expect(sentenceCounts(r, (v) => v.failed)).toEqual({
      "Failed in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). Counts toward the switch-off.":
        flagOnFailures.length,
    });
    const answers = r.events.filter((e) => e.type === 'switched-off');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ confirmed: true });
    expect(r.state.switchOffConfirmed).toBe(true);
    expect(r.state.recoveredAtMs).toBeDefined();
    expect((r.state.recoveredAtMs as number) - (r.state.switchedOffAtMs as number)).toBeGreaterThanOrEqual(60_000);
    expect(r.state.label).toBe('probably the feature');
    expect(r.state.stableBaselineWindow).toBe('before-first-counted-failure');
    expect(r.record?.label).toBe('probably the feature');
    expect(r.record?.baseline.map((b) => b.span)).toEqual(['checkout_v2.apply_coupon']);
    const row = r.record?.baseline[0];
    expect(row?.spanExistsInStable).toBe(false);
    expect(row?.flagOn.failures).toBe(flagOnFailures.length);
    expect(actedAt(r)).toEqual({ plain: '+01:58', arm: '+01:58', count: '+02:29' });
    const arm = armTrip(r);
    expect([arm.flagOnRequests, arm.stableRequests, arm.stableErrorRate]).toEqual([49, 66, 0]);
    expect(arm.flagOnErrorRate).toBeCloseTo(5 / 49);
    expectNoNotices(r);
    expect(r.record?.armRuleTrippedAtMs).toBe(r.state.armRuleTrippedAtMs);
    expect(recordToMarkdown(r.record as NonNullable<typeof r.record>)).toContain('## Two simpler rules on the same requests');
    expectNoCauseWording(r);
  });

  it('slow-host: the new checkout fails first, the flag goes off, the slowness stays', () => {
    const r = replayBoth('slow-host');
    const flagOnFailures = r.verdicts.filter((v) => v.failed && v.flagOn);
    expect(r.state.counted).toBe(16);
    expect(flagOnFailures.length).toBeGreaterThanOrEqual(16);
    for (const v of flagOnFailures) {
      expect(v.failureClass).toBe('flagged-path');
      expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.price']);
      expect(v.origins[0]?.detail).toMatch(/^PriceBudgetExceeded: v2 price rules took \d+ ms, the budget is 150 ms$/);
    }
    for (const sentence of Object.keys(sentenceCounts(r, (v) => v.failed))) {
      expect(sentence).toMatch(
        /^Failed in checkout_v2\.price, a span on the flagged path: PriceBudgetExceeded: v2 price rules took \d+ ms, the budget is 150 ms\. Counts toward the switch-off\.$/,
      );
    }
    expect(r.state.switchOffConfirmed).toBe(true);
    expect(r.state.recoveredAtMs).toBeUndefined();
    expect(r.state.label).toBe('probably not the feature');
    const after = r.record?.afterSwitchOff;
    const stable = r.state.stableBaseline;
    expect(after?.errorRate).toBe(0);
    expect(after?.p95Ms).toBeGreaterThan((stable?.p95Ms ?? Infinity) * 1.25 * 2);
    expect(actedAt(r)).toEqual({ plain: '+01:36', arm: '+01:36', count: '+01:48' });
    const arm = armTrip(r);
    expect([arm.flagOnRequests, arm.stableRequests, arm.stableErrorRate]).toEqual([62, 53, 0]);
    expect(arm.flagOnErrorRate).toBeCloseTo(7 / 62);
    expectNoNotices(r);
    expectNoCauseWording(r);
  });
  it('service-outage: the rules service stops, only the feature calls it, the flag stays on with a notice', () => {
    const r = replayBoth('service-outage');
    const failing = r.verdicts.filter((v) => v.failed);
    expect(failing).toHaveLength(97);
    expect(failing.every((v) => v.flagOn)).toBe(true);
    for (const v of failing) {
      expect(v.failureClass).toBe('dependency');
      expect(v.counted).toBe(false);
      expect(v.origins.map((o) => o.label)).toEqual(['GET rules:3000']);
      expect(v.origins.every((o) => o.onFlaggedPath)).toBe(true);
    }
    expect(r.state.counted).toBe(0);
    expect(r.state.notCounted).toEqual({ dependency: 97, server: 0, mixed: 0 });
    expect(r.events.filter((e) => e.type === 'switched-off' || e.type === 'threshold-crossed')).toEqual([]);
    expect(r.state.phase).toBe('armed');
    expect(r.state.switchedOffAtMs).toBeUndefined();
    expect(r.state.label).toBeUndefined();
    expect(r.record).toBeUndefined();
    expect(actedAt(r)).toEqual({ plain: '+01:39', arm: '+01:43', count: undefined });
    expect(r.header.config.armRule?.errorRatePoints).toBe(20);

    const notices = r.events.filter((e) => e.type === 'notice');
    expect(notices).toHaveLength(1);
    const notice = r.state.notices?.[0];
    expect(r.state.notices).toHaveLength(1);
    expect(notice).toMatchObject({ kind: 'flagged-path-only', span: 'GET rules:3000', failures: 5 });
    expect(formatRelative((notice?.atMs as number) - r.header.startedAtMs)).toBe('+01:37');
    expect(notice?.text).toBe(
      '5 requests with the flag on failed in GET rules:3000, a dependency that only the flagged path calls and that was unavailable. By the rule these do not count toward the switch-off. The stable version never makes this call, so a person should look.',
    );
    for (const sentence of Object.keys(sentenceCounts(r, (v) => v.failed))) {
      expect(sentence).toMatch(
        /^Failed in GET rules:3000, a dependency call \(server\.address=rules\): .+\. The dependency was unavailable, so this does not count\. It was called from the flagged path, but an unavailable dependency is infrastructure\.$/,
      );
    }
    expectNoCauseWording(r);
  });

  it('rare-bug: sixteen failures, the flag goes off, the run recovers', () => {
    const r = replayBoth('rare-bug');
    const failing = r.verdicts.filter((v) => v.failed);
    expect(failing).toHaveLength(16);
    for (const v of failing) {
      expect(v.flagOn).toBe(true);
      expect(v.failureClass).toBe('flagged-path');
      expect(v.counted).toBe(true);
      expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.apply_coupon']);
    }
    expect(sentenceCounts(r, (v) => v.failed)).toEqual({
      "Failed in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). Counts toward the switch-off.": 16,
    });
    expect(r.state.counted).toBe(16);
    expect(r.state.notCounted).toEqual({ dependency: 0, server: 0, mixed: 0 });
    const answers = r.events.filter((e) => e.type === 'switched-off');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ confirmed: true });
    expect(answers[0]?.type === 'switched-off' && answers[0].detail).toContain('20 of 20 identities checked get stable');
    expect(r.state.switchOffConfirmed).toBe(true);
    expect(formatRelative((r.state.switchedOffAtMs as number) - r.header.startedAtMs)).toBe('+09:02');
    expect(actedAt(r)).toEqual({ plain: undefined, arm: undefined, count: '+09:02' });
    expect(r.state.plainRuleTrippedAtMs).toBeUndefined();
    expect(r.state.armRuleTrippedAtMs).toBeUndefined();
    expect(formatRelative((r.state.recoveredAtMs as number) - r.header.startedAtMs)).toBe('+10:03');
    expect(r.state.label).toBe('probably the feature');
    expect(formatRelative((r.events.find((e) => e.type === 'labelled')?.atMs as number) - r.header.startedAtMs)).toBe('+14:03');
    expect(r.record?.label).toBe('probably the feature');
    expectNoNotices(r);
    expectNoCauseWording(r);
  });
});
