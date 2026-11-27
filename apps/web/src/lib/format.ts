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
    return { key, tripped: false, text: finished ? `${PREFIX[key]} would not have switched the flag off.` : `${PREFIX[key]} watching the same requests.` };
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
