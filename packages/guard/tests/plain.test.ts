import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRun, replayRun, type InvestigationRecord } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { feedCrossing, play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { FakeFlagsmith, HEALTH_TOKEN, envFor, harness, tempDir, type Harness } from './helpers.js';

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

/** A flag that is not in an experiment: no experiment id anywhere. */
const plain = (extra: Record<string, string> = {}, dir = tempDir()): Harness =>
  harness(fake, START, { FLAGSMITH_EXPERIMENT_ID: '', ALIBI_FLAG: 'checkout_v2', ...extra }, dir);

describe('a flag that is not in an experiment', () => {
  it('is disabled once, confirmed with 20 identities, and says so in plain words', async () => {
    h = plain();
    await h.service.start();
    expect(h.service.state().flagsmith.mode).toBe('plain-flag');
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    const view = h.service.state();
    expect(view.state.phase).toBe('watching');
    expect(fake.patches).toBe(1);
    expect(fake.featureDisabled).toBe(true);
    expect(fake.rollouts).toHaveLength(0);
    expect(view.flagsmith.switchOff).toEqual({ requested: true, confirmed: true, detail: 'checkout_v2 disabled in Flagsmith; 20 of 20 identities checked get stable' });
    expect(view.flagsmith.note).toContain('No experiment is configured');
    expect(fake.count('GET /api/v1/identities/')).toBe(20);
    expect(fake.count('POST /api/v1/events/')).toBe(0);
    expect(fake.count('GET /api/v1/environments/' + 'ENVKEY-abc123456' + '/experiments')).toBe(0);
  });

  it('sends no experiment events and reads no experiment numbers, but the record is written and replays equal', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.jsonl');
    h = plain({ ALIBI_RECORD: file, FLAGSMITH_FEATURE_HEALTH_URL: `http://flagsmith:8000/api/v1/feature-health/${HEALTH_TOKEN}` }, dir);
    await h.service.start();
    await play(h, buildRun('feature-bug'));
    await h.clock.advanceBy(5000);
    await h.service.stop();
    expect(fake.events).toHaveLength(0);
    expect(fake.refreshes).toBe(0);
    expect(fake.patches).toBe(1);
    expect(h.service.state().flagsmith.results).toBeUndefined();
    expect(h.service.state().state.label).toBe('probably the feature');
    expect(fake.healthPosts).toHaveLength(2);
    const [entry] = h.service.listRecords();
    const record = JSON.parse(readFileSync(join(dir, 'data', 'records', `${entry?.id}.json`), 'utf8')) as InvestigationRecord;
    expect(record.flagsmith).toBeUndefined();
    expect(record.label).toBe('probably the feature');
    const text = readFileSync(file, 'utf8');
    const lines = parseRun(text);
    expect(lines.some((line) => line.kind === 'flagsmith' && line.what === 'results' && !line.ok && line.detail.includes('No experiment is configured'))).toBe(true);
    const replay = replayRun(lines);
    expect(replay.record).toEqual(record);
    expect(replay.state.switchedOffAtMs).toBe(h.service.state().state.switchedOffAtMs);
  });

  it('says "not confirmed" while the evaluation still serves the new version, and while Flagsmith is down, then confirms', async () => {
    h = plain();
    await h.service.start();
    fake.patchHasNoEffect = true;
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    expect(h.service.state().state.phase).toBe('switching-off');
    expect(h.service.state().flagsmith.switchOff.detail).toMatch(/^switch-off not confirmed: \d+ of 20 identities checked still get the new version$/);
    fake.patchHasNoEffect = false;
    fake.down = true;
    await h.clock.advanceBy(10000);
    expect(h.service.state().flagsmith.switchOff.detail).toContain('switch-off not confirmed: Flagsmith did not answer');
    fake.down = false;
    await h.clock.advanceBy(30000);
    expect(h.service.state().state.phase).toBe('watching');
    expect(fake.patches).toBe(1);
  });

  it('refuses an environment that uses feature versioning, in plain words', async () => {
    fake.versioningV2 = true;
    h = plain();
    await h.service.start();
    feedCrossing(h);
    await h.clock.advanceBy(3000);
    expect(h.service.state().state.phase).toBe('switching-off');
    expect(h.service.state().flagsmith.switchOff.detail).toBe('switch-off not confirmed: this Flagsmith environment uses feature versioning (v2), and Alibi cannot change the flag there yet');
    expect(fake.patches).toBe(0);
  });

  it('reads no results at the end of a run either', async () => {
    h = plain();
    await h.service.start();
    h.service.receive([]);
    expect(await h.service.finish()).toEqual({ resultsRead: false });
    expect(fake.refreshes).toBe(0);
  });
});

describe('choosing the way to switch off', () => {
  const base = envFor(new FakeFlagsmith(), '/tmp/x');
  const load = (extra: Record<string, string>) => loadConfig({ ...base, ...extra }).flagsmith;

  it('uses the rollout when there is an experiment and disables the flag when there is not', () => {
    expect(load({})).toMatchObject({ switchOff: 'rollout-zero', experimentMode: true, experimentId: 1 });
    expect(load({ FLAGSMITH_EXPERIMENT_ID: '', ALIBI_FLAG: 'checkout_v2' })).toMatchObject({ switchOff: 'disable-feature', experimentMode: false });
  });

  it('lets ALIBI_SWITCH_OFF decide', () => {
    expect(load({ ALIBI_SWITCH_OFF: 'disable-feature', ALIBI_FLAG: 'checkout_v2' })).toMatchObject({ switchOff: 'disable-feature', experimentMode: false, experimentId: 1 });
  });

  it('says in one line what is missing', () => {
    const reason = (extra: Record<string, string>): string => {
      try {
        loadConfig({ ...base, ...extra });
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as Error).message;
      }
      throw new Error('expected a ConfigError');
    };
    expect(reason({ FLAGSMITH_EXPERIMENT_ID: '' , ALIBI_SWITCH_OFF: 'rollout-zero' })).toContain('FLAGSMITH_EXPERIMENT_ID is missing');
    expect(reason({ FLAGSMITH_EXPERIMENT_ID: '' })).toContain('ALIBI_FLAG is missing');
    expect(loadConfig({ ...base, FLAGSMITH_EXPERIMENT_ID: '', FLAGSMITH_FEATURE_ID: '3' }).flagsmith).toMatchObject({ switchOff: 'disable-feature', featureId: 3 });
  });
});
