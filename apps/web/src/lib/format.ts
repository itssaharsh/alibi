import { DEFAULT_ARM_RULE, describeLevel, formatMs, formatRelative, type FailureClass, type GuardConfig, type Rates } from '@alibi/core';
import type { Board } from './viewModel';

export const rel = (board: Board, absMs: number): string => formatRelative(absMs - board.meta.startedAtMs);
export const relMs = (ms: number): string => formatRelative(ms);
export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export const classWords: Record<FailureClass, string> = {
  'flagged-path': 'flagged path',
  dependency: 'dependency',
  server: 'server',
  mixed: 'dependency and server',
};

/** Durations and levels are written by the engine, never rounded here. */
export const ms = formatMs;
/** Recorded numbers, formatted and never rounded to nothing: a chance of 0.00013 reads "0.013%". */
export function pct(fraction: number): string {
  const p = fraction * 100;
  if (p === 0) return '0%';
  const a = Math.abs(p);
  if (a >= 10) return `${p.toFixed(0)}%`;
  if (a >= 1) return `${p.toFixed(1)}%`;
  return `${Number(p.toPrecision(2))}%`;
}
export const sig = (x: number): string => String(Number(x.toPrecision(4)));

export const ratesLine = (r: Rates): string => describeLevel(r);

export interface SimplerRuleLine {
  key: 'plain' | 'arm';
  tripped: boolean;
  /** Relative time of the trip, for example `+01:16`. */
  at?: string;
  /** The engine's own sentence. */
  text: string;
}

const PREFIX = { plain: 'Plain error-rate rule:', arm: 'Arm comparison (flag on against stable):' } as const;

/** The two simpler rules on the same requests, in the engine's own wording, and what Alibi did. */
export function simplerRules(board: Board, finished: boolean): { rules: SimplerRuleLine[]; alibi: string; sooner?: string } {
  const { state } = board;
  const line = (key: 'plain' | 'arm', abs: number | undefined): SimplerRuleLine => {
    if (abs !== undefined) {
      const entry = board.timeline.find((e) => e.text.startsWith(PREFIX[key]));
      return { key, tripped: true, at: rel(board, abs), text: entry?.text ?? `${PREFIX[key]} would have switched the flag off here.` };
    }
    if (finished) return { key, tripped: false, text: `${PREFIX[key]} would not have switched the flag off.` };
    // After Alibi's switch-off nobody gets the feature, so a rule that has not acted by then has nothing left to act on.
    if (state.switchedOffAtMs !== undefined) return { key, tripped: false, text: `${PREFIX[key]} had not acted when Alibi switched the flag off.` };
    return { key, tripped: false, text: `${PREFIX[key]} watching the same requests.` };
  };
  const rules = [line('plain', state.plainRuleTrippedAtMs), line('arm', state.armRuleTrippedAtMs)];
  let sooner: string | undefined;
  const off = state.switchedOffAtMs;
  if (off !== undefined) {
    const early = [
      state.plainRuleTrippedAtMs !== undefined && state.plainRuleTrippedAtMs < off ? 'plain' : '',
      state.armRuleTrippedAtMs !== undefined && state.armRuleTrippedAtMs < off ? 'arm' : '',
    ].filter(Boolean);
    if (early.length === 2) sooner = 'Both simpler rules acted sooner than Alibi.';
    else if (early[0] === 'plain') sooner = 'The plain error-rate rule acted sooner than Alibi.';
    else if (early[0] === 'arm') sooner = 'The arm comparison acted sooner than Alibi.';
  }
  return { rules, alibi: alibiLine(board, finished), ...(sooner ? { sooner } : {}) };
}

/** The short line on the stamp card before anything is switched off. */
export function simplerRulesShort(board: Board, finished: boolean): string {
  const p = board.state.plainRuleTrippedAtMs;
  const a = board.state.armRuleTrippedAtMs;
  if (p !== undefined && a !== undefined) return `Both simpler rules would have switched it off: at ${rel(board, p)} and ${rel(board, a)}.`;
  if (p !== undefined) return `The plain error-rate rule would have switched it off at ${rel(board, p)}.`;
  if (a !== undefined) return `The arm comparison would have switched it off at ${rel(board, a)}.`;
  return finished ? 'Neither simpler rule would have switched it off.' : 'Two simpler rules are watching the same requests.';
}

export function alibiLine(board: Board, finished: boolean): string {
  const { state } = board;
  const failures = Math.max(state.totals.flagOn.failures, board.tags.length);
  if (failures === 0) return 'Alibi: no request with the flag on has failed yet.';
  if (state.switchedOffAtMs !== undefined) return `Alibi switched it off at ${rel(board, state.switchedOffAtMs)}, after ${state.counted} counted failures.`;
  if (state.phase === 'switching-off') return `Alibi counted ${state.counted} failures on the flagged path and is switching it off.`;
  const parts: string[] = [];
  const n = state.notCounted;
  if (n.dependency) parts.push(`${n.dependency} in a dependency`);
  if (n.server) parts.push(`${n.server} in the server`);
  if (n.mixed) parts.push(`${n.mixed} in both`);
  const rest = parts.length ? ` ${parts.join(', ').replace(/^(\d+)/, '$1 failed')}.` : '';
  return `Alibi counted ${state.counted} of ${failures}, so the flag ${finished ? 'stays' : 'is'} on.${rest}`;
}

