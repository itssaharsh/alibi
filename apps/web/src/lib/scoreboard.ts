/**
 * The scoreboard of the pre-registered outage runs, computed from `runs/outage-scenarios/summary.json`.
 * Every number on the page comes from that file; the words around them are fixed here.
 */
export interface SummaryRow {
  scenario: string;
  shouldAct: boolean;
  alibiRight: boolean;
  rule20Right: boolean;
}

export interface EarlierRow {
  scenario: string;
  alibiRight: boolean;
  rule20Right: boolean;
}

export interface ScenarioSummary {
  counted: SummaryRow[];
  earlierRunsScoredAfterTheFact: EarlierRow[];
}

export interface ScoreRow {
  scenario: string;
  /** What was done to the stack, in plain words. */
  what: string;
  /** The right decision for that scenario. */
  decision: 'Switch off' | 'Leave on';
  alibi: { right: number; total: number };
  rule: { right: number; total: number };
}

export interface Scoreboard {
  planned: number;
  alibiRight: number;
  ruleRight: number;
  headline: string;
  rows: ScoreRow[];
  lines: string[];
}

const WHAT: Record<string, string> = {
  'shared-service-outage': 'A service both versions call is stopped',
  'feature-service-outage': 'A service only the new checkout calls is stopped',
  'database-flaky': 'The database drops about a third of its connections',
  'shared-service-outage-low-traffic': 'A shared service is stopped, at half the traffic',
  'database-outage-with-bug': 'The database is stopped, and the new checkout has a coupon bug',
  'shared-service-outage-with-bug': 'A shared service is stopped, and the new checkout has the coupon bug',
  'rare-bug': 'A rare bug: a few carts crash the new checkout',
  healthy: 'Nothing is wrong',
};

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n: number): string => WORDS[n] ?? String(n);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plain = (scenario: string): string => scenario.replace(/-/g, ' ');

/** How a miss of the simple rule is described, by scenario; an unknown scenario is named as it is. */
function missText(scenario: string, n: number): string {
  const be = n === 1 ? 'is' : 'are';
  if (scenario === 'feature-service-outage') return `${be} a matter of definition (a service only the feature uses was down; the author's rule calls that infrastructure)`;
  if (scenario === 'rare-bug') return `${be} the rare bug`;
  if (scenario === 'shared-service-outage-low-traffic') return `${be} noise at low traffic`;
  return `${be} in the ${plain(scenario)} scenario`;
}

export function buildScoreboard(summary: ScenarioSummary): Scoreboard {
  const counted = summary.counted;
  const byScenario = new Map<string, SummaryRow[]>();
  for (const row of counted) byScenario.set(row.scenario, [...(byScenario.get(row.scenario) ?? []), row]);

  const rows: ScoreRow[] = [...byScenario.entries()].map(([scenario, list]) => ({
    scenario,
    what: WHAT[scenario] ?? cap(plain(scenario)),
    decision: list[0]!.shouldAct ? 'Switch off' : 'Leave on',
    alibi: { right: list.filter((r) => r.alibiRight).length, total: list.length },
    rule: { right: list.filter((r) => r.rule20Right).length, total: list.length },
  }));

  const alibiRight = counted.filter((r) => r.alibiRight).length;
  const ruleRight = counted.filter((r) => r.rule20Right).length;
  const misses = counted.length - ruleRight;
  const lines: string[] = [];
  // Definition first, then the rare bug, then noise; anything else after, in the order the summary lists it.
  const order = ['feature-service-outage', 'rare-bug', 'shared-service-outage-low-traffic'];
  const rank = (s: string): number => (order.includes(s) ? order.indexOf(s) : order.length);
  const groups = rows.filter((r) => r.rule.right < r.rule.total).sort((a, b) => rank(a.scenario) - rank(b.scenario));
  groups.forEach((g, i) => {
    const n = g.rule.total - g.rule.right;
    const text = missText(g.scenario, n);
    lines.push(i === 0 ? `${cap(word(n))} of the simple rule's ${word(misses)} misses ${text}.` : `${cap(word(n))} ${text}.`);
  });
  if (misses === 0) lines.push("The simple rule had no misses.");

  const earlier = summary.earlierRunsScoredAfterTheFact;
  if (earlier.length > 0) {
    const bothRight = earlier.filter((r) => r.alibiRight && r.rule20Right).length;
    const bothWrong = earlier.filter((r) => !r.alibiRight && !r.rule20Right);
    const split = earlier.length - bothRight - bothWrong.length;
    const names = [...new Set(bothWrong.map((r) => r.scenario))];
    const which = names.length > 0 ? ` (the ${names.join(' and ')} runs)` : '';
    lines.push(`On the ${earlier.length} earlier runs both rules are right in ${bothRight} and wrong in ${bothWrong.length}${which}${split > 0 ? `; on ${split} only one is right` : ''}.`);
  }

  return {
    planned: counted.length,
    alibiRight,
    ruleRight,
    headline: `${counted.length} runs planned before any of them ran: Alibi right in ${alibiRight}, the 20-point rule in ${ruleRight}`,
    rows,
    lines,
  };
}
