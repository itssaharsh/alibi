import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRun, replayRun, type GuardState } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { play } from './drive.js';
import { buildRun, START } from './fixtures.js';
import { FakeFlagsmith, envFor, harness, tempDir, type Harness } from './helpers.js';

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

const withoutLastSpan = (state: GuardState): Omit<GuardState, 'lastSpanAtMs'> => {
  const { lastSpanAtMs: _ignored, ...rest } = state;
  return rest;
};

describe('observe only', () => {
  it('counts and records as usual, never calls Flagsmith to switch off, and replays equal', async () => {
    const dir = tempDir();
    const file = join(dir, 'run.jsonl');
    h = harness(fake, START, { ALIBI_OBSERVE_ONLY: '1', ALIBI_RECORD: file }, dir);
    await h.service.start();
    await play(h, buildRun('feature-bug'));
    await h.clock.advanceBy(10_000);
    const view = h.service.state({ recent: false });
    expect(view.state.phase).toBe('switching-off');
    expect(view.state.counted).toBe(16);
    expect(view.state.switchOffConfirmed).toBe(false);
    expect(view.flagsmith.observeOnly).toBe(true);
    expect(view.flagsmith.switchOff.detail).toMatch(/^observing/);
    expect(fake.patches).toBe(0);
    expect(fake.count('PATCH')).toBe(0);
    expect(fake.count('GET /api/v1/identities/')).toBe(0);
    // experiment events keep being forwarded as usual, also after the crossing
    expect(fake.events.length).toBeGreaterThan(1000);
    expect(view.flagsmith.forwardingStoppedAtMs).toBeUndefined();
    expect(view.timeline.filter((e) => e.text === 'Switch-off not confirmed: observe only: the flag was not switched off')).toHaveLength(1);

    await h.service.stop();
    const lines = parseRun(readFileSync(file, 'utf8'));
    const answers = lines.filter((line) => line.kind === 'flagsmith' && line.what === 'switch-off');
    expect(answers).toEqual([expect.objectContaining({ ok: false, detail: 'observe only: the flag was not switched off' })]);
    const replay = replayRun(lines);
    expect(withoutLastSpan(replay.state)).toEqual(withoutLastSpan(h.service.state({ recent: false }).state));
    expect(replay.events.filter((e) => e.type === 'threshold-crossed')).toHaveLength(1);
  });

  it('is off by default, and can be set in the rule file', () => {
    const env = envFor(fake, '/tmp/x');
    expect(loadConfig(env).observeOnly).toBe(false);
    expect(loadConfig({ ...env, ALIBI_OBSERVE_ONLY: '1' }).observeOnly).toBe(true);
    const dir = tempDir();
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ observeOnly: true, armRule: { errorRatePoints: 20 } }));
    const config = loadConfig({ ...env, ALIBI_RULES: join(dir, 'rules.json') });
    expect(config.observeOnly).toBe(true);
    expect(config.guard.armRule).toEqual({ windowMs: 60000, minRequestsPerArm: 20, errorRatePoints: 20 });
  });
});
