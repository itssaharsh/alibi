import { describe, expect, it } from 'vitest';
import { serialiseRun, type FlatSpan, type RunLine } from '@alibi/core';
import { slimSpan } from '../src/slim.js';
import { checkoutTrace, config, faults, START, STABLE, V2 } from './fixtures.js';

describe('slimming spans for a recording', () => {
  it('keeps the attributes the engine and the page read, and the two events', () => {
    const [root, handler, , query] = checkoutTrace({ n: 1, startMs: START, variation: V2, faults: [faults.coupon] });
    const noisy: FlatSpan = {
      ...root!,
      attrs: { ...root!.attrs, 'process.pid': 12, 'http.user_agent': 'curl', 'service.name': 'shop', 'telemetry.sdk.version': '1.2.3', 'alibi.flagged_path': 'checkout_v2', 'messaging.system': 'kafka', 'rpc.system': 'grpc', 'url.full': 'http://x', 'server.address': 'shop', 'net.peer.name': 'db', 'error.type': 'Error', 'exception.type': 'E', 'feature_flag.key': 'checkout_v2' },
      events: [
        { name: 'log', timeMs: 1, attrs: { message: 'noise' } },
        { name: 'exception', timeMs: 2, attrs: { 'exception.type': 'TypeError' } },
        { name: 'feature_flag.evaluation', timeMs: 3, attrs: { 'feature_flag.key': 'checkout_v2' } },
      ],
    };
    const slim = slimSpan(noisy);
    expect(Object.keys(slim.attrs).sort()).toEqual(
      ['alibi.flagged_path', 'error.type', 'exception.type', 'feature_flag.key', 'http.request.method', 'http.response.status_code', 'http.route', 'http.user_agent', 'messaging.system', 'net.peer.name', 'rpc.system', 'server.address', 'service.name', 'url.full'].sort(),
    );
    expect(slim.events.map((e) => e.name)).toEqual(['exception', 'feature_flag.evaluation']);
    expect(handler!.attrs['express.type']).toBe('request_handler');
    expect(slimSpan(handler!).attrs).toEqual({});
    expect(slimSpan(query!).attrs['db.statement']).toBe('SELECT * FROM shops WHERE id = $1');
    expect(slimSpan({ ...query!, attrs: { 'db.statement': 'x'.repeat(400) } }).attrs['db.statement']).toHaveLength(259);
    expect(slimSpan(root!)).toMatchObject({ traceId: root!.traceId, spanId: root!.spanId, startMs: root!.startMs, endMs: root!.endMs, error: root!.error });
  });

  it('keeps a nine minute run at 5 requests a second under 8 MB', () => {
    const lines: RunLine[] = [];
    for (let n = 0; n < 9 * 60 * 5; n += 1) {
      const startMs = START + n * 200;
      const spans = checkoutTrace({ n, startMs, variation: n % 2 === 0 ? V2 : STABLE, durationMs: 90 + (n % 11), faults: n % 9 === 0 && n % 2 === 0 ? [faults.coupon] : [] });
      for (const span of spans) Object.assign(span.attrs, { 'process.pid': 1, 'http.user_agent': 'k6/0.50', 'net.host.port': 8080, 'http.scheme': 'http', 'http.target': '/checkout' });
      lines.push({ kind: 'spans', atMs: startMs + 130, spans: spans.map(slimSpan) });
    }
    const bytes = Buffer.byteLength(serialiseRun([{ kind: 'alibi-run', version: 1, name: 'n', title: 't', planted: 'p', config: config(), startedAtMs: START, source: 's' }, ...lines]));
    console.log(`nine minute run at 5 requests a second: ${(bytes / 1048576).toFixed(2)} MB, ${Math.round(bytes / (9 * 60 * 5))} bytes a request`);
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
  });
});
