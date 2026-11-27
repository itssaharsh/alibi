import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvestigationRecord } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing, play } from './drive.js';
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

describe('the baseline comparison in the state', () => {
  it('is empty before anything has failed, and shows the failing point against stable once it has', async () => {
    expect(h.service.state().baseline).toEqual([]);
    feedCrossing(h);
    await h.clock.advanceBy(1000);
    expect(h.service.state().baseline).toEqual([]);
    await h.clock.advanceBy(2500);
    const rows = h.service.state().baseline;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: '/checkout', span: 'checkout_v2.apply_coupon', spanExistsInStable: false });
    expect(rows[0]?.flagOn.failures).toBe(20);
    expect(rows[0]?.stable.requests).toBe(10);
  });

  it('equals the record\'s table once the record is written', async () => {
    await play(h, buildRun('feature-bug'));
    await h.clock.advanceBy(5000);
    const [entry] = h.service.listRecords();
    const record = JSON.parse(readFileSync(join(h.dir, 'data', 'records', `${entry?.id}.json`), 'utf8')) as InvestigationRecord;
    expect(record.baseline.length).toBeGreaterThan(0);
    expect(h.service.state().baseline).toEqual(record.baseline);
  });

  it('is sent in the stream\'s state snapshot too, and cleared by a new run', async () => {
    feedCrossing(h);
    await h.clock.advanceBy(4000);
    expect(h.service.state({ recent: false }).baseline).toHaveLength(1);
    await h.service.arm({ name: 'next', force: true });
    expect(h.service.state().baseline).toEqual([]);
  });
});
