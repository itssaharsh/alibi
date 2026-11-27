import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/command.js';
import { formatReport } from '../src/format.js';
import { readRun } from '../src/node.js';
import { createReplayer, parseRun, replayRun, RunFileError, serialiseRun } from '../src/replay.js';
import { makeRates } from '../src/stats.js';
import { buildRun } from './fixtures.js';

describe('replayRun', () => {
  it('outage: the flag stays on, nothing counts, the plain rule trips', () => {
    const r = replayRun(buildRun('outage'));
    expect(r.state.phase).toBe('armed');
    expect(r.state.counted).toBe(0);
    expect(r.state.label).toBeUndefined();
    expect(r.state.switchedOffAtMs).toBeUndefined();
    expect(r.state.plainRuleTrippedAtMs).toBeDefined();
    expect(r.state.notCounted.dependency).toBeGreaterThan(100);
    expect(r.state.notCounted.dependency).toBe(r.state.totals.flagOn.failures);
    expect(r.events.some((e) => e.type === 'threshold-crossed')).toBe(false);
    expect(r.record).toBeUndefined();
    expect(r.verdicts.filter((v) => v.failed).every((v) => v.failureClass === 'dependency')).toBe(true);
  });

  it('feature bug: switched off at the sixteenth, recovers, "probably the feature"', () => {
    const r = replayRun(buildRun('feature-bug'));
    expect(r.state.counted).toBe(16);
    expect(r.state.phase).toBe('closed');
    expect(r.state.switchOffConfirmed).toBe(true);
    expect(r.state.recoveredAtMs).toBeDefined();
    expect(r.state.label).toBe('probably the feature');
    expect(r.events.filter((e) => e.type === 'threshold-crossed')).toHaveLength(1);
    expect(r.record?.label).toBe('probably the feature');
    const order = r.events.map((e) => e.type).filter((t) => t !== 'verdict' && t !== 'plain-rule-tripped');
    expect(order).toEqual(['threshold-crossed', 'switched-off', 'watch-started', 'recovered', 'labelled']);
  });

  it('degraded host: switched off, no recovery, "probably not the feature"', () => {
    const r = replayRun(buildRun('degraded-host'));
    expect(r.state.counted).toBe(16);
    expect(r.state.phase).toBe('closed');
    expect(r.state.recoveredAtMs).toBeUndefined();
    expect(r.state.label).toBe('probably not the feature');
    expect(r.state.plainRuleTrippedAtMs).toBeDefined();
    expect(r.record?.label).toBe('probably not the feature');
  });

  it('slow host: the stable level is the healthy one from before the trouble, so the label is "probably not the feature"', () => {
    const r = replayRun(buildRun('slow-host'));
    const baseline = r.state.stableBaseline;
    expect(r.state.stableBaselineWindow).toBe('before-first-counted-failure');
    expect(baseline?.errorRate).toBe(0);
    expect(baseline?.p95Ms).toBeLessThanOrEqual(110);
    expect(baseline?.requests).toBeGreaterThanOrEqual(20);
    expect(r.state.counted).toBe(16);
    expect(r.state.recoveredAtMs).toBeUndefined();
    expect(r.state.label).toBe('probably not the feature');

    // Measured up to the switch-off instead, the stable version is already slow and the run would have recovered.
    const off = r.state.switchedOffAtMs as number;
    const durations = r.verdicts.filter((v) => v.evaluation && !v.flagOn && v.endMs <= off).map((v) => v.durationMs);
    const failures = r.verdicts.filter((v) => v.evaluation && !v.flagOn && v.endMs <= off && v.failed).length;
    const old = makeRates(durations, failures);
    expect(old.p95Ms).toBeGreaterThan(400);
    const after = r.record?.afterSwitchOff as NonNullable<typeof r.record>['afterSwitchOff'];
    expect(after.p95Ms).toBeLessThanOrEqual(old.p95Ms * 1.25);
    expect(after.errorRate).toBeLessThanOrEqual(old.errorRate + 0.02);
    expect(r.record?.stableBaselineWindow).toBe('before-first-counted-failure');
    expect(r.timeline.some((e) => e.text.includes('Stable version level, measured before the first counted failure: 0.0% errors'))).toBe(true);
  });

  it('measures the stable level before the switch-off when too few stable requests came before the trouble', () => {
    const lines = buildRun('feature-bug');
    const header = lines[0];
    if (header?.kind !== 'alibi-run') throw new Error('no header');
    const early = { ...header, config: { ...header.config, tolerance: { ...header.config.tolerance, minRequests: 100000 } } };
    const r = replayRun([early, ...lines.slice(1)]);
    expect(r.state.stableBaselineWindow).toBe('before-switch-off');
    expect(r.timeline.some((e) => e.text.includes('Stable version level, measured before the switch-off:'))).toBe(true);
  });

  it('confirms as not confirmed when the run recorded no answer', () => {
    const lines = buildRun('feature-bug').filter((l) => l.kind !== 'flagsmith');
    const r = replayRun(lines);
    const answers = r.events.filter((e) => e.type === 'switched-off');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ confirmed: false, detail: 'no recorded answer' });
    expect(r.state.phase).toBe('switching-off');
    expect(r.state.label).toBeUndefined();
    expect(formatReport(r)).toContain('Flagsmith did not confirm it');
  });

  it('is deterministic: the same file gives the same output', () => {
    const lines = buildRun('feature-bug');
    const again = parseRun(serialiseRun(lines));
    expect(JSON.stringify(replayRun(lines))).toBe(JSON.stringify(replayRun(again)));
    expect(formatReport(replayRun(lines))).toBe(formatReport(replayRun(again)));
  });

  it('does not depend on the order of lines in the file', () => {
    const [header, ...rest] = buildRun('degraded-host');
    const shuffled = [header, ...[...rest].reverse()];
    expect(replayRun(shuffled as typeof rest).state.label).toBe('probably not the feature');
  });
});

