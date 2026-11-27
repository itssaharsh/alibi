import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvestigationRecord } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feedCrossing, play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { FakeFlagsmith, harness, tempDir, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let first: Harness;
let second: Harness | undefined;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
  second = undefined;
});

afterEach(async () => {
  await first.service.stop();
  await second?.service.stop();
  await fake.stop();
});

describe('a restart in the middle of a run', () => {
  it('carries on in the watch and writes the record at its end', async () => {
    const dir = tempDir();
    first = harness(fake, START, {}, dir);
    await first.service.start();
    const lines = buildRun('feature-bug');
    await play(first, lines, START + 150_000);
    const before = first.service.state().state;
    expect(before.phase).toBe('watching');
    expect(before.counted).toBe(16);
    await first.clock.advanceBy(3000);
    await first.service.stop();

    second = harness(fake, first.clock.now(), {}, dir);
    await second.service.start();
    const view = second.service.state().state;
    expect(view.phase).toBe('watching');
    expect(view.counted).toBe(16);
    expect(view.switchedOffAtMs).toBe(before.switchedOffAtMs);
    expect(view.switchOffConfirmed).toBe(true);
    expect(second.service.state().timeline.map((t) => t.text)).toEqual(first.service.state().timeline.map((t) => t.text));

    await play(second, lines);
    await second.clock.advanceBy(5000);
    expect(second.service.state().state.phase).toBe('closed');
    expect(second.service.state().state.label).toBe('probably the feature');
    const [entry] = second.service.listRecords();
    const record = JSON.parse(readFileSync(join(dir, 'data', 'records', `${entry?.id}.json`), 'utf8')) as InvestigationRecord;
    expect(record.counted).toBe(16);
    expect(record.flagsmith?.variations).toHaveLength(2);
    expect(record.traces.length).toBeGreaterThanOrEqual(16);
    expect(record.baseline.length).toBeGreaterThan(0);
    expect(fake.patches).toBe(1);
  });

  it('resumes a switch-off that was not yet confirmed', async () => {
    const dir = tempDir();
    first = harness(fake, START, {}, dir);
    await first.service.start();
    fake.down = true;
    feedCrossing(first);
    await first.clock.advanceBy(5000);
    expect(first.service.state().state.phase).toBe('switching-off');
    await first.service.stop();

    fake.down = false;
    second = harness(fake, first.clock.now(), {}, dir);
    await second.service.start();
    expect(second.service.state().state.phase).toBe('switching-off');
    await second.clock.advanceBy(3000);
    const view = second.service.state();
    expect(view.state.phase).toBe('watching');
    expect(view.flagsmith.switchOff.confirmed).toBe(true);
    expect(fake.patches).toBe(1);
  });

  it('keeps the list of records and appends to the same run file', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.jsonl');
    first = harness(fake, START, { ALIBI_RECORD: file }, dir);
    await first.service.start();
    const lines = buildRun('feature-bug');
    await play(first, lines, START + 30_000);
    await first.service.stop();
    const sizeBefore = readFileSync(file, 'utf8').split('\n').length;

    second = harness(fake, first.clock.now(), { ALIBI_RECORD: file }, dir);
    await second.service.start();
    await play(second, lines);
    await second.clock.advanceBy(5000);
    await second.service.stop();
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n').length).toBeGreaterThan(sizeBefore);
    expect(text.split('\n').filter((line) => line.includes('"kind":"alibi-run"'))).toHaveLength(1);
    expect(second.service.listRecords()).toHaveLength(1);

    const third = harness(fake, second.clock.now(), {}, dir);
    await third.service.start();
    expect(third.service.listRecords()).toHaveLength(1);
    await third.service.stop();
  });

  it('starts fresh when the saved state is for another flag', async () => {
    const dir = tempDir();
    first = harness(fake, START, {}, dir);
    await first.service.start();
    feedCrossing(first);
    await first.clock.advanceBy(3000);
    await first.service.stop();
    second = harness(fake, first.clock.now(), { ALIBI_FLAG: 'other_flag' }, dir);
    await second.service.start();
    expect(second.service.state().state.phase).toBe('armed');
  });
});
