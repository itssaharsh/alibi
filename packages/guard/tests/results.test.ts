import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvestigationRecord } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { FakeFlagsmith, harness, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
  h = harness(fake, START);
  await h.service.start();
});

afterEach(async () => {
  await h.service.stop();
  await fake.stop();
});

const record = (): InvestigationRecord => {
  const [entry] = h.service.listRecords();
  return JSON.parse(readFileSync(join(h.dir, 'data', 'records', `${entry?.id}.json`), 'utf8')) as InvestigationRecord;
};

describe("Flagsmith's own numbers", () => {
  it('reads the results once, shortly before the watch ends, and the record carries them', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    expect(fake.refreshes).toBe(0);
    expect(h.service.state().flagsmith.results).toBeUndefined();
    const off = h.service.state().state.switchedOffAtMs as number;
    await play(h, lines, off + 300_100);
    expect(h.service.state().state.phase).toBe('closed');
    expect(fake.refreshes).toBe(1);
    const results = h.service.state().flagsmith.results;
    expect(results).toEqual({
      experimentId: 1,
      readAtMs: expect.any(Number),
      variations: [
        {
          variation: 'stable',
          exposures: 300,
          metrics: [
            { name: 'checkout_completed', value: 0.6667 },
            { name: 'checkout_latency_ms', value: 100 },
          ],
        },
        {
          variation: 'v2',
          exposures: 310,
          metrics: [
            { name: 'checkout_completed', value: 0.8065, lift: 0.25, chanceToWin: 0.97, interval: [0.05, 0.45] },
            { name: 'checkout_latency_ms', value: 100, lift: 0.04, chanceToWin: 0.3, interval: [-0.1, 0.18] },
          ],
        },
      ],
    });
    expect(record().flagsmith).toEqual(results);
    expect(results?.readAtMs).toBeLessThan(off + 300_000);
    await h.clock.advanceBy(600_000);
    expect(fake.refreshes).toBe(1);
  });

  it('waits for Flagsmith to finish a refresh instead of treating "nothing yet" as a failure', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    fake.resultsMissing = 3;
    const off = h.service.state().state.switchedOffAtMs as number;
    await play(h, lines, off + 300_100);
    await h.clock.advanceBy(10_000);
    expect(fake.refreshes).toBe(1);
    expect(record().flagsmith?.variations).toHaveLength(2);
  });

  it('on a 429 waits for the time Flagsmith names, tries once more and updates the record', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    fake.limits = [100];
    const off = h.service.state().state.switchedOffAtMs as number;
    await play(h, lines, off + 300_100);
    expect(fake.refreshes).toBe(1);
    expect(record().flagsmith).toBeUndefined();
    await h.clock.advanceBy(120_000);
    expect(fake.refreshes).toBe(2);
    expect(record().flagsmith?.readAtMs).toBeGreaterThanOrEqual(off + 300_000);
  });

  it('never loops: two refusals in a row stop after one retry', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    fake.limits = [60, 60, 60, 60];
    await play(h, lines);
    await h.clock.advanceBy(600_000);
    expect(fake.refreshes).toBe(2);
    expect(record().flagsmith).toBeUndefined();
  });
});
