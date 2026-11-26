import { readFileSync } from 'node:fs';
import { parseRun } from './replay.js';
import type { RunLine } from './types.js';

/** Reads a run file from disk. Kept apart from the browser entry so it never pulls in node:fs. */
export function readRun(path: string): RunLine[] {
  return parseRun(readFileSync(path, 'utf8'));
}
