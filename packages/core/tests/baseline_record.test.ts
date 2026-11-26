import { describe, expect, it } from 'vitest';
import { buildBaseline } from '../src/baseline.js';
import { Guard } from '../src/guard.js';
import { judgeTrace } from '../src/judge.js';
import { buildRecord, recordToMarkdown } from '../src/record.js';
import { replayRun } from '../src/replay.js';
import type { TraceVerdict } from '../src/types.js';
import { buildRun, checkoutTrace, config, faults, START, STABLE, V2, type Fault } from './fixtures.js';

function verdictsFor() {
  const verdicts: TraceVerdict[] = [];
  const add = (n: number, variation: string, planted: Fault[], durationMs: number) => {
    const v = judgeTrace(checkoutTrace({ n, startMs: START + n * 100, variation, faults: planted, durationMs }), config());
    if (v) verdicts.push(v);
  };
  for (let n = 1; n <= 10; n += 1) add(n, V2, [faults.coupon], 100);
  for (let n = 11; n <= 20; n += 1) add(n, V2, [], 100);
  for (let n = 21; n <= 23; n += 1) add(n, V2, [faults.dbRefused('shop-query')], 100);
  for (let n = 100; n < 120; n += 1) add(n, STABLE, [], 60);
  for (let n = 120; n < 122; n += 1) add(n, STABLE, [faults.dbRefused('shop-query')], 90);
  return verdicts;
}

describe('buildBaseline', () => {
  const rows = buildBaseline(verdictsFor());

  it('has one row per failing point, most flag-on failures first', () => {
    expect(rows.map((r) => [r.route, r.span, r.flagOn.failures])).toEqual([
      ['/checkout', 'checkout_v2.apply_coupon', 10],
      ['/checkout', 'pg.query:SELECT shop', 3],
    ]);
  });

  it('compares a span the stable version also runs, span against span', () => {
    expect(rows[1]).toMatchObject({
      spanExistsInStable: true,
      flagOn: { requests: 23, failures: 3, p95Ms: 6 },
      stable: { requests: 22, failures: 2, p95Ms: 6 },
      why: 'db.system=postgresql connect ECONNREFUSED 172.18.0.5:5432',
    });
  });

  it('compares at the route when the stable version never runs the span', () => {
    expect(rows[0]).toMatchObject({
      spanExistsInStable: false,
      flagOn: { requests: 23, failures: 10, p95Ms: 3 },
      stable: { requests: 22, failures: 2, p95Ms: 90 },
      why: "TypeError: Cannot read properties of undefined (reading 'percent')",
    });
  });

  it('keeps to the period before the cut-off', () => {
    const early = buildBaseline(verdictsFor(), START + 1500);
    expect(early.every((r) => r.flagOn.requests < 23)).toBe(true);
    expect(early.length).toBeGreaterThan(0);
  });

  it('is empty when nothing failed with the flag on', () => {
    expect(buildBaseline([])).toEqual([]);
  });
});

describe('the investigation record', () => {
  const result = replayRun(buildRun('feature-bug'));
  const record = result.record;

  it('is built when the watch ends and carries the fixed next step', () => {
    expect(record).toBeDefined();
    expect(record?.label).toBe('probably the feature');
    expect(record?.nextStep).toBe('A person investigates. Alibi does not declare the cause.');
    expect(record?.counted).toBe(16);
    const labelled = result.events.find((e) => e.type === 'labelled');
    expect(labelled?.type === 'labelled' && labelled.recordId).toBe(record?.id);
  });

  it('lists counted traces first and leaves per-trace lines out of the timeline', () => {
    const traces = record?.traces ?? [];
    expect(traces.length).toBeGreaterThanOrEqual(16);
    const firstUncounted = traces.findIndex((t) => !t.counted);
    expect(traces.slice(0, firstUncounted === -1 ? traces.length : firstUncounted).every((t) => t.counted)).toBe(true);
    expect(record?.timeline.some((e) => e.text.includes('Request failed'))).toBe(false);
    expect(record?.timeline.at(-1)?.text).toContain('Label: probably the feature (not proven)');
  });

  it('turns into a plain Markdown document that claims nothing beyond the data', () => {
    const markdown = recordToMarkdown(record as NonNullable<typeof record>);
    expect(markdown).toContain('**probably the feature** (not proven)');
    expect(markdown).toContain('Next step: A person investigates. Alibi does not declare the cause.');
    expect(markdown).toContain('| Route | Failing point |');
    expect(markdown).toContain('checkout_v2.apply_coupon');
    expect(markdown).toContain('(the stable version does not run this span; compared at the route)');
    expect(markdown).toContain(`trace ${record?.traces[0]?.traceId}`);
    expect(markdown).toContain('## Timeline');
    expect(markdown).not.toContain('\u2014');
    expect(markdown).not.toMatch(/proven cause|caused by|root cause/i);
  });

  it('refuses to build before the watch has ended', () => {
    expect(() => buildRecord(new Guard(config()).state, [], [])).toThrow('no record yet');
  });

  it('carries Flagsmith\'s numbers when it was given them', () => {
    const summary = { experimentId: 7, readAtMs: START, variations: [{ variation: V2, exposures: 120, metrics: [{ name: 'checkout_completed', value: 0.4 }] }] };
    const withNumbers = buildRecord(result.state, result.verdicts, [], summary);
    expect(recordToMarkdown(withNumbers)).toContain('- v2: 120 exposures');
    expect(recordToMarkdown(withNumbers)).toContain('checkout_completed: 0.4');
  });
});
