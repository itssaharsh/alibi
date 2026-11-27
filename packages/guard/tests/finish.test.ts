import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_TOKEN, FakeFlagsmith, harness, listen, tempDir, type Harness } from './helpers.js';
import { checkoutTrace, START, V2 } from './fixtures.js';
import { feedCrossing } from './drive.js';

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

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);

describe('finishing a run', () => {
  it('reads Flagsmith once for a run that never switched off, records it, and closes the file', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.jsonl');
    h = harness(fake, START, { ALIBI_RECORD: file }, dir);
    await h.service.start();
    h.service.receive(checkoutTrace({ n: 1, startMs: START, variation: V2, identity: 'ann' }));
    await h.clock.advanceBy(5000);
    const done = await h.service.finish();
    expect(done).toEqual({ resultsRead: true });
    expect(fake.refreshes).toBe(1);
    expect(h.service.state().flagsmith.results?.variations.map((v) => v.variation)).toEqual(['stable', 'v2']);
    const written = lines(file);
    const results = written.filter((line) => line.kind === 'flagsmith' && line.what === 'results');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, detail: 'read at the end of the run' });
    expect(h.service.state().run.recording).toBe(false);
    const size = written.length;
    h.service.receive(checkoutTrace({ n: 2, startMs: START + 6000, variation: V2, identity: 'bob' }));
    await h.clock.advanceBy(3000);
    expect(lines(file)).toHaveLength(size);
  });

  it('waits for the 300 second limit when a refresh just happened', async () => {
    h = harness(fake, START);
    await h.service.start();
    await h.service.finish();
    expect(fake.refreshes).toBe(1);
    const second = h.service.finish();
    await h.clock.advanceBy(120_000);
    expect(fake.refreshes).toBe(1);
    await h.clock.advanceBy(200_000);
    expect(await second).toEqual({ resultsRead: true });
    expect(fake.refreshes).toBe(2);
  });

  it('only closes the recording after a run that switched off', async () => {
    const dir = tempDir();
    h = harness(fake, START, { ALIBI_RECORD: join(dir, 'run.jsonl') }, dir);
    await h.service.start();
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    expect(h.service.state().state.phase).toBe('watching');
    const refreshes = fake.refreshes;
    expect(await h.service.finish()).toEqual({ resultsRead: false });
    expect(fake.refreshes).toBe(refreshes);
    expect(h.service.state().run.recording).toBe(false);
  });

  it('is behind the control token', async () => {
    h = harness(fake, START, { ALIBI_CONTROL_TOKEN: CONTROL_TOKEN });
    await h.service.start();
    const api = await listen(h);
    try {
      expect((await fetch(`${api.url}/api/finish`, { method: 'POST', body: '{}' })).status).toBe(401);
      const ok = await fetch(`${api.url}/api/finish`, { method: 'POST', headers: { Authorization: `Bearer ${CONTROL_TOKEN}` }, body: '{}' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, resultsRead: true });
    } finally {
      await api.close();
    }
  });
});
