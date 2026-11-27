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
  it('reads the results at the switch-off and maps the real payload shape', async () => {
    await play(h, buildRun('feature-bug'), START + 150_000);
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
  });

  it('respects the 300 second limit: the end-of-watch read waits until Flagsmith allows it', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    const off = h.service.state().state.switchedOffAtMs as number;
    await play(h, lines, off + 300_100);
    expect(h.service.state().state.phase).toBe('closed');
    expect(fake.refreshes).toBe(1);
    const atLabel = record();
    expect(Math.abs((atLabel.flagsmith?.readAtMs as number) - off)).toBeLessThanOrEqual(1);

    await play(h, lines);
    expect(fake.refreshes).toBe(2);
    const later = record();
    expect(later.flagsmith?.readAtMs).toBeGreaterThanOrEqual(off + 300_000);
    expect(later.flagsmith?.variations).toEqual(atLabel.flagsmith?.variations);
  });

  it('on a 429 waits for the time Flagsmith names and tries once more', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    fake.limits = [100];
    await play(h, lines);
    await h.clock.advanceBy(300_000);
    expect(fake.refreshes).toBe(3);
    const readAt = record().flagsmith?.readAtMs as number;
    const off = h.service.state().state.switchedOffAtMs as number;
    expect(readAt).toBeGreaterThanOrEqual(off + 300_000 + 100_000);
  });

  it('never loops: two refusals in a row stop after one retry', async () => {
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 150_000);
    fake.limits = [60, 60, 60, 60];
    await play(h, lines);
    await h.clock.advanceBy(600_000);
    expect(fake.refreshes).toBe(3);
    expect(Math.abs((record().flagsmith?.readAtMs as number) - (h.service.state().state.switchedOffAtMs as number))).toBeLessThanOrEqual(1);
  });

  it('is not read when the experiment id is unknown', async () => {
    await h.service.stop();
    h = harness(fake, START, { FLAGSMITH_EXPERIMENT_ID: '' });
    await h.service.start();
    await play(h, buildRun('feature-bug'));
    expect(fake.refreshes).toBe(0);
    expect(record().flagsmith).toBeUndefined();
  });
});
