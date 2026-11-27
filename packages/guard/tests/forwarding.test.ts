import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutTrace, faults, START, STABLE, V2 } from './fixtures.js';
import { FakeFlagsmith, harness, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
});

afterEach(async () => {
  await h.service.stop();
  await fake.stop();
});

async function boot(extra: Record<string, string> = {}): Promise<void> {
  h = harness(fake, START, extra);
  await h.service.start();
}

describe('forwarding to Flagsmith Experimentation', () => {
  it('sends an exposure and the metrics for each request, with the span end time in milliseconds', async () => {
    await boot();
    const ok = checkoutTrace({ n: 1, startMs: START, durationMs: 120, variation: V2, identity: 'ann' });
    const bug = checkoutTrace({ n: 2, startMs: START, durationMs: 90, variation: V2, identity: 'bob', faults: [faults.coupon] });
    const outage = checkoutTrace({ n: 3, startMs: START, durationMs: 40, variation: V2, identity: 'cy', faults: [faults.dbRefused('shop-query')] });
    const calm = checkoutTrace({ n: 4, startMs: START, durationMs: 80, variation: STABLE, identity: 'di' });
    for (const spans of [ok, bug, outage, calm]) h.service.receive(spans);
    await h.clock.advanceBy(6000);

    const by = (identifier: string) => fake.events.filter((e) => e.identifier === identifier).map((e) => e.event);
    expect(by('ann')).toEqual(['$flag_exposure', 'checkout_completed', 'checkout_latency_ms']);
    expect(by('bob')).toEqual(['$flag_exposure', 'flag_path_failure', 'checkout_latency_ms']);
    expect(by('cy')).toEqual(['$flag_exposure', 'checkout_latency_ms']);
    expect(by('di')).toEqual(['$flag_exposure', 'checkout_completed', 'checkout_latency_ms']);

    const exposure = fake.events.find((e) => e.identifier === 'ann' && e.event === '$flag_exposure');
    expect(exposure).toEqual({ event: '$flag_exposure', identifier: 'ann', feature_name: 'checkout_v2', value: 'v2', timestamp: START + 120 });
    const latency = fake.events.find((e) => e.identifier === 'ann' && e.event === 'checkout_latency_ms');
    expect(latency).toMatchObject({ value: 120, timestamp: START + 120 });
    expect(fake.events.find((e) => e.identifier === 'di' && e.event === '$flag_exposure')).toMatchObject({ value: 'control' });
    for (const event of fake.events) expect(Number.isInteger(event.timestamp) && (event.timestamp as number) > 1.5e12).toBe(true);
    expect(fake.headers.find((header) => header['x-environment-key'])).toBeDefined();
    expect(h.service.state().flagsmith.forwarded).toMatchObject({ sent: 11, accepted: 11, rejected: 0, failed: 0 });
  });

  it('uses event names from the rule file', async () => {
    const dir = (await import('./helpers.js')).tempDir();
    const { writeFileSync } = await import('node:fs');
    const rules = `${dir}/rules.json`;
    writeFileSync(rules, JSON.stringify({ events: { completed: 'order_done', latency: 'order_ms' } }));
    h = harness(fake, START, { ALIBI_RULES: rules }, dir);
    await h.service.start();
    h.service.receive(checkoutTrace({ n: 1, startMs: START, variation: V2, identity: 'ann' }));
    await h.clock.advanceBy(5000);
    expect(fake.events.map((e) => e.event)).toEqual(['$flag_exposure', 'order_done', 'order_ms']);
  });

  it('skips requests that never evaluated the flag, and identities that are empty', async () => {
    await boot();
    h.service.receive(checkoutTrace({ n: 1, startMs: START, variation: V2, evaluation: 'none' }));
    h.service.receive(checkoutTrace({ n: 2, startMs: START, variation: V2, identity: '' }));
    await h.clock.advanceBy(5000);
    expect(fake.events).toHaveLength(0);
  });

  it('flushes a full batch of 200 at once, and the rest on the timer', async () => {
    await boot();
    for (let n = 1; n <= 70; n += 1) h.service.receive(checkoutTrace({ n, startMs: START, variation: V2, identity: `u${n}` }));
    await h.clock.advanceBy(3000);
    const sizes = (fake.eventBodies as { events: unknown[] }[]).map((body) => body.events.length);
    expect(sizes[0]).toBe(200);
    await h.clock.advanceBy(3000);
    expect((fake.eventBodies as { events: unknown[] }[]).reduce((sum, body) => sum + body.events.length, 0)).toBe(210);
  });

  it('retries a 5xx with backoff and loses nothing', async () => {
    await boot();
    fake.eventFailures = [503, 502];
    h.service.receive(checkoutTrace({ n: 1, startMs: START, variation: V2, identity: 'ann' }));
    await h.clock.advanceBy(3000);
    expect(fake.events).toHaveLength(0);
    await h.clock.advanceBy(10000);
    expect(fake.events).toHaveLength(3);
    expect(h.service.state().flagsmith.forwarded).toMatchObject({ sent: 3, accepted: 3, failed: 0, retries: 2 });
  });

  it('retries a network error, and counts events it gave up on as failed', async () => {
    await boot();
    fake.down = true;
    h.service.receive(checkoutTrace({ n: 1, startMs: START, variation: V2, identity: 'ann' }));
    await h.clock.advanceBy(60000);
    const totals = h.service.state().flagsmith.forwarded;
    expect(totals).toMatchObject({ sent: 0, accepted: 0, failed: 3, retries: 5 });
    expect(totals.lastProblem).toContain('gave up on 3 events');
    fake.down = false;
    h.service.receive(checkoutTrace({ n: 2, startMs: START + 60000, variation: V2, identity: 'bea' }));
    await h.clock.advanceBy(8000);
    expect(fake.events.filter((e) => e.identifier === 'bea')).toHaveLength(3);
  });

  it('does not hold up ingestion while Flagsmith is down', async () => {
    await boot();
    fake.down = true;
    for (let n = 1; n <= 30; n += 1) h.service.receive(checkoutTrace({ n, startMs: START, variation: V2, identity: `u${n}` }));
    await h.clock.advanceBy(4000);
    expect(h.service.state().state.totals.flagOn.requests).toBe(30);
    expect(h.service.state().flagsmith.forwarded).toMatchObject({ sent: 0, failed: 0 });
    expect(h.service.state().flagsmith.forwarded.retries).toBeGreaterThan(0);
  });

  it('counts rejected events and keeps the reason', async () => {
    await boot();
    h.service.receive(checkoutTrace({ n: 1, startMs: 1000, variation: V2, identity: 'old' }));
    await h.clock.advanceBy(5000);
    const totals = h.service.state().flagsmith.forwarded;
    expect(totals).toMatchObject({ sent: 3, accepted: 0, rejected: 3, failed: 0 });
    expect(totals.lastProblem).toContain('Timestamp must be after 2020-01-01');
  });
});
