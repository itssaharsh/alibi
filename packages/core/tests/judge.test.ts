import { describe, expect, it } from 'vitest';
import { judgeTrace } from '../src/judge.js';
import type { FlatSpan } from '../src/types.js';
import { checkoutTrace, config, faults, FLAG, STABLE, START, V2, type Fault } from './fixtures.js';

const judge = (spans: FlatSpan[]) => {
  const v = judgeTrace(spans, config());
  if (!v) throw new Error('no root');
  return v;
};
const find = (spans: FlatSpan[], name: string) => spans.find((s) => s.name === name) as FlatSpan;

/** A refusal on the price query with the given error words, to test the dependency reading. */
function priceQuery(fault: Fault, extra: Record<string, string | number> = {}) {
  const spans = checkoutTrace({ n: 2, startMs: START, variation: V2, faults: [fault] });
  Object.assign(find(spans, 'pg.query:SELECT price').attrs, extra);
  return judge(spans);
}

describe('reading the flag evaluation', () => {
  it('reads the evaluation from a span event', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2, identity: 'ravi' }));
    expect(v.evaluation).toEqual({ flag: FLAG, variation: V2, identity: 'ravi' });
    expect(v.flagOn).toBe(true);
    expect(v.route).toBe('/checkout');
  });

  it('accepts the same attributes placed directly on a span', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2, evaluation: 'attributes' }));
    expect(v.evaluation?.variation).toBe(V2);
  });

  it('never assigns a variation: no evaluation means the flag is not on', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2, evaluation: 'none', faults: [faults.coupon] }));
    expect(v.evaluation).toBeUndefined();
    expect(v.flagOn).toBe(false);
    expect(v.counted).toBe(false);
    expect(v.reason).toContain('did not evaluate the flag');
  });

  it('ignores an evaluation of a different flag', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2 });
    const event = find(spans, 'request handler - /checkout').events[0];
    if (event) event.attrs['feature_flag.key'] = 'other_flag';
    expect(judge(spans).evaluation).toBeUndefined();
  });

  it('a stable evaluation is not on, even for a failure on the flagged path', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2, faults: [faults.coupon] });
    const event = find(spans, 'request handler - /checkout').events[0];
    if (event) event.attrs['feature_flag.result.variant'] = STABLE;
    const v = judge(spans);
    expect(v.failureClass).toBe('flagged-path');
    expect(v.flagOn).toBe(false);
    expect(v.counted).toBe(false);
    expect(v.reason).toBe(
      "Failed in checkout_v2.apply_coupon, a span on the flagged path: TypeError: Cannot read properties of undefined (reading 'percent'). The flag was off for this request, so this does not count.",
    );
  });
});

describe('finding where a request failed', () => {
  it('returns nothing without a root server span', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2 }).filter((s) => s.kind !== 'server');
    expect(judgeTrace(spans, config())).toBeUndefined();
  });

  it('falls back to the span name when there is no route', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2 });
    delete (spans[0] as FlatSpan).attrs['http.route'];
    expect(judge(spans).route).toBe('POST /checkout');
  });

  it('keeps the origin at the deepest error span, not the ones above it', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2, faults: [faults.coupon] }));
    expect(v.origins.map((o) => o.name)).toEqual(['checkout_v2.apply_coupon']);
  });

  it('a handled error does not fail the request', () => {
    const spans = checkoutTrace({ n: 1, startMs: START, variation: V2 });
    find(spans, 'tax.lookup').error = true;
    const v = judge(spans);
    expect(v.failed).toBe(false);
    expect(v.origins).toEqual([]);
  });

  it('only a span under the flagged-path span is on the flagged path', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2, faults: [faults.tax, faults.coupon] }));
    expect(v.failureClass).toBe('mixed');
    expect(v.origins.map((o) => [o.name, o.onFlaggedPath])).toEqual([
      ['tax.lookup', false],
      ['checkout_v2.apply_coupon', true],
    ]);
  });

  it('keeps one span list per request for the baseline', () => {
    const v = judge(checkoutTrace({ n: 1, startMs: START, variation: V2 }));
    expect(v.points?.map((p) => p.name)).toContain('checkout_v2.price');
  });

  it('shortens long messages to 140 characters', () => {
    const v = judge(
      checkoutTrace({ n: 1, startMs: START, variation: V2, faults: [{ at: 'coupon', type: 'Error', message: 'x'.repeat(300) }] }),
    );
    expect(v.reason).toContain(`Error: ${'x'.repeat(133)}... Counts toward the switch-off.`);
    expect(v.reason).not.toContain('x'.repeat(134));
  });
});

