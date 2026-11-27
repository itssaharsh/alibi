import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TraceAssembler } from '../src/assemble.js';
import { defaultConfig } from '../src/guard.js';
import { judgeTrace } from '../src/judge.js';
import { flattenOtlp } from '../src/otlp.js';
import type { FlatSpan, TraceVerdict } from '../src/types.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');
const config = defaultConfig('checkout_v2', 'stable');

function load(name: string): FlatSpan[] {
  return flattenOtlp(JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

/** Assembles spans fed in the given batches, one poll after the quiet time, and judges every trace. */
function judgeAll(batches: FlatSpan[][]): TraceVerdict[] {
  const assembler = new TraceAssembler();
  batches.forEach((batch, i) => assembler.add(batch, i * 10));
  const { ready, expired } = assembler.poll(batches.length * 10 + 60_000);
  expect(expired).toEqual([]);
  return ready.map((trace) => judgeTrace(trace.spans, config) as TraceVerdict);
}

const failing = (verdicts: TraceVerdict[]) => verdicts.filter((v) => v.failed);
const reasons = (verdicts: TraceVerdict[]) => failing(verdicts).map((v) => v.reason).sort();

const files = ['normal.json', 'db-refused.json', 'coupon-bug.json', 'budget.json', 'server-timeout.json'];
const present = files.every((name) => existsSync(join(dir, name)));

describe.skipIf(!present)('captured traces from the live stack', () => {
  it('normal traffic completes on both variations', () => {
    const verdicts = judgeAll([load('normal.json')]);
    expect(verdicts).toHaveLength(6);
    expect(failing(verdicts)).toEqual([]);
    expect(verdicts.filter((v) => v.flagOn)).toHaveLength(3);
    expect(verdicts.every((v) => v.evaluation !== undefined && v.route === '/checkout')).toBe(true);
    expect(verdicts.map((v) => v.reason).every((r) => /^Completed in \d+ ms\.$/.test(r))).toBe(true);
  });

  it('a stopped database is a dependency failure and never counts', () => {
    const verdicts = judgeAll([load('db-refused.json')]);
    const bad = failing(verdicts);
    expect(bad).toHaveLength(3);
    for (const v of bad) {
      expect(v.failureClass).toBe('dependency');
      expect(v.counted).toBe(false);
      expect(v.origins.map((o) => o.name)).toEqual(['pg.connect']);
    }
    expect(reasons(verdicts)).toEqual(
      Array(3).fill(
        'Failed in pg.connect, a dependency call (db.system.name=postgresql): Connection terminated unexpectedly. The dependency was unavailable, so this does not count.',
      ),
    );
  });

  it('the coupon bug counts when the flag is on', () => {
    const verdicts = judgeAll([load('coupon-bug.json')]);
    const bad = failing(verdicts);
    expect(bad).toHaveLength(4);
    for (const v of bad) {
      expect(v.flagOn).toBe(true);
      expect(v.failureClass).toBe('flagged-path');
      expect(v.counted).toBe(true);
      // the checkout and checkout_v2 spans above it also carry the error, but are not origins
      expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.apply_coupon']);
    }
    expect(reasons(verdicts)).toEqual(
      Array(4).fill(
        "Failed in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). Counts toward the switch-off.",
      ),
    );
  });

  it('a price budget thrown by the feature\'s own span counts', () => {
    const verdicts = judgeAll([load('budget.json')]);
    const bad = failing(verdicts);
    expect(bad).toHaveLength(4);
    for (const v of bad) {
      expect(v.failureClass).toBe('flagged-path');
      expect(v.counted).toBe(true);
      expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.price']);
    }
    expect(reasons(verdicts)).toEqual(
      [170, 188, 195, 198].map(
        (ms) =>
          `Failed in checkout_v2.price, a span on the flagged path: PriceBudgetExceeded: v2 price rules took ${ms} ms, the budget is 150 ms. Counts toward the switch-off.`,
      ),
    );
  });

  it('a request timeout is a server failure: two origins, both outside the flagged path', () => {
    const verdicts = judgeAll([load('server-timeout.json')]);
    const bad = failing(verdicts);
    expect(bad).toHaveLength(3);
    for (const v of bad) {
      expect(v.failureClass).toBe('server');
      expect(v.counted).toBe(false);
      // the shop's `checkout` span gives up after the timeout fired, so both are leaves
      expect(v.origins.map((o) => o.name).sort()).toEqual(['checkout', 'request_timeout']);
      expect(v.origins.every((o) => !o.onFlaggedPath)).toBe(true);
      expect(v.origins[0]?.name).toBe('request_timeout');
    }
    expect(bad.filter((v) => v.flagOn)).toHaveLength(2);
    expect(reasons(verdicts)).toEqual(
      Array(3).fill(
        'Failed in request_timeout outside the flagged path: RequestTimeout: The request took longer than 2000 ms (1 more failing span in the same category). Does not count.',
      ),
    );
  });
});

describe.skipIf(!present)('assembling real traces from separate batches', () => {
  const key = (v: TraceVerdict) => `${v.traceId} ${v.failureClass ?? 'ok'} ${v.counted} ${v.reason}`;

  it.each(files)('%s gives the same verdicts when its spans arrive one at a time, in any order', (name) => {
    const spans = load(name);
    const whole = judgeAll([spans]).map(key).sort();

    const reversed = judgeAll([...spans].reverse().map((s) => [s])).map(key).sort();
    expect(reversed).toEqual(whole);

    const rootsLast = [...spans].sort((a, b) => Number(a.parentSpanId === undefined) - Number(b.parentSpanId === undefined));
    expect(judgeAll(rootsLast.map((s) => [s])).map(key).sort()).toEqual(whole);

    const rootsFirst = [...rootsLast].reverse();
    expect(judgeAll(rootsFirst.map((s) => [s])).map(key).sort()).toEqual(whole);
  });

  it('keeps every span of every trace', () => {
    for (const name of files) {
      const spans = load(name);
      const assembler = new TraceAssembler();
      assembler.add(spans, 0);
      const { ready } = assembler.poll(60_000);
      expect(ready.reduce((sum, t) => sum + t.spans.length, 0)).toBe(spans.length);
    }
  });
});
