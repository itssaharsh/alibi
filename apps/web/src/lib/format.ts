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