describe('dependency calls', () => {
  const unavailable: [string, Fault, Record<string, string | number>][] = [
    ['connection reset', { at: 'price-query', type: 'ECONNRESET', message: 'read ECONNRESET' }, {}],
    ['timeout', { at: 'price-query', type: 'Error', message: 'Query read timeout' }, {}],
    ['DNS failure', { at: 'price-query', type: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND postgres' }, {}],
    ['pool cannot connect', { at: 'price-query', type: 'Error', message: 'Connection terminated unexpectedly' }, {}],
    ['shutting down', { at: 'price-query', type: 'Error', message: 'the database system is shutting down' }, {}],
    ['SQLSTATE 08', { at: 'price-query', type: 'Error', message: 'boom' }, { 'db.response.status_code': '08006' }],
    ['SQLSTATE 53', { at: 'price-query', type: 'Error', message: 'boom' }, { 'db.response.status_code': '53300' }],
    ['SQLSTATE 57P01', { at: 'price-query', type: '57P01', message: 'terminating connection due to administrator command' }, {}],
    ['HTTP 503', { at: 'price-query', type: 'Error', message: 'bad gateway' }, { 'http.response.status_code': 503 }],
  ];
  it.each(unavailable)('%s is an unavailable dependency and never counts', (_name, fault, extra) => {
    const v = priceQuery(fault, extra);
    expect(v.failureClass).toBe('dependency');
    expect(v.counted).toBe(false);
  });

  const rejected: [string, Fault, Record<string, string | number>][] = [
    ['SQLSTATE 23 constraint', { at: 'price-query', type: '23505', message: 'duplicate key value violates unique constraint "prices_pkey"' }, {}],
    ['SQLSTATE 22', { at: 'price-query', type: 'Error', message: 'bad' }, { 'db.response.status_code': '22P02' }],
    ['SQLSTATE 42 missing table', { at: 'price-query', type: '42P01', message: 'relation "prices" does not exist' }, {}],
    ['HTTP 404', { at: 'price-query', type: 'Error', message: 'not found' }, { 'http.response.status_code': 404 }],
  ];
  it.each(rejected)('%s is a rejected call, the feature\'s fault', (_name, fault, extra) => {
    const v = priceQuery(fault, extra);
    expect(v.failureClass).toBe('flagged-path');
    expect(v.counted).toBe(true);
  });

  it('a rejected call outside the flagged path is a server failure', () => {
    const v = judge(
      checkoutTrace({ n: 3, startMs: START, variation: STABLE, faults: [{ at: 'shop-query', type: '42601', message: 'syntax error at or near "X"' }] }),
    );
    expect(v.failureClass).toBe('server');
    expect(v.reason).toBe(
      'Failed in pg.query:SELECT shop, a dependency call (db.system.name=postgresql) outside the flagged path: 42601: syntax error at or near "X". The dependency rejected the call, so the fault is in the calling code outside the flagged path. Does not count.',
    );
  });

  it('a timeout in a span that is not a dependency call is not an unavailable dependency', () => {
    const v = judge(checkoutTrace({ n: 4, startMs: START, variation: V2, faults: [faults.budget] }));
    expect(v.failureClass).toBe('flagged-path');
  });

  it('an unrecognised dependency error does not count and says so', () => {
    const v = priceQuery({ at: 'price-query', type: 'Error', message: 'odd' });
    expect(v.failureClass).toBe('dependency');
    expect(v.reason).toContain('nothing in the span says the dependency rejected it');
  });

  it('names an http client by its address', () => {
    const spans = checkoutTrace({ n: 5, startMs: START, variation: V2, faults: [{ at: 'price-query', type: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.9:443' }] });
    const q = find(spans, 'pg.query:SELECT price');
    q.attrs = { 'http.request.method': 'GET', 'server.address': 'rates.internal' };
    expect(judge(spans).reason).toContain('a dependency call (server.address=rates.internal)');
  });

  it('an error span above another error span is not an origin', () => {
    const spans = checkoutTrace({ n: 7, startMs: START, variation: V2, faults: [faults.coupon, faults.budget] });
    expect(judge(spans).origins.map((o) => o.name)).toEqual(['checkout_v2.apply_coupon']);
  });
});
