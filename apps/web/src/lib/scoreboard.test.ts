import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildScoreboard, type ScenarioSummary } from './scoreboard';

const row = (scenario: string, shouldAct: boolean, alibiRight: boolean, rule20Right: boolean) => ({ scenario, shouldAct, alibiRight, rule20Right });

describe('the scoreboard is computed from the summary, nothing else', () => {
  it('counts runs, rights, misses and groups the misses by scenario', () => {
    const s: ScenarioSummary = {
      counted: [
        ...[0, 1, 2].map(() => row('rare-bug', true, true, false)),
        ...[0, 1].map(() => row('feature-service-outage', false, true, false)),
        row('feature-service-outage', false, true, true),
        ...[0, 1, 2].map(() => row('healthy', false, true, true)),
        row('shared-service-outage-low-traffic', false, false, false),
      ],
      earlierRunsScoredAfterTheFact: [
        ...Array.from({ length: 4 }, () => ({ scenario: 'outage', alibiRight: true, rule20Right: true })),
        ...Array.from({ length: 2 }, () => ({ scenario: 'slow-host', alibiRight: false, rule20Right: false })),
        { scenario: 'odd', alibiRight: true, rule20Right: false },
      ],
    };
    const b = buildScoreboard(s);
    expect(b.planned).toBe(10);
    expect(b.alibiRight).toBe(9);
    expect(b.ruleRight).toBe(4);
    expect(b.headline).toBe('10 runs planned before any of them ran: Alibi right in 9, the 20-point rule in 4');
    expect(b.rows.find((r) => r.scenario === 'rare-bug')).toMatchObject({ decision: 'Switch off', alibi: { right: 3, total: 3 }, rule: { right: 0, total: 3 } });
    expect(b.rows.find((r) => r.scenario === 'healthy')?.decision).toBe('Leave on');
    expect(b.lines[0]).toContain("Two of the simple rule's six misses are a matter of definition");
    expect(b.lines[1]).toBe('Three are the rare bug.');
    expect(b.lines[2]).toBe('One is noise at low traffic.');
    expect(b.lines[3]).toBe('On the 7 earlier runs both rules are right in 4 and wrong in 2 (the slow-host runs); on 1 only one is right.');
  });

  it('reads the real summary: 24 runs, Alibi 24, the 20-point rule 17, and the three kinds of miss', () => {
    const file = fileURLToPath(new URL('../../../../runs/outage-scenarios/summary.json', import.meta.url));
    expect(existsSync(file), 'runs/outage-scenarios/summary.json is required by the build').toBe(true);
    const b = buildScoreboard(JSON.parse(readFileSync(file, 'utf8')) as ScenarioSummary);
    expect(b.planned).toBe(24);
    expect(b.alibiRight).toBe(24);
    expect(b.ruleRight).toBe(17);
    expect(b.rows).toHaveLength(8);
    expect(b.lines.slice(0, 3)).toEqual([
      "Three of the simple rule's seven misses are a matter of definition (a service only the feature uses was down; the author's rule calls that infrastructure).",
      'Three are the rare bug.',
      'One is noise at low traffic.',
    ]);
    expect(b.lines[3]).toBe('On the 18 earlier runs both rules are right in 12 and wrong in 6 (the slow-host runs).');
  });
});
