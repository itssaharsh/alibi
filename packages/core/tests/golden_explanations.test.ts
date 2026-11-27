import { describe, expect, it } from 'vitest';
import { judgeTrace } from '../src/judge.js';
import { checkoutTrace, config, faults, STABLE, START, V2, type Fault } from './fixtures.js';

function judge(variation: string, planted: Fault[], durationMs = 90) {
  const verdict = judgeTrace(checkoutTrace({ n: 1, startMs: START, variation, faults: planted, durationMs }), config());
  if (!verdict) throw new Error('the planted trace has no root');
  return verdict;
}

describe('golden explanations', () => {
  it('coupon bug on the flagged path counts', () => {
    const v = judge(V2, [faults.coupon]);
    expect(v.failureClass).toBe('flagged-path');
    expect(v.counted).toBe(true);
    expect(v.reason).toBe(
      "Failed in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). Counts toward the switch-off.",
    );
  });

  it('database refused on the stable version is a dependency failure', () => {
    const v = judge(STABLE, [faults.dbRefused('shop-query')]);
    expect(v.failureClass).toBe('dependency');
    expect(v.flagOn).toBe(false);
    expect(v.counted).toBe(false);
    expect(v.reason).toBe(
      'Failed in pg.query:SELECT shop, a dependency call (db.system.name=postgresql): connect ECONNREFUSED 172.18.0.5:5432. The dependency was unavailable, so this does not count.',
    );
  });

  it('database refused with the flag on is still a dependency failure', () => {
    const v = judge(V2, [faults.dbRefused('shop-query')]);
    expect(v.failureClass).toBe('dependency');
    expect(v.flagOn).toBe(true);
    expect(v.counted).toBe(false);
    expect(v.reason).toBe(
      'Failed in pg.query:SELECT shop, a dependency call (db.system.name=postgresql): connect ECONNREFUSED 172.18.0.5:5432. The dependency was unavailable, so this does not count.',
    );
  });

  it('database refused when called from inside the flagged path does not count', () => {
    const v = judge(V2, [faults.dbRefused('price-query')]);
    expect(v.failureClass).toBe('dependency');
    expect(v.origins[0]?.onFlaggedPath).toBe(true);
    expect(v.counted).toBe(false);
    expect(v.reason).toBe(
      'Failed in pg.query:SELECT price, a dependency call (db.system.name=postgresql): connect ECONNREFUSED 172.18.0.5:5432. The dependency was unavailable, so this does not count. It was called from the flagged path, but an unavailable dependency is infrastructure.',
    );
  });

  it('a SQL syntax error from the flagged path is the feature\'s fault', () => {
    const v = judge(V2, [faults.sqlSyntax]);
    expect(v.failureClass).toBe('flagged-path');
    expect(v.counted).toBe(true);
    expect(v.reason).toBe(
      'Failed in pg.query:SELECT price, a dependency call (db.system.name=postgresql) on the flagged path: 42601: syntax error at or near "FROM". The dependency rejected the call, so the fault is in the calling code. Counts toward the switch-off.',
    );
  });

  it('a server error outside the flagged path does not count', () => {
    const v = judge(V2, [faults.tax]);
    expect(v.failureClass).toBe('server');
    expect(v.counted).toBe(false);
    expect(v.reason).toBe('Failed in tax.lookup outside the flagged path: Error: Tax table is not loaded. Does not count.');
  });

  it('a 500 with no error span names the root request', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2 });
    (spans[0] as { attrs: Record<string, number> }).attrs['http.response.status_code'] = 500;
    const v = judgeTrace(spans, config());
    expect(v?.failureClass).toBe('server');
    expect(v?.origins.map((o) => o.name)).toEqual(['POST /checkout']);
    expect(v?.reason).toBe('Failed in POST /checkout outside the flagged path: HTTP status 500. Does not count.');
  });

  it('a budget timeout thrown by the flagged path\'s own span counts', () => {
    const v = judge(V2, [faults.budget]);
    expect(v.failureClass).toBe('flagged-path');
    expect(v.counted).toBe(true);
    expect(v.reason).toBe(
      'Failed in checkout_v2.price, a span on the flagged path: TimeoutError: price budget of 800 ms exceeded (timeout). Counts toward the switch-off.',
    );
  });

  it('a mixed trace names both origins and does not count', () => {
    const v = judge(V2, [faults.coupon, faults.dbRefused('shop-query')]);
    expect(v.failureClass).toBe('mixed');
    expect(v.counted).toBe(false);
    expect(v.origins).toHaveLength(2);
    expect(v.reason).toBe(
      "Failed in pg.query:SELECT shop, a dependency call (db.system.name=postgresql): connect ECONNREFUSED 172.18.0.5:5432, and in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). The failures are in different places, so this does not count.",
    );
  });

  it('a request that completed says how long it took', () => {
    const v = judge(V2, [], 84);
    expect(v.failed).toBe(false);
    expect(v.failureClass).toBeUndefined();
    expect(v.reason).toBe('Completed in 84 ms.');
  });
});
