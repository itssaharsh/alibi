import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlatSpan, InvestigationRecord } from '@alibi/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing, play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { CONTROL_TOKEN, FakeFlagsmith, harness, listen, tempDir, type Harness } from './helpers.js';

describe('after a finished run', () => {
  let fake: FakeFlagsmith;
  let h: Harness;
  let api: { url: string; close: () => Promise<void> };
  let recordId: string;

  beforeAll(async () => {
    fake = new FakeFlagsmith();
    await fake.start();
    h = harness(fake, START);
    await h.service.start();
    api = await listen(h);
    await play(h, buildRun('feature-bug'));
    recordId = h.service.listRecords()[0]?.id as string;
  });

  afterAll(async () => {
    await api.close();
    await h.service.stop();
    await fake.stop();
  });

  it('writes the record as JSON and Markdown and lists it', async () => {
    expect(recordId).toMatch(/^checkout_v2-\d+$/);
    const dir = join(h.dir, 'data', 'records');
    expect(existsSync(join(dir, `${recordId}.json`))).toBe(true);
    expect(existsSync(join(dir, `${recordId}.md`))).toBe(true);
    const list = (await (await fetch(`${api.url}/api/records`)).json()) as { id: string; label: string; openedAtMs: number }[];
    expect(list).toEqual([{ id: recordId, label: 'probably the feature', openedAtMs: expect.any(Number) }]);
    const record = (await (await fetch(`${api.url}/api/records/${recordId}`)).json()) as InvestigationRecord;
    expect(record.label).toBe('probably the feature');
    expect(record.nextStep).toBe('A person investigates. Alibi does not declare the cause.');
    expect(record.counted).toBe(16);
    const md = await (await fetch(`${api.url}/api/records/${recordId}.md`)).text();
    expect(md.startsWith('# Investigation record: checkout_v2')).toBe(true);
    expect(md).toContain('**probably the feature** (not proven)');
    expect(md).toContain('## Flagsmith experiment numbers');
    expect((await fetch(`${api.url}/api/records/nope`)).status).toBe(404);
    expect((await fetch(`${api.url}/api/records/..%2Fstate.json`)).status).toBe(404);
  });

  it('serves the state for the page', async () => {
    const res = await fetch(`${api.url}/api/state`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(['flagsmith', 'lastSpanAtMs', 'receiver', 'records', 'recent', 'run', 'state', 'timeline'].sort());
    expect(body.state.phase).toBe('closed');
    expect(body.state.label).toBe('probably the feature');
    expect(body.flagsmith.forwarded.accepted).toBeGreaterThan(300);
    expect(body.flagsmith.forwardingStoppedAtMs).toBe(body.state.switchedOffAtMs);
    expect(body.flagsmith.switchOff.confirmed).toBe(true);
    expect(body.recent.length).toBeGreaterThan(100);
    expect(body.recent.length).toBeLessThanOrEqual(200);
    expect(body.recent.every((v: { failed: boolean; flagOn: boolean }) => v.failed || v.flagOn)).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.run).toMatchObject({ name: 'live', startedAtMs: START });
    expect(body.timeline.some((e: { text: string }) => e.text.startsWith('Label: probably the feature'))).toBe(true);
    expect(typeof body.lastSpanAtMs).toBe('number');
  });

  it('keeps the spans of a failing trace', async () => {
    const record = JSON.parse(readFileSync(join(h.dir, 'data', 'records', `${recordId}.json`), 'utf8')) as InvestigationRecord;
    const failing = record.traces[0]?.traceId as string;
    const res = await fetch(`${api.url}/api/traces/${failing}`);
    const spans = (await res.json()) as FlatSpan[];
    expect(spans.length).toBe(7);
    expect(spans.some((s) => s.error && s.name === 'checkout_v2.apply_coupon')).toBe(true);
    expect((await fetch(`${api.url}/api/traces/${'0'.repeat(32)}`)).status).toBe(404);
  });

  it('answers CORS for GET and the preflight, with no cookies', async () => {
    const pre = await fetch(`${api.url}/api/state`, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
    expect(pre.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${api.url}/nothing`)).status).toBe(404);
  });
});

describe('the control endpoints', () => {
  let fake: FakeFlagsmith;
  let h: Harness;
  let api: { url: string; close: () => Promise<void> };
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${api.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    fake = new FakeFlagsmith();
    await fake.start();
    const dir = tempDir();
    h = harness(fake, START, { ALIBI_CONTROL_TOKEN: CONTROL_TOKEN, ALIBI_RECORD_DIR: join(dir, 'runs') }, dir);
    await h.service.start();
    api = await listen(h);
  });

  afterEach(async () => {
    await api.close();
    await h.service.stop();
    await fake.stop();
  });

  it('refuses arm and world without the token, and with a wrong one', async () => {
    expect((await post('/api/arm', {})).status).toBe(401);
    expect((await post('/api/world', { text: 'x' })).status).toBe(401);
    expect((await post('/api/arm', {}, 'wrong-token-value')).status).toBe(401);
    expect((await post('/api/world', { text: 'x' }, CONTROL_TOKEN)).status).toBe(200);
    const direct = await fetch(`${api.url}/api/world`, { method: 'POST', headers: { 'X-Alibi-Token': CONTROL_TOKEN }, body: JSON.stringify({ text: 'y' }) });
    expect(direct.status).toBe(200);
  });

  it('adds a world line to the timeline and the recording', async () => {
    await post('/api/arm', { name: 'bug', title: 'The bug', planted: 'A planted bug.' }, CONTROL_TOKEN);
    await h.clock.advanceBy(5000);
    await post('/api/world', { text: 'The coupon bug started.' }, CONTROL_TOKEN);
    expect(h.service.state().timeline.at(-1)).toEqual({ atMs: START + 5000, text: 'The coupon bug started.' });
    await h.service.idle();
    const lines = readFileSync(join(h.dir, 'runs', 'bug.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'alibi-run', name: 'bug', title: 'The bug', planted: 'A planted bug.', startedAtMs: START });
    expect(lines[0]?.source).toBe('self-hosted Flagsmith 2.295.2, recorded 14 Nov 2023');
    expect(lines[1]).toEqual({ kind: 'world', atMs: START + 5000, text: 'The coupon bug started.' });
    expect((await post('/api/world', { text: '' }, CONTROL_TOKEN)).status).toBe(400);
  });

  it('refuses to arm while a watch is running unless forced, then resets and starts a new file', async () => {
    await post('/api/arm', { name: 'first' }, CONTROL_TOKEN);
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    expect(h.service.state().state.phase).toBe('watching');
    const refused = await post('/api/arm', { name: 'second' }, CONTROL_TOKEN);
    expect(refused.status).toBe(409);
    expect(h.service.state().state.phase).toBe('watching');
    const forced = await post('/api/arm', { name: 'second', title: 'Second run', force: true }, CONTROL_TOKEN);
    expect(forced.status).toBe(200);
    const view = h.service.state();
    expect(view.state.phase).toBe('armed');
    expect(view.state.counted).toBe(0);
    expect(view.timeline).toEqual([]);
    expect(view.run).toMatchObject({ name: 'second', title: 'Second run', recording: true });
    await h.service.idle();
    expect(existsSync(join(h.dir, 'runs', 'first.jsonl'))).toBe(true);
    expect(existsSync(join(h.dir, 'runs', 'second.jsonl'))).toBe(true);
  });

  it('arms again after a finished run without force', async () => {
    await post('/api/arm', { name: 'run' }, CONTROL_TOKEN);
    await play(h, buildRun('feature-bug'));
    expect(h.service.state().state.phase).toBe('closed');
    expect((await post('/api/arm', { name: 'next' }, CONTROL_TOKEN)).status).toBe(200);
    expect(h.service.state().state.phase).toBe('armed');
    expect(h.service.listRecords()).toHaveLength(1);
  });

  it('needs no token when none is set', async () => {
    await api.close();
    await h.service.stop();
    h = harness(fake, START);
    await h.service.start();
    api = await listen(h);
    expect((await post('/api/arm', {})).status).toBe(200);
    expect((await post('/api/arm', { name: 5 })).status).toBe(400);
  });
});

describe('GET /api/events', () => {
  let fake: FakeFlagsmith;
  let h: Harness;
  let api: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    fake = new FakeFlagsmith();
    await fake.start();
    h = harness(fake, START);
    await h.service.start();
    api = await listen(h);
  });

  afterEach(async () => {
    await api.close();
    await h.service.stop();
    await fake.stop();
  });

  it('streams a state snapshot, rates once a second, and only the failing verdicts, then cleans up', async () => {
    const controller = new AbortController();
    const res = await fetch(`${api.url}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const until = async (needle: RegExp): Promise<void> => {
      while (!needle.test(text)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('the stream ended');
        text += decoder.decode(chunk.value);
      }
    };
    await until(/event: state\ndata: .*\n/);
    expect(JSON.parse(/event: state\ndata: (.+)\n/.exec(text)?.[1] ?? '{}')).toMatchObject({ type: 'state', state: { phase: 'armed' }, run: { name: 'live' } });
    const internals = h.service as unknown as { listeners: Set<unknown> };
    expect(internals.listeners.size).toBe(1);

    feedCrossing(h);
    await h.clock.advanceBy(4000);
    await until(/event: threshold-crossed\n/);
    await until(/event: switched-off\n/);
    await until(/event: rates\n/);
    const events = [...text.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({ name: m[1] as string, data: JSON.parse(m[2] as string) as Record<string, any> }));
    const verdicts = events.filter((e) => e.name === 'verdict');
    expect(verdicts.length).toBe(20);
    expect(verdicts.every((e) => e.data.verdict.failed)).toBe(true);
    const rates = events.filter((e) => e.name === 'rates');
    expect(rates.reduce((sum, e) => sum + e.data.flagOn.requests, 0)).toBe(20);
    expect(rates.reduce((sum, e) => sum + e.data.stable.requests, 0)).toBe(10);
    expect(text).toContain('retry: 3000');

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(internals.listeners.size).toBe(0);
  });
});