/** The arm comparison's margin in plain words, from the run's own settings. */
export function armMarginLine(config: GuardConfig): string {
  const a = config.armRule ?? DEFAULT_ARM_RULE;
  return `The arm comparison acts at a ${a.errorRatePoints}-point margin: flag-on errors must exceed stable by that many points over ${a.windowMs / 1000} seconds, with at least ${a.minRequestsPerArm} requests in each arm.`;
}

export type WhyTarget = { kind: 'tab'; tab: 'counted' | 'excluded' } | { kind: 'compare' } | { kind: 'watch' } | { kind: 'rule' };

export interface WhyLine {
  n: 1 | 2 | 3 | 4 | 5;
  /** The part to set in bold: a number or a short phrase at the start of the line. */
  lead: string;
  text: string;
  target: WhyTarget;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The most common failing point and reason among excluded requests, for example `pg.connect, Connection terminated unexpectedly`. */
export function topExcludedReason(board: Board): string | undefined {
  const rest = board.tags.filter((t) => !t.counted);
  const counts = new Map<string, number>();
  for (const t of rest) {
    const o = t.origins[0];
    if (!o) continue;
    const name = o.label ?? o.name;
    // The engine's short reason can begin with span attributes (`db.system.name=postgresql`); the readable part follows them.
    const detail = o.detail.replace(/^(?:\S+=\S+\s+)+/, '');
    const key = detail ? `${name}, ${detail}` : name;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
}

/**
 * "Why this verdict": the author's four-part rule, each line from the engine's numbers for this moment of this run.
 * Nothing is computed here beyond picking the biggest group and writing the sentence.
 */
export function whyVerdict(board: Board, finished: boolean): WhyLine[] {
  const { state } = board;
  const lines: WhyLine[] = [];

  const counted = state.counted;
  lines.push({
    n: 1,
    lead: counted === 0 ? 'None' : String(counted),
    text: counted === 0 ? " in the feature's own code" : ` ${plural(counted, 'failure', 'failures')} in the feature's own code`,
    target: { kind: 'tab', tab: 'counted' },
  });

  const n = state.notCounted;
  const excluded = n.dependency + n.server + n.mixed;
  if (excluded === 0) {
    lines.push({ n: 2, lead: 'None', text: ' failed in a dependency or the server', target: { kind: 'tab', tab: 'excluded' } });
  } else {
    const where = n.dependency >= n.server && n.dependency >= n.mixed ? 'in a dependency' : n.server >= n.mixed ? 'in the server' : 'in a dependency and the server';
    const reason = topExcludedReason(board);
    lines.push({ n: 2, lead: String(excluded), text: ` failed ${where}${reason ? `: ${reason}` : ''}`, target: { kind: 'tab', tab: 'excluded' } });
  }

  const rows = board.record?.baseline ?? board.baseline;
  const top = rows[0];
  if (top) {
    const s = top.stable;
    const spanName = spanLabel(board, top.route, top.span);
    const text = !top.spanExistsInStable
      ? `The stable version does not run ${spanName}; on ${top.route} it failed ${s.failures} of ${s.requests} requests`
      : s.failures > 0
        ? `The stable version failed at ${spanName} too: ${s.failures} of its requests`
        : `The stable version did not fail at ${spanName}: 0 of ${s.requests} requests`;
    const lead = !top.spanExistsInStable ? 'The stable version does not run' : s.failures > 0 ? 'The stable version failed' : 'The stable version did not fail';
    lines.push({ n: 3, lead, text: text.slice(lead.length), target: { kind: 'compare' } });
  } else {
    lines.push({ n: 3, lead: 'The stable version', text: ' is compared at each failing point once something fails', target: { kind: 'compare' } });
  }

  let four: WhyLine;
  if (state.label) {
    const minutes = state.config.watchMs / 60000;
    four =
      state.recoveredAtMs !== undefined
        ? { n: 4, lead: 'Back at the stable level', text: ` at ${rel(board, state.recoveredAtMs)}: ${state.label}`, target: { kind: 'watch' } }
        : { n: 4, lead: 'Still above the stable level', text: ` after ${minutes} minutes: ${state.label}`, target: { kind: 'watch' } };
  } else if (state.phase === 'watching' || state.phase === 'switching-off') {
    const left = state.watchEndsAtMs === undefined ? undefined : Math.max(0, Math.ceil((state.watchEndsAtMs - (board.meta.startedAtMs + board.nowMs)) / 1000));
    four = { n: 4, lead: 'Watching', text: left === undefined ? ' for the stable level to come back' : ` for the stable level to come back: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`, target: { kind: 'watch' } };
  } else {
    four = finished
      ? { n: 4, lead: 'The flag was not switched off', text: ', so there was nothing to check', target: { kind: 'rule' } }
      : { n: 4, lead: 'Not needed yet', text: ': the flag has not been switched off', target: { kind: 'rule' } };
  }
  lines.push(four);
  // A notice is the engine's own sentence for something a person should look at; it is never a count.
  const notice = state.notices?.[0];
  if (notice) lines.push({ n: 5, lead: 'Notice', text: `: ${notice.text}`, target: { kind: 'tab', tab: 'excluded' } });
  return lines;
}

/** The name to print for a failing point: the engine's label (for example `GET rules:3000`) when it has one. */
export function spanLabel(board: Board, route: string, span: string): string {
  for (const t of [...board.tags, ...board.stableTags]) {
    if (t.route !== route) continue;
    const o = t.origins.find((x) => x.name === span && x.label);
    if (o?.label) return o.label;
  }
  return span;
}
