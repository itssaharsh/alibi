import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutTrace, faults, START, V2 } from './fixtures.js';
import { FakeFlagsmith, harness, listen, toOtlp, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;
let api: { url: string; close: () => Promise<void> };

async function boot(extra: Record<string, string> = {}): Promise<void> {
  h = harness(fake, START, extra);
  await h.service.start();
  api = await listen(h);
}

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
});

afterEach(async () => {
  await api.close();
  await h.service.stop();
  await fake.stop();
});

const post = (body: string | Buffer, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  fetch(`${api.url}/v1/traces`, { method: 'POST', headers, body });

describe('POST /v1/traces', () => {
  const body = () => JSON.stringify(toOtlp(checkoutTrace({ n: 1, startMs: START, variation: V2 })));

  it('takes a plain OTLP JSON body', async () => {
    await boot();
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(h.service.state().receiver).toMatchObject({ batches: 1, spans: 7, malformed: 0 });
  });

  it('takes a gzipped body, as the collector sends by default', async () => {
    await boot();
    const res = await post(gzipSync(body()), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(200);
    expect(h.service.state().receiver.spans).toBe(7);
  });

  it('answers 400 with a short reason for a malformed body', async () => {
    await boot();
    for (const [payload, reason] of [
      ['{not json', 'the body is not valid JSON'],
      ['[]', 'the body is not a JSON object'],
      [JSON.stringify({ resourceSpans: 'x' }), 'resourceSpans is not a list'],
    ] as const) {
      const res = await post(payload);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: reason });
    }
    const bad = await post(Buffer.from('this is not gzip'), { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'the body is not valid gzip' });
    expect(h.service.state().receiver.malformed).toBe(4);
  });

  it('refuses a protobuf body and says what to change', async () => {
    await boot();
    const res = await post(Buffer.from([1, 2, 3]), { 'Content-Type': 'application/x-protobuf' });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toContain('encoding: json');
  });

  it('refuses a body over the limit, plain or after unzipping', async () => {
    await boot({ ALIBI_MAX_BODY_BYTES: '2000' });
    const big = JSON.stringify(toOtlp(checkoutTrace({ n: 2, startMs: START, variation: V2 })));
    expect(big.length).toBeGreaterThan(2000);
    expect((await post(big)).status).toBe(413);
    const bomb = gzipSync(JSON.stringify({ resourceSpans: [], padding: 'x'.repeat(50000) }));
    expect(bomb.length).toBeLessThan(2000);
    const res = await post(bomb, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(res.status).toBe(413);
    expect(h.service.state().receiver.spans).toBe(0);
  });

  it('answers an empty export with 200 and keeps going', async () => {
    await boot();
    expect((await post(JSON.stringify({ resourceSpans: [] }))).status).toBe(200);
    expect((await post(JSON.stringify({}))).status).toBe(200);
  });

  it('only accepts POST, and reports health with the phase', async () => {
    await boot();
    expect((await fetch(`${api.url}/v1/traces`)).status).toBe(405);
    const health = await fetch(`${api.url}/healthz`);
    expect(await health.text()).toBe('ok armed\n');
  });

  it('judges a received request: a failing flagged-path request is counted', async () => {
    await boot();
    const spans = checkoutTrace({ n: 3, startMs: START, variation: V2, faults: [faults.coupon] });
    await post(JSON.stringify(toOtlp(spans)));
    await h.clock.advanceBy(3000);
    expect(h.service.state().state.counted).toBe(1);
    expect(h.service.state().recent?.[0]?.failureClass).toBe('flagged-path');
  });
});
