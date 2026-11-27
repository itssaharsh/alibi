import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatReport, parseRun, replayRun, type GuardState, type InvestigationRecord, type RunLine } from '@alibi/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { play } from './drive.js';
import { buildRun, START, type RunName } from './fixtures.js';
import { FakeFlagsmith, harness, tempDir, type Harness } from './helpers.js';

let fake: FakeFlagsmith;
let h: Harness;

beforeEach(async () => {
  fake = new FakeFlagsmith();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
});

const withoutLastSpan = (state: GuardState): Omit<GuardState, 'lastSpanAtMs'> => {
  const { lastSpanAtMs: _ignored, ...rest } = state;
  return rest;
};

async function liveRun(name: RunName): Promise<{ lines: RunLine[]; file: string }> {
  const dir = tempDir();
  const file = join(dir, 'recording', `${name}.jsonl`);
  h = harness(fake, START, { ALIBI_RECORD: file, ALIBI_RUN_NAME: name, ALIBI_RUN_TITLE: `Title of ${name}`, ALIBI_RUN_PLANTED: 'Something planted.' }, dir);
  await h.service.start();
  const lines = buildRun(name);
  await play(h, lines, START + 60_000);
  h.service.addWorld('The trouble started.');
  await play(h, lines);
  await h.clock.advanceBy(10_000);
  await h.service.stop();
  return { lines: parseRun(readFileSync(file, 'utf8')), file };
}

describe('replaying what the live service recorded', () => {
  for (const name of ['feature-bug', 'degraded-host'] as const) {
    it(`${name}: same counts, switch-off time, label and record`, async () => {
      const { lines, file } = await liveRun(name);
      const header = lines[0];
      expect(header).toMatchObject({
        kind: 'alibi-run',
        version: 1,
        name,
        title: `Title of ${name}`,
        planted: 'Something planted.',
        startedAtMs: START,
        source: 'self-hosted Flagsmith 2.295.2, recorded 14 Nov 2023',
        config: h.config.guard,
      });
      const kinds = new Set(lines.map((line) => (line.kind === 'flagsmith' ? `flagsmith:${line.what}` : line.kind)));
      expect([...kinds].sort()).toEqual(['alibi-run', 'flagsmith:evaluation-check', 'flagsmith:events', 'flagsmith:results', 'flagsmith:switch-off', 'spans', 'world']);

      const replay = replayRun(lines);
      const live = h.service.state({ recent: false }).state;
      expect(withoutLastSpan(replay.state)).toEqual(withoutLastSpan(live));
      expect(replay.state.counted).toBe(16);
      expect(Math.floor((replay.state.switchedOffAtMs as number) / 1000)).toBe(Math.floor((live.switchedOffAtMs as number) / 1000));
      expect(replay.state.label).toBe(live.label);
      expect(replay.state.label).toBe(name === 'feature-bug' ? 'probably the feature' : 'probably not the feature');

      const [entry] = h.service.listRecords();
      const liveRecord = JSON.parse(readFileSync(join(h.dir, 'data', 'records', `${entry?.id}.json`), 'utf8')) as InvestigationRecord;
      const replayRecord = replay.record as InvestigationRecord;
      expect(replayRecord).toBeDefined();
      // The live record was read again at the end of the watch; the replay holds the numbers read at the switch-off.
      const { flagsmith: liveNumbers, ...liveRest } = liveRecord;
      const { flagsmith: replayNumbers, ...replayRest } = replayRecord;
      expect(replayRest).toEqual(liveRest);
      const recorded = lines.find((line) => line.kind === 'flagsmith' && line.what === 'results');
      expect(replayNumbers).toEqual((recorded as { data: unknown }).data);
      expect(liveNumbers?.variations).toEqual(replayNumbers?.variations);

      expect(replay.record?.timeline.map((t) => t.text)).toEqual(liveRecord.timeline.map((t) => t.text));
      expect(formatReport(replay)).toContain(`Result: ${live.label} (not proven)`);
      expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    });
  }

  it('outage: the flag stays on in both, and the plain rule trips in both', async () => {
    const { lines } = await liveRun('outage');
    const replay = replayRun(lines);
    const live = h.service.state({ recent: false }).state;
    expect(withoutLastSpan(replay.state)).toEqual(withoutLastSpan(live));
    expect(live.phase).toBe('armed');
    expect(live.counted).toBe(0);
    expect(live.plainRuleTrippedAtMs).toBeDefined();
    expect(replay.record).toBeUndefined();
    expect(lines.some((line) => line.kind === 'flagsmith' && line.what === 'switch-off')).toBe(false);
  });

  it('records a refused switch-off and its confirmation, and the replay agrees', async () => {
    const dir = tempDir();
    const file = join(dir, 'refused.jsonl');
    h = harness(fake, START, { ALIBI_RECORD: file }, dir);
    await h.service.start();
    fake.down = true;
    const lines = buildRun('feature-bug');
    await play(h, lines, START + 120_000);
    expect(h.service.state().state.phase).toBe('switching-off');
    fake.down = false;
    await h.clock.advanceBy(30_000);
    await play(h, lines);
    await h.clock.advanceBy(5000);
    await h.service.stop();
    const replay = replayRun(parseRun(readFileSync(file, 'utf8')));
    const live = h.service.state({ recent: false }).state;
    expect(withoutLastSpan(replay.state)).toEqual(withoutLastSpan(live));
    expect(replay.events.filter((e) => e.type === 'switched-off').some((e) => e.type === 'switched-off' && !e.confirmed)).toBe(true);
    expect(replay.state.label).toBeDefined();
  });
});
