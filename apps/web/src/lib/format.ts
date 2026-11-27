import { describeLevel, formatMs, formatRelative, type FailureClass, type Rates } from '@alibi/core';
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

/** The plain rule's side of the story, from the engine's state. */
export function plainRuleLine(board: Board, finished: boolean): string {
  const { state } = board;
  const flag = state.config.flag;
  if (state.plainRuleTrippedAtMs !== undefined) {
    return `A plain error-rate rule would have switched ${flag} off at ${rel(board, state.plainRuleTrippedAtMs)}.`;
  }
  return finished ? `A plain error-rate rule would not have switched ${flag} off.` : 'A plain error-rate rule is watching the same requests.';
}

export function alibiLine(board: Board): string {
  const { state } = board;
  const failures = state.totals.flagOn.failures;
  if (failures === 0) return 'No request with the flag on has failed yet.';
  if (state.switchedOffAtMs !== undefined) return `Alibi switched it off at ${rel(board, state.switchedOffAtMs)}, after ${state.counted} counted failures.`;
  if (state.phase === 'switching-off') return `Alibi counted ${state.counted} failures on the flagged path and is switching it off.`;
  const parts: string[] = [];
  const n = state.notCounted;
  if (n.dependency) parts.push(`${n.dependency} in a dependency`);
  if (n.server) parts.push(`${n.server} in the server`);
  if (n.mixed) parts.push(`${n.mixed} in both`);
  const rest = parts.length ? ` The rest failed ${parts.join(', ')}.` : '';
  return `Alibi counted ${state.counted} of ${failures}, so the flag is on.${rest}`;
}