describe('createReplayer', () => {
  it('plays forward in time and ends in the same place as a full replay', () => {
    const lines = buildRun('feature-bug');
    const replayer = createReplayer(lines);
    const start = replayer.header.startedAtMs;
    expect(replayer.step(start + 30_000).filter((e) => e.type === 'threshold-crossed')).toEqual([]);
    expect(replayer.result().state.phase).toBe('armed');

    const mid = replayer.step(start + 100_000);
    expect(mid.map((e) => e.type)).toContain('threshold-crossed');
    expect(replayer.result().state.phase).toBe('watching');

    replayer.step(Infinity);
    const full = replayRun(lines);
    expect(replayer.result().state).toEqual(full.state);
    expect(replayer.result().events).toHaveLength(full.events.length);
    expect(replayer.result().record?.id).toBe(full.record?.id);
  });

  it('rejects a list that does not start with a header', () => {
    expect(() => createReplayer([{ kind: 'world', atMs: 0, text: 'x' }])).toThrow(RunFileError);
  });
});

describe('stepping', () => {
  it.each([1000, 7000, 'whole'] as const)('gives the same final state as a one-shot replay when stepped by %s', (increment) => {
    const lines = buildRun('feature-bug');
    const whole = replayRun(lines);
    const replayer = createReplayer(lines);
    if (increment !== 'whole') {
      for (let t = replayer.header.startedAtMs; t < replayer.endsAtMs; t += increment) replayer.step(t);
    }
    replayer.step(replayer.endsAtMs);
    const stepped = replayer.result();
    expect(JSON.stringify(stepped.state)).toBe(JSON.stringify(whole.state));
    expect(stepped.verdicts).toHaveLength(whole.verdicts.length);
    expect(stepped.state.totals).toEqual(whole.state.totals);
    expect(JSON.stringify(stepped.events)).toBe(JSON.stringify(whole.events));
  });
});

describe('parseRun', () => {
  it('round trips a run file', () => {
    const lines = buildRun('outage');
    expect(parseRun(serialiseRun(lines))).toEqual(lines);
  });

  it('says which line is wrong', () => {
    const header = JSON.stringify(buildRun('outage')[0]);
    expect(() => parseRun('')).toThrow('empty');
    expect(() => parseRun('{"kind":"spans"}')).toThrow('first line is not an alibi-run header');
    expect(() => parseRun(`${header}\nnot json`)).toThrow('line 2 is not valid JSON');
    expect(() => parseRun(`${header}\n{"kind":"mystery"}`)).toThrow('line 2 has an unknown kind');
  });
});

describe('the command line', () => {
  function run(argv: string[], lines = buildRun('feature-bug')) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, { read: () => lines, out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out: out.join(''), err: err.join('') };
  }

  it('prints the title, what was planted, a timeline with relative times and a summary', () => {
    const { code, out } = run(['replay', 'x.jsonl']);
    expect(code).toBe(0);
    expect(out.startsWith('The coupon bug\nPlanted: Carts with a coupon crash inside the new checkout.\n')).toBe(true);
    expect(out).toMatch(/^\+01:00 {2}The coupon bug started\.$/m);
    expect(out).toMatch(/^\+\d\d:\d\d {2}Flag-on request failed on \/checkout \(trace [0-9a-f]{8}\)\. Failed in checkout_v2\.apply_coupon, a span on the flagged path/m);
    expect(out).toMatch(/^\+\d\d:\d\d {2}Counter passed 15: 16 failures/m);
    expect(out).toMatch(/Flagsmith confirmed the switch-off: feature checkout_v2 disabled for everyone/);
    expect(out).toMatch(/Watch started for 5 minutes/);
    expect(out).toMatch(/back at the stable version's level/);
    expect(out).toMatch(/Label: probably the feature \(not proven\)/);
    expect(out).toMatch(/Counted toward the switch-off: 16/);
    expect(out).toMatch(/Plain error-rate rule: would have switched the flag off at \+\d\d:\d\d/);
    expect(out).toMatch(/Result: probably the feature \(not proven\)\. A person investigates\./);
  });

  it('says the flag stayed on when nothing switched it off', () => {
    const { out } = run(['replay', 'x.jsonl'], buildRun('outage'));
    expect(out).toContain('Result: the flag stayed on.');
    expect(out).toContain('Counted toward the switch-off: 0');
    expect(out).toMatch(/Not counted: \d+ from a dependency, 0 from the server, 0 mixed/);
  });

  it('prints JSON with --json', () => {
    const { code, out } = run(['replay', 'x.jsonl', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).state.label).toBe('probably the feature');
  });

  it('explains wrong usage and unreadable files', () => {
    expect(run(['replay']).code).toBe(2);
    expect(run(['frobnicate', 'x']).err).toContain('Usage: alibi replay');
    expect(run(['--help']).code).toBe(0);
    const out: string[] = [];
    const code = runCli(['replay', 'missing.jsonl'], {
      read: () => {
        throw new Error('no such file');
      },
      out: (t) => out.push(t),
      err: (t) => out.push(t),
    });
    expect(code).toBe(1);
    expect(out.join('')).toBe('Could not read missing.jsonl: no such file\n');
  });

  it('reads a run file from disk and replays ten minutes of traffic in under ten seconds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alibi-'));
    try {
      const file = join(dir, 'run.jsonl');
      writeFileSync(file, serialiseRun(buildRun('degraded-host')));
      const started = performance.now();
      const result = replayRun(readRun(file));
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(result.state.label).toBe('probably not the feature');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
