import { describe, expect, it } from 'vitest';
import { flattenOtlp, OtlpError } from '../src/otlp.js';

const body = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'shop' } }] },
      scopeSpans: [
        {
          scope: { name: '@opentelemetry/instrumentation-http' },
          spans: [
            {
              traceId: '5b8efff798038103d269b633813fc60c',
              spanId: 'eee19b7ec3c1b174',
              name: 'POST /checkout',
              kind: 2,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000000084500000',
              attributes: [
                { key: 'http.route', value: { stringValue: '/checkout' } },
                { key: 'http.response.status_code', value: { intValue: '500' } },
                { key: 'http.request.content_length', value: { intValue: 42 } },
                { key: 'cache.hit', value: { boolValue: false } },
                { key: 'cart.total', value: { doubleValue: 12.5 } },
                { key: 'cart.items', value: { arrayValue: { values: [] } } },
              ],
              status: { code: 2 },
              events: [],
            },
            {
              traceId: '5b8efff798038103d269b633813fc60c',
              spanId: 'eee19b7ec3c1b175',
              parentSpanId: 'eee19b7ec3c1b174',
              name: 'pg.query:SELECT shop',
              kind: 3,
              startTimeUnixNano: '1700000000010000000',
              endTimeUnixNano: '1700000000013000000',
              status: { code: 2, message: 'connect ECONNREFUSED 172.18.0.5:5432' },
              events: [
                {
                  name: 'exception',
                  timeUnixNano: '1700000000012000000',
                  attributes: [{ key: 'exception.type', value: { stringValue: 'ECONNREFUSED' } }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              spanId: 'bbbbbbbbbbbbbbbb',
              parentSpanId: '',
              name: 'GET /health',
              kind: 'SPAN_KIND_SERVER',
              startTimeUnixNano: '1700000001000000000',
              endTimeUnixNano: '1700000001001000000',
              status: {},
            },
          ],
        },
      ],
    },
  ],
};

describe('flattenOtlp', () => {
  const spans = flattenOtlp(body);

  it('walks resources, scopes and spans', () => {
    expect(spans.map((s) => s.name)).toEqual(['POST /checkout', 'pg.query:SELECT shop', 'GET /health']);
  });

  it('reads the service name from the resource, with a fallback', () => {
    expect(spans.map((s) => s.service)).toEqual(['shop', 'shop', 'unknown']);
  });

  it('reads attribute value types', () => {
    expect(spans[0]?.attrs).toEqual({
      'http.route': '/checkout',
      'http.response.status_code': 500,
      'http.request.content_length': 42,
      'cache.hit': false,
      'cart.total': 12.5,
    });
  });

  it('turns nanosecond strings into milliseconds', () => {
    expect(spans[0]?.startMs).toBe(1_700_000_000_000);
    expect(spans[0]?.endMs).toBe(1_700_000_000_084.5);
    expect(spans[0]?.durationMs).toBe(84.5);
  });

  it('maps kind numbers and names', () => {
    expect(spans.map((s) => s.kind)).toEqual(['server', 'client', 'server']);
  });

  it('reads status, parent and events', () => {
    expect(spans[0]?.error).toBe(true);
    expect(spans[0]?.parentSpanId).toBeUndefined();
    expect(spans[1]?.parentSpanId).toBe('eee19b7ec3c1b174');
    expect(spans[1]?.statusMessage).toBe('connect ECONNREFUSED 172.18.0.5:5432');
    expect(spans[1]?.events).toEqual([{ name: 'exception', timeMs: 1_700_000_000_012, attrs: { 'exception.type': 'ECONNREFUSED' } }]);
    expect(spans[2]?.error).toBe(false);
    expect(spans[2]?.parentSpanId).toBeUndefined();
  });

  it('returns no spans for an empty export', () => {
    expect(flattenOtlp({})).toEqual([]);
    expect(flattenOtlp({ resourceSpans: [] })).toEqual([]);
  });

  it('says what is wrong with a malformed body', () => {
    expect(() => flattenOtlp('nope')).toThrow(OtlpError);
    expect(() => flattenOtlp({ resourceSpans: 3 })).toThrow('resourceSpans is not a list');
    expect(() => flattenOtlp({ resourceSpans: [{ scopeSpans: [{ spans: [{ spanId: 'a' }] }] }] })).toThrow('no traceId or spanId');
    expect(() =>
      flattenOtlp({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 't', spanId: 's', startTimeUnixNano: 'x', endTimeUnixNano: '1' }] }] }] }),
    ).toThrow('startTimeUnixNano of span s is not a nanosecond timestamp');
  });
});
