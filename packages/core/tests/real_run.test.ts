import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatMs, makeRates } from '../src/stats.js';
import { readRun } from '../src/node.js';
import { replayRun } from '../src/replay.js';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'runs', 'coupon-bug.jsonl');

describe.skipIf(!existsSync(file))('the recorded coupon-bug run from the live stack', () => {
  const result = replayRun(readRun(file));

  it('switches off at the sixteenth counted failure and ends "probably the feature"', () => {
    expect(result.state.counted).toBe(16);
    expect(result.state.label).toBe('probably the feature');
    expect(result.state.recoveredAtMs).toBeDefined();
    expect(result.record?.label).toBe('probably the feature');
  });

  it('recovers no earlier than the full window after the switch-off', () => {
    const state = result.state;
    expect((state.recoveredAtMs as number) - (state.switchedOffAtMs as number)).toBeGreaterThanOrEqual(60_000);
    const line = result.timeline.find((e) => e.text.startsWith('Error rate and latency are back'));
    console.log(Math.round(((state.recoveredAtMs as number) - result.header.startedAtMs) / 1000), line?.text);
  });

  it('measures the stable level before the first counted failure', () => {
    expect(result.state.stableBaselineWindow).toBe('before-first-counted-failure');
    const off = result.state.switchedOffAtMs as number;
    const stable = result.verdicts.filter((v) => v.evaluation && !v.flagOn && v.endMs <= off);
    const early = result.state.stableBaseline;
    expect(early && early.requests).toBeLessThanOrEqual(stable.length);
    expect(early?.requests).toBeGreaterThanOrEqual(20);
    console.log('before the first counted failure:', early, 'before the switch-off:', makeRates(stable.map((v) => v.durationMs), stable.filter((v) => v.failed).length));
  });

  it('flag-on requests through the coupon span are counted, not every flag-on request', () => {
    const row = result.record?.baseline.find((r) => r.span === 'checkout_v2.apply_coupon');
    const off = result.state.switchedOffAtMs as number;
    const flagOn = result.verdicts.filter((v) => v.flagOn && v.endMs <= off);
    const through = flagOn.filter((v) => v.points?.some((p) => p.name === 'checkout_v2.apply_coupon'));
    expect(row?.flagOn.requests).toBe(through.length);
    console.log('flag-on requests', flagOn.length, 'through apply_coupon', through.length, 'row', row, formatMs(row?.flagOn.p95Ms ?? 0));
  });
});
